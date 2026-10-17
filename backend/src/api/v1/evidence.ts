/**
 * Test definitions, builds, and test results (BACKEND_PRD section 12.2).
 *
 * Nothing here executes a test, probes a machine, or assigns verification.
 * Submissions are stored private and pending review; reads of private records
 * answer 404 to everyone but the owner.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  TEST_RESULT_SCHEMA_ID,
  anyBuildInputSchema,
  anyTestResultSchema,
  type AnyBuildInput,
} from '@localfirst/contracts';
import type { AppEnv } from '../../http/context.js';
import { hasScope } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { cursorBound, parsePageRequest } from '../../http/envelope.js';
import { success } from '../../http/middleware.js';
import { requireScope } from '../../auth/guards.js';
import { config } from '../../config.js';
import { parseJson, requireFeature } from './body.js';
import { limitPublicRead, limitSubmission } from './limits.js';
import { requireIdempotencyKey, withIdempotency } from '../../services/idempotency.js';
import {
  createBuild,
  listPublicBuilds,
  loadReadableBuild,
  manualReportOf,
  serializeOwnerBuild,
  serializePublicBuild,
  submitterHandle,
  withdrawBuild,
} from '../../services/builds.js';
import {
  listPublicReports,
  loadReadableReport,
  serializeOwnerReport,
  serializePublicReport,
  submitTestResult,
  withdrawReport,
  type ReviewFilter,
} from '../../services/reports.js';
import {
  definitionAvailable,
  loadDefinitionById,
  planTemplate,
  serializeDefinitionDetail,
} from '../../services/test-definitions.js';
import { compatibilityReportsView } from '../../services/evidence.js';
import { loadVersion, loadVisibleProject } from '../../services/projects.js';

const submitEnvelopeSchema = z
  .object({
    result: anyTestResultSchema,
    build_id: z.uuid().optional(),
    build: anyBuildInputSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.build_id === undefined) !== (value.build === undefined),
    'supply exactly one of `build_id` (an owned build) or `build` (an inline build)',
  );

/**
 * A bare sanitized result is accepted as shorthand for an owned build: the
 * result already names its build (`build_id`), which must be one of the
 * submitter's. An inline build needs the envelope form.
 */
const submitResultSchema = z.preprocess((raw) => {
  if (raw !== null && typeof raw === 'object' && (raw as { schema?: unknown }).schema === TEST_RESULT_SCHEMA_ID) {
    return { result: raw, build_id: (raw as { build_id?: unknown }).build_id };
  }
  return raw;
}, submitEnvelopeSchema);

const FEATURE_BUILDS = () => requireFeature('testDefinitions');

// --------------------------------------------------------------------------
// /test-definitions
// --------------------------------------------------------------------------

export const testDefinitionRoutes = new Hono<AppEnv>();

testDefinitionRoutes.get('/:test_id', async (c) => {
  requireFeature('testDefinitions');
  await limitPublicRead(c);
  const definition = await loadDefinitionById(c.req.param('test_id'));
  if (!definition) throw ApiError.notFound();
  await loadVisibleProject({ id: definition.projectId }, c.get('actor'));
  return c.json(success(await serializeDefinitionDetail(definition), c.get('requestId')));
});

testDefinitionRoutes.get('/:test_id/plan', async (c) => {
  requireFeature('testDefinitions');
  await limitPublicRead(c);
  const definition = await loadDefinitionById(c.req.param('test_id'));
  if (!definition) throw ApiError.notFound();
  await loadVisibleProject({ id: definition.projectId }, c.get('actor'));
  if (!definitionAvailable(definition)) {
    // Never issue a plan for something the runner cannot execute.
    throw new ApiError({
      code: 'PLAN_BLOCKED',
      message: 'The first-party runner cannot execute this test definition.',
      details: { refusal_codes: definition.refusalCodes },
    });
  }
  return c.json(success(planTemplate(definition), c.get('requestId')));
});

// --------------------------------------------------------------------------
// /builds
// --------------------------------------------------------------------------

export const buildRoutes = new Hono<AppEnv>();

buildRoutes.post('/', requireScope('builds:write'), async (c) => {
  FEATURE_BUILDS();
  const actor = c.get('actor');
  const body = await parseJson<AnyBuildInput>(c, anyBuildInputSchema);
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  await limitSubmission(c);

  const outcome = await withIdempotency(
    { actor, operation: 'build.create', key, request: body },
    async () => {
      const saved = await createBuild({ actor, build: body });
      return {
        status: saved.buildCreated ? 201 : 200,
        body: serializeOwnerBuild(saved.build, saved.report),
        operationId: saved.report?.operationId ?? null,
      };
    },
  );
  const data = outcome.body as { build_id: string };
  c.header('Location', `${config().apiBaseUrl}/api/v1/builds/${data.build_id}`);
  return c.json(
    success(outcome.body, c.get('requestId'), {
      replayed: outcome.replayed,
      operation_id: outcome.operationId ?? null,
    }),
    outcome.status as 200 | 201,
  );
});

buildRoutes.get('/:build_id', async (c) => {
  FEATURE_BUILDS();
  await limitPublicRead(c);
  const actor = c.get('actor');
  const { record, owner } = await loadReadableBuild(actor, c.req.param('build_id'));
  const report = await manualReportOf(record.id);
  if (owner) return c.json(success(serializeOwnerBuild(record, report), c.get('requestId')));
  return c.json(
    success(
      serializePublicBuild(record, report, await submitterHandle(record.ownerUserId)),
      c.get('requestId'),
    ),
  );
});

