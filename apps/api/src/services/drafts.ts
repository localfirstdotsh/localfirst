/**
 * Draft lifecycle (BACKEND_PRD sections 3.2, 12.1, 14.1).
 *
 * `editable` -> `ready_for_review` -> `approved` -> `published`, with
 * `ingesting`/`ingestion_failed` for optional imports and `discarded` as a
 * terminal state. An edit increments the revision and invalidates approval.
 * Validation may update the derived ready state without changing content.
 */

import { lockActiveAccount } from './accounts.js';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { digestOfBytes, ERROR_CODES, type BundleFile } from '@localfirst/contracts';
import { drafts, projects, publicationApprovals } from '../db/schema/registry.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { revisionEtag } from '../http/envelope.js';
import type { Actor } from '../http/context.js';
import { config } from '../config.js';
import { APPROVAL_POLICY_VERSION } from '../domain/policy.js';
import { assertWarningsAcknowledged } from '../domain/approval.js';
import { validateDraft, type DraftPayload, type RegistryValidation } from './validation.js';
import { writeAudit } from './audit.js';
import { createOperation } from './operations.js';
import { creatingClient, delegateCreatingConnection } from './delegation.js';
import { enqueueJob } from './jobs.js';
import { emitEvent } from './outbox.js';
import { evaluateRecordDraft, isRecordKind, type RecordDraftPayload } from './contributions.js';

