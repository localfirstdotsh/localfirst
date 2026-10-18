import type { AnyBuildPayload } from '@localfirst/contracts';
/**
 * Saved builds and their optional manual reports (BACKEND_PRD sections 6, 8.4,
 * 12.2, 14.2).
 *
 * A build is private, immutable configuration content. The same owner saving
 * the same content gets the same build back, so a retry never creates a second
 * record. Visibility changes only through the exact-artifact publication
 * approval flow or an explicit withdrawal; there is no code path here that
 * publishes, verifies, or classifies evidence on a caller's say-so.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  BUILD_REPORT_SCHEMA_ID,
  digestOf,
  ERROR_CODES,
  type AnyBuildInput,
  type BuildReport,
} from '@localfirst/contracts';
import { userProfiles } from '../db/schema/registry.js';
import { buildConfigurations, runReports } from '../db/schema/evidence.js';
import { db, type DbOrTx, type Transaction } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { encodeCursor, type PageRequest } from '../http/envelope.js';
import { config } from '../config.js';
import {
  buildContentPayload,
  buildFingerprint,
  classifyReproducibility,
  type Reproducibility,
} from '../domain/evidence.js';
import { lockActiveAccount } from './accounts.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { enqueueJob } from './jobs.js';
import { createOperation } from './operations.js';
import { loadVersion, loadVisibleProject, type VersionDetail } from './projects.js';

export type StoredBuildPayload = AnyBuildPayload;

export interface BuildRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  projectVersionId: string;
  configurationKey: string;
  payload: StoredBuildPayload;
  contentDigest: string;
  fingerprint: string;
  reproducibility: Reproducibility;
  visibility: 'private' | 'public' | 'withdrawn';
  publicProjection: Record<string, unknown> | null;
  publicProjectionDigest: string | null;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
  parentBuildId: string | null;
  createdAt: Date;
}

export interface ReportRecord {
  id: string;
  kind: 'manual_build' | 'test_run';
  submitterUserId: string;
  clientRunId: string;
  requestDigest: string;
  contentDigest: string;
  projectId: string;
  projectVersionId: string;
  buildId: string;
  testDefinitionId: string | null;
  payload: Record<string, unknown>;
  outcome: string;
  validationState: 'pending' | 'valid' | 'invalid';
  validation: { checks?: Array<{ code: string; status: string; kind: string }>; eligibility?: Record<string, unknown> };
  reviewState: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  evidenceLevel: 'community_reported' | 'reproducible_test' | null;
  visibility: 'private' | 'public' | 'withdrawn';
  publicProjection: Record<string, unknown> | null;
  publicProjectionDigest: string | null;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const asBuild = (row: unknown): BuildRecord => row as BuildRecord;
export const asReport = (row: unknown): ReportRecord => row as ReportRecord;

/** A published project version the caller may attach evidence to. */
export async function loadContributionTarget(
  actor: Actor,
  projectId: string,
  versionId: string,
): Promise<{ projectId: string; version: VersionDetail }> {
  const project = await loadVisibleProject({ id: projectId }, actor);
  // Evidence attaches to public registry content only.
  if (project.visibility !== 'published') throw ApiError.notFound();
  const version = await loadVersion(project.id, versionId);
  return { projectId: project.id, version };
}

/** Registry-side checks a build must pass beyond its own schema. */
export function validateBuildAgainstVersion(
  input: AnyBuildInput,
  version: VersionDetail,
): Array<{ pointer: string; message: string }> {
  const issues: Array<{ pointer: string; message: string }> = [];
  const spec = version.manifest;
  if (!spec.configurations.some((entry) => entry.key === input.configuration_key)) {
    issues.push({
      pointer: '/configuration_key',
      message: `Configuration \`${input.configuration_key}\` is not declared by this project version.`,
    });
  }
  if (spec.models.state === 'declared') {
    const declared = new Set(spec.models.roles.map((role) => role.key));
    input.model_bindings.forEach((binding, index) => {
      if (!declared.has(binding.role)) {
        issues.push({
          pointer: `/model_bindings/${index}/role`,
          message: `Model role \`${binding.role}\` is not declared by this project version.`,
        });
      }
    });
  }
  const accepted = new Set([version.contentDigest, digestOf(version.manifest)]);
  if (!accepted.has(input.source.project_manifest_digest)) {
    issues.push({
      pointer: '/source/project_manifest_digest',
      message: 'The project digest does not match the named version; the source may have drifted.',
    });
  }
  if (input.schema === 'localfirst/build/v0.2' && (spec.schema !== 'localfirst/project/v0.3' || !spec.environments.some(e => e.key === input.workflow.environment_key && e.digest === input.workflow.environment_digest))) issues.push({ pointer: '/workflow/environment_digest', message: 'Workflow environment is not declared by this version.' });
  return issues;
}

