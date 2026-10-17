/**
 * Metadata-only job handlers (BACKEND_PRD section 16.3).
 *
 * Jobs: source import, publication indexing, source-drift checks, operation
 * reconciliation, and retention. **No inference or test execution job exists in
 * the hosted queue**, and no handler contacts a user's machine.
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  drafts,
  operations,
  projectVersions,
  sourceDriftChecks,
  sourceReferences,
} from '../../db/schema/registry.js';
import { config } from '../../config.js';
import { createLogger } from '../../observability/logger.js';
import { incrementCounter } from '../../observability/metrics.js';
import { ImportRejected, runDraftImport } from '../../services/import.js';
import { reindexProject } from '../../services/search.js';
import { reaggregateProject } from '../../services/evidence.js';
import { ReportMissing, validateStoredReport } from '../../services/reports.js';
import { pruneIdempotencyRecords } from '../../services/idempotency.js';
import { pruneDispatchedEvents } from '../../services/outbox.js';
import { pruneRateLimits } from '../../http/rate-limit.js';
import { markOperationFailed, markOperationRunning } from '../../services/operations.js';
import type { ClaimedJob, JobKind } from '../../services/jobs.js';
import { RETENTION_POLICY_VERSION } from '../../domain/policy.js';
import { pruneApprovers } from '../../services/approvers.js';

const log = createLogger('worker');

export class JobFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
  }
}

export type JobHandler = (job: ClaimedJob) => Promise<Record<string, unknown>>;

const handleSourceImport: JobHandler = async (job) => {
  const draftId = String(job.payload.draft_id ?? '');
  const generation = Number(job.payload.generation ?? 0);
  if (!draftId || !generation) throw new JobFailure('NOT_FOUND', 'The import payload is incomplete.');
  if (job.operationId) await markOperationRunning(job.operationId);
  try {
    const outcome = await runDraftImport({
      draftId,
      generation,
      operationId: job.operationId,
    });
    incrementCounter(`import.${outcome}`);
    return { draft_id: draftId, outcome };
  } catch (error) {
    if (error instanceof ImportRejected) {
      incrementCounter('import.rejected');
      throw new JobFailure(error.code, error.message);
    }
    throw error;
  }
};

const handlePublicationIndex: JobHandler = async (job) => {
  const projectId = String(job.payload.project_id ?? '');
  if (!projectId) throw new JobFailure('NOT_FOUND', 'The index payload is incomplete.');
  const outcome = await reindexProject(projectId);
  incrementCounter(`index.${outcome}`);
  return { project_id: projectId, outcome };
};

/**
 * Record what is known about an upstream source without rewriting any
 * published fact (section 15.4). Phase 1 does not fetch arbitrary
 * documentation URLs, so an unfetchable source is recorded as `unknown`.
 */
const handleSourceDriftCheck: JobHandler = async (job) => {
  const versionId = String(job.payload.project_version_id ?? '');
  if (!versionId) throw new JobFailure('NOT_FOUND', 'The drift payload is incomplete.');
  const sources = await db()
    .select({
      id: sourceReferences.id,
      kind: sourceReferences.kind,
      url: sourceReferences.url,
      revision: sourceReferences.revision,
      pinned: sourceReferences.pinned,
      providerName: sourceReferences.providerName,
    })
    .from(sourceReferences)
    .where(eq(sourceReferences.projectVersionId, versionId));

  const now = new Date();
  // Poll with jitter so many versions do not line up on one interval.
  const nextCheckAt = new Date(now.getTime() + (24 + Math.random() * 12) * 3600 * 1000);
  let recorded = 0;
  for (const source of sources) {
    const checkable = source.providerName === 'github' && config().features.githubImport;
    await db()
      .insert(sourceDriftChecks)
      .values({
        sourceReferenceId: source.id,
        lastCheckedAt: now,
        observedUpstreamRevision: null,
        pinnedRevisionAvailable: null,
        // An unfetched source is `declared_unverified`, never silently "public".
        sourceVisibility: checkable ? 'declared_unverified' : 'not_checked',
        errorClass: checkable ? null : 'source_not_server_fetchable_in_phase_1',
        nextCheckAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sourceDriftChecks.sourceReferenceId,
        set: {
          lastCheckedAt: now,
          sourceVisibility: checkable ? 'declared_unverified' : 'not_checked',
          errorClass: checkable ? null : 'source_not_server_fetchable_in_phase_1',
          nextCheckAt,
          updatedAt: now,
        },
      });
    recorded += 1;
  }
  return { project_version_id: versionId, sources_recorded: recorded };
};

