/**
 * Build and test-result contributions (BACKEND_PRD sections 10.4, 14.2, 16.3).
 *
 * A draft of kind `build` or `test_result` references an immutable private
 * record and an exact proposed public projection. The projection is computed by
 * the server from the record and the owner's selections, and the draft's
 * payload digest binds the record, the selections, the redaction version, and
 * the projection itself. Any edit to a selection changes the digest, so the
 * existing exact-artifact approval flow invalidates the approval; publication
 * recomputes everything inside one transaction before consuming it.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { digestOf, ERROR_CODES } from '@localfirst/contracts';
import type { ValidationIssue } from '@localfirst/contracts';
import { drafts, publicationApprovals } from '../db/schema/registry.js';
import { buildConfigurations, runReports } from '../db/schema/evidence.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { assertApprovalUsable } from '../domain/approval.js';
import { APPROVAL_POLICY_VERSION } from '../domain/policy.js';
import {
  buildSelectionSchema,
  buildWarnings,
  projectBuild,
  projectionDigest,
  projectTestResult,
  resultSelectionSchema,
  resultWarnings,
} from '../domain/evidence.js';
import { communityRecords } from '../db/schema/community.js';
import { evaluateCommunityDraft, isCommunityKind } from './community.js';
import { lockActiveAccount } from './accounts.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { asBuild, asReport, manualReportOf } from './builds.js';

export type RecordKind = 'build' | 'test_result' | 'collection' | 'troubleshooting';
export const RECORD_KINDS: readonly RecordKind[] = ['build', 'test_result', 'collection', 'troubleshooting'];
export const isRecordKind = (kind: string): kind is RecordKind =>
  (RECORD_KINDS as readonly string[]).includes(kind);

/** Scopes that write each contribution kind, and the scopes that publish it. */
export const WRITE_SCOPE = {
  collection: 'community:write',
  troubleshooting: 'community:write',
  project: 'projects:draft',
  build: 'builds:write',
  test_result: 'tests:submit',
} as const;
export const PUBLISH_SCOPE = {
  collection: 'community:publish',
  troubleshooting: 'community:publish',
  project: 'projects:publish',
  build: 'builds:publish',
  test_result: 'tests:publish',
} as const;

export interface RecordDraftPayload {
  record_id: string;
  selection: Record<string, unknown>;
}

export interface RecordValidation {
  issues: ValidationIssue[];
  warning_codes: string[];
  readyForReview: boolean;
  /** The exact fields that become public on publication. */
  projection: Record<string, unknown> | null;
  /** Digest binding record, selections, redaction version, and projection. */
  payloadDigest: string;
  recordDigest: string | null;
  /** Normalized selection actually applied (defaults filled in). */
  selection: Record<string, unknown>;
}

const issue = (
  severity: 'error' | 'warning',
  code: string,
  message: string,
  pointer = '/record_id',
): ValidationIssue => ({ severity, code, message, pointer });

/**
 * Compute the validation and exact projection for a record draft from the
 * authoritative rows. Pure function of the stored record and the selections.
 */