/** Digests that identify a manual report, separate from its client run ID. */
export function manualReportDigests(
  buildContentDigest: string,
  report: BuildReport,
): { requestDigest: string; contentDigest: string } {
  const { client_run_id: _id, ...content } = report;
  void _id;
  return {
    requestDigest: digestOf({ build: buildContentDigest, report }),
    contentDigest: digestOf({ build: buildContentDigest, report: content }),
  };
}

export interface CreateBuildResult {
  build: BuildRecord;
  report: ReportRecord | null;
  buildCreated: boolean;
  reportCreated: boolean;
}

export interface PreparedBuild {
  target: { projectId: string; version: VersionDetail };
  payload: StoredBuildPayload;
  contentDigest: string;
}

/** Validate a build against the registry before any write. */
export async function prepareBuild(actor: Actor, build: AnyBuildInput): Promise<PreparedBuild> {
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const target = await loadContributionTarget(actor, build.project_id, build.project_version_id);
  const issues = validateBuildAgainstVersion(build, target.version);
  if (issues.length > 0) throw ApiError.validationFailed(issues);

  if (build.parent_build_id) {
    const [parent] = await db()
      .select({ id: buildConfigurations.id })
      .from(buildConfigurations)
      .where(
        and(
          eq(buildConfigurations.id, build.parent_build_id),
          eq(buildConfigurations.ownerUserId, actor.userId),
          eq(buildConfigurations.projectId, target.projectId),
        ),
      )
      .limit(1);
    if (!parent) {
      throw ApiError.validationFailed([
        { pointer: '/parent_build_id', message: 'The parent build must be one of your builds for this project.' },
      ]);
    }
  }
  const payload = buildContentPayload(build);
  return { target, payload, contentDigest: digestOf(payload) };
}

/** Insert or reuse the owner's build with this exact content. */
export async function saveBuildInTx(
  tx: Transaction,
  actor: Actor,
  build: AnyBuildInput,
  prepared: PreparedBuild,
): Promise<{ build: BuildRecord; created: boolean }> {
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const owner = actor.userId;
  const inserted = await tx
    .insert(buildConfigurations)
    .values({
      ownerUserId: owner,
      projectId: prepared.target.projectId,
      projectVersionId: prepared.target.version.id,
      configurationKey: build.configuration_key,
      payload: prepared.payload,
      contentDigest: prepared.contentDigest,
      fingerprint: buildFingerprint(build),
      reproducibility: classifyReproducibility(build),
      parentBuildId: build.parent_build_id,
    })
    .onConflictDoNothing()
    .returning();

  let row = inserted[0];
  const created = row !== undefined;
  if (!row) {
    [row] = await tx
      .select()
      .from(buildConfigurations)
      .where(
        and(
          eq(buildConfigurations.ownerUserId, owner),
          eq(buildConfigurations.contentDigest, prepared.contentDigest),
        ),
      )
      .limit(1);
  }
  if (!row) throw ApiError.internal('The build could not be saved.');
  const record = asBuild(row);
  if (record.visibility === 'withdrawn') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'This exact build was withdrawn; change its content to save a new one.',
    });
  }
  if (created) {
    await writeAudit(tx, actor, {
      action: 'build.saved',
      targetKind: 'build',
      targetId: record.id,
      metadata: {
        project_id: record.projectId,
        project_version_id: record.projectVersionId,
        content_digest: prepared.contentDigest,
        reproducibility: record.reproducibility,
      },
    });
  }
  return { build: record, created };
}

/**
 * Save a private build, optionally with a manual report, in one transaction.
 * Identical content by the same owner returns the existing build; a reused
 * client run ID with different report content is a conflict.
 */
export async function createBuild(input: {
  actor: Actor;
  build: AnyBuildInput;
}): Promise<CreateBuildResult> {
  const { actor } = input;
  if (input.build.schema === 'localfirst/build/v0.2' && !config().features.workflowResults) throw ApiError.phaseUnavailable('Workflow builds');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const prepared = await prepareBuild(actor, input.build);

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, actor.userId);
    const saved = await saveBuildInTx(tx, actor, input.build, prepared);
    let report: ReportRecord | null = null;
    let reportCreated = false;
    if (input.build.manual_report) {
      const result = await saveManualReport(tx, actor, saved.build, input.build.manual_report);
      report = result.report;
      reportCreated = result.created;
    }
    return { build: saved.build, report, buildCreated: saved.created, reportCreated };
  });
}

