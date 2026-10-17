/**
 * Source import orchestration (BACKEND_PRD sections 15.1, 16.3).
 *
 * Retrieval happens outside long database transactions; applying the result
 * uses a short lock plus a generation check, so a late import can never
 * overwrite newer edits.
 */

import { lockActiveAccount } from './accounts.js';
import { and, eq, sql } from 'drizzle-orm';
import { drafts, publicationApprovals } from '../db/schema/registry.js';
import { db } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { createOperation, markOperationFailed, markOperationSucceeded } from './operations.js';
import { enqueueJob } from './jobs.js';
import { emitEvent } from './outbox.js';
import { writeAudit } from './audit.js';
import { loadOwnedDraft, serializeDraft } from './drafts.js';
import { validateDraft } from './validation.js';
import { importProjectFromGitHub, type ImportDescriptor, type ImportResult } from '../sources/github.js';
import { SourceFetchError } from '../sources/safe-fetch.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('import');

export interface RequestImportInput {
  actor: Actor;
  draftId: string;
  descriptor: ImportDescriptor;
}

/** Queue an import attempt against an existing draft and return 202 data. */
export async function requestDraftImport(
  input: RequestImportInput,
): Promise<{ body: Record<string, unknown>; operationId: string }> {
  const existing = await loadOwnedDraft(input.actor, input.draftId);

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, existing.ownerUserId);
    const [row] = await tx
      .update(drafts)
      .set({
        state: 'ingesting',
        importDescriptor: input.descriptor,
        importError: null,
        // A new attempt invalidates any in-flight result from an older one.
        sourceGeneration: sql`${drafts.sourceGeneration} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(drafts.id, existing.id))
      .returning();
    if (!row) throw ApiError.notFound();

    // An import changes content, so any live approval is no longer valid.
    await tx
      .update(publicationApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(publicationApprovals.draftId, existing.id),
          sql`${publicationApprovals.consumedAt} is null`,
          sql`${publicationApprovals.revokedAt} is null`,
        ),
      );

    const operationId = await createOperation(tx, {
      kind: 'project.source_import',
      actor: input.actor,
      targetKind: 'draft',
      targetId: existing.id,
      requiredScope: 'projects:draft',
    });
    await tx.update(drafts).set({ operationId }).where(eq(drafts.id, existing.id));
    await enqueueJob(tx, {
      kind: 'source_import',
      payload: { draft_id: existing.id, generation: row.sourceGeneration },
      dedupeKey: `source_import:${existing.id}:${row.sourceGeneration}`,
      operationId,
    });
    await emitEvent(tx, {
      eventType: 'draft.import_requested',
      aggregateKind: 'draft',
      aggregateId: existing.id,
      payload: {
        provider: input.descriptor.provider,
        manifest_path: input.descriptor.manifest_path,
        generation: row.sourceGeneration,
      },
    });
    await writeAudit(tx, input.actor, {
      action: 'draft.import_requested',
      targetKind: 'draft',
      targetId: existing.id,
      metadata: {
        provider: input.descriptor.provider,
        repository_url: input.descriptor.repository_url,
        ref: input.descriptor.ref,
        manifest_path: input.descriptor.manifest_path,
        generation: row.sourceGeneration,
      },
    });

    return {
      body: {
        ...serializeDraft({
          ...existing,
          state: 'ingesting',
          operationId,
          importDescriptor: input.descriptor,
        }),
        operation_id: operationId,
      },
      operationId,
    };
  });
}

export class ImportRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportRejected';
    this.code = code;
  }
}

export interface RunImportInput {
  draftId: string;
  generation: number;
  operationId: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Execute one import attempt. Retrieval is outside the transaction; the result
 * is applied only if the draft's generation is still current.
 */
export async function runDraftImport(input: RunImportInput): Promise<'applied' | 'stale'> {
  const [draft] = await db().select().from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
  if (!draft) throw new ImportRejected('NOT_FOUND', 'The draft no longer exists.');
  if (draft.sourceGeneration !== input.generation || draft.state !== 'ingesting') {
    // Discard or a newer attempt invalidated this queued result.
    return 'stale';
  }
  const descriptor = draft.importDescriptor as ImportDescriptor | null;
  if (!descriptor) throw new ImportRejected('NOT_FOUND', 'The draft has no import descriptor.');

  let result: ImportResult;
  try {
    result = await importProjectFromGitHub(
      descriptor,
      input.fetchImpl ? { fetchImpl: input.fetchImpl } : {},
    );
  } catch (error) {
    const code = error instanceof SourceFetchError ? error.code : 'SOURCE_UNAVAILABLE';
    const message =
      error instanceof SourceFetchError || error instanceof Error
        ? error.message
        : 'The source could not be imported.';
    await failImport(input.draftId, input.generation, input.operationId, code, message);
    throw new ImportRejected(code, message);
  }

  const validation = await validateDraft({
    payload: result.payload,
    ownerUserId: draft.ownerUserId,
    projectId: draft.projectId,
  });

  const applied = await db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ sourceGeneration: drafts.sourceGeneration, state: drafts.state })
      .from(drafts)
      .where(eq(drafts.id, input.draftId))
      .for('update');
    if (!locked || locked.sourceGeneration !== input.generation || locked.state !== 'ingesting') {
      return false;
    }
    await tx
      .update(drafts)
      .set({
        payload: result.payload,
        payloadDigest: validation.payload_digest,
        manifest: validation.manifest ?? null,
        markdown: validation.markdown,
        derived: validation.derived ?? null,
        contentDigest: validation.content_digest,
        issues: validation.issues,
        warningCodes: validation.warning_codes,
        importError: null,
        importDescriptor: {
          ...descriptor,
          provenance: result.provenance,
          repository: result.repository,
          files_read: result.files_read,
          bytes_read: result.bytes_read,
        },
        state: validation.readyForReview ? 'ready_for_review' : 'editable',
        revision: sql`${drafts.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(drafts.id, input.draftId));
    return true;
  });

  if (!applied) return 'stale';

  if (input.operationId) {
    await markOperationSucceeded(input.operationId, {
      draft_id: input.draftId,
      resolved_commit: result.repository.resolved_commit,
      provider_repo_id: result.repository.provider_repo_id,
      files_read: result.files_read,
      ready_for_review: validation.readyForReview,
      issue_count: validation.issues.length,
    });
  }
  log.info(
    {
      draft_id: input.draftId,
      resolved_commit: result.repository.resolved_commit,
      files_read: result.files_read.length,
      bytes_read: result.bytes_read,
      ready_for_review: validation.readyForReview,
    },
    'import applied',
  );
  return 'applied';
}

async function failImport(
  draftId: string,
  generation: number,
  operationId: string | null,
  code: string,
  message: string,
): Promise<void> {
  await db()
    .update(drafts)
    .set({
      state: 'ingestion_failed',
      importError: { code, message: message.slice(0, 500) },
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.sourceGeneration, generation)));
  if (operationId) await markOperationFailed(operationId, code, message.slice(0, 500));
}
