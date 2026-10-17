/**
 * OpenAPI document for the *implemented* REST contract (section 12.3).
 *
 * Future-phase routes are deliberately absent: a feature that has not shipped
 * is not advertised.
 */

import {
  buildJsonSchema,
  environmentJsonSchemas,
  buildReportJsonSchema,
  projectJsonSchema,
  testResultJsonSchema,
} from '@localfirst/contracts';
import { communityPaths } from './community-openapi.js';
import type { AppConfig } from '../config.js';
import { advertisedScopes, PRODUCT_SCOPES } from '../auth/scopes.js';

const envelope = (dataSchema: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: dataSchema,
    meta: {
      type: 'object',
      required: ['request_id'],
      properties: { request_id: { type: 'string' } },
      additionalProperties: true,
    },
  },
});

const errorResponse = {
  description: 'Error envelope with a stable code',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error', 'meta'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'retryable'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              retryable: { type: 'boolean' },
              details: { type: 'object', additionalProperties: true },
            },
          },
          meta: { type: 'object', properties: { request_id: { type: 'string' } } },
        },
      },
    },
  },
};

const standardErrors = {
  '400': errorResponse,
  '401': errorResponse,
  '403': errorResponse,
  '404': errorResponse,
  '409': errorResponse,
  '422': errorResponse,
  '429': errorResponse,
};


const idParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const ok = (description: string) => ({ '200': { description }, ...standardErrors });

function environmentPaths(): Record<string, unknown> {
  const path = '/api/v1/projects/{project_id}/versions/{version_id}/environments/{environment_key}';
  const parameters = [idParam('project_id'), idParam('version_id'), idParam('environment_key')];
  return {
    [path]: { get: { tags: ['registry'], summary: 'Retrieve an immutable agent environment and its digest-bound bundle', parameters, responses: ok('Environment bundle; no execution') } },
    [path + '/local-plan']: { get: { tags: ['registry'], summary: 'Prepare a pinned local environment handoff without probing or execution', parameters: [...parameters, { name: 'runtime_family', in: 'query', required: true, schema: { type: 'string', enum: ['ollama', 'lmstudio'] } }], responses: ok('Local plan template') } },
  };
}