export interface DraftRecord {
  id: string;
  kind: string;
  state: string;
  ownerUserId: string;
  projectId: string | null;
  revision: number;
  sourceGeneration: number;
  payload: DraftPayload;
  payloadDigest: string;
  manifest: unknown;
  markdown: string | null;
  derived: unknown;
  contentDigest: string | null;
  issues: unknown;
  warningCodes: string[];
  importDescriptor: unknown;
  importError: unknown;
  operationId: string | null;
  /** The connection that created this draft, if one did (section 10.4). */
  createdByClientId: string | null;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveApproval {
  id: string;
  draftRevision: number;
  payloadDigest: string;
  acknowledgedWarningCodes: unknown;
  expiresAt: Date;
  actorUserId: string;
}

function asDraftRecord(row: Record<string, unknown>): DraftRecord {
  return {
    ...(row as unknown as DraftRecord),
    payload: (row.payload ?? { project_md: '', files: [] }) as DraftPayload,
    warningCodes: Array.isArray(row.warningCodes) ? (row.warningCodes as string[]) : [],
  };
}

export async function loadOwnedDraft(
  actor: Actor,
  draftId: string,
  conn: DbOrTx = db(),
): Promise<DraftRecord> {
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const [row] = await conn.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  // A draft is private: a non-owner is told it does not exist.
  if (!row || row.ownerUserId !== actor.userId) throw ApiError.notFound();
  return asDraftRecord(row as unknown as Record<string, unknown>);
}

export async function activeApproval(
  draftId: string,
  conn: DbOrTx = db(),
): Promise<ActiveApproval | undefined> {
  const [row] = await conn
    .select({
      id: publicationApprovals.id,
      draftRevision: publicationApprovals.draftRevision,
      payloadDigest: publicationApprovals.payloadDigest,
      acknowledgedWarningCodes: publicationApprovals.acknowledgedWarningCodes,
      expiresAt: publicationApprovals.expiresAt,
      actorUserId: publicationApprovals.actorUserId,
    })
    .from(publicationApprovals)
    .where(
      and(
        eq(publicationApprovals.draftId, draftId),
        eq(publicationApprovals.decision, 'approved'),
        isNull(publicationApprovals.consumedAt),
        isNull(publicationApprovals.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

export interface SerializedDraft {
  draft_id: string;
  kind: string;
  state: string;
  revision: number;
  etag: string;
  project_id: string | null;
  payload_digest: string;
  content_digest: string | null;
  manifest: unknown;
  markdown: string | null;
  files: Array<{ path: string; content_digest: string; bytes: number }>;
  /** For build and result drafts: the private record and the exact applied selections. */
  record: { record_id: string; selection: unknown } | null;
  issues: unknown;
  warning_codes: string[];
  ready_for_review: boolean;
  approval: {
    approval_id: string;
    draft_revision: number;
    payload_digest: string;
    acknowledged_warning_codes: unknown;
    expires_at: string;
  } | null;
  review_url: string;
  operation_id: string | null;
  import: { descriptor: unknown; error: unknown } | null;
  published_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export function serializeDraft(
  draft: DraftRecord,
  approval?: ActiveApproval | undefined,
): SerializedDraft {
  return {
    draft_id: draft.id,
    kind: draft.kind,
    state: draft.state,
    revision: draft.revision,
    etag: revisionEtag(draft.revision),
    project_id: draft.projectId,
    payload_digest: draft.payloadDigest,
    content_digest: draft.contentDigest,
    manifest: draft.manifest ?? null,
    markdown: draft.markdown,
    files: (draft.payload.files ?? []).map((file) => ({
      path: file.path,
      content_digest: digestOfBytes(file.content),
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
    record: isRecordKind(draft.kind)
      ? {
          record_id: (draft.payload as unknown as RecordDraftPayload).record_id,
          selection: (draft.payload as unknown as RecordDraftPayload).selection,
        }
      : null,
    issues: draft.issues ?? [],
    warning_codes: draft.warningCodes,
    ready_for_review: draft.state === 'ready_for_review' || draft.state === 'approved',
    approval: approval
      ? {
          approval_id: approval.id,
          draft_revision: approval.draftRevision,
          payload_digest: approval.payloadDigest,
          acknowledged_warning_codes: approval.acknowledgedWarningCodes,
          expires_at: approval.expiresAt.toISOString(),
        }
      : null,
    // The exact-artifact review surface is a trusted browser page.
    review_url: `${config().websiteUrl}/review/drafts/${draft.id}`,
    operation_id: draft.operationId,
    import:
      draft.importDescriptor || draft.importError
        ? { descriptor: draft.importDescriptor ?? null, error: draft.importError ?? null }
        : null,
    published_version_id: draft.publishedVersionId,
    created_at: draft.createdAt.toISOString(),
    updated_at: draft.updatedAt.toISOString(),
  };
}

function validationFields(validation: RegistryValidation): Record<string, unknown> {
  return {
    manifest: validation.manifest ?? null,
    markdown: validation.markdown,
    derived: validation.derived ?? null,
    contentDigest: validation.content_digest,
    issues: validation.issues,
    warningCodes: validation.warning_codes,
    state: validation.readyForReview ? 'ready_for_review' : 'editable',
  };
}

export interface CreateDirectDraftInput {
  actor: Actor;
  ownerUserId: string;
  projectId: string | null;
  payload: DraftPayload;
}

/** Direct text submission: synchronous, no source retrieval, no execution. */
export async function createDirectProjectDraft(
  input: CreateDirectDraftInput,
): Promise<{ draft: DraftRecord; validation: RegistryValidation }> {
  const validation = await validateDraft({
    payload: input.payload,
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
  });

  const draft = await db().transaction(async (tx) => {
    await lockActiveAccount(tx, input.ownerUserId);
    const [row] = await tx
      .insert(drafts)
      .values({
        kind: 'project',
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        payload: input.payload,
        payloadDigest: validation.payload_digest,
        createdByClientId: creatingClient(input.actor),
        ...validationFields(validation),
      })
      .returning();
    if (!row) throw ApiError.internal('The draft could not be created.');
    await writeAudit(tx, input.actor, {
      action: 'draft.created',
      targetKind: 'draft',
      targetId: row.id,
      metadata: {
        kind: 'project',
        payload_digest: validation.payload_digest,
        source: 'direct_submission',
        ready_for_review: validation.readyForReview,
      },
    });
    return asDraftRecord(row as unknown as Record<string, unknown>);
  });

  return { draft, validation };
}

export interface CreateImportDraftInput {
  actor: Actor;
  ownerUserId: string;
  projectId: string | null;
  descriptor: {
    provider: string;
    repository_url: string;
    ref: string;
    manifest_path: string;
  };
}

/** Import draft: created in `ingesting` with a durable operation (202). */
export async function createImportProjectDraft(
  input: CreateImportDraftInput,
): Promise<{ draft: DraftRecord; operationId: string }> {
  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, input.ownerUserId);
    const emptyPayload: DraftPayload = { project_md: '', files: [] };
    const [row] = await tx
      .insert(drafts)
      .values({
        kind: 'project',
        state: 'ingesting',
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        payload: emptyPayload,
        payloadDigest: digestOfBytes(JSON.stringify(input.descriptor)),
        importDescriptor: input.descriptor,
        sourceGeneration: 1,
        createdByClientId: creatingClient(input.actor),
      })
      .returning();
    if (!row) throw ApiError.internal('The draft could not be created.');

    const operationId = await createOperation(tx, {
      kind: 'project.source_import',
      actor: input.actor,
      targetKind: 'draft',
      targetId: row.id,
      requiredScope: 'projects:draft',
    });
    await tx.update(drafts).set({ operationId }).where(eq(drafts.id, row.id));
    await enqueueJob(tx, {
      kind: 'source_import',
      payload: { draft_id: row.id, generation: 1 },
      dedupeKey: `source_import:${row.id}:1`,
      operationId,
    });
    await emitEvent(tx, {
      eventType: 'draft.import_requested',
      aggregateKind: 'draft',
      aggregateId: row.id,
      payload: { provider: input.descriptor.provider, manifest_path: input.descriptor.manifest_path },
    });
    await writeAudit(tx, input.actor, {
      action: 'draft.import_requested',
      targetKind: 'draft',
      targetId: row.id,
      metadata: {
        provider: input.descriptor.provider,
        repository_url: input.descriptor.repository_url,
        ref: input.descriptor.ref,
        manifest_path: input.descriptor.manifest_path,
      },
    });
    return {
      draft: asDraftRecord({ ...(row as unknown as Record<string, unknown>), operationId }),
      operationId,
    };
  });
}

export interface PatchDraftInput {
  actor: Actor;
  draftId: string;
  expectedRevision: number;
  patch: { project_md?: string; files?: BundleFile[] };
}

/** A content edit increments the revision and invalidates any approval. */
export async function patchProjectDraft(
  input: PatchDraftInput,
): Promise<{ draft: DraftRecord; validation: RegistryValidation }> {
  if (input.actor.kind === 'anonymous') throw ApiError.notFound();
  const ownerUserId = input.actor.userId;

  const existing = await loadOwnedDraft(input.actor, input.draftId);
  assertEditable(existing);
  if (existing.revision !== input.expectedRevision) {
    throw new ApiError({
      code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
      message: 'The draft changed since this revision was read.',
      details: { expected_revision: input.expectedRevision, current_revision: existing.revision },
    });
  }

  const payload: DraftPayload = {
    project_md: input.patch.project_md ?? existing.payload.project_md,
    files: input.patch.files ?? existing.payload.files ?? [],
  };
  const validation = await validateDraft({
    payload,
    ownerUserId,
    projectId: existing.projectId,
  });

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, ownerUserId);
    // Optimistic concurrency: the update only applies to the revision we read.
    const [row] = await tx
      .update(drafts)
      .set({
        payload,
        payloadDigest: validation.payload_digest,
        revision: sql`${drafts.revision} + 1`,
        updatedAt: new Date(),
        ...validationFields(validation),
      })
      .where(and(eq(drafts.id, input.draftId), eq(drafts.revision, input.expectedRevision)))
      .returning();
    if (!row) {
      throw new ApiError({
        code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
        message: 'The draft changed while this edit was being applied.',
      });
    }
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
    await writeAudit(tx, input.actor, {
      action: 'draft.updated',
      targetKind: 'draft',
      targetId: input.draftId,
      metadata: {
        revision: row.revision,
        payload_digest: validation.payload_digest,
        invalidated_approvals: revoked.length,
        ready_for_review: validation.readyForReview,
      },
    });
    return { draft: asDraftRecord(row as unknown as Record<string, unknown>), validation };
  });
}

function assertEditable(draft: DraftRecord): void {
  if (draft.state === 'published') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'A published draft is immutable.',
      details: { state: draft.state },
    });
  }
  if (draft.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'A discarded draft cannot be changed.',
      details: { state: draft.state },
    });
  }
  if (draft.state === 'ingesting') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'This draft is still importing its source.',
      details: { state: draft.state },
    });
  }
}

