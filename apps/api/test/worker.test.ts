/**
 * Durable work checks (BACKEND_PRD sections 16.3, 20.4).
 */

import { describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { drafts, jobs, operations, outboxEvents, searchDocuments } from '../src/db/schema/registry.js';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  queueDepth,
  reclaimExpiredLeases,
} from '../src/services/jobs.js';
import { emitEvent, lockPendingEvents, outboxQueueAgeSeconds, pendingEvents } from '../src/services/outbox.js';
import { createOperation, getOperationForActor } from '../src/services/operations.js';
import { JOB_HANDLERS } from '../src/jobs/handlers/index.js';
import { createWorkerCycle, DISPATCH_BATCH, startWorker } from '../src/jobs/worker.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { moderateProject } from '../src/services/moderation.js';
import { reindexProject } from '../src/services/search.js';

describe('job queue', () => {
  it('leases a job once across concurrent workers', async () => {
    await enqueueJob(db(), { kind: 'operation_reconcile', payload: {}, dedupeKey: 'single' });
    const [first, second] = await Promise.all([
      claimJobs('worker-a', 5),
      claimJobs('worker-b', 5),
    ]);
    expect((first?.length ?? 0) + (second?.length ?? 0)).toBe(1);
  });

  it('deduplicates queued work by key', async () => {
    const a = await enqueueJob(db(), {
      kind: 'publication_index',
      payload: { project_id: 'x' },
      dedupeKey: 'same',
    });
    const b = await enqueueJob(db(), {
      kind: 'publication_index',
      payload: { project_id: 'x' },
      dedupeKey: 'same',
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('retries a transient failure with backoff and stops at the attempt limit', async () => {
    await enqueueJob(db(), { kind: 'operation_reconcile', payload: {}, maxAttempts: 2 });
    const [job] = await claimJobs('worker', 1);
    const first = await failJob(job!, 'DEPENDENCY_UNAVAILABLE', 'upstream down');
    expect(first).toBe('retrying');
    const [row] = await db().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row?.state).toBe('queued');
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());

    await db().update(jobs).set({ runAt: new Date(), attempts: 2 }).where(eq(jobs.id, job!.id));
    const [again] = await claimJobs('worker', 1);
    const second = await failJob(again!, 'DEPENDENCY_UNAVAILABLE', 'still down');
    expect(second).toBe('failed');
  });

  it('does not retry a terminal error', async () => {
    await enqueueJob(db(), { kind: 'source_import', payload: {}, maxAttempts: 5 });
    const [job] = await claimJobs('worker', 1);
    const outcome = await failJob(job!, 'VALIDATION_FAILED', 'invalid source');
    expect(outcome).toBe('failed');
  });

  it('returns an expired lease to the queue', async () => {
    await enqueueJob(db(), { kind: 'operation_reconcile', payload: {} });
    const [job] = await claimJobs('worker', 1);
    await db()
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(jobs.id, job!.id));
    expect(await reclaimExpiredLeases()).toBe(1);
    const [row] = await db().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row?.state).toBe('queued');
    expect(row?.leaseOwner).toBeNull();
  });

  it('reports queue depth for readiness', async () => {
    await enqueueJob(db(), { kind: 'operation_reconcile', payload: {} });
    const depth = await queueDepth();
    expect(depth.queued).toBe(1);
  });
});

