/**
 * Draft routes (BACKEND_PRD section 12.1).
 *
 * Both API and MCP expose preparation, editing, validation, and publication of
 * every implemented contribution kind. The human approval boundary is the only
 * browser-only step.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ERROR_CODES } from '@localfirst/contracts';
import type { AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { parseIfMatchRevision, revisionEtag } from '../../http/envelope.js';
import { success } from '../../http/middleware.js';
import { requireApprover, requireScope } from '../../auth/guards.js';
import { loadReviewData } from '../../services/review.js';
import { config } from '../../config.js';
import {
  activeApproval,
  assertManagesProject,
  createApproval,
  createDirectProjectDraft,
  createImportProjectDraft,
  discardDraft,
  listOwnedDrafts,
  loadOwnedDraft,
  patchProjectDraft,
  revalidateDraft,
  revokeApproval,
  serializeDraft,
} from '../../services/drafts.js';
import { publishProjectDraft } from '../../services/publication.js';
import { isDelegated } from '../../services/delegation.js';
import {
  PUBLISH_SCOPE,
  WRITE_SCOPE,
  createRecordDraft,
  isRecordKind,
  patchRecordDraft,
  publishRecordDraft,
  revalidateRecordDraft,
} from '../../services/contributions.js';
import { hasScope, type Actor } from '../../http/context.js';
import {
  requireIdempotencyKey,
  withIdempotency,
} from '../../services/idempotency.js';
import { getOperationForActor, serializeOperation } from '../../services/operations.js';
import { assertImportSlotAvailable, limitDraftCreation, limitPublication } from './limits.js';

const bundleFileSchema = z
  .object({
    path: z.string().min(1).max(200),
    content: z.string().max(512 * 1024),
  })
  .strict();

const importDescriptorSchema = z
  .object({
    provider: z.literal('github'),
    repository_url: z.string().min(1).max(2048),
    ref: z.string().min(1).max(120),
    manifest_path: z.string().min(1).max(200),
  })
  .strict();

/** Contribution kinds a draft can hold; the write scope depends on the kind. */
const recordDraftSchema = z
  .object({
    kind: z.enum(['build', 'test_result', 'collection', 'troubleshooting']),
    record_id: z.uuid(),
    selection: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const projectDraftSchema = z
  .object({
    kind: z.literal('project').default('project'),
    project_id: z.uuid().optional(),
    project_md: z.string().max(256 * 1024).optional(),
    files: z.array(bundleFileSchema).max(20).optional(),
    source_import: importDescriptorSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.project_md === undefined) !== (value.source_import === undefined),
    'supply either `project_md` (direct submission) or `source_import` (bounded import)',
  );

const createDraftSchema = z.union([recordDraftSchema, projectDraftSchema]);

type DraftKindName = keyof typeof WRITE_SCOPE;

/** The write or publish scope for this draft's kind; read scopes never grant either. */
export function assertDraftScope(actor: Actor, kind: string, mode: 'write' | 'publish'): void {
  if (['collection', 'troubleshooting'].includes(kind) && !config().features.communityNetwork) throw ApiError.phaseUnavailable('Community contributions');
  const table = mode === 'write' ? WRITE_SCOPE : PUBLISH_SCOPE;
  const scope = table[kind as DraftKindName];
  if (!scope) throw ApiError.notFound();
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  if (!actor.scopes.has(scope)) throw ApiError.insufficientScope([scope]);
}

const patchDraftSchema = z
  .object({
    project_md: z.string().max(256 * 1024).optional(),
    files: z.array(bundleFileSchema).max(20).optional(),
  })
  .strict()
  .refine(
    (value) => value.project_md !== undefined || value.files !== undefined,
    'a patch must change `project_md` or `files`',
  );

const patchRecordDraftSchema = z
  .object({ selection: z.record(z.string(), z.unknown()) })
  .strict();

const approvalSchema = z
  .object({
    draft_revision: z.int().positive(),
    payload_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    acknowledged_warning_codes: z.array(z.string().max(64)).max(50).default([]),
    decision: z.enum(['approved', 'denied']).default('approved'),
    /** Also let the connection that created the draft publish without asking (section 10.4). */
    delegate_connection: z.boolean().default(false),
  })
  .strict();

/** An approval ID, or for a delegated connection its own warning acknowledgements instead. */
const publishSchema = z
  .object({
    approval_id: z.uuid().optional(),
    acknowledged_warning_codes: z.array(z.string().max(64)).max(50).optional(),
    draft_revision: z.int().positive(),
    payload_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict()
  .refine((body) => !(body.approval_id && body.acknowledged_warning_codes), {
    message: 'Send either approval_id or acknowledged_warning_codes, not both.',
  });

async function parseJson<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw ApiError.badRequest('A JSON request body is required.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ApiError.badRequest('The request body is not valid.', {
      issues: result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export const draftRoutes = new Hono<AppEnv>();

/**
 * Shared by `POST /drafts` and `POST /projects/:project_id/drafts`; the second
 * supplies the project from the path (section 12.1).
 */
export async function handleCreateDraft(
  c: Context<AppEnv>,
  projectIdFromPath?: string,
): Promise<Response> {
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const parsedBody = await parseJson(c, createDraftSchema);
  if (parsedBody.kind !== 'project') {
    if (projectIdFromPath) throw ApiError.badRequest('A build or result draft is not tied to a project path.');
    assertDraftScope(actor, parsedBody.kind, 'write');
    const record = parsedBody;
    const recordKey = requireIdempotencyKey(c.req.header('Idempotency-Key'));
    await limitDraftCreation(c);
    const created = await withIdempotency(
      { actor, operation: 'draft.create', key: recordKey, request: record },
      async () => {
        const { draftRow } = await createRecordDraft({
          actor,
          kind: record.kind,
          recordId: record.record_id,
          selection: record.selection ?? {},
        });
        return {
          status: 201,
          body: serializeDraft(await loadOwnedDraft(actor, draftRow.id)) as unknown as Record<string, unknown>,
        };
      },
    );
    const createdDraft = created.body as { revision: number };
    c.header('ETag', revisionEtag(createdDraft.revision));
    return c.json(success(created.body, c.get('requestId'), { replayed: created.replayed }), 201);
  }
  assertDraftScope(actor, 'project', 'write');
  const projectParsed = parsedBody as z.infer<typeof projectDraftSchema>;
  const body = projectIdFromPath ? { ...projectParsed, project_id: projectIdFromPath } : projectParsed;
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  await limitDraftCreation(c);

  if (body.project_id) {
    // A version update needs the update scope as well as draft rights.
    if (!actor.scopes.has('projects:update')) {
      throw ApiError.insufficientScope(['projects:update']);
    }
    await assertManagesProject(actor, body.project_id);
  }

  const outcome = await withIdempotency(
    { actor, operation: 'draft.create', key, request: body },
    async () => {
      if (body.source_import) {
        if (!config().features.githubImport) {
          throw ApiError.phaseUnavailable('Source import');
        }
        await assertImportSlotAvailable(actor.userId);
        const { draft, operationId } = await createImportProjectDraft({
          actor,
          ownerUserId: actor.userId,
          projectId: body.project_id ?? null,
          descriptor: body.source_import,
        });
        return {
          status: 202,
          body: {
            ...serializeDraft(draft),
            operation_id: operationId,
          },
          operationId,
        };
      }
      const { draft } = await createDirectProjectDraft({
        actor,
        ownerUserId: actor.userId,
        projectId: body.project_id ?? null,
        payload: { project_md: body.project_md ?? '', files: body.files ?? [] },
      });
      return { status: 201, body: serializeDraft(draft) };
    },
  );

  if (outcome.status === 202) {
    const draftId = (outcome.body as { draft_id: string }).draft_id;
    c.header('Location', `${config().apiBaseUrl}/api/v1/operations/${outcome.operationId}`);
    c.header('Retry-After', '2');
    return c.json(
      success(outcome.body, c.get('requestId'), {
        operation_id: outcome.operationId,
        draft_id: draftId,
        replayed: outcome.replayed,
      }),
      202,
    );
  }
  const draft = outcome.body as { revision: number };
  c.header('ETag', revisionEtag(draft.revision));
  return c.json(
    success(outcome.body, c.get('requestId'), { replayed: outcome.replayed }),
    201,
  );
}

draftRoutes.post('/', requireScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'), (c) => handleCreateDraft(c));

draftRoutes.get('/', requireScope('projects:draft', 'projects:read', 'builds:write', 'tests:submit', 'community:write'), async (c) => {
  const actor = c.get('actor');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw ApiError.badRequest('limit must be an integer between 1 and 100.');
  }
  const kind = c.req.query('kind');
  const state = c.req.query('state');
  const rows = (await listOwnedDrafts(actor, { kind, state, limit })).filter((draft) =>
    draft.kind === 'project'
      ? hasScope(actor, 'projects:draft') || hasScope(actor, 'projects:read')
      : hasScope(actor, WRITE_SCOPE[draft.kind as DraftKindName]),
  );
  return c.json(
    success(
      { items: rows.map((draft) => serializeDraft(draft)), has_more: false, next_cursor: null },
      c.get('requestId'),
    ),
  );
});

draftRoutes.get('/:draft_id', requireScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'), async (c) => {
  const actor = c.get('actor');
  const draft = await loadOwnedDraft(actor, c.req.param('draft_id'));
  assertDraftScope(actor, draft.kind, 'write');
  const approval = await activeApproval(draft.id);
  c.header('ETag', revisionEtag(draft.revision));
  return c.json(success(
    { ...serializeDraft(draft, approval), publication_delegated: await isDelegated(actor) },
    c.get('requestId'),
  ));
});

draftRoutes.patch('/:draft_id', requireScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'), async (c) => {
  const actor = c.get('actor');
  const expected = parseIfMatchRevision(c.req.header('If-Match'));
  if (expected === null) {
    throw new ApiError({
      code: ERROR_CODES.REVISION_PRECONDITION_REQUIRED,
      message: 'An If-Match revision ETag is required to edit a draft.',
      details: { example: 'If-Match: W/"rev-1"' },
    });
  }
  const target = await loadOwnedDraft(actor, c.req.param('draft_id'));
  assertDraftScope(actor, target.kind, 'write');
  if (isRecordKind(target.kind)) {
    const recordPatch = await parseJson(c, patchRecordDraftSchema);
    await patchRecordDraft({
      actor,
      draftId: target.id,
      expectedRevision: expected,
      selection: recordPatch.selection,
    });
    const updated = await loadOwnedDraft(actor, target.id);
    c.header('ETag', revisionEtag(updated.revision));
    return c.json(success(serializeDraft(updated), c.get('requestId')));
  }
  const patch = await parseJson(c, patchDraftSchema);
  const { draft } = await patchProjectDraft({
    actor,
    draftId: c.req.param('draft_id'),
    expectedRevision: expected,
    patch,
  });
  c.header('ETag', revisionEtag(draft.revision));
  return c.json(success(serializeDraft(draft), c.get('requestId')));
});

draftRoutes.post('/:draft_id/validate', requireScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'), async (c) => {
  const actor = c.get('actor');
  const expectedRaw = c.req.query('expected_revision');
  const expected = expectedRaw ? Number(expectedRaw) : undefined;
  const target = await loadOwnedDraft(actor, c.req.param('draft_id'));
  assertDraftScope(actor, target.kind, 'write');
  if (isRecordKind(target.kind)) {
    const { validation: recordValidation } = await revalidateRecordDraft({
      actor,
      draftId: target.id,
      expectedRevision: expected,
    });
    const refreshed = await loadOwnedDraft(actor, target.id);
    const liveApproval = await activeApproval(refreshed.id);
    c.header('ETag', revisionEtag(refreshed.revision));
    return c.json(
      success(
        {
          ...serializeDraft(refreshed, liveApproval),
          validation: {
            issues: recordValidation.issues,
            warning_codes: recordValidation.warning_codes,
            ready_for_review: recordValidation.readyForReview,
            projection: recordValidation.projection,
            payload_digest: recordValidation.payloadDigest,
          },
        },
        c.get('requestId'),
      ),
    );
  }
  const { draft, validation } = await revalidateDraft(actor, c.req.param('draft_id'), expected);
  const approval = await activeApproval(draft.id);
  c.header('ETag', revisionEtag(draft.revision));
  return c.json(
    success(
      {
        ...serializeDraft(draft, approval),
        validation: {
          issues: validation.issues,
          warning_codes: validation.warning_codes,
          ready_for_review: validation.readyForReview,
          proposed_slug: validation.proposedSlug,
          content_digest: validation.content_digest,
          declared_tests: validation.tests.map((test) => ({
            path: test.path,
            key: test.manifest.key,
            scope: test.manifest.scope,
            harness: test.manifest.harness,
            // A declared harness is not a shipped runner (section 1.2).
            runner_available: false,
          })),
        },
      },
      c.get('requestId'),
    ),
  );
});

draftRoutes.post('/:draft_id/import', requireScope('projects:draft'), async (c) => {
  if (!config().features.githubImport) throw ApiError.phaseUnavailable('Source import');
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const draftId = c.req.param('draft_id');
  const descriptor = await parseJson(c, importDescriptorSchema);
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  await limitDraftCreation(c);
  await assertImportSlotAvailable(actor.userId);

  const existing = await loadOwnedDraft(actor, draftId);
  if (existing.state === 'published' || existing.state === 'discarded') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${existing.state}\` cannot import a source.`,
    });
  }

  const outcome = await withIdempotency(
    { actor, operation: 'draft.import', targetKey: draftId, key, request: descriptor },
    async () => {
      const { requestDraftImport } = await import('../../services/import.js');
      const result = await requestDraftImport({ actor, draftId, descriptor });
      return { status: 202, body: result.body, operationId: result.operationId };
    },
  );
  c.header('Location', `${config().apiBaseUrl}/api/v1/operations/${outcome.operationId}`);
  c.header('Retry-After', '2');
  return c.json(
    success(outcome.body, c.get('requestId'), { operation_id: outcome.operationId }),
    202,
  );
});