export async function evaluateRecordDraft(input: {
  kind: RecordKind;
  ownerUserId: string;
  recordId: string;
  selection: unknown;
  conn?: DbOrTx;
  lock?: boolean;
}): Promise<RecordValidation> {
  const conn = input.conn ?? db();
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, selection: Record<string, unknown> = {}): RecordValidation => ({
    issues: [...issues, issue('error', code, message)],
    warning_codes: [],
    readyForReview: false,
    projection: null,
    payloadDigest: digestOf({ kind: input.kind, record_id: input.recordId, selection, error: code }),
    recordDigest: null,
    selection,
  });

  if (!/^[0-9a-f-]{36}$/i.test(input.recordId)) return fail('record_not_found', 'The record does not exist.');

  if (isCommunityKind(input.kind)) return evaluateCommunityDraft({ ...input, kind: input.kind, conn });

  if (input.kind === 'build') {
    const parsed = buildSelectionSchema.safeParse(input.selection ?? {});
    if (!parsed.success) {
      return fail('selection_invalid', 'The selection is not valid.', {});
    }
    const selection = parsed.data;
    const query = conn.select().from(buildConfigurations).where(eq(buildConfigurations.id, input.recordId));
    const [row] = input.lock ? await query.for('update') : await query;
    if (!row || row.ownerUserId !== input.ownerUserId) {
      return fail('record_not_found', 'The build does not exist.', selection);
    }
    const build = asBuild(row);
    if (build.visibility === 'withdrawn') return fail('record_withdrawn', 'This build was withdrawn.', selection);
    if (build.visibility === 'public') return fail('already_public', 'This build is already public.', selection);

    const report = await manualReportOf(build.id, conn);
    const recordDigest = digestOf({ build: build.contentDigest, manual: report?.contentDigest ?? null });
    const projection = projectBuild(
      {
        buildId: build.id,
        payload: build.payload,
        reproducibility: build.reproducibility,
        manualReport: report ? { report_id: report.id, payload: report.payload as never } : null,
      },
      selection,
    );
    const warnings = buildWarnings(build.reproducibility, selection, report !== null, build.payload.hardware !== null);
    for (const code of warnings) issues.push(issue('warning', code, WARNING_TEXT[code] ?? code, '/selection'));
    return {
      issues,
      warning_codes: warnings,
      readyForReview: true,
      projection,
      payloadDigest: projectionDigest({
        kind: 'build',
        recordId: build.id,
        recordDigest,
        selection,
        projection,
      }),
      recordDigest,
      selection,
    };
  }

  const parsed = resultSelectionSchema.safeParse(input.selection ?? {});
  if (!parsed.success) return fail('selection_invalid', 'The selection is not valid.', {});
  const selection = parsed.data;
  const query = conn.select().from(runReports).where(eq(runReports.id, input.recordId));
  const [row] = input.lock ? await query.for('update') : await query;
  if (!row || row.submitterUserId !== input.ownerUserId || row.kind !== 'test_run') {
    return fail('record_not_found', 'The test result does not exist.', selection);
  }
  const report = asReport(row);
  if (report.visibility === 'withdrawn') return fail('record_withdrawn', 'This result was withdrawn.', selection);
  if (report.visibility === 'public') return fail('already_public', 'This result is already public.', selection);
  if (report.validationState === 'pending') {
    return fail('report_not_validated', 'Server validation of this result has not finished yet.', selection);
  }
  if (report.validationState === 'invalid') {
    return fail('report_invalid', 'Server validation rejected this result, so it cannot be published.', selection);
  }
  const [buildRow] = await conn
    .select()
    .from(buildConfigurations)
    .where(eq(buildConfigurations.id, report.buildId))
    .limit(1);
  if (!buildRow || asBuild(buildRow).visibility !== 'public') {
    return fail('build_not_published', 'Publish the build this result belongs to first.', selection);
  }
  const projection = projectTestResult(report.id, report.payload as never, selection);
  const warnings = resultWarnings(selection);
  for (const code of warnings) issues.push(issue('warning', code, WARNING_TEXT[code] ?? code, '/selection'));
  return {
    issues,
    warning_codes: warnings,
    readyForReview: true,
    projection,
    payloadDigest: projectionDigest({
      kind: 'test_result',
      recordId: report.id,
      recordDigest: report.contentDigest,
      selection,
      projection,
    }),
    recordDigest: report.contentDigest,
    selection,
  };
}

const WARNING_TEXT: Record<string, string> = {
  build_identity_incomplete:
    'The build lacks a complete model or runtime identity, which limits reproducibility and comparison eligibility.',
  hardware_not_shared: 'No hardware detail is shared, so this build cannot be matched to a platform.',
  model_source_not_shared: 'The model source URL is not shared, which limits reproducibility.',
  model_alias_not_shared: 'The runtime model name is not shared.',
  manual_report_not_shared: 'The attached manual report stays private and will not count as evidence.',
  case_results_not_shared: 'Per-case results are not shared; only aggregate counts become public.',
};

// --------------------------------------------------------------------------
// Draft creation and editing
// --------------------------------------------------------------------------

export interface CreateRecordDraftInput {
  actor: Actor;
  kind: RecordKind;
  recordId: string;
  selection?: unknown;
}