/**
 * Re-validate without changing content. The content revision is unchanged, so
 * an existing approval stays valid when the artifact itself did not move.
 */
export async function revalidateDraft(
  actor: Actor,
  draftId: string,
  expectedRevision?: number,
): Promise<{ draft: DraftRecord; validation: RegistryValidation }> {
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const existing = await loadOwnedDraft(actor, draftId);
  if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
    throw new ApiError({
      code: ERROR_CODES.REVISION_PRECONDITION_FAILED,
      message: 'The draft changed since this revision was read.',
      details: { expected_revision: expectedRevision, current_revision: existing.revision },
    });
  }
  if (existing.state === 'ingesting' || existing.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${existing.state}\` cannot be validated.`,
    });
  }

  const validation = await validateDraft({
    payload: existing.payload,
    ownerUserId: actor.userId,
    projectId: existing.projectId,
  });
  const fields = validationFields(validation);
  // Keep `approved` when the artifact still has a live approval.
  const approval = await activeApproval(draftId);
  const nextState =
    approval && validation.readyForReview && approval.payloadDigest === existing.payloadDigest
      ? 'approved'
      : (fields.state as string);

  const [row] = await db()
    .update(drafts)
    .set({ ...fields, state: nextState, updatedAt: new Date() })
    .where(eq(drafts.id, draftId))
    .returning();
  if (!row) throw ApiError.notFound();
  return { draft: asDraftRecord(row as unknown as Record<string, unknown>), validation };
}