// --- Human-only approval surface ------------------------------------------

draftRoutes.get('/:draft_id/review', requireApprover(), async (c) => {
  const draft = await loadOwnedDraft(c.get('actor'), c.req.param('draft_id'));
  const review = await loadReviewData(draft);
  const approval = await activeApproval(draft.id);
  return c.json(
    success(
      {
        draft: serializeDraft(draft, approval),
        stale: review.stale,
        content: review.content,
        content_label: review.contentLabel,
        content_digest: review.contentDigest,
        slug: review.slug,
        files: (draft.payload.files ?? []).map((file) => ({ path: file.path, content: file.content })),
        issues: review.issues,
        warning_codes: review.warningCodes,
        approval_window_seconds: config().ttl.approvalSeconds,
      },
      c.get('requestId'),
    ),
  );
});

draftRoutes.post('/:draft_id/approval', requireApprover(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session' && actor.kind !== 'approver') throw ApiError.forbidden('A signed-in person is required.');
  const body = await parseJson(c, approvalSchema);
  if (body.delegate_connection && actor.kind !== 'session') {
    throw ApiError.forbidden('Delegating publication needs a browser session.');
  }
  const { approvalId, draft } = await createApproval({
    actor,
    draftId: c.req.param('draft_id'),
    draftRevision: body.draft_revision,
    payloadDigest: body.payload_digest,
    acknowledgedWarningCodes: body.acknowledged_warning_codes,
    decision: body.decision,
    sessionId: actor.kind === 'session' ? actor.sessionId : null,
    approverCredentialId: actor.kind === 'approver' ? actor.credentialId : null,
    delegateConnection: body.delegate_connection,
  });
  const approval = await activeApproval(draft.id);
  return c.json(
    success(
      {
        approval_id: approvalId,
        decision: body.decision,
        draft: serializeDraft(draft, approval),
      },
      c.get('requestId'),
    ),
    approvalId ? 201 : 200,
  );
});

