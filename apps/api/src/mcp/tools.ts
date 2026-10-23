/**
 * Hosted MCP tools and resources (BACKEND_PRD section 13).
 *
 * Wire names use underscores and one name is registered per operation. P1/P2
 * tools are absent from discovery until implemented. There is no hosted
 * `local_runtime_discover`, `test_run`, or code-execution tool, and no tool
 * here can reach a user's machine.
 */

import { z } from 'zod';
import { registerEnvironmentTools } from './environments.js';
import {
  McpServer,
  requireScopes,
  ResourceTemplate,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import {
  anyBuildInputSchema,
  comparisonQuerySchema, derivativeDraftInputSchema, collectionInputSchema, troubleshootingInputSchema,
  compatibilityRequestSchema,
  serializeProjectDocument,
  SPEC_SCHEMA_ID,
  TEST_RESULT_SCHEMA_ID,
  TEST_SCHEMA_ID,
  BUILD_SCHEMA_ID,
  anyTestResultSchema,
} from '@localfirst/contracts';
import type { Actor } from '../http/context.js';
import { hasScope } from '../http/context.js';
import type { ProductScope } from '../auth/scopes.js';
import { ApiError, isApiError } from '../http/errors.js';
import { config, independentVerificationEnabled } from '../config.js';
import {
  exportProjectDocument,
  hydrateSummaries,
  loadCurrentVersion,
  loadVersion,
  loadVersionRelations,
  loadVisibleProject,
  normalizedManifest,
  serializeVersion,
} from '../services/projects.js';
import { parseSearchFilters, searchCursorBound, searchProjects } from '../services/search.js';
import { recordUsage } from '../services/usage.js';
import { readHardwareDescriptor, readModelReference } from '../services/references.js';
import { assessProjectVersion } from '../services/assessment.js';
import {
  activeApproval,
  assertManagesProject,
  createDirectProjectDraft,
  createImportProjectDraft,
  loadOwnedDraft,
  patchProjectDraft,
  revalidateDraft,
  serializeDraft,
} from '../services/drafts.js';
import { publishProjectDraft } from '../services/publication.js';
import { isDelegated } from '../services/delegation.js';
import {
  PUBLISH_SCOPE,
  WRITE_SCOPE,
  createRecordDraft,
  isRecordKind,
  patchRecordDraft,
  publishRecordDraft,
  revalidateRecordDraft,
} from '../services/contributions.js';
import {
  createBuild,
  loadReadableBuild,
  manualReportOf,
  serializeOwnerBuild,
  serializePublicBuild,
  submitterHandle,
} from '../services/builds.js';
import {
  loadReadableReport,
  serializeOwnerReport,
  serializePublicReport,
  submitTestResult,
} from '../services/reports.js';
import {
  definitionAvailable,
  loadDefinitionById,
  loadDefinitionByKey,
  planTemplate,
  serializeDefinitionDetail,
} from '../services/test-definitions.js';
import { compatibilityReportsView, summariesForProject } from '../services/evidence.js';
import { requireIdempotencyKey, withIdempotency } from '../services/idempotency.js';
import {
  assertImportSlotAvailable,
  consumeDraftQuota,
  consumePublicationQuota,
  consumeSubmissionQuota,
} from '../api/v1/limits.js';
import { parsePageRequest } from '../http/envelope.js';
import { digestOf } from '@localfirst/contracts';
import { buildSubject } from '../domain/evidence-match.js';
import { publicComparisons } from '../services/comparisons.js';
import { createDerivativeDraft, derivativeView } from '../services/derivatives.js';
import { referenceRelationships } from '../services/relationships.js';
import { listCommunity, saveCommunityRecord } from '../services/community.js';
import { verificationHistory } from '../services/verification.js';
import { projectJsonSchema } from '@localfirst/contracts';

export type ToolResult = CallToolResult;

/**
 * Protocol-level challenge satisfied by any one of the scopes. Per-kind and
 * per-record checks still run in the handler, because a challenge is not
 * authorization.
 */
function requireAnyScope(...scopes: [ProductScope, ...ProductScope[]]) {
  return ({ authInfo }: { authInfo?: { scopes: readonly string[] } | undefined }) => {
    if (!authInfo) return undefined;
    if (scopes.some((scope) => authInfo.scopes.includes(scope))) return undefined;
    return { scopes: [scopes[0]] as [string, ...string[]] };
  };
}

/** Kind-specific write or publish scope for a draft the caller already owns. */
function requireKindScope(
  actor: Actor,
  kind: string,
  mode: 'write' | 'publish',
): ToolResult | null {
  if (['collection', 'troubleshooting'].includes(kind) && !config().features.communityNetwork) return toolError('PHASE_UNAVAILABLE', 'Community contributions are disabled.');
  const table = mode === 'write' ? WRITE_SCOPE : PUBLISH_SCOPE;
  const scope = table[kind as keyof typeof WRITE_SCOPE];
  if (!scope) return toolError('NOT_FOUND', 'The requested record does not exist or is not accessible.');
  return requireToolScope(actor, scope);
}

/** A tool denial returns a stable code and safe remediation, never a stack. */
function toolError(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...(details ? { details } : {}) } },
  };
}

function ok(summary: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

function requireToolScope(actor: Actor, ...scopes: ProductScope[]): ToolResult | null {
  if (actor.kind === 'anonymous') {
    return toolError('UNAUTHENTICATED', 'Authorize this client with Localfirst first.', {
      required_scopes: scopes,
    });
  }
  if (!scopes.some((scope) => hasScope(actor, scope))) {
    return toolError(
      'INSUFFICIENT_SCOPE',
      `This tool requires the ${scopes.join(' or ')} scope. Request it and retry.`,
      { required_scopes: scopes },
    );
  }
  return null;
}

async function guard(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    if (isApiError(error)) {
      return toolError(error.code, error.message, error.details);
    }
    const internal = ApiError.internal();
    return toolError(internal.code, internal.message);
  }
}

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .describe('Caller-generated key; a retry with the same content returns the same result.');

const bundleFile = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(512 * 1024),
});