export async function createRecordDraft(input: CreateRecordDraftInput) {
  const { actor } = input;
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const validation = await evaluateRecordDraft({
    kind: input.kind,
    ownerUserId: actor.userId,
    recordId: input.recordId,
    selection: input.selection ?? {},
  });
  // A draft only ever references a record its owner can see; anything else is a 404.
  if (validation.issues.some((entry) => entry.code === 'record_not_found')) throw ApiError.notFound();

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, actor.userId);
    const payload: RecordDraftPayload = { record_id: input.recordId, selection: validation.selection };
    const [row] = await tx
      .insert(drafts)
      .values({
        kind: input.kind,
        ownerUserId: actor.userId,
        payload,
        payloadDigest: validation.payloadDigest,
        manifest: validation.projection,
        contentDigest: validation.payloadDigest,
        issues: validation.issues,
        warningCodes: validation.warning_codes,
        state: validation.readyForReview ? 'ready_for_review' : 'editable',
      })
      .returning();
    if (!row) throw ApiError.internal('The draft could not be created.');
    await writeAudit(tx, actor, {
      action: 'draft.created',
      targetKind: 'draft',
      targetId: row.id,
      metadata: {
        kind: input.kind,
        record_id: input.recordId,
        payload_digest: validation.payloadDigest,
        ready_for_review: validation.readyForReview,
      },
    });
    return { draftRow: row, validation };
  });
}

