/**
 * Sanitized test results and their review (BACKEND_PRD sections 8.1, 8.4, 9.1,
 * 12.2, 16.3).
 *
 * `POST /test-results` stores a private report and queues metadata validation;
 * it never runs a test. A report is never auto-verified: its review state
 * starts `pending`, its evidence level is `null` until an operator accepts a
 * report whose server checks hold, and `independently_verified` is not
 * reachable here at all.
 */

import { config } from '../config.js';
import { evaluateWorkflowChecks } from '../domain/workflow-evidence.js';
import { workflowTestSchema } from '@localfirst/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  buildReportSchema,
  digestOf,
  ERROR_CODES,
  testManifestSchema,
  anyTestResultSchema,
  type AnyBuildInput,
  type AnyTestResult,
} from '@localfirst/contracts';
import { buildConfigurations, evidenceReviews, runReports } from '../db/schema/evidence.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { encodeCursor, type PageRequest } from '../http/envelope.js';
import {
  evaluateReportChecks,
  EVIDENCE_POLICY_VERSION,
  evidenceLevelOnAcceptance,
  summarizeChecks,
  type ServerCheck,
} from '../domain/evidence.js';
import { lockActiveAccount } from './accounts.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { enqueueJob } from './jobs.js';
import { createOperation } from './operations.js';
import { loadDefinitionById } from './test-definitions.js';
import { loadVisibleProject } from './projects.js';
import {
  asBuild,
  asReport,
  loadContributionTarget,
  loadOwnedBuild,
  prepareBuild,
  saveBuildInTx,
  serializeReportStatus,
  submitterHandle,
  type BuildRecord,
  type ReportRecord,
} from './builds.js';

export interface SubmitResultInput {
  actor: Actor;
  result: AnyTestResult;
  /** An existing owned build, or an inline build to save in the same transaction. */
  buildId?: string | undefined;
  build?: AnyBuildInput | undefined;
}

export interface SubmitResultOutcome {
  report: ReportRecord;
  build: BuildRecord;
  created: boolean;
  buildCreated: boolean;
}

