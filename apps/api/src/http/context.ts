/**
 * Request context shared by the REST adapter, the web consent pages, and the
 * hosted MCP adapter.
 */

import type { Context } from 'hono';
import type { ProductScope } from '../auth/scopes.js';

export type OperatorRole = 'moderator' | 'admin';

/** Resolved caller. Ownership is always checked separately per record. */
export type Actor =
  | { kind: 'anonymous' }
  | {
      kind: 'session';
      userId: string;
      sessionId: string;
      operatorRoles: OperatorRole[];
      /** Browser sessions act for their own records across product scopes. */
      scopes: Set<string>;
    }
  | {
      kind: 'token';
      userId: string;
      clientId: string;
      tokenId: string;
      operatorRoles: OperatorRole[];
      scopes: Set<string>;
      audience: string;
    };

export interface AppVariables {
  requestId: string;
  actor: Actor;
  startedAt: number;
  /** Set by the rate limiter so handlers can report the applied bucket. */
  rateLimitBucket?: string;
  /** The client address behind trusted proxies; undefined when none can be trusted. */
  clientIp?: string;
}

export type AppEnv = { Variables: AppVariables };
export type AppContext = Context<AppEnv>;

export function actorUserId(actor: Actor): string | null {
  return actor.kind === 'anonymous' ? null : actor.userId;
}

export function actorClientId(actor: Actor): string | null {
  return actor.kind === 'token' ? actor.clientId : null;
}

/** `user:<id>` / `client:<id>` scope key for idempotency and rate limits. */
export function actorKey(actor: Actor): string {
  switch (actor.kind) {
    case 'anonymous':
      return 'anonymous';
    case 'session':
      return `user:${actor.userId}`;
    case 'token':
      return `user:${actor.userId}:client:${actor.clientId}`;
  }
}

export function isOperator(actor: Actor, role: OperatorRole = 'moderator'): boolean {
  if (actor.kind === 'anonymous') return false;
  if (actor.operatorRoles.includes('admin')) return true;
  return actor.operatorRoles.includes(role);
}

export function hasScope(actor: Actor, scope: ProductScope): boolean {
  if (actor.kind === 'anonymous') return false;
  return actor.scopes.has(scope);
}