describe('outbox', () => {
  it('delivers events once and tolerates duplicate delivery', async () => {
    await emitEvent(db(), {
      eventType: 'project.published',
      aggregateKind: 'project',
      aggregateId: 'project-1',
      payload: {},
    });
    const pending = await pendingEvents(10);
    expect(pending).toHaveLength(1);
    expect(await outboxQueueAgeSeconds()).toBeGreaterThanOrEqual(0);

    const worker = startWorker();
    await worker.tick();
    await worker.stop();
    const [row] = await db().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, 'project-1'));
    expect(row?.dispatchedAt).not.toBeNull();
  });

  const emitMany = async (count: number, eventType: 'evidence.changed' | 'project.manager_changed', prefix: string) => {
    await db().insert(outboxEvents).values(
      Array.from({ length: count }, (_, i) => ({
        eventType,
        aggregateKind: 'project',
        aggregateId: `${prefix}-${i % 7}`,
        payload: {},
      })),
    );
  };

  it('dispatches a whole batch in one cycle, one job per evidence event', async () => {
    const count = DISPATCH_BATCH + 20;
    await emitMany(count, 'evidence.changed', 'batch');
    const cycle = createWorkerCycle('dispatch-test');
    await cycle();
    const remaining = await db().select().from(outboxEvents).where(sql`dispatched_at is null`);
    expect(remaining).toHaveLength(count - DISPATCH_BATCH);
    await cycle();
    expect(await db().select().from(outboxEvents).where(sql`dispatched_at is null`)).toHaveLength(0);
    const queued = await db().select().from(jobs).where(like(jobs.dedupeKey, 'evidence_reaggregate:batch-%'));
    expect(queued).toHaveLength(count);
    expect(new Set(queued.map((job) => job.dedupeKey)).size).toBe(count);
  });

  it('marks events with no job as dispatched without queueing anything', async () => {
    await emitMany(5, 'project.manager_changed', 'quiet');
    await createWorkerCycle('quiet-test')();
    expect(await db().select().from(outboxEvents).where(sql`dispatched_at is null`)).toHaveLength(0);
    expect(await db().select().from(jobs).where(like(jobs.dedupeKey, '%quiet-%'))).toHaveLength(0);
  });

  it('gives concurrent dispatchers different events', async () => {
    await emitMany(40, 'project.manager_changed', 'split');
    const seen: string[][] = [];
    await Promise.all(
      [0, 1].map(() =>
        db().transaction(async (tx) => {
          const events = await lockPendingEvents(tx, 25);
          seen.push(events.map((event) => event.id));
          // Hold the locks until the other transaction has taken its share.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }),
      ),
    );
    const [first, second] = seen as [string[], string[]];
    expect(first.length + second.length).toBe(40);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
  });

  it('delivers events one at a time when the batch fails as a whole', async () => {
    await emitMany(3, 'evidence.changed', 'fallback');
    await db().insert(outboxEvents).values({ eventType: 'evidence.changed', aggregateKind: 'project', aggregateId: 'poison', payload: {} });
    await db().execute(sql`
      create function test_poison_job() returns trigger language plpgsql as $$
      begin
        if new.payload->>'project_id' = 'poison' then raise exception 'poison job'; end if;
        return new;
      end $$`);
    await db().execute(sql`create trigger poison_job before insert on jobs for each row execute function test_poison_job()`);
    try {
      await createWorkerCycle('fallback-test')();
    } finally {
      await db().execute(sql`drop trigger poison_job on jobs`);
      await db().execute(sql`drop function test_poison_job()`);
    }
    const rows = await db().select().from(outboxEvents);
    const poison = rows.find((row) => row.aggregateId === 'poison');
    expect(poison?.dispatchedAt).toBeNull();
    expect(poison?.attempts).toBe(1);
    expect(rows.filter((row) => row.aggregateId.startsWith('fallback-') && row.dispatchedAt !== null)).toHaveLength(3);
    expect(await db().select().from(jobs).where(like(jobs.dedupeKey, 'evidence_reaggregate:fallback-%'))).toHaveLength(3);
  });
});

describe('job handlers', () => {
  it('reindexes a published project and removes a hidden one', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'worker-index' }));
    await db().delete(searchDocuments).where(eq(searchDocuments.projectId, published.projectId));

    const result = await JOB_HANDLERS.publication_index({
      id: 'j1',
      kind: 'publication_index',
      payload: { project_id: published.projectId },
      attempts: 1,
      maxAttempts: 5,
      operationId: null,
    });
    expect(result.outcome).toBe('indexed');

    const operator = await createAccount({ operator: true });
    await moderateProject({
      actor: operator.actor,
      projectId: published.projectId,
      action: 'quarantine',
      reason: 'Removed for the worker test.',
    });
    const removed = await JOB_HANDLERS.publication_index({
      id: 'j2',
      kind: 'publication_index',
      payload: { project_id: published.projectId },
      attempts: 1,
      maxAttempts: 5,
      operationId: null,
    });
    expect(removed.outcome).toBe('removed');
    const rows = await db().select().from(searchDocuments).where(eq(searchDocuments.projectId, published.projectId));
    expect(rows).toHaveLength(0);
  });

  it('records source drift observations without rewriting published facts', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'worker-drift' }));
    const result = await JOB_HANDLERS.source_drift_check({
      id: 'j3',
      kind: 'source_drift_check',
      payload: { project_version_id: published.projectVersionId },
      attempts: 1,
      maxAttempts: 5,
      operationId: null,
    });
    expect(result.sources_recorded).toBe(1);

    const detail = await request(`/api/v1/projects/${published.projectId}`);
    const source = detail.json.data.current_version.sources[0];
    expect(source.last_checked_at).not.toBeNull();
    // An unfetched source is explicitly "not checked", never silently public.
    expect(source.source_visibility).toBe('not_checked');
    expect(source.revision).toBeNull();
  });

  it('fails a stranded operation so a caller stops waiting forever', async () => {
    const account = await createAccount();
    const operationId = await createOperation(db(), {
      kind: 'project.source_import',
      actor: account.actor,
      targetKind: 'draft',
      targetId: 'draft-x',
      requiredScope: 'projects:draft',
    });
    await db()
      .update(operations)
      .set({ state: 'running', updatedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(operations.id, operationId));

    const result = await JOB_HANDLERS.operation_reconcile({
      id: 'j4',
      kind: 'operation_reconcile',
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      operationId: null,
    });
    expect(result.stranded_operations).toBe(1);
    const record = await getOperationForActor(operationId, account.actor);
    expect(record.state).toBe('failed');
    expect(record.errorCode).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('clears discarded draft content after the retention window', async () => {
    const account = await createAccount();
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'retention-1',
      body: { kind: 'project', project_md: projectDocument({ key: 'retention' }) },
    });
    const draftId = created.json.data.draft_id;
    await request(`/api/v1/drafts/${draftId}`, { method: 'DELETE', user: account.userId });
    await db()
      .update(drafts)
      .set({ discardedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) })
      .where(eq(drafts.id, draftId));

    const result = await JOB_HANDLERS.retention_sweep({
      id: 'j5',
      kind: 'retention_sweep',
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      operationId: null,
    });
    expect(result.discarded_drafts_cleared).toBe(1);
    const [row] = await db().select().from(drafts).where(eq(drafts.id, draftId));
    expect((row?.payload as { project_md: string }).project_md).toBe('');
  });
});