export async function patchRecordDraft(input: {
  actor: Actor;
  draftId: string;
  expectedRevision: number;
  selection: unknown;
}) {
  const { actor } = input;
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const [existing] = await db().select().from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
  if (!existing || existing.ownerUserId !== actor.userId || !isRecordKind(existing.kind)) {
    throw ApiError.notFound();
  }
  if (existing.state === 'published' || existing.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${existing.state}\` cannot be changed.`,
    });
  }
  if (existing.revision !== input.expectedRevision) {
    throw new ApiError({
      code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
      message: 'The draft changed since this revision was read.',
      details: { expected_revision: input.expectedRevision, current_revision: existing.revision },
    });
  }
  const recordId = (existing.payload as RecordDraftPayload).record_id;
  const validation = await evaluateRecordDraft({
    kind: existing.kind,
    ownerUserId: actor.userId,
    recordId,
    selection: input.selection,
  });
  if (validation.issues.some((entry) => entry.code === 'selection_invalid')) {
    throw ApiError.validationFailed(validation.issues);
  }

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, actor.userId);
    const payload: RecordDraftPayload = { record_id: recordId, selection: validation.selection };
    const [row] = await tx
      .update(drafts)
      .set({
        payload,
        payloadDigest: validation.payloadDigest,
        manifest: validation.projection,
        contentDigest: validation.payloadDigest,
        issues: validation.issues,
        warningCodes: validation.warning_codes,
        state: validation.readyForReview ? 'ready_for_review' : 'editable',
        revision: sql`${drafts.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(drafts.id, input.draftId), eq(drafts.revision, input.expectedRevision)))
      .returning();
    if (!row) {
      throw new ApiError({
        code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
        message: 'The draft changed while this edit was being applied.',
      });
    }
    // Any change to the exact projection invalidates a live approval.
    const revoked = await tx
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(publicationApprovals.draftId, input.draftId),
          isNull(publicationApprovals.consumedAt),
          isNull(publicationApprovals.revokedAt),
        ),
      )
      .returning({ id: publicationApprovals.id });
    await writeAudit(tx, actor, {
      action: 'draft.updated',
      targetKind: 'draft',
      targetId: input.draftId,
      metadata: {
        revision: row.revision,
        payload_digest: validation.payloadDigest,
        invalidated_approvals: revoked.length,
        ready_for_review: validation.readyForReview,
      },
    });
    return { draftRow: row, validation };
  });
}

/** Re-evaluate without changing content; keeps `approved` when the digest still matches. */
export async function revalidateRecordDraft(input: {
  actor: Actor;
  draftId: string;
  expectedRevision?: number | undefined;
}) {
  const { actor } = input;
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const [existing] = await db().select().from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
  if (!existing || existing.ownerUserId !== actor.userId || !isRecordKind(existing.kind)) {
    throw ApiError.notFound();
  }
  if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    throw new ApiError({
      code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
      message: 'The draft changed since this revision was read.',
      details: { expected_revision: input.expectedRevision, current_revision: existing.revision },
    });
  }
  if (existing.state === 'published' || existing.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${existing.state}\` cannot be validated.`,
    });
  }
  const payload = existing.payload as RecordDraftPayload;
  const validation = await evaluateRecordDraft({
    kind: existing.kind,
    ownerUserId: actor.userId,
    recordId: payload.record_id,
    selection: payload.selection,
  });
  const [live] = await db()
    .select({ id: publicationApprovals.id, payloadDigest: publicationApprovals.payloadDigest })
    .from(publicationApprovals)
    .where(
      and(
        eq(publicationApprovals.draftId, existing.id),
        eq(publicationApprovals.decision, 'approved'),
        isNull(publicationApprovals.consumedAt),
        isNull(publicationApprovals.revokedAt),
      ),
    )
    .limit(1);
  // The projection is a function of the stored record, so a changed record
  // (for example a validation result arriving) moves the digest.
  const digestMoved = validation.payloadDigest !== existing.payloadDigest;
  const state =
    live && validation.readyForReview && !digestMoved
      ? 'approved'
      : validation.readyForReview
        ? 'ready_for_review'
        : 'editable';
  const [row] = await db()
    .update(drafts)
    .set({
      payloadDigest: validation.payloadDigest,
      manifest: validation.projection,
      contentDigest: validation.payloadDigest,
      issues: validation.issues,
      warningCodes: validation.warning_codes,
      state,
      ...(digestMoved ? { revision: sql`${drafts.revision} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, existing.id))
    .returning();
  if (digestMoved && live) {
    await db()
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(and(eq(publicationApprovals.id, live.id), isNull(publicationApprovals.consumedAt)));
  }
  return { draftRow: row!, validation };
}

// --------------------------------------------------------------------------
// Publication
// --------------------------------------------------------------------------

export interface PublishRecordInput {
  actor: Actor;
  draftId: string;
  approvalId: string;
  draftRevision: number;
  payloadDigest: string;
}

export interface PublishRecordResult {
  kind: RecordKind;
  record_id: string;
  visibility: 'public';
  review_state: 'pending';
  evidence_level: null;
  projection_digest: string;
  published_at: string;
  url: string;
  warning_codes: string[];
}

/**
 * Publish the exact approved projection. One transaction locks draft, approval,
 * and target, rechecks revision, digest, and policy, flips visibility,
 * consumes the approval, and writes audit and outbox rows. A published record
 * is `pending` review with no evidence level: publication never verifies.
 */
export async function publishRecordDraft(input: PublishRecordInput): Promise<PublishRecordResult> {
  const { actor } = input;
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const userId = actor.userId;

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, userId);
    const [draft] = await tx.select().from(drafts).where(eq(drafts.id, input.draftId)).for('update');
    if (!draft || draft.ownerUserId !== userId || !isRecordKind(draft.kind)) throw ApiError.notFound();
    if (draft.state === 'published') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'This draft was already published.',
      });
    }
    if (draft.state !== 'approved') {
      throw new ApiError({
        code: ERROR_CODES.APPROVAL_REQUIRED,
        message: 'This draft has no live human approval of its exact current artifact.',
        details: { state: draft.state },
      });
    }
    const [approval] = await tx
      .select()
      .from(publicationApprovals)
      .where(eq(publicationApprovals.id, input.approvalId))
      .for('update');

    const payload = draft.payload as RecordDraftPayload;
    const validation = await evaluateRecordDraft({
      kind: draft.kind,
      ownerUserId: userId,
      recordId: payload.record_id,
      selection: payload.selection,
      conn: tx,
      lock: true,
    });
    if (!validation.readyForReview || !validation.projection) {
      throw new ApiError({
        code: ERROR_CODES.PUBLICATION_BLOCKED,
        message: 'This contribution cannot be published in its current state.',
        details: { issues: validation.issues.filter((entry) => entry.severity === 'error') },
      });
    }

    assertApprovalUsable(
      approval,
      {
        draftId: draft.id,
        kind: draft.kind,
        revision: draft.revision,
        payloadDigest: draft.payloadDigest,
        warningCodes: validation.warning_codes,
      },
      { approvalId: input.approvalId, draftRevision: input.draftRevision, payloadDigest: input.payloadDigest },
      userId,
    );
    // The approved bytes must still be exactly what would be published now.
    if (validation.payloadDigest !== draft.payloadDigest) {
      throw new ApiError({
        code: ERROR_CODES.APPROVAL_STALE,
        message: 'The record changed after it was approved. Review and approve the exact current projection.',
        details: {
          approved_payload_digest: draft.payloadDigest,
          current_payload_digest: validation.payloadDigest,
        },
      });
    }

    const publishedAt = new Date();
    const projection = validation.projection;
    let projectId: string | null = null;
    if (isCommunityKind(draft.kind)) {
      const [updated] = await tx.update(communityRecords).set({ visibility: 'public', publishedAt })
        .where(and(eq(communityRecords.id, payload.record_id), eq(communityRecords.visibility, 'private'))).returning();
      if (!updated) throw ApiError.conflict('INVALID_LIFECYCLE', 'This community record is no longer private.');
    } else if (draft.kind === 'build') {
      const [updated] = await tx
        .update(buildConfigurations)
        .set({
          visibility: 'public',
          publicProjection: projection,
          publicProjectionDigest: validation.payloadDigest,
          publishedAt,
        })
        .where(and(eq(buildConfigurations.id, payload.record_id), eq(buildConfigurations.visibility, 'private')))
        .returning({ projectId: buildConfigurations.projectId });
      if (!updated) {
        throw new ApiError({ code: ERROR_CODES.INVALID_LIFECYCLE, message: 'This build is no longer private.' });
      }
      projectId = updated.projectId;
      const manual = projection.manual_report as { report_id: string } | null;
      if (manual) {
        await tx
          .update(runReports)
          .set({
            visibility: 'public',
            publicProjection: manual,
            publicProjectionDigest: digestOf(manual),
            publishedAt,
            updatedAt: publishedAt,
          })
          .where(and(eq(runReports.id, manual.report_id), eq(runReports.visibility, 'private')));
      }
    } else {
      const [updated] = await tx
        .update(runReports)
        .set({
          visibility: 'public',
          publicProjection: projection,
          publicProjectionDigest: validation.payloadDigest,
          publishedAt,
          updatedAt: publishedAt,
        })
        .where(and(eq(runReports.id, payload.record_id), eq(runReports.visibility, 'private')))
        .returning({ projectId: runReports.projectId });
      if (!updated) {
        throw new ApiError({ code: ERROR_CODES.INVALID_LIFECYCLE, message: 'This result is no longer private.' });
      }
      projectId = updated.projectId;
    }

    const consumed = await tx
      .update(publicationApprovals)
      .set({ consumedAt: publishedAt })
      .where(and(eq(publicationApprovals.id, input.approvalId), isNull(publicationApprovals.consumedAt)))
      .returning({ id: publicationApprovals.id });
    if (consumed.length === 0) {
      throw new ApiError({ code: ERROR_CODES.APPROVAL_REQUIRED, message: 'This approval was already used.' });
    }
    await tx
      .update(drafts)
      .set({ state: 'published', updatedAt: publishedAt })
      .where(eq(drafts.id, draft.id));

    if (projectId) await emitEvent(tx, {
      eventType: 'evidence.changed',
      aggregateKind: 'project',
      aggregateId: projectId,
      payload: { cause: `${draft.kind}.published`, record_id: payload.record_id },
    });
    await writeAudit(tx, actor, {
      action: `${draft.kind}.published`,
      targetKind: draft.kind === 'build' ? 'build' : isCommunityKind(draft.kind) ? draft.kind : 'run_report',
      targetId: payload.record_id,
      policyVersion: APPROVAL_POLICY_VERSION,
      metadata: {
        project_id: projectId,
        draft_id: draft.id,
        approval_id: input.approvalId,
        projection_digest: validation.payloadDigest,
      },
    });

    return {
      kind: draft.kind,
      record_id: payload.record_id,
      visibility: 'public',
      review_state: 'pending',
      evidence_level: null,
      projection_digest: validation.payloadDigest,
      published_at: publishedAt.toISOString(),
      url: `/api/v1/${draft.kind === 'collection' ? 'collections' : draft.kind === 'troubleshooting' ? 'troubleshooting-notes' : draft.kind === 'build' ? 'builds' : 'test-results'}/${payload.record_id}`,
      warning_codes: validation.warning_codes,
    };
  });
}