export async function listOwnedDrafts(
  actor: Actor,
  filters: { kind?: string | undefined; state?: string | undefined; limit: number },
): Promise<DraftRecord[]> {
  if (actor.kind === 'anonymous') return [];
  const conditions = [eq(drafts.ownerUserId, actor.userId)];
  if (filters.kind) conditions.push(eq(drafts.kind, filters.kind));
  if (filters.state) conditions.push(eq(drafts.state, filters.state));
  const rows = await db()
    .select()
    .from(drafts)
    .where(and(...conditions))
    .orderBy(desc(drafts.updatedAt))
    .limit(filters.limit);
  return rows.map((row) => asDraftRecord(row as unknown as Record<string, unknown>));
}

export async function discardDraft(actor: Actor, draftId: string): Promise<void> {
  const existing = await loadOwnedDraft(actor, draftId);
  if (existing.state === 'published') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'A published draft cannot be discarded.',
    });
  }
  if (existing.state === 'discarded') return;
  await db().transaction(async (tx) => {
    await lockActiveAccount(tx, existing.ownerUserId);
    await tx
      .update(drafts)
      .set({ state: 'discarded', discardedAt: new Date(), updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
    await tx
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(publicationApprovals.draftId, draftId),
          isNull(publicationApprovals.consumedAt),
          isNull(publicationApprovals.revokedAt),
        ),
      );
    // Queued import results for a discarded draft are invalidated.
    await tx
      .update(drafts)
      .set({ sourceGeneration: sql`${drafts.sourceGeneration} + 1` })
      .where(eq(drafts.id, draftId));
    await emitEvent(tx, {
      eventType: 'draft.discarded',
      aggregateKind: 'draft',
      aggregateId: draftId,
      payload: {},
    });
    await writeAudit(tx, actor, {
      action: 'draft.discarded',
      targetKind: 'draft',
      targetId: draftId,
    });
  });
}

