/**
 * Localfirst profiles for people who sign in (BACKEND_PRD sections 10.1 and
 * 17.2).
 *
 * Better Auth owns the `user` row; Localfirst keeps the public handle, display
 * name, and external identity hints in `user_profiles`, and refuses any
 * identity without one. Every successful sign-in creates a session, after the
 * user row exists, so the session hook creates a missing profile there. That
 * covers brand-new users and repairs any user created before this existed.
 *
 * The GitHub login is the natural handle, but Better Auth stores only name,
 * email, and image. `validateUserInfo` sees the raw provider profile on the
 * same request, so it remembers the login briefly, keyed by email, for the
 * session hook to use.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userTable } from '../db/schema/auth.js';
import { userProfiles } from '../db/schema/registry.js';
import { createLogger } from '../observability/logger.js';

// Created on first use: this module is reached from the auth options, which
// load early (and statically, for the schema generator), so it creates no
// logger at import time.
let log: ReturnType<typeof createLogger> | null = null;
const logger = () => (log ??= createLogger('profiles'));

/** GitHub's login rule: alphanumerics and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Logins seen during sign-ins in flight. Entries live for one request at most. */
const pendingLogins = new Map<string, { login: string; expiresAt: number }>();
const PENDING_TTL_MS = 60_000;

const emailKey = (email: string) => email.trim().toLowerCase();

/** Remember the GitHub login carried by a sign-in, if it is a valid one. */
export function rememberGithubLogin(email: string | null | undefined, profile: Record<string, unknown> | undefined): void {
  const login = profile?.login;
  if (!email || typeof login !== 'string' || !GITHUB_LOGIN.test(login)) return;
  const now = Date.now();
  for (const [key, entry] of pendingLogins) if (entry.expiresAt < now) pendingLogins.delete(key);
  pendingLogins.set(emailKey(email), { login, expiresAt: now + PENDING_TTL_MS });
}

function takeGithubLogin(email: string): string | null {
  const key = emailKey(email);
  const entry = pendingLogins.get(key);
  pendingLogins.delete(key);
  return entry && entry.expiresAt >= Date.now() ? entry.login : null;
}

/** A handle base from a name when no login is known: lowercase words joined by hyphens. */
function handleFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32);
  return base || 'member';
}

function* handleCandidates(base: string): Generator<string> {
  yield base;
  for (let suffix = 2; suffix <= 20; suffix += 1) yield `${base.slice(0, 35)}-${suffix}`;
  for (;;) yield `${base.slice(0, 30)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isHandleTaken = (error: unknown) => {
  const pg = (error as { cause?: { code?: string; constraint?: string } })?.cause ?? (error as { code?: string; constraint?: string });
  return pg?.code === '23505' && pg.constraint === 'user_profiles_handle_uidx';
};

/**
 * Create the profile for `userId` if it has none. Idempotent and safe under
 * concurrent sign-ins: an existing profile is never changed.
 */
export async function ensureProfile(userId: string, login: string | null = null): Promise<'created' | 'exists'> {
  const [existing] = await db().select({ userId: userProfiles.userId }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  if (existing) return 'exists';
  const [user] = await db().select({ name: userTable.name, email: userTable.email }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  if (!user) return 'exists';
  const githubLogin = login ?? takeGithubLogin(user.email);
  const base = githubLogin ?? handleFromName(user.name);
  let attempts = 0;
  for (const handle of handleCandidates(base)) {
    attempts += 1;
    try {
      const inserted = await db()
        .insert(userProfiles)
        .values({
          userId,
          handle,
          displayName: user.name.trim() || githubLogin || handle,
          externalIdentities: githubLogin ? [`github:${githubLogin}`] : [],
        })
        .onConflictDoNothing({ target: userProfiles.userId })
        .returning({ userId: userProfiles.userId });
      if (inserted.length === 0) return 'exists';
      logger().info({ user_id: userId, handle_from: githubLogin ? 'github_login' : 'name', attempts }, 'profile created');
      return 'created';
    } catch (error) {
      if (!isHandleTaken(error) || attempts >= 30) throw error;
    }
  }
  throw new Error('unreachable');
}

/** Test helper: forget any remembered logins. */
export function resetPendingLogins(): void {
  pendingLogins.clear();
}
