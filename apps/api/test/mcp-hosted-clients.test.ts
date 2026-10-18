/**
 * Hosted web clients (claude.ai / Claude Desktop, ChatGPT) connect to a custom
 * MCP server by URL and register themselves with Dynamic Client Registration
 * from an https callback. This is a separate file because Better Auth limits
 * registration to 5 per minute per process, which the CLI-client suite uses up.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config, setConfig } from '../src/config.js';
import { resetAuth } from '../src/auth/instance.js';
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

async function register(redirectUri: string, name = 'Hosted client (test)') {
  const response = await fetch(`${harness.baseUrl}${config().authBasePath}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'projects:read projects:draft',
    }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe('registration for hosted web clients', () => {
  it.each([
    ['Claude', 'https://claude.ai/api/mcp/auth_callback'],
    ['ChatGPT', 'https://chatgpt.com/connector/oauth/abc123'],
  ])('registers %s as a public PKCE web client from its https callback', async (name, callback) => {
    withDynamicRegistration(true);
    const registered = await register(callback, `${name} (test)`);
    expect(registered.status, JSON.stringify(registered.json)).toBeLessThan(300);
    expect(registered.json.client_id).toBeTruthy();
    expect(registered.json.client_secret).toBeUndefined();
    expect(registered.json.token_endpoint_auth_method).toBe('none');
    expect(registered.json.application_type).not.toBe('native');
  });

  it('refuses a hosted client while dynamic registration is off, so connection fails visibly', async () => {
    withDynamicRegistration(false);
    expect((await register('https://claude.ai/api/mcp/auth_callback')).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a plain-http callback that is not loopback', async () => {
    withDynamicRegistration(true);
    expect((await register('http://claude.ai.evil.example/cb')).status).toBeGreaterThanOrEqual(400);
  });
});