/** Hard request-time bindings; digest and eligibility checks run in the job. */
export async function submitTestResult(input: SubmitResultInput): Promise<SubmitResultOutcome> {
  const { actor, result } = input;
  if (result.schema === 'localfirst/test-result/v0.2' && !config().features.workflowResults) throw ApiError.phaseUnavailable('Workflow result submission');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const owner = actor.userId;

  const target = await loadContributionTarget(actor, result.project_id, result.project_version_id);
  const definition = await loadDefinitionById(result.test_definition_id);
  const bindingIssues: Array<{ pointer: string; message: string }> = [];
  if (!definition || definition.projectVersionId !== target.version.id || definition.projectId !== target.projectId) {
    bindingIssues.push({
      pointer: '/test_definition_id',
      message: 'This test definition does not belong to the named project version.',
    });
  } else if ((result.schema === 'localfirst/test-result/v0.2') !== (definition.harness === 'declarative_workflow_v1')) {
    bindingIssues.push({ pointer: '/schema', message: 'Result version/harness does not match the test definition.' });
  } else if (definition.key !== result.test_key) {
    bindingIssues.push({ pointer: '/test_key', message: 'The test key does not match the test definition.' });
  }
  if (bindingIssues.length > 0) throw ApiError.validationFailed(bindingIssues);

  let prepared: Awaited<ReturnType<typeof prepareBuild>> | null = null;
  if (input.build) {
    if ((input.build.schema === 'localfirst/build/v0.2') !== (result.schema === 'localfirst/test-result/v0.2')) throw ApiError.validationFailed([{ pointer: '/build/schema', message: 'Build and result versions must match.' }]);
    if (input.build.project_version_id !== result.project_version_id || input.build.project_id !== result.project_id) {
      throw ApiError.validationFailed([
        { pointer: '/build/project_version_id', message: 'The inline build must belong to the same project version as the result.' },
      ]);
    }
    prepared = await prepareBuild(actor, input.build);
  } else {
    const owned = await loadOwnedBuild(actor, input.buildId ?? result.build_id);
    if ((owned.payload.schema === 'localfirst/build/v0.2') !== (result.schema === 'localfirst/test-result/v0.2')) throw ApiError.validationFailed([{ pointer: '/build_id', message: 'Build and result versions must match.' }]);
    if (owned.projectVersionId !== result.project_version_id) {
      throw ApiError.validationFailed([
        { pointer: '/build_id', message: 'The build belongs to a different project version than the result.' },
      ]);
    }
    if (owned.visibility === 'withdrawn') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'A withdrawn build cannot receive new reports.',
      });
    }
    if (input.buildId && input.buildId !== result.build_id) {
      throw ApiError.validationFailed([
        { pointer: '/result/build_id', message: 'The result names a different build than the one referenced.' },
      ]);
    }
  }

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, owner);
    let build: BuildRecord;
    let buildCreated = false;
    let buildRef: string;
    if (input.build && prepared) {
      const saved = await saveBuildInTx(tx, actor, input.build, prepared);
      build = saved.build;
      buildCreated = saved.created;
      buildRef = prepared.contentDigest;
    } else {
      build = await loadOwnedBuild(actor, input.buildId ?? result.build_id, tx);
      buildRef = build.id;
    }

    // The stored report always names the real build, never a placeholder.
    const stored: AnyTestResult = { ...result, build_id: build.id };
    const { client_run_id: _id, ...content } = stored;
    void _id;
    const requestDigest = digestOf({ build: buildRef, result });
    const contentDigest = digestOf({ build_id: build.id, result: content });

    const inserted = await tx
      .insert(runReports)
      .values({
        kind: 'test_run',
        submitterUserId: owner,
        clientRunId: result.client_run_id,
        requestDigest,
        contentDigest,
        projectId: target.projectId,
        projectVersionId: target.version.id,
        buildId: build.id,
        testDefinitionId: result.test_definition_id,
        payload: stored,
        outcome: result.outcome,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) {
      const report = asReport(inserted[0]);
      const operationId = await createOperation(tx, {
        kind: 'report.validate',
        actor,
        targetKind: 'run_report',
        targetId: report.id,
        requiredScope: 'tests:submit',
      });
      await tx.update(runReports).set({ operationId }).where(eq(runReports.id, report.id));
      await enqueueJob(tx, {
        kind: 'report_validation',
        payload: { report_id: report.id },
        dedupeKey: `report_validation:${report.id}`,
        operationId,
      });
      await writeAudit(tx, actor, {
        action: 'report.submitted',
        targetKind: 'run_report',
        targetId: report.id,
        metadata: {
          kind: 'test_run',
          project_id: report.projectId,
          build_id: build.id,
          test_definition_id: result.test_definition_id,
          content_digest: contentDigest,
        },
      });
      return {
        report: asReport({ ...inserted[0], operationId }),
        build,
        created: true,
        buildCreated,
      };
    }

    // The unique run ID or unique content already exists: replay or conflict.
    const [existing] = await tx
      .select()
      .from(runReports)
      .where(and(eq(runReports.submitterUserId, owner), eq(runReports.clientRunId, result.client_run_id)))
      .limit(1);
    if (existing && existing.requestDigest === requestDigest) {
      return { report: asReport(existing), build, created: false, buildCreated };
    }
    if (existing) {
      throw new ApiError({
        code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
        message: 'This client run ID was already used with different content.',
        details: { client_run_id: result.client_run_id },
      });
    }
    throw new ApiError({
      code: ERROR_CODES.DUPLICATE_CONTENT,
      message: 'A report with exactly this content was already submitted under another run ID.',
    });
  });
}

// --------------------------------------------------------------------------
// Reads and withdrawal
// --------------------------------------------------------------------------

export type ReportAccess = { record: ReportRecord; owner: boolean };

