/**
 * Health, schema, discovery, and monitoring routes (BACKEND_PRD section 12.3).
 */

import { Hono } from 'hono';
import {
  buildJsonSchema,
  environmentJsonSchemas,
  buildReportJsonSchema,
  projectJsonSchema,
  testJsonSchema,
  testResultJsonSchema,
} from '@localfirst/contracts';
import type { AppEnv } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { success } from '../http/middleware.js';
import { config } from '../config.js';
import { checkDatabaseReady } from '../db/client.js';
import { outboxQueueAgeSeconds } from '../services/outbox.js';
import { queueDepth } from '../services/jobs.js';
import { renderMetrics } from '../observability/metrics.js';
import { openApiDocument } from './openapi.js';
import { advertisedScopes } from '../auth/scopes.js';

export const serviceRoutes = new Hono<AppEnv>();
for (const schema of ['project/v0.3', 'environment/v0.1', 'test/v0.2', 'build/v0.2', 'test-result/v0.2']) {
  serviceRoutes.get('/schemas/' + schema + '.json', c => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(environmentJsonSchemas(config().apiBaseUrl)[schema]!);
  });
}

/** Process responsiveness only: no dependency is consulted. */
serviceRoutes.get('/health/live', (c) => c.json({ status: 'live' }));

/** Readiness consults the schema and durable-work state. */
serviceRoutes.get('/health/ready', async (c) => {
  const database = await checkDatabaseReady();
  let queue: Awaited<ReturnType<typeof queueDepth>> | null = null;
  let queueAgeSeconds: number | null = null;
  if (database.ok) {
    try {
      queue = await queueDepth();
      queueAgeSeconds = await outboxQueueAgeSeconds();
    } catch {
      queue = null;
    }
  }
  const ready = database.ok && queue !== null;
  return c.json(
    {
      status: ready ? 'ready' : 'not_ready',
      database: database.detail,
      durable_work: queue
        ? { ...queue, outbox_oldest_pending_seconds: Math.round(queueAgeSeconds ?? 0) }
        : { reason: 'durable_work_unavailable' },
    },
    ready ? 200 : 503,
  );
});

serviceRoutes.get('/openapi.json', (c) => c.json(openApiDocument(config())));

serviceRoutes.get('/schemas/project/v0.2.json', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(projectJsonSchema(config().apiBaseUrl));
});

/**
 * The test contract. Whether the first-party runner can execute a given
 * definition is reported per definition (`runner_available`), never assumed.
 */
serviceRoutes.get('/schemas/test/v0.1.json', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    ...testJsonSchema(config().apiBaseUrl),
    'x-localfirst-status': {
      phase: 'P1',
      runner_available: 'per_definition',
      note: 'A declared harness is not a shipped runner; check runner_available on each test definition.',
    },
  });
});

/** Build, manual-report, and sanitized test-result contracts (P1). */
for (const [name, generate] of [
  ['build', buildJsonSchema],
  ['build-report', buildReportJsonSchema],
  ['test-result', testResultJsonSchema],
] as const) {
  serviceRoutes.get(`/schemas/${name}/v0.1.json`, (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      ...generate(config().apiBaseUrl),
      'x-localfirst-status': {
        phase: 'P1',
        note: 'Strict allowlist: unknown fields are rejected, and no field can assert verification, review state, evidence level, or a badge.',
      },
    });
  });
}

/** Internal authenticated monitoring. */
serviceRoutes.get('/metrics', async (c) => {
  const token = config().metricsToken;
  if (token) {
    const supplied = c.req.header('authorization');
    if (supplied !== `Bearer ${token}`) throw ApiError.notFound();
  } else if (config().isProduction) {
    throw ApiError.notFound();
  }
  let extra: Record<string, number> = {};
  try {
    const queue = await queueDepth();
    extra = {
      jobs_queued: queue.queued,
      jobs_running: queue.running,
      jobs_failed: queue.failed,
      outbox_oldest_pending_seconds: Math.round(await outboxQueueAgeSeconds()),
    };
  } catch {
    extra = { dependency_unavailable: 1 };
  }
  c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return c.body(renderMetrics(extra));
});

/**
 * RFC 9728 metadata for the REST protected resource. The MCP resource metadata
 * is served by the auth library at its own well-known path.
 */
serviceRoutes.get('/.well-known/oauth-protected-resource/api/v1', (c) => {
  const cfg = config();
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    resource: cfg.restResource,
    authorization_servers: [cfg.authIssuer],
    jwks_uri: `${cfg.authIssuer}/jwks`,
    scopes_supported: advertisedScopes(cfg),
    bearer_methods_supported: ['header'],
    resource_documentation: `${cfg.apiBaseUrl}/openapi.json`,
    resource_name: 'Localfirst REST API',
  });
});

/** A small, honest description of what this deployment implements. */
serviceRoutes.get('/', (c) => {
  const cfg = config();
  return c.json(
    success(
      {
        service: 'localfirst-registry',
        phase: cfg.features.communityNetwork ? 'P2' : 'P1',
        schema: 'localfirst/project/v0.2',
        rest: `${cfg.apiBaseUrl}/api/v1`,
        mcp: cfg.mcpResource,
        openapi: `${cfg.apiBaseUrl}/openapi.json`,
        auth_issuer: cfg.authIssuer,
        setup: {
          // Advertised only as a design contract until the package is released.
          cli_package: 'localfirstdotsh',
          mcp_add_command: 'npx localfirstdotsh mcp add',
          released: false,
          note: 'The connection helper is not a released package yet. Use the REST API or a tested MCP client configuration directly.',
        },
        boundaries: [
          'The registry never runs inference, never contacts a local runtime, and hosts no model weights.',
          'Evidence is server-derived. Independent verification requires separate qualified reproduction and operator provenance.',
          'Publication requires a person to approve the exact artifact.',
        ],
      },
      c.get('requestId'),
    ),
  );
});