/** Phase 1 evidence surface; present only when the matching gate is on. */
function evidencePaths(config: AppConfig): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  if (config.features.testDefinitions) {
    paths['/api/v1/test-definitions/{test_id}'] = {
      get: {
        tags: ['evidence'],
        summary: 'Immutable test definition: manifest, public fixtures, digests, runner availability',
        parameters: [idParam('test_id')],
        responses: ok('Test definition'),
      },
    };
    paths['/api/v1/test-definitions/{test_id}/plan'] = {
      get: {
        tags: ['evidence'],
        summary: 'Generic local plan template (no machine probing, no execution)',
        description:
          'Answers 422 `PLAN_BLOCKED` for a definition the first-party runner cannot execute. The real plan is sealed and approved locally.',
        parameters: [idParam('test_id')],
        responses: ok('Plan template'),
      },
    };
    paths['/api/v1/projects/{project_id}/tests'] = {
      get: {
        tags: ['evidence'],
        summary: 'Test definitions of a version, each with `runner_available`',
        parameters: [
          idParam('project_id'),
          { name: 'version', in: 'query', schema: { type: 'string' } },
        ],
        responses: ok('Test definitions'),
      },
    };
    paths['/api/v1/builds'] = {
      post: {
        tags: ['evidence'],
        summary: 'Save a private immutable build, optionally with a manual report',
        description:
          'Scope `builds:write`. `id`, `visibility`, and `reproducibility` are server-only and rejected if sent. Identical content returns the same build.',
        security: [{ localfirstOAuth: ['builds:write'] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Build' } } },
        },
        responses: {
          '200': { description: 'The existing identical build' },
          '201': { description: 'Build saved privately' },
          ...standardErrors,
        },
      },
    };
    paths['/api/v1/builds/{build_id}'] = {
      get: {
        tags: ['evidence'],
        summary: 'Public approved build projection, or your own private build',
        parameters: [idParam('build_id')],
        responses: ok('Build'),
      },
    };
    paths['/api/v1/builds/{build_id}/withdraw'] = {
      post: {
        tags: ['evidence'],
        summary: 'Withdraw your build and its reports; schedules reaggregation',
        security: [{ localfirstOAuth: ['builds:write'] }],
        parameters: [idParam('build_id')],
        responses: ok('Withdrawn build'),
      },
    };
    paths['/api/v1/projects/{project_id}/builds'] = {
      get: {
        tags: ['evidence'],
        summary: 'Public approved build configurations',
        parameters: [idParam('project_id'), { $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: ok('Builds'),
      },
    };
  }
  if (config.features.resultSubmission) {
    paths['/api/v1/test-results'] = {
      post: {
        tags: ['evidence'],
        summary: 'Upload a sanitized private test result (never executes anything)',
        description:
          'Scope `tests:submit` (plus `builds:write` for an inline build). The body is a sanitized result naming one of your builds in `build_id`, or an envelope `{result, build_id | build}`. Returns 202 with an operation while metadata validation runs. The report is stored `pending`, never verified; a repeated client run ID with identical content replays, with different content conflicts.',
        security: [{ localfirstOAuth: ['tests:submit'] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/TestResult' },
                  {
                    type: 'object',
                    required: ['result'],
                    properties: {
                      result: { $ref: '#/components/schemas/TestResult' },
                      build_id: { type: 'string', format: 'uuid' },
                      build: { $ref: '#/components/schemas/Build' },
                    },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
        },
        responses: { '202': { description: 'Stored privately; validation queued' }, ...standardErrors },
      },
    };
    paths['/api/v1/test-results/{result_id}'] = {
      get: {
        tags: ['evidence'],
        summary: 'Public result projection, or your own private result',
        parameters: [idParam('result_id')],
        responses: ok('Test result'),
      },
    };
    paths['/api/v1/test-results/{result_id}/withdraw'] = {
      post: {
        tags: ['evidence'],
        summary: 'Withdraw your result; removes it from evidence and schedules reaggregation',
        security: [{ localfirstOAuth: ['tests:submit'] }],
        parameters: [idParam('result_id')],
        responses: ok('Withdrawn result'),
      },
    };
    paths['/api/v1/projects/{project_id}/test-results'] = {
      get: {
        tags: ['evidence'],
        summary: 'Public reports (default: accepted only) with review status',
        parameters: [
          idParam('project_id'),
          { name: 'review_state', in: 'query', schema: { type: 'string', enum: ['accepted', 'pending', 'rejected', 'all'] } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['test_run', 'manual_build', 'all'] } },
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: ok('Reports'),
      },
    };
    paths['/api/v1/projects/{project_id}/compatibility-reports'] = {
      get: {
        tags: ['evidence'],
        summary: 'Accepted-evidence summaries: distinct contributors, failures, conflicts, freshness',
        parameters: [idParam('project_id'), { name: 'version', in: 'query', schema: { type: 'string' } }],
        responses: ok('Evidence summaries'),
      },
    };
  }
  if (config.features.evidenceClassification) {
    const review = (summary: string, param: string) => ({
      post: {
        tags: ['operator'],
        summary,
        description: 'Operator only. The evidence level is derived by the server; it cannot be chosen here.',
        parameters: [idParam(param)],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision', 'reason_code'],
                properties: {
                  decision: { type: 'string', enum: ['accepted', 'rejected'] },
                  reason_code: { type: 'string' },
                  note: { type: ['string', 'null'] },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: ok('Review recorded'),
      },
    });
    paths['/api/v1/admin/test-results/{result_id}/review'] = review('Review a published test result', 'result_id');
    paths['/api/v1/admin/builds/{build_id}/report-review'] = review('Review a build\'s published manual report', 'build_id');
  }
  return paths;
}

export function openApiDocument(config: AppConfig): Record<string, unknown> {
  const versioned = environmentJsonSchemas(config.apiBaseUrl);
  const scopes = Object.fromEntries(
    advertisedScopes(config).map((scope) => [scope, PRODUCT_SCOPES[scope].description]),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'Localfirst registry API',
      version: '0.2.0',
      summary: 'Agent-native registry for local-AI projects, with sanitized local test evidence.',
      description: [
        'Implemented surfaces only; community routes are feature-gated.',
        'Evidence levels are derived by the server: `claimed` and `documented` from provenance, and `community_reported` or `reproducible_test` only for reports an operator accepted. `independently_verified` requires separate qualified reproduction and human operator provenance. The registry runs no tests and hosts no inference.',
        'The hosted MCP adapter lives at `/mcp` with its own token audience.',
      ].join(' '),
      license: { name: 'See repository', identifier: 'NOASSERTION' },
    },
    servers: [{ url: config.apiBaseUrl }],
    tags: [
      { name: 'registry', description: 'Public catalog reads' },
      { name: 'contribution', description: 'Drafts, approval, and publication' },
      { name: 'account', description: 'Own identity and agent grants' },
      { name: 'evidence', description: 'Test definitions, builds, and sanitized test results' },
      { name: 'community', description: 'Scoped comparisons, independent reproduction and attributed knowledge' },
      { name: 'operator', description: 'Moderation, evidence review, and audit' },
      { name: 'service', description: 'Health, schemas, and discovery' },
    ],
    components: {
      securitySchemes: {
        localfirstOAuth: {
          type: 'oauth2',
          description:
            'Localfirst OAuth. REST tokens are audience-bound to the REST resource; an MCP token is not accepted here.',
          flows: {
            authorizationCode: {
              authorizationUrl: `${config.authIssuer}/oauth2/authorize`,
              tokenUrl: `${config.authIssuer}/oauth2/token`,
              refreshUrl: `${config.authIssuer}/oauth2/token`,
              scopes,
            },
          },
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description: 'Human browser session. Required for approval and other human-only routes.',
        },
        approverDevice: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A machine the person linked with `auth approver-login`. It records or reads a publication decision and is refused on every other route; it cannot be granted through OAuth or MCP consent.',
        },
      },
      schemas: {
        ProjectSpecification: { oneOf: [projectJsonSchema(config.apiBaseUrl), versioned['project/v0.3']] },
        Build: config.features.workflowResults ? { oneOf: [buildJsonSchema(config.apiBaseUrl), versioned['build/v0.2']] } : buildJsonSchema(config.apiBaseUrl),
        BuildReport: buildReportJsonSchema(config.apiBaseUrl),
        TestResult: config.features.workflowResults ? { oneOf: [testResultJsonSchema(config.apiBaseUrl), versioned['test-result/v0.2']] } : testResultJsonSchema(config.apiBaseUrl),
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', maxLength: 200 },
          description: 'Scoped to actor, operation, target, and canonical request digest.',
        },
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: 'Draft revision ETag, e.g. `W/"rev-3"`.',
        },
        Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' } },
        Limit: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    paths: {
      ...(config.features.agentEnvironments ? environmentPaths() : {}),
      ...evidencePaths(config),
      ...communityPaths(config),
      '/api/v1/projects': {
        get: {
          tags: ['registry'],
          summary: 'Search or list published projects',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string', maxLength: 200 } },
            { name: 'type', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'category', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'model', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'runtime', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'hardware', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'os', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'test_support', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'evidence_level', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'offline', in: 'query', schema: { type: 'string', enum: ['yes', 'no', 'unknown'] } },
            { name: 'derivative', in: 'query', schema: { type: 'string', enum: ['yes', 'no'] }, description: 'yes: only remixes with a pinned parent; no: only originals' },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['relevance', 'updated_at', 'evidence_freshness'] } },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/Limit' },
          ],
          responses: {
            '200': {
              description: 'Visible project summaries with an opaque cursor',
              content: { 'application/json': { schema: envelope({ type: 'object' }) } },
            },
            ...standardErrors,
          },
        },
      },
      '/api/v1/projects/by-slug/{slug}': {
        get: {
          tags: ['registry'],
          summary: 'Resolve a public slug to its canonical project ID',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Canonical identifiers' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}': {
        get: {
          tags: ['registry'],
          summary: 'Read a visible project with its current immutable version',
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Project detail' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/versions': {
        get: {
          tags: ['registry'],
          summary: 'List immutable published versions',
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Version history' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/versions/{version_id}': {
        get: {
          tags: ['registry'],
          summary: 'Read one exact specification with provenance',
          parameters: [
            { name: 'project_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'version_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Version detail' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/export': {
        get: {
          tags: ['registry'],
          summary: 'Export PROJECT.md for a version',
          parameters: [
            { name: 'project_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'version', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Portable document', content: { 'text/markdown': { schema: { type: 'string' } } } },
            ...standardErrors,
          },
        },
      },
      '/api/v1/projects/{project_id}/compatibility-checks': {
        post: {
          tags: ['registry'],
          summary: 'Assess declared compatibility against voluntarily shared facts',
          description:
            '`incompatible` and `unknown` are normal outcomes, not HTTP failures. Raw inventory, credentials, prompts, and document contents are rejected.',
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Assessment' }, ...standardErrors },
        },
      },
      '/api/v1/hardware-profiles/validate': {
        post: {
          tags: ['registry'],
          summary: 'Normalize a supplied hardware summary without persisting it',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Normalized summary' }, ...standardErrors },
        },
      },
      '/api/v1/catalog/facets': {
        get: {
          tags: ['registry'],
          summary: 'Controlled filter vocabulary and this deployment’s phase support',
          responses: { '200': { description: 'Facets' } },
        },
      },
      '/api/v1/models': {
        get: { tags: ['registry'], summary: 'Model references derived from project records', responses: { '200': { description: 'Model references' } } },
      },
      '/api/v1/runtimes': {
        get: { tags: ['registry'], summary: 'Runtime reference catalog and support status', responses: { '200': { description: 'Runtime references' } } },
      },
      '/api/v1/hardware': {
        get: { tags: ['registry'], summary: 'Coarse public hardware descriptors', responses: { '200': { description: 'Hardware descriptors' } } },
      },
      '/api/v1/drafts': {
        post: {
          tags: ['contribution'],
          summary: 'Create a private project, build, test-result, collection or troubleshooting draft; scope depends on kind',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            '201': { description: 'Draft created synchronously' },
            '202': { description: 'Import queued; poll the operation' },
            ...standardErrors,
          },
        },
        get: {
          tags: ['contribution'],
          summary: 'List your own drafts',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          responses: { '200': { description: 'Own drafts' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}': {
        get: {
          tags: ['contribution'],
          summary: 'Read your draft with validation and approval state',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Draft' }, ...standardErrors },
        },
        patch: {
          tags: ['contribution'],
          summary: 'Edit your draft (increments the revision, invalidates approval)',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [
            { name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/IfMatch' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Updated draft' }, '412': errorResponse, '428': errorResponse, ...standardErrors },
        },
        delete: {
          tags: ['contribution'],
          summary: 'Discard your draft',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Discarded' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}/validate': {
        post: {
          tags: ['contribution'],
          summary: 'Validate a draft and refresh its derived ready state',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Validation result' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}/import': {
        post: {
          tags: ['contribution'],
          summary: 'Import a bounded public source into an existing draft',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [
            { name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '202': { description: 'Import queued' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}/review': {
        get: {
          tags: ['contribution'],
          summary: 'Read the exact artifact a person is asked to approve',
          description:
            'Returns the public text, bundled files, blocking issues, and warning codes for the current revision. A browser session or a linked approval device only.',
          security: [{ session: [] }, { approverDevice: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Exact review data' }, ...standardErrors },
        },
      },
      '/api/v1/approver-links': {
        post: {
          tags: ['contribution'],
          summary: 'Start linking a machine as an approval device',
          description:
            'Anonymous. Returns a short code to compare in the browser and a poll secret only the machine holds. Nothing is granted until a signed-in browser session approves the code.',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { client_label: { type: 'string' } } } } } },
          responses: { '201': { description: 'Link started' }, ...standardErrors },
        },
      },
      '/api/v1/approver-links/decision': {
        post: {
          tags: ['contribution'],
          summary: 'Approve or deny a link code in a browser session',
          security: [{ session: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Decision recorded' }, ...standardErrors },
        },
      },
      '/api/v1/approver-links/{link_id}/token': {
        post: {
          tags: ['contribution'],
          summary: 'Redeem an approved link for a credential, once',
          description: '202 while the person has not decided; 410 when denied, expired, or already redeemed.',
          security: [],
          parameters: [{ name: 'link_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Credential issued' }, '202': { description: 'Authorization pending' }, ...standardErrors },
        },
      },
      '/api/v1/me/approver-devices': {
        get: {
          tags: ['contribution'],
          summary: 'List your linked approval devices',
          security: [{ session: [] }],
          responses: { '200': { description: 'Devices' }, ...standardErrors },
        },
      },
      '/api/v1/me/approver-devices/{device_id}': {
        delete: {
          tags: ['contribution'],
          summary: 'Revoke a linked approval device',
          security: [{ session: [] }],
          parameters: [{ name: 'device_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Revoked' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}/approval': {
        post: {
          tags: ['contribution'],
          summary: 'Record a human approval of the exact artifact',
          description:
            'A browser session, or an approval device the person linked from their own machine. An agent token cannot create an approval, and the approval is single use with a short expiry.',
          security: [{ session: [] }, { approverDevice: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '201': { description: 'Approval recorded' }, ...standardErrors },
        },
        delete: {
          tags: ['contribution'],
          summary: 'Revoke an approval',
          security: [{ session: [] }, { approverDevice: [] }],
          parameters: [{ name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Revoked' }, ...standardErrors },
        },
      },
      '/api/v1/drafts/{draft_id}/publish': {
        post: {
          tags: ['contribution'],
          summary: 'Publish the approved artifact as an immutable version',
          security: [{ localfirstOAuth: ['projects:publish'] }, { session: [] }],
          parameters: [
            { name: 'draft_id', in: 'path', required: true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '201': { description: 'Published version' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/drafts': {
        post: {
          tags: ['contribution'],
          summary: 'Create a version-update draft for a project you manage',
          security: [{ localfirstOAuth: ['projects:draft', 'projects:update'] }, { session: [] }],
          parameters: [
            { name: 'project_id', in: 'path', required: true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '201': { description: 'Draft created' }, '202': { description: 'Import queued' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/unpublish': {
        post: {
          tags: ['contribution'],
          summary: 'Hide a project you manage',
          security: [{ localfirstOAuth: ['projects:update'] }, { session: [] }],
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Visibility changed' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/republish': {
        post: {
          tags: ['contribution'],
          summary: 'Restore a project you unpublished (never a quarantine override)',
          security: [{ localfirstOAuth: ['projects:update'] }, { session: [] }],
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Visibility changed' }, ...standardErrors },
        },
      },
      '/api/v1/projects/{project_id}/claim-requests': {
        post: {
          tags: ['contribution'],
          summary: 'Request authorship or management of a listing',
          security: [{ session: [] }],
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '201': { description: 'Claim recorded for operator review' }, ...standardErrors },
        },
      },
      '/api/v1/operations/{operation_id}': {
        get: {
          tags: ['contribution'],
          summary: 'Poll a durable operation you own',
          security: [{ localfirstOAuth: ['projects:draft'] }, { session: [] }],
          parameters: [{ name: 'operation_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Safe operation status' }, ...standardErrors },
        },
      },
      '/api/v1/me': {
        get: {
          tags: ['account'],
          summary: 'Read your own minimal profile and account state',
          security: [{ localfirstOAuth: ['profile:read'] }, { session: [] }],
          responses: { '200': { description: 'Own profile' }, ...standardErrors },
        },
      },
      '/api/v1/me/connections': {
        get: {
          tags: ['account'],
          summary: 'List agent grants (no token bodies)',
          security: [{ session: [] }],
          responses: { '200': { description: 'Grants' }, ...standardErrors },
        },
      },
      '/api/v1/me/connections/{connection_id}': {
        delete: {
          tags: ['account'],
          summary: 'Revoke an agent grant',
          security: [{ session: [] }],
          parameters: [{ name: 'connection_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Revoked' }, ...standardErrors },
        },
      },
      '/api/v1/me/deletion-requests': {
        post: {
          tags: ['account'],
          summary: 'Withdraw managed projects, remove private records and grants, and request final account erasure',
          security: [{ session: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['confirm', 'handle'], additionalProperties: false,
            properties: { confirm: { type: 'boolean', const: true }, handle: { type: 'string', minLength: 1, maxLength: 64 } },
          } } } },
          responses: { '202': { description: 'Deletion requested' }, ...standardErrors },
        },
      },
      '/api/v1/admin/reviews': {
        get: {
          tags: ['operator'],
          summary: 'Operator review queue',
          security: [{ session: [] }],
          responses: { '200': { description: 'Queue' }, '404': errorResponse },
        },
      },
      '/api/v1/admin/projects/{project_id}/moderation': {
        post: {
          tags: ['operator'],
          summary: 'Quarantine or restore a project with a recorded reason',
          security: [{ session: [] }],
          parameters: [{ name: 'project_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Visibility changed' }, '404': errorResponse },
        },
      },
      '/api/v1/admin/claim-requests/{claim_id}/review': {
        post: {
          tags: ['operator'],
          summary: 'Review a claim and optionally transfer management explicitly',
          security: [{ session: [] }],
          parameters: [{ name: 'claim_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'Reviewed' }, '404': errorResponse },
        },
      },
      '/api/v1/admin/operations/{operation_id}/retry': {
        post: {
          tags: ['operator'],
          summary: 'Retry an eligible failed operation',
          security: [{ session: [] }],
          parameters: [{ name: 'operation_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Requeued' }, '404': errorResponse, '409': errorResponse },
        },
      },
      '/api/v1/admin/audit-events': {
        get: {
          tags: ['operator'],
          summary: 'Search bounded safe audit events',
          security: [{ session: [] }],
          responses: { '200': { description: 'Events' }, '404': errorResponse },
        },
      },
      '/health/live': { get: { tags: ['service'], summary: 'Process responsiveness', responses: { '200': { description: 'Alive' } } } },
      '/health/ready': { get: { tags: ['service'], summary: 'Schema and durable-work readiness', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } } },
      '/openapi.json': { get: { tags: ['service'], summary: 'This document', responses: { '200': { description: 'OpenAPI document' } } } },
      '/schemas/project/v0.2.json': { get: { tags: ['service'], summary: 'Specification schema', responses: { '200': { description: 'JSON Schema' } } } },
      '/schemas/test/v0.1.json': {
        get: {
          tags: ['service'],
          summary: 'Declarative task test contract (preview; no runner has shipped)',
          responses: { '200': { description: 'JSON Schema' } },
        },
      },
    },
  };
}