/** A public report is readable by anyone; otherwise only its owner, else 404. */
export async function loadReadableReport(
  actor: Actor,
  id: string,
  conn: DbOrTx = db(),
): Promise<ReportAccess> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound();
  const [row] = await conn.select().from(runReports).where(eq(runReports.id, id)).limit(1);
  if (!row) throw ApiError.notFound();
  const record = asReport(row);
  if (record.visibility === 'public') {
    const owner = actor.kind !== 'anonymous' && actor.userId === record.submitterUserId;
    // Hidden or quarantined content is excluded at read time, even by direct ID.
    if (!owner) await loadVisibleProject({ id: record.projectId }, actor);
    return { record, owner };
  }
  if (actor.kind === 'anonymous' || actor.userId !== record.submitterUserId) throw ApiError.notFound();
  const required = record.kind === 'test_run' ? 'tests:submit' : 'builds:write';
  if (!actor.scopes.has(required)) throw ApiError.insufficientScope([required]);
  return { record, owner: true };
}

export async function loadOwnedReport(
  actor: Actor,
  id: string,
  conn: DbOrTx = db(),
): Promise<ReportRecord> {
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound();
  const [row] = await conn.select().from(runReports).where(eq(runReports.id, id)).limit(1);
  if (!row || row.submitterUserId !== actor.userId) throw ApiError.notFound();
  return asReport(row);
}

export function serializeOwnerReport(report: ReportRecord): Record<string, unknown> {
  return {
    ...serializeReportStatus(report),
    project_id: report.projectId,
    project_version_id: report.projectVersionId,
    build_id: report.buildId,
    test_definition_id: report.testDefinitionId,
    client_run_id: report.clientRunId,
    payload: report.payload,
    validation: report.validation,
    public_projection_digest: report.publicProjectionDigest,
    published_at: report.publishedAt?.toISOString() ?? null,
    withdrawn_at: report.withdrawnAt?.toISOString() ?? null,
    updated_at: report.updatedAt.toISOString(),
    // Review state, evidence level, outcome, and visibility stay separate.
    evidence_note: evidenceNote(report),
  };
}

export function serializePublicReport(report: ReportRecord, handle: string | null): Record<string, unknown> {
  return {
    ...(report.publicProjection ?? {}),
    report_id: report.id,
    kind: report.kind,
    outcome: report.outcome,
    review_state: report.reviewState,
    evidence_level: report.evidenceLevel,
    visibility: 'public',
    submitted_by: { handle },
    published_at: report.publishedAt?.toISOString() ?? null,
    public_projection_digest: report.publicProjectionDigest,
    evidence_note: evidenceNote(report),
  };
}

function evidenceNote(report: ReportRecord): string {
  if (report.reviewState === 'accepted' && report.evidenceLevel) {
    return report.kind === 'manual_build'
      ? 'An accepted manual report is a community report; it is never reproducible or independently verified evidence.'
      : report.evidenceLevel === 'reproducible_test'
        ? 'Accepted component-scope evidence for the named build and test; it does not establish offline use or whole-project behavior.'
        : 'Accepted as a community report; a server check for reproducibility did not hold.';
  }
  if (report.reviewState === 'pending') return 'Pending review: excluded from accepted compatibility evidence.';
  if (report.reviewState === 'rejected') return 'Rejected on review: excluded from accepted compatibility evidence.';
  return 'Withdrawn: excluded from compatibility evidence.';
}

export async function withdrawReport(actor: Actor, id: string): Promise<ReportRecord> {
  const owned = await loadOwnedReport(actor, id);
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, owned.submitterUserId);
    const [locked] = await tx.select().from(runReports).where(eq(runReports.id, id)).for('update');
    if (!locked) throw ApiError.notFound();
    if (locked.visibility === 'withdrawn') return asReport(locked);
    const withdrawnAt = new Date();
    const [updated] = await tx
      .update(runReports)
      .set({
        visibility: 'withdrawn',
        reviewState: 'withdrawn',
        evidenceLevel: null,
        withdrawnAt,
        updatedAt: withdrawnAt,
      })
      .where(eq(runReports.id, id))
      .returning();
    await emitEvent(tx, {
      eventType: 'evidence.changed',
      aggregateKind: 'project',
      aggregateId: locked.projectId,
      payload: { cause: 'report.withdrawn', report_id: id },
    });
    await writeAudit(tx, actor, {
      action: 'report.withdrawn',
      targetKind: 'run_report',
      targetId: id,
      metadata: { project_id: locked.projectId, kind: locked.kind },
    });
    return asReport(updated);
  });
}