async function saveManualReport(
  tx: Transaction,
  actor: Actor,
  build: BuildRecord,
  manual: BuildReport,
): Promise<{ report: ReportRecord; created: boolean }> {
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const digests = manualReportDigests(build.contentDigest, manual);
  const inserted = await tx
    .insert(runReports)
    .values({
      kind: 'manual_build',
      submitterUserId: actor.userId,
      clientRunId: manual.client_run_id,
      requestDigest: digests.requestDigest,
      contentDigest: digests.contentDigest,
      projectId: build.projectId,
      projectVersionId: build.projectVersionId,
      buildId: build.id,
      testDefinitionId: null,
      payload: manual,
      outcome: manual.outcome,
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
      requiredScope: 'builds:write',
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
        kind: 'manual_build',
        schema: BUILD_REPORT_SCHEMA_ID,
        build_id: build.id,
        content_digest: digests.contentDigest,
      },
    });
    return { report: asReport({ ...inserted[0], operationId }), created: true };
  }

  // Replay or conflict: the unique run ID or the unique content already exists.
  const [existing] = await tx
    .select()
    .from(runReports)
    .where(
      and(
        eq(runReports.submitterUserId, actor.userId),
        eq(runReports.clientRunId, manual.client_run_id),
      ),
    )
    .limit(1);
  if (existing && existing.requestDigest === digests.requestDigest) {
    return { report: asReport(existing), created: false };
  }
  throw new ApiError({
    code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
    message: 'This client run ID or report content was already submitted with different content.',
    details: { client_run_id: manual.client_run_id },
  });
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export type BuildAccess = { record: BuildRecord; owner: boolean };

/**
 * A public build is readable by anyone. Otherwise only its owner may read it,
 * and a non-owner is told it does not exist.
 */
export async function loadReadableBuild(
  actor: Actor,
  id: string,
  conn: DbOrTx = db(),
): Promise<BuildAccess> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound();
  const [row] = await conn
    .select()
    .from(buildConfigurations)
    .where(eq(buildConfigurations.id, id))
    .limit(1);
  if (!row) throw ApiError.notFound();
  const record = asBuild(row);
  if (record.visibility === 'public') {
    const owner = actor.kind !== 'anonymous' && actor.userId === record.ownerUserId;
    // Hidden or quarantined content is excluded at read time, even by direct ID.
    if (!owner) await loadVisibleProject({ id: record.projectId }, actor);
    return { record, owner };
  }
  if (actor.kind === 'anonymous' || actor.userId !== record.ownerUserId) throw ApiError.notFound();
  if (!actor.scopes.has('builds:write')) throw ApiError.insufficientScope(['builds:write']);
  return { record, owner: true };
}

export async function loadOwnedBuild(
  actor: Actor,
  id: string,
  conn: DbOrTx = db(),
): Promise<BuildRecord> {
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound();
  const [row] = await conn
    .select()
    .from(buildConfigurations)
    .where(eq(buildConfigurations.id, id))
    .limit(1);
  if (!row || row.ownerUserId !== actor.userId) throw ApiError.notFound();
  return asBuild(row);
}

export async function manualReportOf(buildId: string, conn: DbOrTx = db()): Promise<ReportRecord | null> {
  const [row] = await conn
    .select()
    .from(runReports)
    .where(and(eq(runReports.buildId, buildId), eq(runReports.kind, 'manual_build')))
    .orderBy(desc(runReports.createdAt))
    .limit(1);
  return row ? asReport(row) : null;
}

export async function submitterHandle(userId: string): Promise<string | null> {
  const [profile] = await db()
    .select({ handle: userProfiles.handle })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return profile?.handle ?? null;
}

export function serializeReportStatus(report: ReportRecord): Record<string, unknown> {
  return {
    report_id: report.id,
    kind: report.kind,
    outcome: report.outcome,
    validation_state: report.validationState,
    review_state: report.reviewState,
    evidence_level: report.evidenceLevel,
    visibility: report.visibility,
    operation_id: report.operationId,
    created_at: report.createdAt.toISOString(),
  };
}

