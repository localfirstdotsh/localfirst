/**
 * An MCP application connecting through OAuth, the way Claude Code does
 * (BACKEND_PRD sections 10.5 and 13.1: "test actual client flows"). With
 * dynamic registration on, the client registers itself without a session as a
 * public PKCE client, the person consents in their browser session, and the
 * client exchanges the code with its PKCE verifier for an MCP-audience token.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { auth, resetAuth } from '../src/auth/instance.js';
import { config, setConfig } from '../src/config.js';
import { createAccount } from './factories.js';
import { withNativeLoopbackDefault } from '../src/auth/client-registration.js';
import { startTestServer, type Harness } from './server-harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
afterEach(() => {
  setConfig(null);
  resetAuth();
});

function withDynamicRegistration(enabled: boolean) {
  const current = config();
  setConfig({ ...current, features: { ...current.features, dynamicClientRegistration: enabled } });
  resetAuth();
}

const REDIRECT = 'http://localhost:43123/callback';

async function register(body: Record<string, unknown>) {
  const response = await fetch(`${harness.baseUrl}${config().authBasePath}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const publicClient = {
  client_name: 'Claude Code (test)',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'projects:read projects:draft',
};

async function sessionCookie(userId: string) {
  const ctx = (await (auth() as unknown as { $context: Promise<any> }).$context);
  const session = await ctx.internalAdapter.createSession(userId, false);
  return `${ctx.authCookies.sessionToken.name}=${session.token}.${await makeSignature(session.token, ctx.secret)}`;
}

describe('MCP client registration', () => {
  it('refuses unauthenticated registration while dynamic registration is off', async () => {
    withDynamicRegistration(false);
    const { status } = await register(publicClient);
    expect([401, 403, 404]).toContain(status);
  });

  it('lets an MCP application register itself, without a session, as a public client', async () => {
    withDynamicRegistration(true);
    const registered = await register(publicClient);
    expect(registered.status, JSON.stringify(registered.json)).toBeLessThan(300);
    expect(registered.json.client_id).toBeTruthy();
    // A public PKCE client: no secret is issued, and none is needed at the token endpoint.
    expect(registered.json.client_secret).toBeUndefined();
    expect(registered.json.token_endpoint_auth_method).toBe('none');
    // Registered as a native app because its only callback is a loopback address.
    expect(registered.json.application_type).toBe('native');
  });

  // The browser half (consent on the real page, the code reaching the client's
  // callback, the token exchange, and an MCP tool call with the issued token)
  // runs in real Chrome in `verify:browser-consent`.

  it('requires PKCE from a dynamically registered client', async () => {
    withDynamicRegistration(true);
    const registered = await register({ ...publicClient, client_name: 'No PKCE (test)' });
    const person = await createAccount();
    const cookie = await sessionCookie(person.userId);
    const authorizeUrl = new URL(`${harness.baseUrl}${config().authBasePath}/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: registered.json.client_id as string, redirect_uri: REDIRECT,
      scope: 'projects:read', state: randomUUID(), resource: config().mcpResource,
    })) authorizeUrl.searchParams.set(key, value);
    const response = await fetch(authorizeUrl, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
    const location = response.headers.get('location') ?? '';
    // Refused outright, or redirected back with an error, but never sent on to consent.
    expect(location.includes('/consent')).toBe(false);
  });
});

describe('registration defaults for loopback (CLI) clients', () => {
  it('registers an explicitly native client, and still refuses a web client on localhost', async () => {
    withDynamicRegistration(true);
    const native = await register({ ...publicClient, client_name: 'Native (test)', application_type: 'native' });
    expect(native.status, JSON.stringify(native.json)).toBeLessThan(300);
    const web = await register({ ...publicClient, client_name: 'Web (test)', application_type: 'web' });
    expect(web.status).toBe(400);
    expect(web.json.error).toBe('invalid_redirect_uri');
  });

  it('treats a registration as native only when every callback is http loopback and no type is given', () => {
    const loopback = { redirect_uris: ['http://localhost:1234/callback', 'http://127.0.0.1:5678/cb', 'http://[::1]:9/x'] };
    expect(withNativeLoopbackDefault(loopback)).toEqual({ ...loopback, application_type: 'native' });
    for (const unchanged of [
      { redirect_uris: ['http://localhost:1/cb', 'https://app.example/cb'] },
      { redirect_uris: ['https://localhost:1/cb'] },
      { redirect_uris: ['http://localhost.evil.example/cb'] },
      { redirect_uris: [] },
      { redirect_uris: ['http://localhost:1/cb'], application_type: 'web' },
      { client_name: 'no uris' },
      'not an object',
      null,
    ]) {
      expect(withNativeLoopbackDefault(unchanged)).toEqual(unchanged);
    }
  });
});