draftRoutes.delete('/:draft_id/approval', requireApprover(), async (c) => {
  await revokeApproval(c.get('actor'), c.req.param('draft_id'));
  return c.body(null, 204);
});

draftRoutes.post('/:draft_id/publish', requireScope('projects:publish', 'builds:publish', 'tests:publish', 'community:publish'), async (c) => {
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const body = await parseJson(c, publishSchema);
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  const draftId = c.req.param('draft_id');
  const target = await loadOwnedDraft(actor, draftId);
  assertDraftScope(actor, target.kind, 'publish');
  await limitPublication(c);

  if (isRecordKind(target.kind)) {
    const published = await withIdempotency(
      { actor, operation: 'draft.publish', targetKey: draftId, key, request: body },
      async () => {
        const result = await publishRecordDraft({
          actor,
          draftId,
          approvalId: body.approval_id ?? null,
          draftRevision: body.draft_revision,
          payloadDigest: body.payload_digest,
          acknowledgedWarningCodes: body.acknowledged_warning_codes ?? [],
        });
        return { status: 201, body: result as unknown as Record<string, unknown> };
      },
    );
    return c.json(
      success(published.body, c.get('requestId'), { replayed: published.replayed }),
      201,
    );
  }

  const outcome = await withIdempotency(
    { actor, operation: 'draft.publish', targetKey: draftId, key, request: body },
    async () => {
      const result = await publishProjectDraft({
        actor,
        draftId,
        approvalId: body.approval_id ?? null,
        draftRevision: body.draft_revision,
        payloadDigest: body.payload_digest,
        acknowledgedWarningCodes: body.acknowledged_warning_codes ?? [],
      });
      return { status: 201, body: result as unknown as Record<string, unknown> };
    },
  );
  c.header('Location', `${config().apiBaseUrl}/api/v1/projects/${(outcome.body as { project_id: string }).project_id}`);
  return c.json(
    success(outcome.body, c.get('requestId'), { replayed: outcome.replayed }),
    201,
  );
});

draftRoutes.delete('/:draft_id', requireScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'), async (c) => {
  const target = await loadOwnedDraft(c.get('actor'), c.req.param('draft_id'));
  assertDraftScope(c.get('actor'), target.kind, 'write');
  await discardDraft(c.get('actor'), c.req.param('draft_id'));
  return c.body(null, 204);
});

export const operationRoutes = new Hono<AppEnv>();

operationRoutes.get('/:operation_id', async (c) => {
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const record = await getOperationForActor(c.req.param('operation_id'), actor);
  if (record.state === 'queued' || record.state === 'running') c.header('Retry-After', '2');
  return c.json(success(serializeOperation(record), c.get('requestId')));
});
