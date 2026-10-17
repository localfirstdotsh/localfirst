/**
 * Client addresses behind proxies (BACKEND_PRD sections 17.1 and 19.2): a
 * caller cannot choose the address its quota is counted against.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, loadConfig, ConfigError, setConfig } from '../src/config.js';
import { auth } from '../src/auth/instance.js';
import { CLIENT_IP_HEADER, parseTrustedProxies, resolveClientIp } from '../src/http/client-ip.js';
import { startTestServer, type Harness } from './server-harness.js';

const trusted = (spec: string) => parseTrustedProxies(spec)!.list;

describe('resolveClientIp', () => {
  it('ignores every forwarding header when no proxy is trusted', () => {
    expect(resolveClientIp({ peer: '198.51.100.7', forwardedFor: '6.6.6.6', trusted: null })).toBe('198.51.100.7');
    expect(resolveClientIp({ peer: '::ffff:198.51.100.7', forwardedFor: undefined, trusted: null })).toBe('198.51.100.7');
  });

  it('ignores forwarding headers from a peer that is not a trusted proxy', () => {
    expect(resolveClientIp({ peer: '198.51.100.7', forwardedFor: '6.6.6.6', trusted: trusted('private,cloudflare') })).toBe('198.51.100.7');
  });

  it('takes the first untrusted address from the right, so entries the client prepends are ignored', () => {
    // Client 203.0.113.9 sent a forged entry; Cloudflare appended the client, the platform appended Cloudflare's edge.
    const forwardedFor = '6.6.6.6, 203.0.113.9, 162.158.1.1';
    expect(resolveClientIp({ peer: '10.0.0.5', forwardedFor, trusted: trusted('private,cloudflare') })).toBe('203.0.113.9');
  });

  it('counts a caller that bypasses Cloudflare by its own address, not its forged one', () => {
    // Straight to the platform URL: only the platform's proxy appended an entry.
    expect(resolveClientIp({ peer: '10.0.0.5', forwardedFor: '6.6.6.6, 198.51.100.7', trusted: trusted('private,cloudflare') })).toBe('198.51.100.7');
  });

  it('handles IPv6 clients and mapped or bracketed proxy addresses', () => {
    expect(resolveClientIp({ peer: '::ffff:10.1.2.3', forwardedFor: '2001:db8::42, 2606:4700::1', trusted: trusted('private,cloudflare') })).toBe('2001:db8::42');
    expect(resolveClientIp({ peer: '[::1]', forwardedFor: '203.0.113.9', trusted: trusted('private') })).toBe('203.0.113.9');
  });

  it('stops at the nearest trusted proxy on a malformed entry instead of guessing', () => {
    expect(resolveClientIp({ peer: '10.0.0.5', forwardedFor: 'not-an-ip, 162.158.1.1', trusted: trusted('private,cloudflare') })).toBe('162.158.1.1');
    expect(resolveClientIp({ peer: '10.0.0.5', forwardedFor: '', trusted: trusted('private') })).toBe('10.0.0.5');
  });

  it('refuses a TRUSTED_PROXIES value it cannot parse, at startup', () => {
    const base = { DATABASE_URL: 'postgres://localhost/x', API_BASE_URL: 'http://127.0.0.1:8787', WEBSITE_URL: 'http://127.0.0.1:3000', AUTH_SECRET: 'x'.repeat(40) };
    expect(() => loadConfig({ ...base, TRUSTED_PROXIES: 'cloudflare, 10.0.0.0/33' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUSTED_PROXIES: 'render' } as NodeJS.ProcessEnv)).toThrow(/not an address, a CIDR, or a preset/);
    expect(loadConfig({ ...base, TRUSTED_PROXIES: 'cloudflare,private,203.0.113.1' } as NodeJS.ProcessEnv).trustedProxies?.entries.length).toBeGreaterThan(20);
  });
});

describe('over HTTP', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startTestServer();
  });
  afterAll(async () => {
    await harness.close();
  });
  afterEach(() => {
    setConfig(null);
    vi.restoreAllMocks();
  });

  const limited = async (forwardedFor: string) =>
    (await fetch(`${harness.baseUrl}/api/v1/projects`, { headers: { 'x-forwarded-for': forwardedFor } })).status;

  it('does not let a rotating X-Forwarded-For escape a per-ingress limit when no proxy is trusted', async () => {
    const current = config();
    setConfig({ ...current, trustedProxies: null, limits: { ...current.limits, publicCatalogPerMinute: 2 } });
    const statuses = [];
    // Different /24 networks: anonymous quotas group IPv4 by /24, so these would be separate buckets if believed.
    for (let index = 0; index < 4; index += 1) statuses.push(await limited(`198.51.${100 + index}.10`));
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it('counts each forwarded client separately behind a trusted proxy', async () => {
    const current = config();
    // The test client connects from loopback, standing in for the platform's proxy.
    setConfig({ ...current, trustedProxies: parseTrustedProxies('private'), limits: { ...current.limits, publicCatalogPerMinute: 1 } });
    expect(await limited('203.0.113.1')).toBe(200);
    expect(await limited('203.0.113.1')).toBe(429);
    // A different /24, with a forged entry in front that must be ignored.
    expect(await limited('6.6.6.6, 198.51.100.200')).toBe(200);
  });

  it('hands Better Auth only the address it resolved, never one the caller sent', async () => {
    const seen: Array<string | null> = [];
    vi.spyOn(auth(), 'handler').mockImplementation(async (request: Request) => {
      seen.push(request.headers.get(CLIENT_IP_HEADER));
      return new Response(null, { status: 204 });
    });
    const current = config();
    setConfig({ ...current, trustedProxies: parseTrustedProxies('private') });
    await fetch(`${harness.baseUrl}${current.authBasePath}/ok`, { headers: { [CLIENT_IP_HEADER]: '6.6.6.6', 'x-forwarded-for': '203.0.113.5' } });
    setConfig({ ...current, trustedProxies: null });
    await fetch(`${harness.baseUrl}${current.authBasePath}/ok`, { headers: { [CLIENT_IP_HEADER]: '6.6.6.6' } });
    expect(seen).toEqual(['203.0.113.5', '127.0.0.1']);
  });
});