export type ReviewFilter = 'accepted' | 'pending' | 'rejected' | 'all';

export async function listPublicReports(
  projectId: string,
  filter: { kind: 'test_run' | 'manual_build' | 'all'; review: ReviewFilter },
  page: PageRequest,
  bound: string,
): Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string | null }> {
  const conditions = [eq(runReports.projectId, projectId), eq(runReports.visibility, 'public')];
  if (filter.kind !== 'all') conditions.push(eq(runReports.kind, filter.kind));
  if (filter.review !== 'all') conditions.push(eq(runReports.reviewState, filter.review));
  if (page.cursor && page.cursor.values.length === 2) {
    const [publishedAt, id] = page.cursor.values as [string, string];
    conditions.push(sql`(${runReports.publishedAt}, ${runReports.id}) < (${new Date(publishedAt)}, ${id})` as never);
  }
  const rows = await db()
    .select()
    .from(runReports)
    .where(and(...conditions))
    .orderBy(desc(runReports.publishedAt), desc(runReports.id))
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const items = rows.slice(0, page.limit).map(asReport);
  const out: Array<Record<string, unknown>> = [];
  for (const report of items) {
    out.push(serializePublicReport(report, await submitterHandle(report.submitterUserId)));
  }
  const last = items.at(-1);
  return {
    items: out,
    hasMore,
    nextCursor:
      hasMore && last?.publishedAt ? encodeCursor(bound, [last.publishedAt.toISOString(), last.id]) : null,
  };
}

// --------------------------------------------------------------------------
// Metadata validation (worker job)
// --------------------------------------------------------------------------

export type ValidationOutcome = 'valid' | 'invalid' | 'skipped';

/**
 * Re-validate a stored report with the contracts schemas and recompute its
 * digests against the stored definition. Pure metadata work: nothing executes,
 * nothing is fetched. Safe to run repeatedly; the result is a function of the
 * stored rows.
 */
export async function validateStoredReport(reportId: string): Promise<ValidationOutcome> {
  const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId)).limit(1);
  if (!row) throw new ReportMissing();
  const report = asReport(row);
  if (report.visibility === 'withdrawn') return 'skipped';

  const [buildRow] = await db()
    .select()
    .from(buildConfigurations)
    .where(eq(buildConfigurations.id, report.buildId))
    .limit(1);
  const build = buildRow ? asBuild(buildRow) : null;

  let checks: ServerCheck[] = [];
  if (report.kind === 'manual_build') {
    const parsed = buildReportSchema.safeParse(report.payload);
    checks = [
      { code: 'schema_valid', kind: 'integrity', status: parsed.success ? 'pass' : 'fail' },
      {
        code: 'build_bound',
        kind: 'integrity',
        status: build && build.ownerUserId === report.submitterUserId ? 'pass' : 'fail',
      },
    ];
  } else {
    const parsed = anyTestResultSchema.safeParse(report.payload);
    const definition = report.testDefinitionId ? await loadDefinitionById(report.testDefinitionId) : null;
    const manifest = definition ? testManifestSchema.safeParse(definition.manifest) : null;
    const workflow = definition ? workflowTestSchema.safeParse(definition.manifest) : null;
    if (parsed.success && parsed.data.schema === 'localfirst/test-result/v0.2' && definition && workflow?.success && build) {
      checks = await evaluateWorkflowChecks(parsed.data, workflow.data, definition, build, report.submitterUserId);
    } else if (!parsed.success || !definition || !manifest?.success || !build) {
      checks = [
        { code: 'schema_valid', kind: 'integrity', status: parsed.success ? 'pass' : 'fail' },
        { code: 'definition_present', kind: 'integrity', status: definition && manifest?.success ? 'pass' : 'fail' },
        { code: 'build_present', kind: 'integrity', status: build ? 'pass' : 'fail' },
      ];
    } else {
      checks = [
        { code: 'schema_valid', kind: 'integrity', status: 'pass' },
        ...evaluateReportChecks({
          result: parsed.data,
          manifest: manifest.data,
          definition,
          build: {
            id: build.id,
            ownerUserId: build.ownerUserId,
            projectId: build.projectId,
            projectVersionId: build.projectVersionId,
            configurationKey: build.configurationKey,
            reproducibility: build.reproducibility,
            payload: build.payload,
          },
          submitterUserId: report.submitterUserId,
        }),
      ];
    }
  }

  const eligibility = summarizeChecks(checks);
  await db()
    .update(runReports)
    .set({
      validationState: eligibility.valid ? 'valid' : 'invalid',
      validation: {
        policy_version: EVIDENCE_POLICY_VERSION,
        checks,
        eligibility: {
          candidate_level: eligibility.candidateLevel,
          failed_integrity: eligibility.failedIntegrity,
          failed_eligibility: eligibility.failedEligibility,
        },
      },
      updatedAt: new Date(),
    })
    .where(and(eq(runReports.id, reportId), sql`${runReports.visibility} <> 'withdrawn'`));
  return eligibility.valid ? 'valid' : 'invalid';
}

