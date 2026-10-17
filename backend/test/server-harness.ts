/**
 * A real listening server for tests that need genuine HTTP behaviour: JWKS
 * retrieval during token verification and the MCP transport both reach the
 * network stack rather than an in-process fetch shim.
 */

import { serve } from '@hono/node-server';
import { signJWT } from 'better-auth/plugins';
import { createApp } from '../src/app.js';
import { auth } from '../src/auth/instance.js';
import { config } from '../src/config.js';

export interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<Harness> {
  const cfg = config();
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
  // Wait for the listener to accept connections.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${cfg.apiBaseUrl}/health/live`);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    baseUrl: cfg.apiBaseUrl,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface MintOptions {
  subject: string;
  audience: string;
  scopes?: string[];
  clientId?: string;
  issuer?: string;
  expiresInSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Mint an access token with the deployment's real signing key, so verification
 * exercises the actual JWKS path rather than a stub.
 */
export async function mintToken(options: MintOptions): Promise<string> {
  const cfg = config();
  const context = await (auth() as unknown as { $context: Promise<unknown> }).$context;
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ context } as never, {
    payload: {
      iss: options.issuer ?? cfg.authIssuer,
      sub: options.subject,
      aud: options.audience,
      iat: now,
      exp: now + (options.expiresInSeconds ?? 300),
      jti: `test-${Math.random().toString(36).slice(2)}`,
      client_id: options.clientId ?? 'test-client',
      scope: (options.scopes ?? ['projects:read']).join(' '),
      ...options.extra,
    },
  });
}
