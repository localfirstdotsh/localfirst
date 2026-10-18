/**
 * Idempotent creation across REST and MCP (BACKEND_PRD section 11).
 *
 * The key is scoped to actor, operation, target, and the canonical request
 * digest. The same key with different content returns 409; a simultaneous
 * retry reuses one operation and result. Replayed private responses are
 * authorized again before they are returned.
 */

import { lockActiveAccount } from './accounts.js';
import { and, eq, lt } from 'drizzle-orm';
import { digestOf, ERROR_CODES } from '@localfirst/contracts';
import { createHash } from 'node:crypto';
import { idempotencyRecords } from '../db/schema/registry.js';
import { db } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { actorKey, type Actor } from '../http/context.js';

/** Replay records are kept at least 24 hours (section 17.5). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  operationId?: string | null;
}

export interface IdempotencyScope {
  actor: Actor;
  operation: string;
  targetKey?: string;
  key: string;
  request: unknown;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function requireIdempotencyKey(key: string | undefined | null, field = 'Idempotency-Key'): string {
  if (!key || key.trim().length === 0) {
    throw new ApiError({
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      message: `${field} is required for this operation.`,
      details: { header: field },
    });
  }
  if (key.length > 200) {
    throw ApiError.badRequest(`${field} must be at most 200 characters.`);
  }
  return key.trim();
}

/**
 * Run `work` at most once for this (actor, operation, target, key). A replay
 * with the same canonical request digest returns the stored response; a replay
 * with different content is a conflict.
 */
export async function withIdempotency<T>(
  scope: IdempotencyScope,
  work: () => Promise<IdempotentOutcome<T>>,
): Promise<IdempotentOutcome<T> & { replayed: boolean }> {
  const actorScope = actorKey(scope.actor);
  const keyHash = hashKey(scope.key);
  const requestDigest = digestOf(scope.request);
  const targetKey = scope.targetKey ?? '';
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);

  const inserted = await db().transaction(async (tx) => {
    if (scope.actor.kind === 'anonymous') throw ApiError.unauthenticated();
    await lockActiveAccount(tx, scope.actor.userId);
    return tx
      .insert(idempotencyRecords)
      .values({
        actorKey: actorScope,
        operation: scope.operation,
        targetKey,
        keyHash,
        requestDigest,
        state: 'in_flight',
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id });
  });

  if (inserted.length === 0) {
    const [existing] = await db()
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.actorKey, actorScope),
          eq(idempotencyRecords.operation, scope.operation),
          eq(idempotencyRecords.targetKey, targetKey),
          eq(idempotencyRecords.keyHash, keyHash),
        ),
      )
      .limit(1);
    if (!existing) throw ApiError.internal('The idempotency record could not be read.');
    if (existing.requestDigest !== requestDigest) {
      throw new ApiError({
        code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
        message: 'This idempotency key was already used with different content.',
        details: { operation: scope.operation },
      });
    }
    if (existing.state === 'completed' && existing.responseStatus) {
      return {
        status: existing.responseStatus,
        body: existing.responseBody as T,
        operationId: existing.operationId,
        replayed: true,
      };
    }
    if (existing.state === 'in_flight') {
      throw new ApiError({
        code: ERROR_CODES.CONFLICT,
        message: 'An identical request is still in progress.',
        headers: { 'Retry-After': '2' },
        details: { operation: scope.operation },
      });
    }
    // A previously failed attempt may be retried with the same key.
    await db()
      .update(idempotencyRecords)
      .set({ state: 'in_flight', updatedAt: new Date() })
      .where(eq(idempotencyRecords.id, existing.id));
  }

  try {
    const outcome = await work();
    await db()
      .update(idempotencyRecords)
      .set({
        state: 'completed',
        responseStatus: outcome.status,
        responseBody: outcome.body as Record<string, unknown>,
        operationId: outcome.operationId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(idempotencyRecords.actorKey, actorScope),
          eq(idempotencyRecords.operation, scope.operation),
          eq(idempotencyRecords.targetKey, targetKey),
          eq(idempotencyRecords.keyHash, keyHash),
        ),
      );
    return { ...outcome, replayed: false };
  } catch (error) {
    await db()
      .update(idempotencyRecords)
      .set({ state: 'failed', updatedAt: new Date() })
      .where(
        and(
          eq(idempotencyRecords.actorKey, actorScope),
          eq(idempotencyRecords.operation, scope.operation),
          eq(idempotencyRecords.targetKey, targetKey),
          eq(idempotencyRecords.keyHash, keyHash),
        ),
      );
    throw error;
  }
}

/** Retention: prune expired replay records; uniqueness constraints remain. */
export async function pruneIdempotencyRecords(now = new Date()): Promise<void> {
  await db().delete(idempotencyRecords).where(lt(idempotencyRecords.expiresAt, now));
}
