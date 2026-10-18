/**
 * Hono composition (BACKEND_PRD sections 2.4, 10.6, 22.1).
 *
 * The auth library owns everything under its base path, root discovery paths
 * are mounted explicitly, the REST adapter and the hosted MCP adapter call the
 * same application services, and the human consent surface is deliberately
 * small.
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from './http/context.js';
import {
  bodyLimit,
  cors,
  requestContext,
  requestLogging,
  requireJson,
  securityHeaders,
  toErrorResponse,
} from './http/middleware.js';
import { ApiError } from './http/errors.js';
import { auth } from './auth/instance.js';
import { v1Routes } from './api/v1/index.js';
import { serviceRoutes } from './api/service.js';
import { mcpRoutes } from './mcp/route.js';
import { browserRoutes } from './api/browser/index.js';
import { config } from './config.js';
import { CLIENT_IP_HEADER } from './http/client-ip.js';
import { withNativeLoopbackDefault } from './auth/client-registration.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const basePath = config().authBasePath;

  app.use('*', requestContext());
  app.use('*', securityHeaders());
  app.use('*', cors());
  app.use('*', requestLogging());
  app.use('*', bodyLimit());

  app.onError((error, c) => {
    const { body, status, headers } = toErrorResponse(error, c.get('requestId'));
    for (const [key, value] of Object.entries(headers)) c.header(key, value);
    return c.json(body, status as 500);
  });

  app.notFound((c) => {
    const { body, status } = toErrorResponse(ApiError.notFound(), c.get('requestId'));
    return c.json(body, status as 404);
  });

  // --- Auth library owned endpoints ---------------------------------------
  // Better Auth rate-limits by the address in CLIENT_IP_HEADER only. The app
  // computes it behind trusted proxies and overwrites whatever the caller sent.
  const forwardToAuth = (c: Context<AppEnv>, body?: string) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const clientIp = c.get('clientIp');
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
    if (body !== undefined) {
      headers.delete('content-length');
      return auth().handler(new Request(c.req.raw.url, { method: c.req.raw.method, headers, body }));
    }
    return auth().handler(new Request(c.req.raw, { headers, duplex: 'half' } as RequestInit));
  };
  // Dynamic registration: a CLI with only loopback callbacks is a native app
  // (src/auth/client-registration.ts). Any other body is forwarded unchanged.
  app.post(`${basePath}/oauth2/register`, async (c) => {
    const text = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return forwardToAuth(c, text);
    }
    return forwardToAuth(c, JSON.stringify(withNativeLoopbackDefault(parsed)));
  });
  app.all(`${basePath}/*`, (c) => forwardToAuth(c));

  // Root discovery paths must be mounted explicitly: an `/api/auth/*` catch-all
  // cannot serve them (section 10.6).
  app.get('/.well-known/oauth-authorization-server', (c) => forwardToAuth(c));
  app.get(`/.well-known/oauth-authorization-server${basePath}`, (c) => forwardToAuth(c));
  app.get('/.well-known/openid-configuration', (c) => forwardToAuth(c));
  app.get(`/.well-known/openid-configuration${basePath}`, (c) => forwardToAuth(c));
  app.get('/.well-known/oauth-protected-resource', (c) => forwardToAuth(c));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => forwardToAuth(c));

  // --- Hosted MCP adapter --------------------------------------------------
  app.route('/mcp', mcpRoutes);

  // --- Domain REST adapter -------------------------------------------------
  app.use('/api/v1/*', requireJson());
  app.route('/api/v1', v1Routes);

  // --- Human consent surface and service routes ---------------------------
  app.route('/api/browser', browserRoutes);
  // Preserve previously issued human-facing links without retaining another HTML renderer.
  for (const path of ['/sign-in', '/consent', '/account/*', '/review/drafts/*', '/privacy']) {
    app.get(path, (c) => {
      const url = new URL(c.req.url);
      // A misrouted public origin must not redirect to itself forever.
      if (url.host === new URL(config().websiteUrl).host) throw ApiError.notFound();
      c.header('Cache-Control', 'no-store');
      return c.redirect(`${config().websiteUrl}${url.pathname}${url.search}`, 307);
    });
  }
  app.route('/', serviceRoutes);

  return app;
}
