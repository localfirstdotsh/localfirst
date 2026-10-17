/**
 * GitHub sign-in end to end (BACKEND_PRD sections 10.1 and 20.4). The real
 * Better Auth routes run over HTTP; only GitHub's three endpoints (token
 * exchange, profile, emails) are simulated. A person who signs in must get a
 * Localfirst profile, or every authenticated route refuses them.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { accountTable, userTable } from '../src/db/schema/auth.js';
import { userProfiles } from '../src/db/schema/registry.js';
import { ensureProfile, resetPendingLogins } from '../src/auth/profiles.js';
import { config, setConfig } from '../src/config.js';
import { parseTrustedProxies } from '../src/http/client-ip.js';
import { startTestServer, type Harness } from './server-harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(() => {
  // Each simulated person arrives from their own address through a trusted
  // proxy, so Better Auth's per-client sign-in limit applies per person.
  setConfig({ ...config(), trustedProxies: parseTrustedProxies('private') });
});
afterEach(() => {
  setConfig(null);
  vi.restoreAllMocks();
  resetPendingLogins();
});
let clientCounter = 0;
const nextClient = () => `198.51.${100 + (clientCounter++ % 100)}.${10 + (clientCounter % 200)}`;

interface GithubUser { id: number; login: string; name: string | null; email: string }

/** Simulate GitHub for one person; every other request goes to the real network stack. */
function simulateGithub(person: GithubUser) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.href === 'https://github.com/login/oauth/access_token') {
      // An OAuth app with expiring user tokens, as configured for staging.
      return json({ access_token: `gho_${randomUUID()}`, token_type: 'bearer', scope: 'read:user,user:email', expires_in: 28800, refresh_token: `ghr_${randomUUID()}`, refresh_token_expires_in: 15897600 });
    }
    if (url.href === 'https://api.github.com/user') {
      return json({ id: person.id, login: person.login, name: person.name, email: person.email, avatar_url: `https://avatars.githubusercontent.com/u/${person.id}` });
    }
    if (url.href === 'https://api.github.com/user/emails') {
      return json([{ email: person.email, primary: true, verified: true, visibility: 'private' }]);
    }
    return realFetch(input, init);
  });
}

const cookiesOf = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!).join('; ');

/** The browser flow: start the sign-in, return from GitHub, then call an authenticated route. */
async function signInWithGithub(person: GithubUser) {
  const base = harness.baseUrl;
  const client = { 'x-forwarded-for': nextClient() };
  const started = await fetch(`${base}${config().authBasePath}/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...client },
    body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
  const state = authorize.searchParams.get('state')!;

  const callback = await fetch(`${base}${config().authBasePath}/callback/github?code=code-${randomUUID()}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookiesOf(started), ...client },
    redirect: 'manual',
  });
  expect(callback.status, await callback.clone().text()).toBe(302);
  const session = cookiesOf(callback);
  expect(session).toContain('session_token=');
  const me = await fetch(`${base}/api/v1/me`, { headers: { cookie: session, ...client } });
  return { me, body: (await me.json()) as { data?: Record<string, unknown>; error?: { code: string } } };
}

const person = (overrides: Partial<GithubUser> = {}): GithubUser => {
  const id = Math.floor(Math.random() * 1e9);
  return { id, login: `octo-${id}`, name: 'Octo Tester', email: `octo-${id}@example.test`, ...overrides };
};

