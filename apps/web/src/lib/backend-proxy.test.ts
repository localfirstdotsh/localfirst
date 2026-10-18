import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { proxyBackendRequest } from './backend-proxy';
afterEach(() => vi.unstubAllEnvs());
it('preserves the public Host, session cookies, POST bodies, redirect status and multiple Set-Cookie headers on the private hop', async () => {
  let observed: { host?: string; cookie?: string; body?: string; forwarded?: string } = {};
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    observed = { host: request.headers.host, cookie: request.headers.cookie, forwarded: request.headers['x-forwarded-for'] as string | undefined, body };
    response.writeHead(302, { location: 'https://github.com/login/oauth/authorize', 'set-cookie': ['one=a; HttpOnly; Path=/', 'two=b; HttpOnly; Path=/'] }); response.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  vi.stubEnv('LOCALFIRST_API_URL', `http://127.0.0.1:${address.port}`); vi.stubEnv('LOCALFIRST_SITE_URL', 'https://localfirst.example');
  try {
    const response = await proxyBackendRequest(new Request('https://localfirst.example/api/auth/sign-in/social', { method: 'POST', headers: { origin: 'https://localfirst.example', cookie: 'session=value', 'x-forwarded-for': 'spoofed', 'content-type': 'application/json' }, body: '{"provider":"github"}' }));
    expect(response.status).toBe(302); expect(response.headers.get('location')).toContain('github.com');
    expect(response.headers.getSetCookie()).toHaveLength(2); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(observed).toEqual({ host: 'localfirst.example', cookie: 'session=value', forwarded: undefined, body: '{"provider":"github"}' });
    await response.text();
    const machine = await proxyBackendRequest(new Request('https://localfirst.example/api/auth/oauth2/token', { method: 'POST', headers: { origin: 'https://client.example', authorization: 'Bearer fixture', 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' }));
    expect(machine.status).toBe(302);
    expect(observed.cookie).toBeUndefined();
    expect(observed.body).toBe('grant_type=authorization_code');
    await machine.text();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
it('rejects a foreign browser mutation and a mismatched MCP Host before forwarding', async () => {
  vi.stubEnv('LOCALFIRST_SITE_URL', 'https://localfirst.example');
  expect((await proxyBackendRequest(new Request('https://localfirst.example/api/v1/drafts/one/approval', { method: 'POST', headers: { origin: 'https://foreign.example', cookie: 'session=fixture' }, body: '{}' }))).status).toBe(403);
  expect((await proxyBackendRequest(new Request('https://rebound.example/mcp'))).status).toBe(403);
});
it('rejects a self-referential private API destination without exposing configuration', async () => {
  vi.stubEnv('LOCALFIRST_API_URL', 'http://localhost:3000');
  const response = await proxyBackendRequest(new Request('http://localhost:3000/api/browser/config'));
  expect(response.status).toBe(502); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).not.toContain('destination');
});
