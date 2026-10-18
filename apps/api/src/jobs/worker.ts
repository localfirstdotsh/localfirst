/**
 * Metadata worker (BACKEND_PRD sections 16.3, 19.4).
 *
 * Leases jobs with `for update skip locked`, dispatches outbox events, retries
 * transient failures with capped backoff, reclaims expired leases, and shuts
 * down gracefully. Duplicate delivery is expected, so every handler is
 * idempotent.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { closeDatabase, db, getPool } from '../db/client.js';
import { migrationStatus, type MigrationStatus } from '../db/migration-status.js';
import { createLogger } from '../observability/logger.js';
import { incrementCounter } from '../observability/metrics.js';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueJobs,
  failJob,
  reclaimExpiredLeases,
  type ClaimedJob,
  type EnqueueInput,
} from '../services/jobs.js';
import {
  lockPendingEvents,
  markAllDispatched,
  markDispatchFailed,
  markDispatched,
  pendingEvents,
  type PendingEvent,
} from '../services/outbox.js';
import { markOperationFailed, markOperationSucceeded } from '../services/operations.js';
import { dueDriftVersions, JOB_HANDLERS, JobFailure } from './handlers/index.js';

const log = createLogger('worker');

export interface WorkerHandle {
  stop: () => Promise<void>;
  /** Run exactly one poll cycle; used by tests. */
  tick: () => Promise<number>;
}

async function runJob(job: ClaimedJob): Promise<void> {
  const handler = JOB_HANDLERS[job.kind];
  if (!handler) {
    await failJob(job, 'NOT_FOUND', `No handler is registered for job kind \`${job.kind}\`.`);
    return;
  }
  const startedAt = Date.now();
  try {
    const result = await handler(job);
    await completeJob(job.id);
    if (job.operationId) await markOperationSucceeded(job.operationId, result);
    incrementCounter(`job.${job.kind}.succeeded`);
    log.info(
      { job_id: job.id, kind: job.kind, attempts: job.attempts, latency_ms: Date.now() - startedAt },
      'job completed',
    );
  } catch (error) {
    const code = error instanceof JobFailure ? error.code : 'INTERNAL';
    const message = error instanceof Error ? error.message : 'The job failed.';
    const outcome = await failJob(job, code, message);
    if (outcome === 'failed' && job.operationId) {
      await markOperationFailed(job.operationId, code, message.slice(0, 500));
    }
    incrementCounter(`job.${job.kind}.${outcome}`);
    log.warn(
      {
        job_id: job.id,
        kind: job.kind,
        attempts: job.attempts,
        error_code: code,
        outcome,
      },
      'job failed',
    );
  }
}

/** The jobs an outbox event asks for. Events with no job are still marked dispatched. */
function jobsFor(event: PendingEvent): EnqueueInput[] {
  if (
    event.eventType === 'project.published' ||
    event.eventType === 'project.restored' ||
    event.eventType === 'project.visibility_changed' ||
    event.eventType === 'project.quarantined'
  ) {
    return [
      {
        kind: 'publication_index',
        payload: { project_id: event.aggregateId },
        dedupeKey: `publication_index:${event.aggregateId}:${event.id}`,
      },
    ];
  }
  if (event.eventType === 'evidence.changed') {
    // One job per event: a recomputation already running cannot swallow a later change.
    return [
      {
        kind: 'evidence_reaggregate',
        payload: { project_id: event.aggregateId },
        dedupeKey: `evidence_reaggregate:${event.aggregateId}:${event.id}`,
      },
    ];
  }
  return [];
}

/** Events taken per cycle. One transaction and three statements cover a whole batch. */
export const DISPATCH_BATCH = 100;

/**
 * Deliver durable outbox events; duplicate delivery is safe. The batch is
 * claimed with `for update skip locked`, so concurrent workers split the
 * backlog instead of repeating it. If the batch fails as a whole, events are
 * delivered one at a time so a single bad event cannot hold up the rest.
 */
async function dispatchEvents(limit: number): Promise<number> {
  try {
    return await db().transaction(async (tx) => {
      const events = await lockPendingEvents(tx, limit);
      await enqueueJobs(tx, events.flatMap(jobsFor));
      await markAllDispatched(tx, events.map((event) => event.id));
      for (const event of events) incrementCounter(`outbox.${event.eventType}`);
      return events.length;
    });
  } catch (error) {
    log.warn(failureFields(error), 'batch dispatch failed; delivering events one at a time');
  }
  const events = await pendingEvents(limit);
  for (const event of events) {
    try {
      await enqueueJobs(db(), jobsFor(event));
      await markDispatched(event.id);
      incrementCounter(`outbox.${event.eventType}`);
    } catch (error) {
      await markDispatchFailed(event.id, (error as Error)?.name ?? 'unknown');
      log.warn({ event_id: event.id, event_type: event.eventType }, 'event dispatch failed');
    }
  }
  return events.length;
}