/** Detect operations stranded by a worker crash or deploy. */
const handleOperationReconcile: JobHandler = async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  const stranded = await db()
    .select({ id: operations.id, kind: operations.kind })
    .from(operations)
    .where(and(eq(operations.state, 'running'), lt(operations.updatedAt, stale)))
    .limit(100);
  for (const operation of stranded) {
    await markOperationFailed(
      operation.id,
      'DEPENDENCY_UNAVAILABLE',
      'The worker handling this operation stopped responding; retry it.',
    );
  }
  // Imports whose draft is stuck in `ingesting` with no live operation.
  const stuck = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.state, 'ingesting'), lt(drafts.updatedAt, stale)))
    .limit(100);
  for (const draft of stuck) {
    await db()
      .update(drafts)
      .set({
        state: 'ingestion_failed',
        importError: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'The import did not complete. Request it again.',
        },
        updatedAt: new Date(),
      })
      .where(eq(drafts.id, draft.id));
  }
  return { stranded_operations: stranded.length, stuck_imports: stuck.length };
};

/** Retention sweep (section 17.5). */
const handleRetentionSweep: JobHandler = async () => {
  await pruneIdempotencyRecords();
  await pruneDispatchedEvents(new Date(Date.now() - 30 * 24 * 3600 * 1000));
  const rateLimits = await pruneRateLimits();
  const approversPruned = await pruneApprovers();

  // Discarded drafts keep 30 days of recoverability, then their content goes.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const cleared = await db()
    .update(drafts)
    .set({ payload: { project_md: '', files: [] }, manifest: null, markdown: null, derived: null })
    .where(
      and(
        eq(drafts.state, 'discarded'),
        lt(drafts.discardedAt, cutoff),
        or(isNull(drafts.markdown), sql`${drafts.markdown} <> ''`),
      ),
    )
    .returning({ id: drafts.id });

  return {
    policy_version: RETENTION_POLICY_VERSION,
    rate_limit_rows_pruned: rateLimits,
    approver_rows_pruned: approversPruned,
    discarded_drafts_cleared: cleared.length,
  };
};

/**
 * Re-validate a stored report with the contracts schemas and recompute its
 * digests against the stored definition. Metadata only; nothing executes.
 */
const handleReportValidation: JobHandler = async (job) => {
  const reportId = String(job.payload.report_id ?? '');
  if (!reportId) throw new JobFailure('NOT_FOUND', 'The validation payload is incomplete.');
  if (job.operationId) await markOperationRunning(job.operationId);
  try {
    const outcome = await validateStoredReport(reportId);
    incrementCounter(`report_validation.${outcome}`);
    return { report_id: reportId, validation: outcome };
  } catch (error) {
    if (error instanceof ReportMissing) throw new JobFailure('NOT_FOUND', error.message);
    throw error;
  }
};

/**
 * Rebuild the accepted-evidence summaries for one project; idempotent. Each
 * evidence change queues its own job, so a burst of reviews on one project
 * queues many; any job enqueued before a rebuild started is already covered
 * by it and stands down instead of rebuilding again.
 */
const handleEvidenceReaggregate: JobHandler = async (job) => {
  const projectId = String(job.payload.project_id ?? '');
  if (!projectId) throw new JobFailure('NOT_FOUND', 'The aggregation payload is incomplete.');
  const outcome = await reaggregateProject(projectId, { unlessRebuiltSince: job.createdAt });
  incrementCounter(outcome.skipped ? 'evidence.reaggregate_skipped' : 'evidence.reaggregated');
  return { project_id: projectId, ...outcome };
};

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  source_import: handleSourceImport,
  publication_index: handlePublicationIndex,
  source_drift_check: handleSourceDriftCheck,
  operation_reconcile: handleOperationReconcile,
  retention_sweep: handleRetentionSweep,
  report_validation: handleReportValidation,
  evidence_reaggregate: handleEvidenceReaggregate,
};

/** Versions whose sources are due for a drift observation. */
export async function dueDriftVersions(limit: number): Promise<string[]> {
  const rows = await db()
    .select({ id: projectVersions.id })
    .from(projectVersions)
    .innerJoin(sourceReferences, eq(sourceReferences.projectVersionId, projectVersions.id))
    .leftJoin(sourceDriftChecks, eq(sourceDriftChecks.sourceReferenceId, sourceReferences.id))
    .where(or(isNull(sourceDriftChecks.nextCheckAt), lt(sourceDriftChecks.nextCheckAt, new Date())))
    .groupBy(projectVersions.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

export { log as workerLog };
