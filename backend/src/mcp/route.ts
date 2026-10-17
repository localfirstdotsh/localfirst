/**
 * Hosted MCP transport (BACKEND_PRD section 13.1).
 *
 * The official SDK's Web Standard Streamable HTTP transport serves the
 * stateless profile: a server and transport are created per request, `POST`
 * is the only executing method, and no JSON-RPC parser is hand written. Access
 * tokens must be bound to the MCP resource audience; a REST-audience token is
 * not accepted here.
 */

import { Hono } from 'hono';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';
import type { JWTPayload } from 'jose';
import type { AppEnv } from '../http/context.js';
import type { Actor } from '../http/context.js';
import { config } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { incrementCounter } from '../observability/metrics.js';
import { resolveBearerActor } from '../auth/actor.js';
import { bucketForActor, consumeLimit } from '../http/rate-limit.js';
import { registerRegistryResources, registerRegistryTools } from './tools.js';

const log = createLogger('mcp');

export const MCP_SERVER_INFO = { name: 'localfirst-registry', version: '0.2.0' } as const;

const INSTRUCTIONS = [
  'Localfirst is the registry for local-AI projects: models, hardware, projects, and builds with explicit evidence levels.',
  'This registry publishes portable project specifications, immutable test definitions, and private-then-published builds and sanitized test results with explicit evidence levels.',
  'Evidence levels are derived by the server: an uploaded or published report is pending review and carries no evidence level until an operator accepts it, and nothing here can mark a result verified.',
  'No tool here can reach your machine, run inference, or execute project code. Local discovery and testing belong to the separate local runner, which asks its user for approval locally.',
  'Publication always needs a person to approve the exact artifact in a browser session; an agent cannot approve on their behalf.',
].join(' ');

/** Build the per-request server with the caller bound to every handler. */
export function buildMcpServer(actor: Actor): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS });
  registerRegistryTools(server, actor);
  registerRegistryResources(server, actor);
  return server;
}

async function handleAuthorizedRequest(
  request: Request,
  claims: JWTPayload,
  parsedBody: unknown,
): Promise<Response> {
  // Re-resolve the caller through the registry's own checks: account state,
  // suspension, and operator roles are not in the token.
  const actor = await resolveBearerActor(
    request.headers.get('authorization') ?? '',
    config().mcpResource,
  );
  // Every call is a read of the registry and may be counted (BACKEND_PRD
  // section 19.3.1), so each is charged against the caller's read allowance, shared
  // with the REST adapter. A JSON-RPC batch pays for every call it carries, so
  // batching cannot slip past a per-request limit.
  await consumeLimit(
    bucketForActor(actor, undefined),
    { name: 'authenticated_read', max: config().limits.authenticatedReadsPerMinute, windowSeconds: 60 },
    Array.isArray(parsedBody) ? Math.max(1, parsedBody.length) : 1,
  );
  const server = buildMcpServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // One complete JSON response per request: the stateless profile has no
    // server-initiated stream, so a buffered body is both simpler and safe to
    // return after the per-request server is closed.
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [new URL(config().apiBaseUrl).host],
  });
  try {
    await server.connect(transport);
    const authInfo = {
      token: 'redacted',
      clientId: typeof claims.client_id === 'string' ? claims.client_id : 'unknown',
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
      ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
    };
    return await transport.handleRequest(request, { parsedBody, authInfo });
  } finally {
    await server.close().catch(() => undefined);
  }
}

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.post('/', async (c) => {
  const cfg = config();
  // Parse the body here so the transport does not have to re-read the stream.
  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    parsedBody = undefined;
  }
  const protect = createMcpProtectedRequestHandler(
    {
      issuer: cfg.authIssuer,
      audience: cfg.mcpResource,
      jwksUrl: `${cfg.authIssuer}/jwks`,
    },
    (request, claims) => handleAuthorizedRequest(request, claims, parsedBody),
  );
  incrementCounter('mcp.request');
  const response = await protect(c.req.raw);
  if (response.status === 401) incrementCounter('mcp.unauthenticated');
  log.info({ request_id: c.get('requestId'), status: response.status }, 'mcp request');
  return response;
});

/** Explicit preflight. It never executes a tool. */
mcpRoutes.options('/', (c) => {
  c.header('Allow', 'POST, OPTIONS');
  return c.body(null, 204);
});

/**
 * The chosen stateless profile has no server-initiated stream and no session to
 * delete, so these answer 405 unless a tested legacy profile is enabled.
 */
const methodNotAllowed = (c: { header: (k: string, v: string) => void; body: (b: null, s: 405) => Response }) => {
  c.header('Allow', 'POST, OPTIONS');
  return c.body(null, 405);
};

mcpRoutes.get('/', (c) => {
  if (config().features.legacyMcpSessions) {
    return c.body(null, 405);
  }
  return methodNotAllowed(c);
});

mcpRoutes.delete('/', (c) => methodNotAllowed(c));