buildRoutes.post('/:build_id/withdraw', requireScope('builds:write'), async (c) => {
  FEATURE_BUILDS();
  const result = await withdrawBuild(c.get('actor'), c.req.param('build_id'));
  return c.json(
    success(
      serializeOwnerBuild(result.build, await manualReportOf(result.build.id)),
      c.get('requestId'),
      { withdrawn_reports: result.withdrawnReports },
    ),
  );
});

// --------------------------------------------------------------------------
// /test-results
// --------------------------------------------------------------------------

export const testResultRoutes = new Hono<AppEnv>();

testResultRoutes.post('/', requireScope('tests:submit'), async (c) => {
  requireFeature('resultSubmission');
  const actor = c.get('actor');
  const body = await parseJson(c, submitResultSchema);
  // Creating the build inline is a build write as well.
  if (body.build && !hasScope(actor, 'builds:write')) {
    throw ApiError.insufficientScope(['builds:write']);
  }
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  await limitSubmission(c);

  const outcome = await withIdempotency(
    { actor, operation: 'test_result.submit', key, request: body },
    async () => {
      const saved = await submitTestResult({
        actor,
        result: body.result,
        buildId: body.build_id,
        build: body.build,
      });
      return {
        // Metadata validation is queued; the report is not yet reviewable.
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
  const data = outcome.body as unknown as { report_id: string };
  c.header('Location', `${config().apiBaseUrl}/api/v1/operations/${outcome.operationId ?? ''}`);
  c.header('Retry-After', '2');
  return c.json(
    success(outcome.body, c.get('requestId'), {
      replayed: outcome.replayed,
      operation_id: outcome.operationId ?? null,
      report_id: data.report_id,
    }),
    202,
  );
});

testResultRoutes.get('/:result_id', async (c) => {
  requireFeature('resultSubmission');
  await limitPublicRead(c);
  const { record, owner } = await loadReadableReport(c.get('actor'), c.req.param('result_id'));
  if (owner) return c.json(success(serializeOwnerReport(record), c.get('requestId')));
  return c.json(
    success(serializePublicReport(record, await submitterHandle(record.submitterUserId)), c.get('requestId')),
  );
});

testResultRoutes.post('/:result_id/withdraw', requireScope('tests:submit'), async (c) => {
  requireFeature('resultSubmission');
  const report = await withdrawReport(c.get('actor'), c.req.param('result_id'));
  return c.json(success(serializeOwnerReport(report), c.get('requestId')));
});

// --------------------------------------------------------------------------
// /projects/:project_id/{builds,test-results,compatibility-reports}
// --------------------------------------------------------------------------

export const projectEvidenceRoutes = new Hono<AppEnv>();

projectEvidenceRoutes.get('/:project_id/builds', async (c) => {
  FEATURE_BUILDS();
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const bound = cursorBound({ route: 'project_builds', project: project.id });
  const page = parsePageRequest({ limit: c.req.query('limit'), cursor: c.req.query('cursor') }, bound);
  const listed = await listPublicBuilds(project.id, page, bound);
  return c.json(
    success({ items: listed.items, has_more: listed.hasMore, next_cursor: listed.nextCursor }, c.get('requestId'), {
      evidence_note: 'A build is a configuration; evidence comes only from accepted reports.',
    }),
  );
});

const REVIEW_FILTERS = ['accepted', 'pending', 'rejected', 'all'] as const;

projectEvidenceRoutes.get('/:project_id/test-results', async (c) => {
  requireFeature('resultSubmission');
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const review = (c.req.query('review_state') ?? 'accepted') as ReviewFilter;
  if (!(REVIEW_FILTERS as readonly string[]).includes(review)) {
    throw ApiError.badRequest('`review_state` must be one of accepted, pending, rejected, all.');
  }
  const kind = c.req.query('kind') ?? 'test_run';
  if (!['test_run', 'manual_build', 'all'].includes(kind)) {
    throw ApiError.badRequest('`kind` must be one of test_run, manual_build, all.');
  }
  const bound = cursorBound({ route: 'project_results', project: project.id, review, kind });
  const page = parsePageRequest({ limit: c.req.query('limit'), cursor: c.req.query('cursor') }, bound);
  const listed = await listPublicReports(
    project.id,
    { kind: kind as 'test_run' | 'manual_build' | 'all', review },
    page,
    bound,
  );
  return c.json(
    success({ items: listed.items, has_more: listed.hasMore, next_cursor: listed.nextCursor }, c.get('requestId'), {
      review_state: review,
      scope_note: 'Component-scope evidence only; a pass is not whole-project reproduction.',
    }),
  );
});

projectEvidenceRoutes.get('/:project_id/compatibility-reports', async (c) => {
  requireFeature('resultSubmission');
  await limitPublicRead(c);
  const project = await loadVisibleProject({ id: c.req.param('project_id') }, c.get('actor'));
  const versionId = c.req.query('version');
  if (versionId) await loadVersion(project.id, versionId);
  const view = await compatibilityReportsView({
    projectId: project.id,
    currentVersionId: project.currentVersionId,
    versionId,
  });
  return c.json(success(view, c.get('requestId')));
});

