/**
 * Durable operation records (BACKEND_PRD section 11 async response contract).
 *
 * Polling checks ownership and the relevant scope and returns safe status only.
 */

import { and, eq } from 'drizzle-orm';
import { operations } from '../db/schema/registry.js';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';
import type { Actor } from '../http/context.js';
import { actorClientId, actorUserId, isOperator } from '../http/context.js';
import { ApiError } from '../http/errors.js';

export type OperationKind =
  | 'project.source_import'
  | 'project.publish'
  | 'project.index'
  | 'source.drift_check'
  | 'evidence.reaggregate'
  | 'report.validate'
  | 'retention.sweep';

export interface CreateOperationInput {
  kind: OperationKind;
  actor: Actor;
  targetKind: string;
  targetId: string;
  requiredScope?: string | null;
}

export interface OperationRecord {
  id: string;
  kind: string;
  state: string;
  targetKind: string | null;
  targetId: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export async function createOperation(
  tx: DbOrTx,
  input: CreateOperationInput,
): Promise<string> {
  const [row] = await tx
    .insert(operations)
    .values({
      kind: input.kind,
      state: 'queued',
      actorUserId: actorUserId(input.actor),
      actorClientId: actorClientId(input.actor),
      requiredScope: input.requiredScope ?? null,
      targetKind: input.targetKind,
      targetId: input.targetId,
    })
    .returning({ id: operations.id });
  if (!row) throw ApiError.internal('The operation could not be recorded.');
  return row.id;
}

export async function markOperationRunning(id: string): Promise<void> {
  await db()
    .update(operations)
    .set({ state: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(operations.id, id));
}

export async function markOperationSucceeded(
  id: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db()
    .update(operations)
    .set({
      state: 'succeeded',
      result,
      errorCode: null,
      errorMessage: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(operations.id, id));
}

export async function markOperationFailed(
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db()
    .update(operations)
    .set({
      state: 'failed',
      errorCode,
      errorMessage,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(operations.id, id));
}

/** Operator-triggered retry of an eligible failed operation (section 12.3). */
export async function requeueOperation(id: string): Promise<boolean> {
  const result = await db()
    .update(operations)
    .set({ state: 'queued', errorCode: null, errorMessage: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(operations.id, id), eq(operations.state, 'failed')))
    .returning({ id: operations.id });
  return result.length > 0;
}

export async function getOperationForActor(id: string, actor: Actor): Promise<OperationRecord> {
  const [row] = await db()
    .select({
      id: operations.id,
      kind: operations.kind,
      state: operations.state,
      targetKind: operations.targetKind,
      targetId: operations.targetId,
      result: operations.result,
      errorCode: operations.errorCode,
      errorMessage: operations.errorMessage,
      actorUserId: operations.actorUserId,
      requiredScope: operations.requiredScope,
      createdAt: operations.createdAt,
      updatedAt: operations.updatedAt,
      finishedAt: operations.finishedAt,
    })
    .from(operations)
    .where(eq(operations.id, id))
    .limit(1);

  // Knowledge of an ID never grants access (section 13.4).
  if (!row) throw ApiError.notFound();
  const owned = actorUserId(actor) !== null && row.actorUserId === actorUserId(actor);
  if (!owned && !isOperator(actor)) throw ApiError.notFound();
  if (owned && row.requiredScope && actor.kind === 'token' && !actor.scopes.has(row.requiredScope)) {
    throw ApiError.insufficientScope([row.requiredScope]);
  }
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    targetKind: row.targetKind,
    targetId: row.targetId,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

export function serializeOperation(record: OperationRecord): Record<string, unknown> {
  return {
    operation_id: record.id,
    kind: record.kind,
    state: record.state,
    target: record.targetKind ? { kind: record.targetKind, id: record.targetId } : null,
    result: record.result ?? null,
    error: record.errorCode
      ? { code: record.errorCode, message: record.errorMessage ?? 'The operation failed.' }
      : null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    finished_at: record.finishedAt?.toISOString() ?? null,
  };
}