/**
 * Register the Phase 1 tool surface on a per-request server instance.
 */
export function registerRegistryTools(server: McpServer, actor: Actor): void {
  registerEnvironmentTools(server, actor);
  const apiBase = config().apiBaseUrl;
  if (config().features.communityNetwork) {
    server.registerTool('project_create_derivative_draft', {
      title: 'Create an attributed derivative draft',
      description: 'Pin a public parent version and create your own private project draft. Preserve parent authors and source licenses; no evidence or management rights transfer. Separate human approval is required to publish.',
      inputSchema: derivativeDraftInputSchema.extend({ project_id: z.uuid(), idempotency_key: idempotencyKey }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('projects:draft'),
    }, async args => {
      const denied = requireToolScope(actor, 'projects:draft'); if (denied) return denied;
      return guard(async () => {
        await consumeDraftQuota(actor);
        const { project_id, idempotency_key, ...body } = args;
        const replay = await withIdempotency({ actor, operation: 'derivative.draft', targetKey: project_id, key: idempotency_key, request: body }, async () => ({ status: 201, body: await createDerivativeDraft(actor, project_id, body) }));
        return ok('Derivative draft prepared for exact-artifact review.', { ...replay.body });
      });
    });
    server.registerTool('comparison_get_groups', {
      title: 'Compare accepted public reports', description: 'Bounded protocol groups with the intentionally varying dimension, confounders and exclusions; no universal score.',
      inputSchema: comparisonQuerySchema, annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => { const denied = requireToolScope(actor, 'projects:read'); if (denied) return denied; return guard(async () => ok('Accepted protocol comparison groups.', await publicComparisons(args))); });
    server.registerTool('project_get_derivatives', {
      title: 'Read attributed lineage', description: 'Immutable parent and child versions with original licenses and attribution; no inherited evidence.',
      inputSchema: z.object({ project_id: z.uuid() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => { const denied = requireToolScope(actor, 'projects:read'); if (denied) return denied; return guard(async () => ok('Attributed version lineage.', await derivativeView(args.project_id))); });
    server.registerTool('reference_get_relationships', {
      title: 'Read model or hardware relationships', description: 'Current public project declarations with separately scoped accepted evidence; no transitive compatibility guarantee.',
      inputSchema: z.object({ kind: z.enum(['model', 'hardware']), reference_id: z.uuid() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => { const denied = requireToolScope(actor, 'projects:read'); if (denied) return denied; return guard(async () => ok('Public reference relationships.', await referenceRelationships(args.kind, args.reference_id))); });
    server.registerTool('community_list', {
      title: 'Read curated community knowledge', description: 'Accepted public collections or attributed troubleshooting notes. Curation does not imply upstream author endorsement.',
      inputSchema: z.object({ kind: z.enum(['collection', 'troubleshooting']), project_id: z.uuid().optional(), limit: z.int().min(1).max(100).optional(), cursor: z.string().max(500).optional() }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => { const denied = requireToolScope(actor, 'projects:read'); if (denied) return denied; return guard(async () => ok('Accepted community contributions.', await listCommunity(args.kind, { ...(args.project_id ? { project_id: args.project_id } : {}), ...(args.limit ? { limit: String(args.limit) } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }))); });
    server.registerTool('community_save', {
      title: 'Save a private community contribution', description: 'Save an immutable private collection or attributed troubleshooting note; then create a contribution draft for exact human approval. Publication stays pending until operator review.',
      inputSchema: z.discriminatedUnion('kind', [z.object({ kind: z.literal('collection'), payload: collectionInputSchema, idempotency_key: idempotencyKey }).strict(), z.object({ kind: z.literal('troubleshooting'), payload: troubleshootingInputSchema, idempotency_key: idempotencyKey }).strict()]),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, scopeChallenge: requireScopes('community:write'),
    }, async args => { const denied = requireToolScope(actor, 'community:write'); if (denied) return denied; return guard(async () => {
      await consumeSubmissionQuota(actor);
      const replay = await withIdempotency({ actor, operation: `${args.kind}.save`, key: args.idempotency_key, request: args.payload }, async () => ({ status: 201, body: await saveCommunityRecord(actor, args.kind, args.payload) }));
      return ok('Private community contribution saved.', replay.body);
    }); });
    if (independentVerificationEnabled()) server.registerTool('test_get_verifications', {
      title: 'Read independent verification provenance', description: 'Read separate human operator decisions linked to independently reproduced exact component claims, including revocation/ineligibility history.',
      inputSchema: z.object({ report_id: z.uuid() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => { const denied = requireToolScope(actor, 'projects:read'); if (denied) return denied; return guard(async () => ok('Scoped independent verification history.', await verificationHistory(args.report_id))); });
  }


  server.registerTool(
    'project_search',
    {
      title: 'Search local-AI projects',
      description:
        'Search published Localfirst projects by text, type, task category, model, runtime, hardware, OS, declared test support, evidence level, and whether a project is a remix (derivative) of another. Returns visible public records only.',
      inputSchema: z.object({
        q: z.string().max(200).optional(),
        type: z.array(z.string()).max(7).optional(),
        category: z.array(z.string()).max(10).optional(),
        model: z.array(z.string()).max(10).optional(),
        runtime: z.array(z.string()).max(10).optional(),
        hardware: z.array(z.string()).max(10).optional(),
        os: z.array(z.string()).max(4).optional(),
        test_support: z.array(z.string()).max(3).optional(),
        evidence_level: z.array(z.string()).max(5).optional(),
        offline: z.enum(['yes', 'no', 'unknown']).optional(),
        derivative: z.enum(['yes', 'no']).optional(),
        sort: z.enum(['relevance', 'updated_at', 'evidence_freshness']).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      // RFC 6750 challenge at the protocol layer; the handler re-checks, because
      // metadata annotations never enforce authorization (section 13.3).
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const raw: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(args)) {
          if (value === undefined) continue;
          raw[key] = Array.isArray(value) ? (value as string[]) : String(value);
        }
        delete raw.cursor;
        delete raw.limit;
        const filters = parseSearchFilters(raw);
        const bound = searchCursorBound(filters);
        const page = parsePageRequest(
          { limit: args.limit ? String(args.limit) : undefined, cursor: args.cursor },
          bound,
        );
        const found = await searchProjects(filters, page);
        const hydrated = await hydrateSummaries(found.items.map((item) => item.project_id));
        const items = found.items
          .map((item) => hydrated.get(item.project_id))
          .filter((item): item is NonNullable<typeof item> => item !== undefined);
        return ok(
          `${items.length} project${items.length === 1 ? '' : 's'} matched. Phase 1 records carry claimed or documented evidence only: accepted reports are scoped community evidence; the registry does not execute tests.`,
          {
            items,
            has_more: found.hasMore,
            next_cursor: found.nextCursor,
            projection_stale: found.projectionStale,
          },
        );
      });
    },
  );

  server.registerTool(
    'project_get',
    {
      title: 'Get a project specification',
      description:
        'Read one project by ID or slug, with its immutable specification, source provenance, attribution, model/runtime/hardware references, and declared test support.',
      inputSchema: z.object({
        project: z.string().min(1).max(100).describe('Project ID or public slug'),
        version_id: z.string().max(64).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      // RFC 6750 challenge at the protocol layer; the handler re-checks, because
      // metadata annotations never enforce authorization (section 13.3).
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const isUuid = /^[0-9a-f-]{36}$/i.test(args.project);
        const project = await loadVisibleProject(
          isUuid ? { id: args.project } : { slug: args.project },
          actor,
        );
        const version = args.version_id
          ? await loadVersion(project.id, args.version_id)
          : await loadCurrentVersion(project);
        if (!version) throw ApiError.notFound();
        const relations = await loadVersionRelations(version.id);
        recordUsage(actor, project, version.id, 'mcp_retrieval');
        return ok(
          `${version.derived.name} (${project.slug}) version ${version.specVersion}. Declared test support: ${version.derived.test_support}; runner executability is reported per test definition.`,
          {
            project: {
              project_id: project.id,
              slug: project.slug,
              visibility: project.visibility,
              listing_origin: project.listingOrigin,
            },
            version: serializeVersion(project, version, relations),
            resources: {
              manifest: `localfirst://projects/${project.id}/versions/${version.id}/manifest`,
              documentation: `localfirst://projects/${project.id}/versions/${version.id}/documentation`,
            },
            export_url: `${apiBase}/api/v1/projects/${project.id}/export?version=${version.id}`,
          },
        );
      });
    },
  );

  server.registerTool(
    'project_check_compatibility',
    {
      title: 'Assess declared compatibility',
      description:
        'Assess a project version against voluntarily shared environment facts. The registry never probes your machine; unknown critical facts return `unknown` rather than a guess.',
      inputSchema: z.object({
        project: z.string().min(1).max(100),
        request: compatibilityRequestSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      // RFC 6750 challenge at the protocol layer; the handler re-checks, because
      // metadata annotations never enforce authorization (section 13.3).
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const isUuid = /^[0-9a-f-]{36}$/i.test(args.project);
        const project = await loadVisibleProject(
          isUuid ? { id: args.project } : { slug: args.project },
          actor,
        );
        const version = args.request.project_version_id
          ? await loadVersion(project.id, args.request.project_version_id)
          : await loadCurrentVersion(project);
        if (!version) throw ApiError.notFound();
        const assessment = await assessProjectVersion({ project, version, request: args.request });
        return ok(
          `Outcome: ${assessment.outcome} (evidence level ${assessment.evidence_level}, scope ${assessment.evidence_scope}). ${assessment.blockers.length} blocker(s), ${assessment.uncertainties.length} uncertainty note(s).`,
          assessment as unknown as Record<string, unknown>,
        );
      });
    },
  );

  server.registerTool(
    'contribution_create_draft',
    {
      title: 'Create a contribution draft',
      description:
        'Create a private draft. Kind `project` takes PROJECT.md text and bundled test files, or a bounded public GitHub import. Kind `build` or `test_result` takes the ID of your own saved private record and optional selections for what becomes public. Publication always needs separate human approval of the exact artifact.',
      inputSchema: z.object({
        kind: z.enum(config().features.communityNetwork ? ['project', 'build', 'test_result', 'collection', 'troubleshooting'] as const : ['project', 'build', 'test_result'] as const).default('project'),
        project_id: z.string().max(64).optional().describe('Set to create a version update draft'),
        project_md: z.string().max(256 * 1024).optional(),
        files: z.array(bundleFile).max(20).optional(),
        source_import: z
          .object({
            provider: z.literal('github'),
            repository_url: z.string().max(2048),
            ref: z.string().max(120),
            manifest_path: z.string().max(200),
          })
          .optional(),
        record_id: z.string().max(64).optional().describe('Your own saved build, test result, collection or troubleshooting note'),
        selection: z.record(z.string(), z.unknown()).optional().describe('What to share publicly; defaults share the least'),
        idempotency_key: idempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: requireAnyScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'),
    },
    async (args) => {
      const denied = requireKindScope(actor, args.kind, 'write');
      if (denied) return denied;
      if (actor.kind === 'anonymous') return toolError('UNAUTHENTICATED', 'Authorize first.');
      const owner = actor.userId;

      if (args.kind !== 'project') {
        if (!args.record_id) {
          return toolError('BAD_REQUEST', 'Record contribution kinds need a `record_id`.');
        }
        const recordKind = args.kind;
        const recordId = args.record_id;
        return guard(async () => {
          const key = requireIdempotencyKey(args.idempotency_key, 'idempotency_key');
          await consumeDraftQuota(actor);
          const outcome = await withIdempotency(
            { actor, operation: 'draft.create', key, request: args },
            async () => {
              const { draftRow } = await createRecordDraft({
                actor,
                kind: recordKind,
                recordId,
                selection: args.selection ?? {},
              });
              return {
                status: 201,
                body: serializeDraft(await loadOwnedDraft(actor, draftRow.id)) as unknown as Record<string, unknown>,
              };
            },
          );
          const draft = outcome.body as unknown as ReturnType<typeof serializeDraft>;
          return ok(
            `Draft ${draft.draft_id} created at revision ${draft.revision}. ${draft.ready_for_review ? 'Ready for human review at' : 'Fix the listed issues, then review at'} ${draft.review_url}`,
            { ...draft, replayed: outcome.replayed },
          );
        });
      }

      if ((args.project_md === undefined) === (args.source_import === undefined)) {
        return toolError(
          'BAD_REQUEST',
          'Supply either `project_md` for direct submission or `source_import` for a bounded import.',
        );
      }
      return guard(async () => {
        if (args.project_id) {
          if (!hasScope(actor, 'projects:update')) {
            throw ApiError.insufficientScope(['projects:update']);
          }
          await assertManagesProject(actor, args.project_id);
        }
        const key = requireIdempotencyKey(args.idempotency_key, 'idempotency_key');
        await consumeDraftQuota(actor);
        const outcome = await withIdempotency(
          { actor, operation: 'draft.create', key, request: args },
          async () => {
            if (args.source_import) {
              if (!config().features.githubImport) {
                throw ApiError.phaseUnavailable('Source import');
              }
              await assertImportSlotAvailable(owner);
              const created = await createImportProjectDraft({
                actor,
                ownerUserId: owner,
                projectId: args.project_id ?? null,
                descriptor: args.source_import,
              });
              return {
                status: 202,
                body: { ...serializeDraft(created.draft), operation_id: created.operationId },
                operationId: created.operationId,
              };
            }
            const created = await createDirectProjectDraft({
              actor,
              ownerUserId: owner,
              projectId: args.project_id ?? null,
              payload: { project_md: args.project_md ?? '', files: args.files ?? [] },
            });
            return { status: 201, body: serializeDraft(created.draft) };
          },
        );
        const draft = outcome.body as ReturnType<typeof serializeDraft>;
        return ok(
          outcome.status === 202
            ? `Draft ${draft.draft_id} created and importing. Poll operation ${outcome.operationId}.`
            : `Draft ${draft.draft_id} created at revision ${draft.revision}. ${draft.ready_for_review ? 'Ready for human review at' : 'Fix the listed issues, then review at'} ${draft.review_url}`,
          { ...draft, operation_id: outcome.operationId ?? null, replayed: outcome.replayed },
        );
      });
    },
  );

  server.registerTool(
    'draft_get',
    {
      title: 'Get your draft',
      description:
        'Read one of your own drafts with its validation issues, warning codes, approval state, the human review URL, and whether this connection may publish without a per-artifact approval (`publication_delegated`).',
      inputSchema: z.object({ draft_id: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireAnyScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'),
    },
    async (args) => {
      const early = requireToolScope(actor, 'projects:draft', 'builds:write', 'tests:submit', 'community:write');
      if (early) return early;
      return guard(async () => {
        const draft = await loadOwnedDraft(actor, args.draft_id);
        const scoped = requireKindScope(actor, draft.kind, 'write');
        if (scoped) return scoped;
        const approval = await activeApproval(draft.id);
        const delegated = await isDelegated(actor);
        const serialized = { ...serializeDraft(draft, approval), publication_delegated: delegated };
        return ok(
          `Draft ${draft.id} is ${draft.state} at revision ${draft.revision}. ${delegated
            ? 'Its owner lets this connection publish without a per-artifact approval.'
            : 'Publishing needs the owner to approve it at the review URL.'}`,
          serialized as unknown as Record<string, unknown>,
        );
      });
    },
  );

  server.registerTool(
    'draft_update',
    {
      title: 'Update your draft',
      description:
        'Apply a bounded edit to your draft: PROJECT.md and files for a project draft, or `selection` for a build or test-result draft. The revision increments and any human approval is invalidated, so the exact new artifact must be approved again.',
      inputSchema: z.object({
        draft_id: z.string().min(1).max(64),
        expected_revision: z.int().positive(),
        project_md: z.string().max(256 * 1024).optional(),
        files: z.array(bundleFile).max(20).optional(),
        selection: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      scopeChallenge: requireAnyScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'),
    },
    async (args) => {
      const early = requireToolScope(actor, 'projects:draft', 'builds:write', 'tests:submit', 'community:write');
      if (early) return early;
      return guard(async () => {
        const target = await loadOwnedDraft(actor, args.draft_id);
        const scoped = requireKindScope(actor, target.kind, 'write');
        if (scoped) return scoped;
        if (isRecordKind(target.kind)) {
          if (args.selection === undefined) {
            return toolError('BAD_REQUEST', 'A build or test-result patch must change `selection`.');
          }
          await patchRecordDraft({
            actor,
            draftId: target.id,
            expectedRevision: args.expected_revision,
            selection: args.selection,
          });
          const updated = await loadOwnedDraft(actor, target.id);
          return ok(
            `Draft ${updated.id} is now revision ${updated.revision}; any previous approval was revoked.`,
            serializeDraft(updated) as unknown as Record<string, unknown>,
          );
        }
        if (args.project_md === undefined && args.files === undefined) {
          return toolError('BAD_REQUEST', 'A patch must change `project_md` or `files`.');
        }
        const patch: { project_md?: string; files?: Array<{ path: string; content: string }> } = {};
        if (args.project_md !== undefined) patch.project_md = args.project_md;
        if (args.files !== undefined) patch.files = args.files;
        const { draft } = await patchProjectDraft({
          actor,
          draftId: args.draft_id,
          expectedRevision: args.expected_revision,
          patch,
        });
        const serialized = serializeDraft(draft);
        return ok(
          `Draft ${draft.id} is now revision ${draft.revision}; any previous approval was revoked.`,
          serialized as unknown as Record<string, unknown>,
        );
      });
    },
  );

  server.registerTool(
    'draft_validate',
    {
      title: 'Validate your draft',
      description:
        'Validate a draft against the specification schema and registry policy, or recompute the exact public projection of a build or test-result draft. The ready state is derived; content changes only if the underlying record moved.',
      inputSchema: z.object({
        draft_id: z.string().min(1).max(64),
        expected_revision: z.int().positive().optional(),
      }),
      // Validation updates derived state, so it is not annotated read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: requireAnyScope('projects:draft', 'builds:write', 'tests:submit', 'community:write'),
    },
    async (args) => {
      const early = requireToolScope(actor, 'projects:draft', 'builds:write', 'tests:submit', 'community:write');
      if (early) return early;
      return guard(async () => {
        const target = await loadOwnedDraft(actor, args.draft_id);
        const scoped = requireKindScope(actor, target.kind, 'write');
        if (scoped) return scoped;
        if (isRecordKind(target.kind)) {
          const { validation } = await revalidateRecordDraft({
            actor,
            draftId: target.id,
            expectedRevision: args.expected_revision,
          });
          const refreshed = await loadOwnedDraft(actor, target.id);
          return ok(
            validation.readyForReview
              ? `Draft ${refreshed.id} is ready for human review at ${config().apiBaseUrl}/review/drafts/${refreshed.id}. ${validation.warning_codes.length} warning(s) must be acknowledged there.`
              : `Draft ${refreshed.id} has blocking issues.`,
            {
              draft: serializeDraft(refreshed),
              issues: validation.issues,
              warning_codes: validation.warning_codes,
              ready_for_review: validation.readyForReview,
              projection: validation.projection,
              payload_digest: validation.payloadDigest,
            },
          );
        }
        const { draft, validation } = await revalidateDraft(
          actor,
          args.draft_id,
          args.expected_revision,
        );
        const errors = validation.issues.filter((issue) => issue.severity === 'error');
        return ok(
          validation.readyForReview
            ? `Draft ${draft.id} is ready for human review at ${config().apiBaseUrl}/review/drafts/${draft.id}. ${validation.warning_codes.length} warning(s) must be acknowledged there.`
            : `Draft ${draft.id} has ${errors.length} blocking issue(s).`,
          {
            draft: serializeDraft(draft),
            issues: validation.issues,
            warning_codes: validation.warning_codes,
            ready_for_review: validation.readyForReview,
            proposed_slug: validation.proposedSlug,
            content_digest: validation.content_digest,
          },
        );
      });
    },
  );

  server.registerTool(
    'contribution_publish',
    {
      title: 'Publish an approved contribution',
      description:
        'Publish the exact artifact a person approved in a browser session, passing that `approval_id`. If the owner lets this connection publish without asking (`publication_delegated` from draft_get), omit `approval_id` and list `acknowledged_warning_codes` for every warning on the draft instead; the owner sees what you published and can unpublish it. The draft revision and payload digest must match the current draft either way. A published build or test result is public but pending review: publication never verifies anything.',
      inputSchema: z.object({
        draft_id: z.string().min(1).max(64),
        approval_id: z.string().min(1).max(64).optional(),
        acknowledged_warning_codes: z.array(z.string().max(64)).max(50).optional(),
        draft_revision: z.int().positive(),
        payload_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        idempotency_key: idempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: requireAnyScope('projects:publish', 'builds:publish', 'tests:publish', 'community:publish'),
    },
    async (args) => {
      const early = requireToolScope(actor, 'projects:publish', 'builds:publish', 'tests:publish', 'community:publish');
      if (early) return early;
      return guard(async () => {
        const target = await loadOwnedDraft(actor, args.draft_id);
        const scoped = requireKindScope(actor, target.kind, 'publish');
        if (scoped) return scoped;
        const key = requireIdempotencyKey(args.idempotency_key, 'idempotency_key');
        await consumePublicationQuota(actor);
        if (isRecordKind(target.kind)) {
          const published = await withIdempotency(
            { actor, operation: 'draft.publish', targetKey: args.draft_id, key, request: args },
            async () => {
              const result = await publishRecordDraft({
                actor,
                draftId: args.draft_id,
                approvalId: args.approval_id ?? null,
                draftRevision: args.draft_revision,
                payloadDigest: args.payload_digest,
                acknowledgedWarningCodes: args.acknowledged_warning_codes ?? [],
              });
              return { status: 201, body: result as unknown as Record<string, unknown> };
            },
          );
          return ok(
            `Published ${target.kind} ${(published.body as { record_id: string }).record_id}: public, review pending, no evidence level.`,
            { ...published.body, replayed: published.replayed },
          );
        }
        const outcome = await withIdempotency(
          {
            actor,
            operation: 'draft.publish',
            targetKey: args.draft_id,
            key,
            request: args,
          },
          async () => {
            const result = await publishProjectDraft({
              actor,
              draftId: args.draft_id,
              approvalId: args.approval_id ?? null,
              draftRevision: args.draft_revision,
              payloadDigest: args.payload_digest,
              acknowledgedWarningCodes: args.acknowledged_warning_codes ?? [],
            });
            return { status: 201, body: result as unknown as Record<string, unknown> };
          },
        );
        const result = outcome.body as { slug: string; version_number: number; evidence_level: string };
        return ok(
          `Published ${result.slug} version ${result.version_number} with evidence level ${result.evidence_level}. Publication records no test evidence.`,
          { ...outcome.body, replayed: outcome.replayed },
        );
      });
    },
  );

  // --- Phase 1 evidence tools ---------------------------------------------
  const evidenceEnabled = config().features.testDefinitions;
  if (evidenceEnabled) registerEvidenceTools(server, actor);
}

/**
 * Read, plan, build, and result tools. None of them executes a test, probes a
 * machine, or can assign verification: the registry stores what a person
 * uploaded and what an operator later decides.
 */
function registerEvidenceTools(server: McpServer, actor: Actor): void {
  const resultsEnabled = config().features.resultSubmission;
  const projectRef = z.string().min(1).max(100).describe('Project ID or public slug');

  server.registerTool(
    'test_get',
    {
      title: 'Get a test definition',
      description:
        'Read an immutable test definition: its manifest with public fixtures, independent manifest/fixture/evaluator/bundle digests, and whether the first-party runner can execute it. Identify it by ID, or by project, optional version, and test key.',
      inputSchema: z.object({
        test_definition_id: z.string().max(64).optional(),
        project: projectRef.optional(),
        version_id: z.string().max(64).optional(),
        test_key: z.string().max(64).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const definition = await resolveDefinition(actor, args);
        const detail = await serializeDefinitionDetail(definition);
        return ok(
          `Test ${definition.key}: ${definition.executable ? 'the first-party runner can execute it' : 'declared, but the first-party runner cannot execute it'}.`,
          detail,
        );
      });
    },
  );

  server.registerTool(
    'test_plan_local',
    {
      title: 'Get a generic local test plan',
      description:
        'Return the generic local plan template for an executable test: requirements, resource effects, digests, and the separate consent stages. It probes nothing and executes nothing; the real plan is sealed and approved on your own machine.',
      inputSchema: z.object({
        test_definition_id: z.string().max(64).optional(),
        project: projectRef.optional(),
        version_id: z.string().max(64).optional(),
        test_key: z.string().max(64).optional(),
        runtime_family: z.enum(['ollama', 'lmstudio']).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const definition = await resolveDefinition(actor, args);
        if (!definitionAvailable(definition)) {
          throw new ApiError({
            code: 'PLAN_BLOCKED',
            message: 'The first-party runner cannot execute this test definition.',
            details: { refusal_codes: definition.refusalCodes },
          });
        }
        const template = planTemplate(definition);
        return ok(
          `Generic plan for ${definition.key}. Nothing was probed or executed; run it with the local CLI after approving the exact plan there.`,
          { ...template, target_runtime: args.runtime_family ?? null },
        );
      });
    },
  );

  server.registerTool(
    'build_save',
    {
      title: 'Save a private build',
      description:
        'Save an actual sanitized build configuration (model bindings, runtime, hardware summary, effective settings) as a private, immutable record, optionally with a manual report for projects without a test harness. Saving carries no evidence authority; identical content returns the same build.',
      inputSchema: z.object({
        build: anyBuildInputSchema.describe(`A ${BUILD_SCHEMA_ID} document without server-only fields`),
        idempotency_key: idempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: requireScopes('builds:write'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'builds:write');
      if (denied) return denied;
      return guard(async () => {
        const key = requireIdempotencyKey(args.idempotency_key, 'idempotency_key');
        await consumeSubmissionQuota(actor);
        const outcome = await withIdempotency(
          { actor, operation: 'build.create', key, request: args.build },
          async () => {
            const saved = await createBuild({ actor, build: args.build });
            return {
              status: saved.buildCreated ? 201 : 200,
              body: serializeOwnerBuild(saved.build, saved.report),
              operationId: saved.report?.operationId ?? null,
            };
          },
        );
        const body = outcome.body as { build_id: string; reproducibility: string };
        return ok(
          `Build ${body.build_id} saved privately (reproducibility: ${body.reproducibility}). It carries no evidence until a reviewed report is attached and published.`,
          { ...outcome.body, operation_id: outcome.operationId ?? null, replayed: outcome.replayed },
        );
      });
    },
  );

  server.registerTool(
    'build_get',
    {
      title: 'Get a build',
      description:
        'Read a public build projection, or one of your own private builds with its server-derived reproducibility and manual-report status.',
      inputSchema: z.object({ build_id: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireAnyScope('projects:read', 'builds:write'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read', 'builds:write');
      if (denied) return denied;
      return guard(async () => {
        const { record, owner } = await loadReadableBuild(actor, args.build_id);
        const report = await manualReportOf(record.id);
        const view = owner
          ? serializeOwnerBuild(record, report)
          : serializePublicBuild(record, report, await submitterHandle(record.ownerUserId));
        return ok(`Build ${record.id} (${record.visibility}, reproducibility ${record.reproducibility}).`, view);
      });
    },
  );

  if (!resultsEnabled) return;

  server.registerTool(
    'test_submit_result',
    {
      title: 'Submit a sanitized test result',
      description:
        'Upload the sanitized result of a local run as a private report with an owned build ID or an inline build. It is stored pending review, never verified, and validated asynchronously; this tool never runs a test. Use only a result the person explicitly chose to upload.',
      inputSchema: z.object({
        result: anyTestResultSchema.describe(`A ${TEST_RESULT_SCHEMA_ID} document`),
        build_id: z.string().max(64).optional(),
        build: anyBuildInputSchema.optional(),
        idempotency_key: idempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: requireScopes('tests:submit'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'tests:submit');
      if (denied) return denied;
      // Without an inline build the result's own `build_id` names the owned build.
      const buildId = args.build ? undefined : (args.build_id ?? args.result.build_id);
      if (args.build && args.build_id !== undefined) {
        return toolError('BAD_REQUEST', 'Supply either `build_id` or an inline `build`, not both.');
      }
      if (args.build) {
        const inline = requireToolScope(actor, 'builds:write');
        if (inline) return inline;
      }
      return guard(async () => {
        const key = requireIdempotencyKey(args.idempotency_key, 'idempotency_key');
        await consumeSubmissionQuota(actor);
        const outcome = await withIdempotency(
          { actor, operation: 'test_result.submit', key, request: { result: args.result, build_id: buildId, build: args.build } },
          async () => {
            const saved = await submitTestResult({
              actor,
              result: args.result,
              buildId,
              build: args.build,
            });
            return {
              status: 202,
              body: {
                ...serializeOwnerReport(saved.report),
                build: { build_id: saved.build.id, created: saved.buildCreated },
                created: saved.created,
              },
              operationId: saved.report.operationId,
            };
          },
        );
        const body = outcome.body as unknown as { report_id: string };
        return ok(
          `Result ${body.report_id} stored privately and pending review. Poll operation ${outcome.operationId} for validation; nothing was executed.`,
          { ...outcome.body, operation_id: outcome.operationId ?? null, replayed: outcome.replayed },
        );
      });
    },
  );

  server.registerTool(
    'test_get_result',
    {
      title: 'Get a test result',
      description:
        'Read a public result projection, or one of your own private results with its validation checks and review state.',
      inputSchema: z.object({ result_id: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireAnyScope('projects:read', 'tests:submit'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read', 'tests:submit');
      if (denied) return denied;
      return guard(async () => {
        const { record, owner } = await loadReadableReport(actor, args.result_id);
        const view = owner
          ? serializeOwnerReport(record)
          : serializePublicReport(record, await submitterHandle(record.submitterUserId));
        return ok(
          `Result ${record.id}: review ${record.reviewState}, evidence level ${record.evidenceLevel ?? 'none'}.`,
          view,
        );
      });
    },
  );

  server.registerTool(
    'build_get_evidence',
    {
      title: 'Get accepted evidence',
      description:
        'List accepted, public evidence for a project, including accepted failures, with evidence levels, distinct-contributor counts, conflicts, and freshness. Optionally narrow by version, test key, or build.',
      inputSchema: z.object({
        project: projectRef,
        version_id: z.string().max(64).optional(),
        test_key: z.string().max(64).optional(),
        build_id: z.string().max(64).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('projects:read'),
    },
    async (args) => {
      const denied = requireToolScope(actor, 'projects:read');
      if (denied) return denied;
      return guard(async () => {
        const isUuid = /^[0-9a-f-]{36}$/i.test(args.project);
        const project = await loadVisibleProject(isUuid ? { id: args.project } : { slug: args.project }, actor);
        const version = args.version_id ? await loadVersion(project.id, args.version_id) : null;
        const view = (await compatibilityReportsView({
          projectId: project.id,
          currentVersionId: project.currentVersionId,
          versionId: version?.id,
        })) as { summaries: Array<{ test_definition_id: string | null; subject: unknown; summary_id: string; project_version_id: string; configuration_key: string }> } & Record<string, unknown>;

        let summaries = view.summaries;
        if (args.test_key) {
          const versionId = version?.id ?? project.currentVersionId;
          const definition = versionId ? await loadDefinitionByKey(versionId, args.test_key) : null;
          summaries = summaries.filter((entry) => entry.test_definition_id === (definition?.id ?? '__none__'));
        }
        if (args.build_id) {
          const { record } = await loadReadableBuild(actor, args.build_id);
          const fingerprints = new Map(
            (await summariesForProject(project.id)).map((row) => [row.id, row.subjectFingerprint]),
          );
          // Summaries are built from public projections; a private build has none, so no evidence matches it.
          const fingerprint = record.publicProjection
            ? digestOf(buildSubject(record.publicProjection as unknown as typeof record.payload))
            : null;
          summaries = summaries.filter((entry) => fingerprint !== null && fingerprints.get(entry.summary_id) === fingerprint);
        }
        return ok(
          `${summaries.length} accepted evidence group(s). Only accepted, public reports on public builds are counted; failures are included.`,
          { ...view, summaries },
        );
      });
    },
  );
}

async function resolveDefinition(
  actor: Actor,
  args: { test_definition_id?: string | undefined; project?: string | undefined; version_id?: string | undefined; test_key?: string | undefined },
) {
  if (args.test_definition_id) {
    const definition = await loadDefinitionById(args.test_definition_id);
    if (!definition) throw ApiError.notFound();
    await loadVisibleProject({ id: definition.projectId }, actor);
    return definition;
  }
  if (!args.project || !args.test_key) {
    throw ApiError.badRequest('Supply `test_definition_id`, or `project` and `test_key`.');
  }
  const isUuid = /^[0-9a-f-]{36}$/i.test(args.project);
  const project = await loadVisibleProject(isUuid ? { id: args.project } : { slug: args.project }, actor);
  const version = args.version_id ? await loadVersion(project.id, args.version_id) : await loadCurrentVersion(project);
  if (!version) throw ApiError.notFound();
  const definition = await loadDefinitionByKey(version.id, args.test_key);
  if (!definition) throw ApiError.notFound();
  return definition;
}

/**
 * Register the Phase 1 resource surface. Each read re-applies visibility and
 * ownership rules; a known ID grants nothing by itself (section 13.4).
 */
export function registerRegistryResources(server: McpServer, actor: Actor): void {
  const read = async (uri: URL | string): Promise<{ contents: Array<Record<string, unknown>> }> => {
    const resolved = await readRegistryResource({ uri: uri.toString(), actor });
    return {
      contents: [
        {
          uri: resolved.uri,
          mimeType: resolved.mimeType,
          text: resolved.text,
          ...(resolved.digest ? { _meta: { content_digest: resolved.digest } } : {}),
        },
      ],
    };
  };

  for (const entry of staticResourceTemplates()) {
    const config = {
      title: entry.name,
      description: entry.description,
      mimeType: entry.mimeType,
      scopeChallenge: requireScopes(entry.scope),
    };
    if (entry.uriTemplate.includes('{')) {
      server.registerResource(
        entry.name,
        new ResourceTemplate(entry.uriTemplate, { list: undefined }),
        config,
        (async (uri: URL) => read(uri)) as never,
      );
    } else {
      server.registerResource(
        entry.name,
        entry.uriTemplate,
        config,
        (async (uri: URL) => read(uri)) as never,
      );
    }
  }
}

export interface ResourceReadInput {
  uri: string;
  actor: Actor;
}

/**
 * Resolve a `localfirst://` resource URI. Knowledge of an ID never grants
 * access: every read re-applies visibility and ownership rules.
 */
export async function readRegistryResource(
  input: ResourceReadInput,
): Promise<{ uri: string; mimeType: string; text: string; digest?: string }> {
  const { uri, actor } = input;
  if (
    !hasScope(actor, 'projects:read') &&
    !hasScope(actor, 'projects:draft') &&
    !hasScope(actor, 'builds:write') &&
    !hasScope(actor, 'tests:submit')
  ) {
    throw ApiError.insufficientScope(['projects:read']);
  }

  const schemaMatch = /^localfirst:\/\/schemas\/project\/v0\.2$/.exec(uri);
  if (schemaMatch) {
    return {
      uri,
      mimeType: 'application/schema+json',
      text: JSON.stringify(projectJsonSchema(config().apiBaseUrl), null, 2),
    };
  }

  const versionMatch =
    /^localfirst:\/\/projects\/([^/]+)\/versions\/([^/]+)\/(manifest|documentation)$/.exec(uri);
  if (versionMatch) {
    const [, projectId, versionId, kind] = versionMatch as unknown as [string, string, string, string];
    const project = await loadVisibleProject({ id: projectId }, actor);
    const version = await loadVersion(project.id, versionId);
    recordUsage(actor, project, version.id, 'mcp_retrieval');
    if (kind === 'manifest') {
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            schema: SPEC_SCHEMA_ID,
            content_digest: version.contentDigest,
            manifest: normalizedManifest(version),
          },
          null,
          2,
        ),
        digest: version.contentDigest,
      };
    }
    return {
      uri,
      mimeType: 'text/markdown',
      text: exportProjectDocument(version),
      digest: version.contentDigest,
    };
  }

  const draftMatch = /^localfirst:\/\/drafts\/([^/]+)$/.exec(uri);
  if (draftMatch) {
    const draft = await loadOwnedDraft(actor, draftMatch[1] as string);
    const approval = await activeApproval(draft.id);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(serializeDraft(draft, approval), null, 2),
    };
  }

  const definitionMatch = /^localfirst:\/\/test-definitions\/([^/]+)$/.exec(uri);
  if (definitionMatch && config().features.testDefinitions) {
    const definition = await loadDefinitionById(definitionMatch[1] as string);
    if (!definition) throw ApiError.notFound();
    await loadVisibleProject({ id: definition.projectId }, actor);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        { schema: TEST_SCHEMA_ID, ...(await serializeDefinitionDetail(definition)) },
        null,
        2,
      ),
      digest: definition.manifestDigest,
    };
  }

  const buildMatch = /^localfirst:\/\/builds\/([^/]+)$/.exec(uri);
  if (buildMatch && config().features.testDefinitions) {
    const { record, owner } = await loadReadableBuild(actor, buildMatch[1] as string);
    const report = await manualReportOf(record.id);
    const view = owner
      ? serializeOwnerBuild(record, report)
      : serializePublicBuild(record, report, await submitterHandle(record.ownerUserId));
    return { uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2), digest: record.contentDigest };
  }

  const resultMatch = /^localfirst:\/\/test-results\/([^/]+)$/.exec(uri);
  if (resultMatch && config().features.resultSubmission) {
    const { record, owner } = await loadReadableReport(actor, resultMatch[1] as string);
    const view = owner
      ? serializeOwnerReport(record)
      : serializePublicReport(record, await submitterHandle(record.submitterUserId));
    return { uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2), digest: record.contentDigest };
  }

  const modelMatch = /^localfirst:\/\/models\/([^/]+)$/.exec(uri);
  if (modelMatch) {
    const view = await readModelReference(modelMatch[1] as string);
    if (!view) throw ApiError.notFound();
    return { uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) };
  }

  const hardwareMatch = /^localfirst:\/\/hardware\/([^/]+)$/.exec(uri);
  if (hardwareMatch) {
    const view = await readHardwareDescriptor(hardwareMatch[1] as string);
    if (!view) throw ApiError.notFound();
    return { uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) };
  }

  // Resource families of phases that are not implemented answer as unavailable.
  if (/^localfirst:\/\/(tests|builds|test-results|test-definitions)\//.test(uri)) {
    throw ApiError.phaseUnavailable('This resource family');
  }
  throw ApiError.notFound();
}

export function staticResourceTemplates(): Array<{
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  scope: ProductScope;
}> {
  return [
    {
      uriTemplate: 'localfirst://projects/{project_id}/versions/{version_id}/manifest',
      name: 'Project manifest',
      description: 'Normalized specification JSON with its content digest.',
      mimeType: 'application/json',
      scope: 'projects:read',
    },
    {
      uriTemplate: 'localfirst://projects/{project_id}/versions/{version_id}/documentation',
      name: 'Project documentation',
      description: 'Portable PROJECT.md export for a published version.',
      mimeType: 'text/markdown',
      scope: 'projects:read',
    },
    {
      uriTemplate: 'localfirst://models/{model_reference_id}',
      name: 'Model reference',
      description: 'External model, version, and license references, with the visible projects that declare it. No weights.',
      mimeType: 'application/json',
      scope: 'projects:read',
    },
    {
      uriTemplate: 'localfirst://hardware/{hardware_descriptor_id}',
      name: 'Hardware descriptor',
      description: 'Coarse public hardware descriptor and the visible projects that declare it. No private machine profile.',
      mimeType: 'application/json',
      scope: 'projects:read',
    },
    {
      uriTemplate: 'localfirst://drafts/{draft_id}',
      name: 'Your draft',
      description: 'Owned draft content with validation and approval state.',
      mimeType: 'application/json',
      scope: 'projects:draft',
    },
    ...(config().features.testDefinitions
      ? [
          {
            uriTemplate: 'localfirst://test-definitions/{test_definition_id}',
            name: 'Test definition',
            description: 'Immutable test manifest, public fixtures, and digests.',
            mimeType: 'application/json',
            scope: 'projects:read' as ProductScope,
          },
          {
            uriTemplate: 'localfirst://builds/{build_id}',
            name: 'Build',
            description: 'A public build projection, or your own private build.',
            mimeType: 'application/json',
            scope: 'projects:read' as ProductScope,
          },
        ]
      : []),
    ...(config().features.resultSubmission
      ? [
          {
            uriTemplate: 'localfirst://test-results/{result_id}',
            name: 'Test result',
            description: 'A public result projection, or your own private result.',
            mimeType: 'application/json',
            scope: 'projects:read' as ProductScope,
          },
        ]
      : []),
    {
      uriTemplate: 'localfirst://schemas/project/v0.2',
      name: 'Specification schema',
      description: `JSON Schema for ${SPEC_SCHEMA_ID} (test contract: ${TEST_SCHEMA_ID}).`,
      mimeType: 'application/schema+json',
      scope: 'projects:read',
    },
  ];
}

export { serializeProjectDocument };
