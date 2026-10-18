/**
 * PostgreSQL-backed job queue with leases (BACKEND_PRD section 16.3).
 *
 * Jobs are metadata only: source import, publication indexing, source-drift
 * checks, operation reconciliation, and retention. **There is no inference or
 * test execution job in the hosted queue.**
 */

import { eq, sql } from 'drizzle-orm';
import { jobs } from '../db/schema/registry.js';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';
import { config } from '../config.js';

export type JobKind =
  | 'source_import'
  | 'publication_index'
  | 'source_drift_check'
  | 'operation_reconcile'
  | 'retention_sweep'
  | 'report_validation'
  | 'evidence_reaggregate';

/** Errors that must not be retried automatically (section 16.3). */
export const TERMINAL_ERROR_CODES = new Set([
  'VALIDATION_FAILED',
  'SOURCE_NOT_ALLOWED',
  'SOURCE_TOO_LARGE',
  'NOT_FOUND',
  'INVALID_LIFECYCLE',
  'PROHIBITED_SOURCE',
  'STALE_GENERATION',
]);

export interface EnqueueInput {
  kind: JobKind;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  operationId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(tx: DbOrTx, input: EnqueueInput): Promise<string | null> {
  const rows = await tx
    .insert(jobs)
    .values({
      kind: input.kind,
      payload: input.payload,
      dedupeKey: input.dedupeKey ?? null,
      operationId: input.operationId ?? null,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? config().worker.maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

/** Insert many jobs in one statement; rows whose dedupe key already exists are skipped. */
export async function enqueueJobs(tx: DbOrTx, inputs: EnqueueInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await tx
    .insert(jobs)
    .values(
      inputs.map((input) => ({
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey ?? null,
        operationId: input.operationId ?? null,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? config().worker.maxAttempts,
      })),
    )
    .onConflictDoNothing();
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  operationId: string | null;
  /** Database time the job was enqueued, as text at full precision. */
  createdAt: string;
}

/**
 * Claim due jobs with `for update skip locked` and a lease, so a crashed worker
 * releases its work instead of stranding it.
 */
export async function claimJobs(owner: string, limit: number, leaseSeconds = 120): Promise<ClaimedJob[]> {
  const result = await db().execute<Record<string, unknown>>(sql`
    with claimed as (
      select id from jobs
      where state = 'queued' and run_at <= now()
      order by run_at asc
      limit ${limit}
      for update skip locked
    )
    update jobs
    set state = 'running',
        attempts = jobs.attempts + 1,
        lease_owner = ${owner},
        lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
        updated_at = now()
    where id in (select id from claimed)
    returning id, kind, payload, attempts, max_attempts as "maxAttempts", operation_id as "operationId", created_at::text as "createdAt"
  `);
  return (result.rows ?? result) as unknown as ClaimedJob[];
}

export async function completeJob(id: string): Promise<void> {
  await db()
    .update(jobs)
    .set({ state: 'succeeded', finishedAt: new Date(), updatedAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
    .where(eq(jobs.id, id));
}

/**
 * Transient failures back off exponentially with jitter, capped at 15 minutes.
 * Terminal errors stop immediately instead of burning attempts.
 */
export async function failJob(
  job: ClaimedJob,
  errorCode: string,
  errorMessage: string,
): Promise<'retrying' | 'failed'> {
  const terminal = TERMINAL_ERROR_CODES.has(errorCode) || job.attempts >= job.maxAttempts;
  if (terminal) {
    await db()
      .update(jobs)
      .set({
        state: 'failed',
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
        updatedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(jobs.id, job.id));
    return 'failed';
  }
  const backoffSeconds = Math.min(15 * 60, 2 ** job.attempts * 5);
  const jitter = Math.floor(Math.random() * Math.min(30, backoffSeconds));
  await db()
    .update(jobs)
    .set({
      state: 'queued',
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage.slice(0, 500),
      runAt: new Date(Date.now() + (backoffSeconds + jitter) * 1000),
      updatedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(jobs.id, job.id));
  return 'retrying';
}

/** Return jobs whose lease expired to the queue (worker crash or deploy). */
export async function reclaimExpiredLeases(): Promise<number> {
  const result = await db().execute<{ count: string }>(sql`
    with reclaimed as (
      update jobs set state = 'queued', lease_owner = null, lease_expires_at = null, updated_at = now()
      where state = 'running' and lease_expires_at is not null and lease_expires_at < now()
      returning 1
    )
    select count(*)::text as count from reclaimed
  `);
  const row = (result.rows ?? result)[0] as { count: string } | undefined;
  return Number(row?.count ?? '0');
}

export async function queueDepth(): Promise<{ queued: number; running: number; failed: number }> {
  const result = await db().execute<{ state: string; count: string }>(
    sql`select state, count(*)::text as count from jobs group by state`,
  );
  const rows = (result.rows ?? result) as Array<{ state: string; count: string }>;
  const byState = new Map(rows.map((row) => [row.state, Number(row.count)]));
  return {
    queued: byState.get('queued') ?? 0,
    running: byState.get('running') ?? 0,
    failed: byState.get('failed') ?? 0,
  };
}