/** Owner view: the full sanitized content plus every derived status. */
export function serializeOwnerBuild(
  build: BuildRecord,
  report: ReportRecord | null,
): Record<string, unknown> {
  return {
    build_id: build.id,
    project_id: build.projectId,
    project_version_id: build.projectVersionId,
    configuration_key: build.configurationKey,
    visibility: build.visibility,
    reproducibility: build.reproducibility,
    content_digest: build.contentDigest,
    fingerprint: build.fingerprint,
    build: build.payload,
    manual_report: report
      ? { ...serializeReportStatus(report), payload: report.payload }
      : null,
    public_projection_digest: build.publicProjectionDigest,
    created_at: build.createdAt.toISOString(),
    published_at: build.publishedAt?.toISOString() ?? null,
    withdrawn_at: build.withdrawnAt?.toISOString() ?? null,
  };
}

/** Public view: only the approved projection, with live review status. */
export function serializePublicBuild(
  build: BuildRecord,
  report: ReportRecord | null,
  handle: string | null,
): Record<string, unknown> {
  return {
    ...(build.publicProjection ?? {}),
    build_id: build.id,
    visibility: 'public',
    reproducibility: build.reproducibility,
    submitted_by: { handle },
    manual_report_status:
      report && report.visibility === 'public'
        ? {
            report_id: report.id,
            review_state: report.reviewState,
            evidence_level: report.evidenceLevel,
          }
        : null,
    // A build is a configuration; only reports carry evidence.
    evidence_note:
      'A saved build records a configuration. Evidence comes only from reviewed reports attached to it.',
    published_at: build.publishedAt?.toISOString() ?? null,
    public_projection_digest: build.publicProjectionDigest,
  };
}

export async function listPublicBuilds(
  projectId: string,
  page: PageRequest,
  bound: string,
): Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string | null }> {
  const conditions = [
    eq(buildConfigurations.projectId, projectId),
    eq(buildConfigurations.visibility, 'public'),
  ];
  if (page.cursor && page.cursor.values.length === 2) {
    const [publishedAt, id] = page.cursor.values as [string, string];
    conditions.push(
      sql`(${buildConfigurations.publishedAt}, ${buildConfigurations.id}) < (${new Date(publishedAt)}, ${id})` as never,
    );
  }
  const rows = await db()
    .select()
    .from(buildConfigurations)
    .where(and(...conditions))
    .orderBy(desc(buildConfigurations.publishedAt), desc(buildConfigurations.id))
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const items = rows.slice(0, page.limit).map(asBuild);
  const out: Array<Record<string, unknown>> = [];
  for (const build of items) {
    out.push(
      serializePublicBuild(build, await manualReportOf(build.id), await submitterHandle(build.ownerUserId)),
    );
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
// Withdrawal
// --------------------------------------------------------------------------

/**
 * Withdraw an owned build. Its reports depend on the configuration, so they are
 * withdrawn with it; observed facts stay stored for the owner, but nothing
 * withdrawn is public or counts as evidence, and reaggregation is scheduled.
 */
export async function withdrawBuild(
  actor: Actor,
  id: string,
): Promise<{ build: BuildRecord; withdrawnReports: number }> {
  const owned = await loadOwnedBuild(actor, id);
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, owned.ownerUserId);
    const [locked] = await tx
      .select()
      .from(buildConfigurations)
      .where(eq(buildConfigurations.id, id))
      .for('update');
    if (!locked) throw ApiError.notFound();
    const build = asBuild(locked);
    if (build.visibility === 'withdrawn') return { build, withdrawnReports: 0 };

    const withdrawnAt = new Date();
    const [updated] = await tx
      .update(buildConfigurations)
      .set({ visibility: 'withdrawn', withdrawnAt })
      .where(eq(buildConfigurations.id, id))
      .returning();
    const reports = await tx
      .update(runReports)
      .set({
        visibility: 'withdrawn',
        reviewState: 'withdrawn',
        evidenceLevel: null,
        withdrawnAt,
        updatedAt: withdrawnAt,
      })
      .where(and(eq(runReports.buildId, id), sql`${runReports.visibility} <> 'withdrawn'`))
      .returning({ id: runReports.id });

    await emitEvent(tx, {
      eventType: 'evidence.changed',
      aggregateKind: 'project',
      aggregateId: build.projectId,
      payload: { cause: 'build.withdrawn', build_id: id, reports: reports.length },
    });
    await writeAudit(tx, actor, {
      action: 'build.withdrawn',
      targetKind: 'build',
      targetId: id,
      metadata: { project_id: build.projectId, withdrawn_reports: reports.length },
    });
    return { build: asBuild(updated), withdrawnReports: reports.length };
  });
}

export function buildUrl(id: string): string {
  return `${config().apiBaseUrl}/api/v1/builds/${id}`;
}