export interface ApprovalDecisionInput {
  actor: Actor;
  draftId: string;
  draftRevision: number;
  payloadDigest: string;
  acknowledgedWarningCodes: string[];
  decision: 'approved' | 'denied';
  /** Exactly one of these records where the decision was made. */
  sessionId: string | null;
  approverCredentialId?: string | null;
  /** Also let the connection that created the draft publish without asking (browser session only). */
  delegateConnection?: boolean;
}

/**
 * Create an exact-artifact approval in a trusted human session (section 10.4).
 * MCP cannot mint this by asserting that a user approved something.
 */
export async function createApproval(
  input: ApprovalDecisionInput,
): Promise<{ approvalId: string | null; draft: DraftRecord }> {
  const existing = await loadOwnedDraft(input.actor, input.draftId);
  if (existing.state === 'published' || existing.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${existing.state}\` cannot be approved.`,
    });
  }
  if (existing.revision !== input.draftRevision || existing.payloadDigest !== input.payloadDigest) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_STALE,
      message: 'The approval must name the exact current draft revision and payload digest.',
      details: {
        current_revision: existing.revision,
        current_payload_digest: existing.payloadDigest,
      },
    });
  }
  let validation: { readyForReview: boolean; issues: Array<{ severity: string }>; warning_codes: string[] };
  if (isRecordKind(existing.kind)) {
    // A build or result draft is approved against its exact, freshly computed projection.
    const recordPayload = existing.payload as unknown as RecordDraftPayload;
    const evaluated = await evaluateRecordDraft({
      kind: existing.kind,
      ownerUserId: existing.ownerUserId,
      recordId: recordPayload.record_id,
      selection: recordPayload.selection,
    });
    if (evaluated.readyForReview && evaluated.payloadDigest !== existing.payloadDigest) {
      throw new ApiError({
        code: ERROR_CODES.APPROVAL_STALE,
        message: 'The record changed since this draft was last validated. Validate it again and review the exact projection.',
        details: {
          draft_payload_digest: existing.payloadDigest,
          current_payload_digest: evaluated.payloadDigest,
        },
      });
    }
    validation = evaluated;
  } else {
    validation = await validateDraft({
      payload: existing.payload,
      ownerUserId: existing.ownerUserId,
      projectId: existing.projectId,
    });
  }
  if (!validation.readyForReview) {
    throw new ApiError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This draft still has blocking issues and cannot be approved.',
      details: { issues: validation.issues.filter((issue) => issue.severity === 'error') },
    });
  }
  // A rejection grants no publication rights and must not require assent to warnings.
  if (input.decision === 'approved') {
    assertWarningsAcknowledged(validation.warning_codes, input.acknowledgedWarningCodes);
  }
  const delegateClientId = input.delegateConnection && input.decision === 'approved' ? existing.createdByClientId : null;
  if (input.delegateConnection && !delegateClientId) {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: input.decision === 'approved'
        ? 'This draft was not created by a connection, so there is nothing to delegate to.'
        : 'Delegation can only be granted together with an approval.',
    });
  }

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, existing.ownerUserId);
    await tx
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(publicationApprovals.draftId, input.draftId),
          isNull(publicationApprovals.consumedAt),
          isNull(publicationApprovals.revokedAt),
        ),
      );

    if (input.decision === 'denied') {
      await tx.insert(publicationApprovals).values({
        draftId: input.draftId,
        kind: existing.kind,
        actorUserId: existing.ownerUserId,
        draftRevision: input.draftRevision,
        payloadDigest: input.payloadDigest,
        acknowledgedWarningCodes: input.acknowledgedWarningCodes,
        policyVersion: APPROVAL_POLICY_VERSION,
        decision: 'denied',
        sessionId: input.sessionId,
        approverCredentialId: input.approverCredentialId ?? null,
        expiresAt: new Date(Date.now() + config().ttl.approvalSeconds * 1000),
        revokedAt: new Date(),
      });
      const [row] = await tx
        .update(drafts)
        .set({ state: 'ready_for_review', updatedAt: new Date() })
        .where(eq(drafts.id, input.draftId))
        .returning();
      await writeAudit(tx, input.actor, {
        action: 'draft.approval_denied',
        targetKind: 'draft',
        targetId: input.draftId,
        policyVersion: APPROVAL_POLICY_VERSION,
        metadata: { revision: input.draftRevision, payload_digest: input.payloadDigest },
      });
      return {
        approvalId: null,
        draft: asDraftRecord(row as unknown as Record<string, unknown>),
      };
    }

    const [approval] = await tx
      .insert(publicationApprovals)
      .values({
        draftId: input.draftId,
        kind: existing.kind,
        actorUserId: existing.ownerUserId,
        draftRevision: input.draftRevision,
        payloadDigest: input.payloadDigest,
        acknowledgedWarningCodes: input.acknowledgedWarningCodes,
        policyVersion: APPROVAL_POLICY_VERSION,
        decision: 'approved',
        sessionId: input.sessionId,
        approverCredentialId: input.approverCredentialId ?? null,
        expiresAt: new Date(Date.now() + config().ttl.approvalSeconds * 1000),
      })
      .returning({ id: publicationApprovals.id });
    if (!approval) throw ApiError.internal('The approval could not be recorded.');
    if (delegateClientId) await delegateCreatingConnection(tx, input.actor, delegateClientId);

    const [row] = await tx
      .update(drafts)
      .set({ state: 'approved', updatedAt: new Date() })
      .where(eq(drafts.id, input.draftId))
      .returning();
    await writeAudit(tx, input.actor, {
      action: 'draft.approved',
      targetKind: 'draft',
      targetId: input.draftId,
      policyVersion: APPROVAL_POLICY_VERSION,
      metadata: {
        approval_id: approval.id,
        revision: input.draftRevision,
        payload_digest: input.payloadDigest,
        acknowledged_warnings: input.acknowledgedWarningCodes.length,
      },
    });
    return {
      approvalId: approval.id,
      draft: asDraftRecord(row as unknown as Record<string, unknown>),
    };
  });
}