describe('GitHub sign-in', () => {
  it('returns a cancelled provider flow to the browser recovery page', async () => {
    const base = harness.baseUrl;
    const client = { 'x-forwarded-for': nextClient() };
    const started = await fetch(
      `${base}${config().authBasePath}/sign-in/social`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          ...client,
        },
        body: JSON.stringify({
          provider: 'github',
          callbackURL: `${config().websiteUrl}/account/connections`,
          errorCallbackURL: `${config().websiteUrl}/sign-in?next=%2Faccount%2Fconnections`,
        }),
      },
    );
    expect(started.status).toBe(200);
    const data = (await started.json()) as { url: string };
    const state = new URL(data.url).searchParams.get('state')!;
    const cancelled = await fetch(
      `${base}${config().authBasePath}/callback/github?error=access_denied&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: cookiesOf(started), ...client },
        redirect: 'manual',
      },
    );
    expect(cancelled.status).toBe(302);
    const destination = new URL(cancelled.headers.get('location')!, base);
    expect(destination.pathname).toBe('/sign-in');
    expect(destination.searchParams.get('error')).toBe('access_denied');
    expect(destination.origin).toBe(new URL(config().websiteUrl).origin);
    expect(destination.searchParams.get('next')).toBe('/account/connections');
    // The root web app owns this recovery page; its content and CSP are checked in browser tests.
  });

  it('gives a first-time person a profile named after their GitHub login', async () => {
    const someone = person({ login: `Octo-Cat-${Date.now().toString(36)}` });
    simulateGithub(someone);
    const { me, body } = await signInWithGithub(someone);
    expect(me.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ handle: someone.login, display_name: 'Octo Tester', external_identities: [`github:${someone.login}`] });
  });

  it('signs a returning person in again without changing their profile', async () => {
    const someone = person();
    simulateGithub(someone);
    const first = await signInWithGithub(someone);
    const second = await signInWithGithub(someone);
    expect(second.me.status).toBe(200);
    expect(second.body.data?.handle).toBe(first.body.data?.handle);
    const users = await db().select().from(userTable).where(eq(userTable.email, someone.email));
    expect(users).toHaveLength(1);
  });

  it('repairs a person who signed in before profiles were created', async () => {
    // The state staging was left in: a user and its GitHub account, but no profile.
    const someone = person();
    const userId = `gh-${someone.id}`;
    const now = new Date();
    await db().insert(userTable).values({ id: userId, name: someone.name!, email: someone.email, emailVerified: true, image: null, createdAt: now, updatedAt: now });
    await db().insert(accountTable).values({ id: randomUUID(), accountId: String(someone.id), providerId: 'github', userId, createdAt: now, updatedAt: now });
    simulateGithub(someone);
    const { me, body } = await signInWithGithub(someone);
    expect(me.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ handle: someone.login, external_identities: [`github:${someone.login}`] });
  });

  it('gives a second person whose login differs only in case a distinct handle', async () => {
    const login = `Shared-${Date.now().toString(36)}`;
    const first = person({ login });
    simulateGithub(first);
    expect((await signInWithGithub(first)).body.data?.handle).toBe(login);
    vi.restoreAllMocks();
    const second = person({ login: login.toLowerCase() });
    simulateGithub(second);
    const { me, body } = await signInWithGithub(second);
    expect(me.status).toBe(200);
    expect(body.data?.handle).toBe(`${login.toLowerCase()}-2`);
  });
});

describe('ensureProfile', () => {
  async function bareUser(name: string) {
    const id = `bare-${randomUUID()}`;
    const now = new Date();
    await db().insert(userTable).values({ id, name, email: `${id}@example.test`, emailVerified: false, image: null, createdAt: now, updatedAt: now });
    return id;
  }

  it('derives a handle from the name when no login is known', async () => {
    const id = await bareUser('Ada Lovelace');
    expect(await ensureProfile(id)).toBe('created');
    const [profile] = await db().select().from(userProfiles).where(eq(userProfiles.userId, id));
    expect(profile?.handle).toMatch(/^ada-lovelace(-\d+)?$/);
    expect(profile?.externalIdentities).toEqual([]);
  });

  it('is idempotent under concurrent sign-ins and never changes an existing profile', async () => {
    const id = await bareUser('Grace Hopper');
    const results = await Promise.all([ensureProfile(id, 'grace-h'), ensureProfile(id, 'grace-h'), ensureProfile(id, 'grace-h')]);
    expect(results.filter((result) => result === 'created')).toHaveLength(1);
    await db().update(userProfiles).set({ deletionRequestedAt: new Date() }).where(eq(userProfiles.userId, id));
    expect(await ensureProfile(id, 'someone-else')).toBe('exists');
    const [profile] = await db().select().from(userProfiles).where(eq(userProfiles.userId, id));
    expect(profile?.handle).toBe('grace-h');
    expect(profile?.deletionRequestedAt).not.toBeNull();
  });
});
