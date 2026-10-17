/**
 * Caller resolution (BACKEND_PRD sections 10.1, 10.3, 10.5).
 *
 * Bearer verification checks issuer, audience, signature, expiry, and scopes
 * plus the current account and target policy. An invalid supplied bearer token
 * must not silently fall back to a valid cookie. Revocation and account checks
 * apply to private reads and mutations with at most a 60 second cache.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { operatorRoles, userProfiles } from '../db/schema/registry.js';
import { config } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Actor, OperatorRole } from '../http/context.js';
import { PRODUCT_SCOPES, parseScopeClaim } from './scopes.js';
import { auth } from './instance.js';
import { resolveApproverCredential } from '../services/approvers.js';

interface AccountState {
  exists: boolean;
  suspended: boolean;
  deleting: boolean;
  operatorRoles: OperatorRole[];
  checkedAtMs: number;
}

const accountCache = new Map<string, AccountState>();

/** Challenge advertised to bearer callers at the REST resource (RFC 9728). */
export function restChallenge(extra?: { error?: string; scopes?: string[] }): string {
  const parts = [
    `Bearer realm="localfirst"`,
    `resource_metadata="${config().apiBaseUrl}/.well-known/oauth-protected-resource/api/v1"`,
  ];
  if (extra?.error) parts.push(`error="${extra.error}"`);
  if (extra?.scopes?.length) parts.push(`scope="${extra.scopes.join(' ')}"`);
  return parts.join(', ');
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwksResolver(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(new URL(`${config().authIssuer}/jwks`), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return jwks;
}

export function resetAuthCaches(): void {
  accountCache.clear();
  jwks = null;
}

async function loadAccountState(userId: string): Promise<AccountState> {
  const cached = accountCache.get(userId);
  const maxAgeMs = config().ttl.authCheckCacheSeconds * 1000;
  // Deletion state is never cached: access must stop across replicas promptly.
  // Cache role lookups only; always check the account row.

  const [profile] = await db()
    .select({ suspendedAt: userProfiles.suspendedAt, deletionRequestedAt: userProfiles.deletionRequestedAt })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const useCachedRoles = cached !== undefined && Date.now() - cached.checkedAtMs <= maxAgeMs;
  const roles = useCachedRoles
    ? cached.operatorRoles.map((role) => ({ role }))
    : await db()
        .select({ role: operatorRoles.role })
        .from(operatorRoles)
        .where(and(eq(operatorRoles.userId, userId), isNull(operatorRoles.revokedAt)));

  const state: AccountState = {
    exists: profile !== undefined,
    suspended: profile?.suspendedAt != null,
    deleting: profile?.deletionRequestedAt != null,
    operatorRoles: roles
      .map((row) => row.role)
      .filter((role): role is OperatorRole => role === 'admin' || role === 'moderator'),
    checkedAtMs: useCachedRoles ? cached.checkedAtMs : Date.now(),
  };
  accountCache.set(userId, state);
  return state;
}

function assertUsable(state: AccountState): void {
  if (!state.exists) {
    throw ApiError.forbidden('This identity has no Localfirst profile.');
  }
  if (state.deleting) throw ApiError.forbidden('This account has requested deletion.');
  if (state.suspended) {
    throw new ApiError({
      code: 'ACCOUNT_SUSPENDED',
      message: 'This account is suspended.',
      status: 403,
    });
  }
}

export interface ResolveActorInput {
  headers: Headers;
  /** Audience the token must be bound to: the REST or MCP resource. */
  audience: string;
}

/**
 * Resolve the caller from a bearer token or, in its absence, a browser session.
 * A present-but-invalid bearer token is an error, never a downgrade.
 */
export async function resolveActor({ headers, audience }: ResolveActorInput): Promise<Actor> {
  const authorization = headers.get('authorization');
  if (authorization) {
    const approver = await resolveApproverActor(authorization);
    if (approver) return approver;
    return resolveBearerActor(authorization, audience);
  }
  const session = await resolveSessionActor(headers);
  return session ?? { kind: 'anonymous' };
}

/**
 * A bearer secret with the approver prefix is an approval credential, never a
 * JWT. An unknown, expired, or revoked one is an error, not a downgrade. The
 * REST adapter limits where this kind of caller is accepted at all.
 */
async function resolveApproverActor(authorization: string): Promise<Actor | null> {
  const match = /^Bearer\s+(lfh_\S+)$/i.exec(authorization.trim());
  if (!match) return null;
  const resolved = await resolveApproverCredential(match[1] as string);
  if (!resolved) {
    throw ApiError.invalidCredential(
      'The approval credential is not valid. Link this machine again.',
      restChallenge({ error: 'invalid_token' }),
    );
  }
  const state = await loadAccountState(resolved.userId);
  assertUsable(state);
  return {
    kind: 'approver',
    userId: resolved.userId,
    credentialId: resolved.credentialId,
    operatorRoles: [],
    scopes: new Set<string>(),
  };
}

export async function resolveBearerActor(authorization: string, audience: string): Promise<Actor> {
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    throw ApiError.invalidCredential(
      'Only the Bearer authorization scheme is accepted.',
      restChallenge({ error: 'invalid_request' }),
    );
  }
  const token = (match[1] ?? '').trim();
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwksResolver(), {
      issuer: config().authIssuer,
      audience,
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch {
    // Wrong issuer, wrong audience, bad signature, expiry, or an ID token used
    // as an access token all land here with one safe message.
    throw ApiError.invalidCredential(
      'The access token is not valid for this resource.',
      restChallenge({ error: 'invalid_token' }),
    );
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) {
    throw ApiError.invalidCredential(
      'The access token has no subject.',
      restChallenge({ error: 'invalid_token' }),
    );
  }
  // An ID token carries a nonce/at_hash and is never an access token.
  if (payload.nonce !== undefined || payload.at_hash !== undefined) {
    throw ApiError.invalidCredential(
      'An identity token cannot be used as an access token.',
      restChallenge({ error: 'invalid_token' }),
    );
  }

  const scopes = parseScopeClaim(payload.scope ?? payload.scopes);
  const state = await loadAccountState(userId);
  assertUsable(state);

  return {
    kind: 'token',
    userId,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
    tokenId: typeof payload.jti === 'string' ? payload.jti : 'unknown',
    operatorRoles: state.operatorRoles,
    scopes,
    audience,
  };
}

export async function resolveSessionActor(headers: Headers): Promise<Actor | null> {
  const devActor = await resolveDevActor(headers);
  if (devActor) return devActor;

  if (!headers.get('cookie')) return null;
  const session = await auth().api.getSession({ headers });
  if (!session?.user?.id || !session.session?.id) return null;

  const state = await loadAccountState(session.user.id);
  assertUsable(state);

  return {
    kind: 'session',
    userId: session.user.id,
    sessionId: session.session.id,
    operatorRoles: state.operatorRoles,
    // A human browser session acts for its own records across product scopes;
    // every mutation still passes ownership and approval checks.
    scopes: new Set<string>(Object.keys(PRODUCT_SCOPES)),
  };
}

/**
 * Development-only header identity, used by local tests:
 * `X-Dev-User` names the account, `X-Dev-Scopes` narrows the granted scopes,
 * and `X-Dev-Actor: token` impersonates an agent credential rather than a human
 * session, so the human-only boundary is testable. Refused unless
 * DEV_AUTH_ENABLED is set, and configuration rejects it in production.
 */
async function resolveDevActor(headers: Headers): Promise<Actor | null> {
  if (!config().features.devAuth) return null;
  const userId = headers.get('x-dev-user');
  if (!userId) return null;
  const state = await loadAccountState(userId);
  assertUsable(state);
  const requested = headers.get('x-dev-scopes');
  const scopes = requested
    ? new Set(requested.split(/[\s,]+/).filter(Boolean))
    : new Set<string>(Object.keys(PRODUCT_SCOPES));

  if (headers.get('x-dev-actor') === 'token') {
    return {
      kind: 'token',
      userId,
      clientId: headers.get('x-dev-client') ?? 'dev-client',
      tokenId: 'dev-token',
      operatorRoles: state.operatorRoles,
      scopes,
      audience: config().restResource,
    };
  }
  return {
    kind: 'session',
    userId,
    sessionId: `dev-session:${userId}`,
    operatorRoles: state.operatorRoles,
    scopes,
  };
}