export async function revokeApproval(actor: Actor, draftId: string): Promise<void> {
  const existing = await loadOwnedDraft(actor, draftId);
  await db().transaction(async (tx) => {
    await lockActiveAccount(tx, existing.ownerUserId);
    const revoked = await tx
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(publicationApprovals.draftId, draftId),
          isNull(publicationApprovals.consumedAt),
          isNull(publicationApprovals.revokedAt),
        ),
      )
      .returning({ id: publicationApprovals.id });
    if (existing.state === 'approved') {
      await tx
        .update(drafts)
        .set({ state: 'ready_for_review', updatedAt: new Date() })
        .where(eq(drafts.id, draftId));
    }
    await writeAudit(tx, actor, {
      action: 'draft.approval_revoked',
      targetKind: 'draft',
      targetId: draftId,
      metadata: { revoked: revoked.length },
    });
  });
}

/** Projects the owner may create an update draft for. */
export async function assertManagesProject(actor: Actor, projectId: string): Promise<void> {
  if (actor.kind === 'anonymous') throw ApiError.notFound();
  const [row] = await db()
    .select({ managerUserId: projects.managerUserId, visibility: projects.visibility })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw ApiError.notFound();
  if (row.managerUserId !== actor.userId) {
    throw ApiError.forbidden('You do not manage this project.');
  }
  if (row.visibility === 'quarantined') {
    throw new ApiError({
      code: ERROR_CODES.QUARANTINED,
      message: 'A quarantined project cannot receive new versions.',
    });
  }
}