export class ReportMissing extends Error {
  constructor() {
    super('The report no longer exists.');
    this.name = 'ReportMissing';
  }
}

// --------------------------------------------------------------------------
// Operator review
// --------------------------------------------------------------------------

export const REVIEW_REASON_CODES = [
  'accepted_as_reported',
  'accepted_checks_incomplete',
  'rejected_unverifiable',
  'rejected_inconsistent',
  'rejected_not_applicable',
  'rejected_abusive',
] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export interface ReviewInput {
  actor: Actor;
  reportId: string;
  decision: 'accepted' | 'rejected';
  reasonCode: ReviewReasonCode;
  note: string | null;
}

/**
 * Operator decision on a published report. Acceptance assigns the evidence
 * level the server derives from its own checks; the reviewer cannot choose it,
 * and cannot review their own report.
 */
export async function reviewReport(input: ReviewInput): Promise<{
  report: ReportRecord;
  evidenceLevel: ReportRecord['evidenceLevel'];
}> {
  const { actor } = input;
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  return db().transaction(async (tx) => {
    const [locked] = await tx.select().from(runReports).where(eq(runReports.id, input.reportId)).for('update');
    if (!locked) throw ApiError.notFound();
    const report = asReport(locked);
    if (report.submitterUserId === actor.userId) {
      throw ApiError.forbidden('Reviewers cannot review their own reports.');
    }
    if (report.visibility !== 'public') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'Only a report its owner published after approving the exact contribution can be reviewed.',
        details: { visibility: report.visibility },
      });
    }
    if (report.validationState !== 'valid' && input.decision === 'accepted') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'Only a report whose server validation passed can be accepted.',
        details: { validation_state: report.validationState },
      });
    }

    const checks = (report.validation.checks ?? []) as ServerCheck[];
    const eligibility = summarizeChecks(checks);
    const level =
      input.decision === 'accepted' ? evidenceLevelOnAcceptance(report.kind, eligibility) : null;

    const [updated] = await tx
      .update(runReports)
      .set({
        reviewState: input.decision,
        evidenceLevel: level,
        updatedAt: new Date(),
      })
      .where(eq(runReports.id, report.id))
      .returning();
    await tx.insert(evidenceReviews).values({
      runReportId: report.id,
      reviewerUserId: actor.userId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      note: input.note,
      evidenceLevel: level,
      serverChecks: { checks, eligibility: { failed_integrity: eligibility.failedIntegrity, failed_eligibility: eligibility.failedEligibility } },
      policyVersion: EVIDENCE_POLICY_VERSION,
    });
    await emitEvent(tx, {
      eventType: 'evidence.changed',
      aggregateKind: 'project',
      aggregateId: report.projectId,
      payload: { cause: 'report.reviewed', report_id: report.id, decision: input.decision },
    });
    await writeAudit(tx, actor, {
      action: `report.${input.decision}`,
      targetKind: 'run_report',
      targetId: report.id,
      reason: input.reasonCode,
      policyVersion: EVIDENCE_POLICY_VERSION,
      metadata: {
        project_id: report.projectId,
        kind: report.kind,
        evidence_level: level,
      },
    });
    return { report: asReport(updated), evidenceLevel: level };
  });
}