/**
 * One poll cycle as a closure: dispatch outbox events, run due jobs, and do
 * periodic maintenance. Exposed separately from the polling loop so tests and
 * one-shot drains can run cycles without a background loop or closing the
 * shared database pool.
 */
export function createWorkerCycle(owner = `worker-${randomUUID()}`): () => Promise<number> {
  const cfg = config();
  let maintenanceAt = 0;

  return async (): Promise<number> => {
    let handled = 0;
    handled += await dispatchEvents(DISPATCH_BATCH);
    const jobs = await claimJobs(owner, cfg.worker.concurrency);
    await Promise.all(jobs.map((job) => runJob(job)));
    handled += jobs.length;

    if (Date.now() - maintenanceAt > 60_000) {
      maintenanceAt = Date.now();
      const reclaimed = await reclaimExpiredLeases();
      if (reclaimed > 0) log.warn({ reclaimed }, 'expired job leases returned to the queue');
      await enqueueJob(db(), {
        kind: 'operation_reconcile',
        payload: {},
        dedupeKey: 'operation_reconcile',
      });
      await enqueueJob(db(), {
        kind: 'retention_sweep',
        payload: {},
        dedupeKey: 'retention_sweep',
        runAt: new Date(Date.now() + 3600_000),
      });
      for (const versionId of await dueDriftVersions(10)) {
        await enqueueJob(db(), {
          kind: 'source_drift_check',
          payload: { project_version_id: versionId },
          dedupeKey: `source_drift_check:${versionId}:${Math.floor(Date.now() / 3600_000)}`,
        });
      }
    }
    return handled;
  };
}

/**
 * Log fields for a failure: the error class plus, for a database error, its
 * SQLSTATE, table, and constraint. Never the message, which can carry values.
 */
export function failureFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = { error_class: (error as Error)?.name ?? 'unknown' };
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const pg = candidate as { code?: unknown; table?: unknown; constraint?: unknown } | undefined;
    if (typeof pg?.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
      fields.error_code = pg.code;
      if (typeof pg.table === 'string') fields.table = pg.table;
      if (typeof pg.constraint === 'string') fields.constraint = pg.constraint;
      break;
    }
  }
  return fields;
}

/**
 * Wait until every migration bundled with this build is applied. The host
 * deploys the worker independently of the API's pre-deploy migration step, so
 * new worker code can start before the schema it expects exists. Returns false
 * if the worker is stopped while waiting.
 */
export async function waitForSchema(
  status: () => Promise<MigrationStatus>,
  options: { isRunning: () => boolean; intervalMs: number; logEvery?: number },
): Promise<boolean> {
  const logEvery = options.logEvery ?? 15;
  for (let attempt = 0; options.isRunning(); attempt += 1) {
    try {
      const current = await status();
      if (current.current) {
        if (attempt > 0) log.info({ applied: current.applied, expected: current.expected }, 'schema current; starting');
        return true;
      }
      if (attempt % logEvery === 0) {
        log.warn({ applied: current.applied, expected: current.expected }, 'waiting for migrations before processing jobs');
      }
    } catch (error) {
      if (attempt % logEvery === 0) log.warn(failureFields(error), 'migration status unavailable; retrying');
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  return false;
}

export function startWorker(): WorkerHandle {
  const owner = `worker-${randomUUID()}`;
  const cfg = config();
  let running = true;
  const tick = createWorkerCycle(owner);

  const loop = async (): Promise<void> => {
    log.info({ owner, concurrency: cfg.worker.concurrency }, 'worker started');
    const ready = await waitForSchema(() => migrationStatus(getPool()), {
      isRunning: () => running,
      intervalMs: Math.max(cfg.worker.pollIntervalMs, 2000),
    });
    while (running && ready) {
      try {
        const handled = await tick();
        if (handled === 0) {
          await new Promise((resolve) => setTimeout(resolve, cfg.worker.pollIntervalMs));
        }
      } catch (error) {
        log.error(failureFields(error), 'worker cycle failed');
        await new Promise((resolve) => setTimeout(resolve, cfg.worker.pollIntervalMs));
      }
    }
    log.info({ owner }, 'worker stopped');
  };

  const task = loop();

  return {
    tick,
    stop: async () => {
      running = false;
      await task;
      await closeDatabase();
    },
  };
}

const isEntryPoint = process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js');
if (isEntryPoint) {
  const handle = startWorker();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void handle.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
