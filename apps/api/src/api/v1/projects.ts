/**
 * Registry read routes and owner controls (BACKEND_PRD sections 12.1, 12.2).
 *
 * Static paths such as `by-slug` are declared before parameter routes so they
 * can never be shadowed.
 */

import { Hono } from 'hono';
import { getEnvironment, environmentPlanTemplate } from '../../services/environments.js';
import { z } from 'zod';
import {
  compatibilityRequestSchema,
  hardwareSummarySchema,
  TASK_CATEGORIES,
} from '@localfirst/contracts';
import type { AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { parsePageRequest } from '../../http/envelope.js';
import { success } from '../../http/middleware.js';
import { requireHuman, requireScope } from '../../auth/guards.js';
import { config } from '../../config.js';
import {
  changeOwnVisibility,
  exportProjectDocument,
  listPublishedProjects,
  listVersions,
  loadCurrentVersion,
  loadVersion,
  loadVersionRelations,
  loadVisibleProject,
  hydrateSummaries,
  serializeProjectDetail,
  serializeVersion,
} from '../../services/projects.js';
import { assessProjectVersion } from '../../services/assessment.js';
import { parseSearchFilters, searchCursorBound, searchProjects } from '../../services/search.js';
import { createClaimRequest } from '../../services/moderation.js';
import { connectionsActive, recordUsage, usageSeries } from '../../services/usage.js';
import { isOperator } from '../../http/context.js';
import { limitCompatibility, limitPublicRead } from './limits.js';
import { handleCreateDraft } from './drafts.js';

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

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get('/:project_id/versions/:version_id/environments/:environment_key', async c => {
  await limitPublicRead(c);
  return c.json(success(await getEnvironment(c.get('actor'), c.req.param('project_id'), c.req.param('version_id'), c.req.param('environment_key')), c.get('requestId')));
});
projectRoutes.get('/:project_id/versions/:version_id/environments/:environment_key/local-plan', async c => {
  await limitPublicRead(c);
  const runtime = z.enum(['ollama', 'lmstudio']).safeParse(c.req.query('runtime_family'));
  if (!runtime.success) throw ApiError.badRequest('runtime_family must be ollama or lmstudio.');
  const env = await getEnvironment(c.get('actor'), c.req.param('project_id'), c.req.param('version_id'), c.req.param('environment_key'));
  return c.json(success(environmentPlanTemplate(env, runtime.data), c.get('requestId')));
});

projectRoutes.get('/', async (c) => {
  await limitPublicRead(c);
  const raw = Object.fromEntries(
    [...new URL(c.req.url).searchParams.keys()].map((key) => [
      key,
      new URL(c.req.url).searchParams.getAll(key),
    ]),
  );
  const filters = parseSearchFilters(raw);
  const hasFilters =
    filters.q !== null ||
    filters.type.length > 0 ||
    filters.category.length > 0 ||
    filters.model.length > 0 ||
    filters.runtime.length > 0 ||
    filters.hardware.length > 0 ||
    filters.os.length > 0 ||
    filters.test_support.length > 0 ||
    filters.evidence_level.length > 0 ||
    filters.offline !== null ||
    filters.derivative !== null;

  const bound = hasFilters ? searchCursorBound(filters) : 'projects:updated_at';
  const page = parsePageRequest(
    { limit: c.req.query('limit'), cursor: c.req.query('cursor') },
    bound,
  );

  if (!hasFilters) {
    const listed = await listPublishedProjects({ page, bound });
    return c.json(
      success(
        { items: listed.items, has_more: listed.hasMore, next_cursor: listed.nextCursor },
        c.get('requestId'),
        { sort: 'updated_at' },
      ),
    );
  }

  const found = await searchProjects(filters, page);
  // Detail facts come from the authoritative version rows, not the projection.
  const hydrated = await hydrateSummaries(found.items.map((item) => item.project_id));
  const items = found.items
    .map((item) => {
      const summary = hydrated.get(item.project_id);
      return summary ? { ...summary, relevance: item.relevance } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return c.json(
    success({ items, has_more: found.hasMore, next_cursor: found.nextCursor }, c.get('requestId'), {
      sort: filters.sort,
      projection_stale: found.projectionStale,
      evidence_note:
        'Phase 1 records carry `claimed` or `documented` levels only; no test has been run by this registry.',
    }),
  );
});

projectRoutes.get('/by-slug/:slug', async (c) => {
  await limitPublicRead(c);
  const project = await loadVisibleProject({ slug: c.req.param('slug') }, c.get('actor'));
  return c.json(
    success(
      { project_id: project.id, slug: project.slug, url: `${config().apiBaseUrl}/api/v1/projects/${project.id}` },
      c.get('requestId'),
    ),
  );
});

projectRoutes.get('/:project_id', async (c) => {
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const version = await loadCurrentVersion(project);
  if (!version) {
    return c.json(
      success(
        {
          project_id: project.id,
          slug: project.slug,
          visibility: project.visibility,
          current_version: null,
        },
        c.get('requestId'),
      ),
    );
  }
  return c.json(success(await serializeProjectDetail(project, version), c.get('requestId')));
});

projectRoutes.get('/:project_id/versions', async (c) => {
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const versions = await listVersions(project.id);
  return c.json(
    success(
      {
        items: versions.map((version) => ({
          project_version_id: version.id,
          version_number: version.versionNumber,
          spec_version: version.specVersion,
          content_digest: version.contentDigest,
          published_at: version.publishedAt.toISOString(),
          is_current: version.id === project.currentVersionId,
        })),
        has_more: false,
        next_cursor: null,
      },
      c.get('requestId'),
    ),
  );
});

projectRoutes.get('/:project_id/versions/:version_id', async (c) => {
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const version = await loadVersion(project.id, c.req.param('version_id'));
  const relations = await loadVersionRelations(version.id);
  return c.json(success(serializeVersion(project, version, relations), c.get('requestId')));
});

projectRoutes.get('/:project_id/export', async (c) => {
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const versionId = c.req.query('version');
  const version = versionId
    ? await loadVersion(project.id, versionId)
    : await loadCurrentVersion(project);
  if (!version) throw ApiError.notFound();
  if (c.req.method === 'GET') recordUsage(c.get('actor'), project, version.id, 'rest_export');
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="PROJECT.md"`);
  c.header('ETag', `"${version.contentDigest}"`);
  return c.body(exportProjectDocument(version));
});

/**
 * Immutable test definitions of a version, each labelled with whether the
 * first-party runner can execute it. A declared harness is not a shipped runner.
 */
projectRoutes.get('/:project_id/tests', async (c) => {
  if (!config().features.testDefinitions) throw ApiError.phaseUnavailable('Test definitions');
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const versionId = c.req.query('version');
  const version = versionId ? await loadVersion(project.id, versionId) : await loadCurrentVersion(project);
  if (!version) throw ApiError.notFound();
  const relations = await loadVersionRelations(version.id);
  return c.json(
    success(
      { items: relations.tests, has_more: false, next_cursor: null },
      c.get('requestId'),
      {
        project_version_id: version.id,
        runner_available: relations.tests.some((test) => test.runner_available === true),
      },
    ),
  );
});

projectRoutes.post('/:project_id/compatibility-checks', async (c) => {
  await limitCompatibility(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const request = await parseJson(c, compatibilityRequestSchema);
  const version = request.project_version_id
    ? await loadVersion(project.id, request.project_version_id)
    : await loadCurrentVersion(project);
  if (!version) throw ApiError.notFound();

  const assessment = await assessProjectVersion({ project, version, request });
  // `incompatible` and `unknown` are normal outcomes, never HTTP failures.
  return c.json(success(assessment, c.get('requestId')));
});

/** An owned version-update draft for an existing project. */
projectRoutes.post('/:project_id/drafts', requireScope('projects:draft'), (c) =>
  handleCreateDraft(c, c.req.param('project_id')),
);

/**
 * Per-day request series for the project's manager and operators. Everyone else
 * gets the lifetime totals already on the public project record.
 */
projectRoutes.get('/:project_id/usage', requireScope('projects:read'), async (c) => {
  const actor = c.get('actor');
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, actor);
  const isManager = actor.kind !== 'anonymous' && actor.userId === project.managerUserId;
  if (!isManager && !isOperator(actor)) throw ApiError.notFound();
  const [series, active] = await Promise.all([usageSeries(project.id), connectionsActive()]);
  return c.json(
    success({ project_id: project.id, days: series, connections_active: active }, c.get('requestId'), {
      note: 'Request counts since counting began. They do not show a project was built or run.',
    }),
  );
});

projectRoutes.post('/:project_id/unpublish', requireScope('projects:update'), async (c) => {
  const result = await changeOwnVisibility({
    actor: c.get('actor'),
    projectId: c.req.param('project_id'),
    action: 'unpublish',
  });
  return c.json(success(result, c.get('requestId')));
});

projectRoutes.post('/:project_id/republish', requireScope('projects:update'), async (c) => {
  const result = await changeOwnVisibility({
    actor: c.get('actor'),
    projectId: c.req.param('project_id'),
    action: 'republish',
  });
  return c.json(success(result, c.get('requestId')));
});

const claimSchema = z
  .object({
    kind: z.enum(['manager', 'author']),
    evidence: z.string().min(20).max(4000),
  })
  .strict();

projectRoutes.post('/:project_id/claim-requests', requireHuman(), async (c) => {
  const body = await parseJson(c, claimSchema);
  const result = await createClaimRequest({
    actor: c.get('actor'),
    projectId: c.req.param('project_id'),
    kind: body.kind,
    evidence: body.evidence,
  });
  return c.json(
    success(
      {
        ...result,
        note: 'An operator reviews this claim. Nothing transfers automatically, and a GitHub login does not prove control of an organization or document.',
      },
      c.get('requestId'),
    ),
    201,
  );
});

export const hardwareProfileRoutes = new Hono<AppEnv>();

/**
 * Normalize a voluntarily supplied hardware summary. The raw body is never
 * persisted (section 17.5) and nothing here is a machine identifier.
 */
hardwareProfileRoutes.post('/validate', async (c) => {
  await limitCompatibility(c);
  const summary = await parseJson(c, hardwareSummarySchema);
  const unknownFields = Object.entries(summary)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  return c.json(
    success(
      {
        normalized: summary,
        unknown_fields: unknownFields,
        notes: [
          'Values are stored for this request only; no hardware profile is persisted.',
          'System memory and discrete accelerator memory stay separate; unified memory is never counted twice.',
          'Available memory is transient. Recheck it locally before execution.',
        ],
      },
      c.get('requestId'),
    ),
  );
});

export const taskCategories = TASK_CATEGORIES;