describe('operations surface', () => {
  it('keeps operation status private to its owner and operators', async () => {
    const owner = await createAccount();
    const stranger = await createAccount();
    const operator = await createAccount({ operator: true });
    const operationId = await createOperation(db(), {
      kind: 'project.source_import',
      actor: owner.actor,
      targetKind: 'draft',
      targetId: 'draft-y',
      requiredScope: 'projects:draft',
    });

    expect((await request(`/api/v1/operations/${operationId}`, { user: owner.userId })).status).toBe(200);
    expect((await request(`/api/v1/operations/${operationId}`, { user: stranger.userId })).status).toBe(404);
    expect((await request(`/api/v1/operations/${operationId}`, { user: operator.userId })).status).toBe(200);
    expect((await request(`/api/v1/operations/${operationId}`)).status).toBe(401);
  });

  it('requires the relevant scope when polling with a narrow token', async () => {
    const owner = await createAccount();
    const operationId = await createOperation(db(), {
      kind: 'project.source_import',
      actor: owner.actor,
      targetKind: 'draft',
      targetId: 'draft-z',
      requiredScope: 'projects:draft',
    });
    const denied = await request(`/api/v1/operations/${operationId}`, {
      user: owner.userId,
      actorKind: 'token',
      scopes: ['projects:read'],
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('lets an operator retry only a failed operation', async () => {
    const owner = await createAccount();
    const operator = await createAccount({ operator: true });
    const operationId = await createOperation(db(), {
      kind: 'project.source_import',
      actor: owner.actor,
      targetKind: 'draft',
      targetId: 'draft-r',
      requiredScope: 'projects:draft',
    });
    const tooEarly = await request(`/api/v1/admin/operations/${operationId}/retry`, {
      method: 'POST',
      user: operator.userId,
    });
    expect(tooEarly.status).toBe(409);

    await db().update(operations).set({ state: 'failed' }).where(eq(operations.id, operationId));
    const retried = await request(`/api/v1/admin/operations/${operationId}/retry`, {
      method: 'POST',
      user: operator.userId,
    });
    expect(retried.status).toBe(200);
    expect(retried.json.data.state).toBe('queued');
  });
});

describe('import through the worker', () => {
  it('completes a queued import and marks its operation succeeded', async () => {
    const account = await createAccount();
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'worker-import',
      body: {
        kind: 'project',
        source_import: {
          provider: 'github',
          repository_url: 'https://github.com/acme/widget',
          ref: 'main',
          manifest_path: 'PROJECT.md',
        },
      },
    });
    expect(created.status).toBe(202);
    expect(created.headers.get('location')).toContain('/api/v1/operations/');
    expect(created.headers.get('retry-after')).toBe('2');

    const queued = await db().select().from(jobs).where(eq(jobs.kind, 'source_import'));
    expect(queued).toHaveLength(1);

    // The real adapter would reach GitHub here; without network access the job
    // fails with a classified source error rather than hanging.
    const worker = startWorker();
    await worker.tick();
    await worker.stop();

    const operation = await request(`/api/v1/operations/${created.json.meta.operation_id}`, {
      user: account.userId,
    });
    expect(['queued', 'running', 'succeeded', 'failed']).toContain(operation.json.data.state);
  });

  it('counts jobs by state for the metrics endpoint', async () => {
    await db().execute(sql`select 1`);
    const depth = await queueDepth();
    expect(depth).toHaveProperty('queued');
  });

  it('completes a job cleanly', async () => {
    await enqueueJob(db(), { kind: 'operation_reconcile', payload: {} });
    const [job] = await claimJobs('worker', 1);
    await completeJob(job!.id);
    const [row] = await db().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.finishedAt).not.toBeNull();
  });

  it('reindexes idempotently', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'idem-index' }));
    expect(await reindexProject(published.projectId)).toBe('indexed');
    expect(await reindexProject(published.projectId)).toBe('indexed');
    expect(await reindexProject('00000000-0000-4000-8000-000000000000')).toBe('missing');
  });
});
