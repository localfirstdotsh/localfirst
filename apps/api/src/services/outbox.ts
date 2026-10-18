/**
 * Transactional outbox (BACKEND_PRD section 16.3).
 *
 * Domain state, audit, operation, and outbox rows are written atomically. A
 * dispatcher delivers events to workers; duplicate delivery is expected and
 * every worker is idempotent.
 */

import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { outboxEvents } from '../db/schema/registry.js';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';

export type OutboxEventType =
  | 'project.published'
  | 'project.visibility_changed'
  | 'project.quarantined'
  | 'project.restored'
  | 'project.manager_changed'
  | 'draft.import_requested'
  | 'draft.discarded'
  | 'source.drift_check_requested'
  | 'evidence.changed';

export interface OutboxInput {
  eventType: OutboxEventType;
  aggregateKind: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export async function emitEvent(tx: DbOrTx, input: OutboxInput): Promise<void> {
  await tx.insert(outboxEvents).values({
    eventType: input.eventType,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    payload: input.payload,
  });
}

export interface PendingEvent {
  id: string;
  eventType: string;
  aggregateKind: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Claim undispatched events in creation order. */
export async function pendingEvents(limit: number): Promise<PendingEvent[]> {
  const rows = await db()
    .select({
      id: outboxEvents.id,
      eventType: outboxEvents.eventType,
      aggregateKind: outboxEvents.aggregateKind,
      aggregateId: outboxEvents.aggregateId,
      payload: outboxEvents.payload,
      attempts: outboxEvents.attempts,
    })
    .from(outboxEvents)
    .where(isNull(outboxEvents.dispatchedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit);
  return rows as PendingEvent[];
}

/**
 * Claim undispatched events inside `tx` with `for update skip locked`, so
 * concurrent workers take different events instead of repeating each other's.
 * The locks last until `tx` ends.
 */
export async function lockPendingEvents(tx: DbOrTx, limit: number): Promise<PendingEvent[]> {
  const result = await tx.execute<Record<string, unknown>>(sql`
    select id, event_type, aggregate_kind, aggregate_id, payload, attempts
    from outbox_events
    where dispatched_at is null
    order by created_at asc
    limit ${limit}
    for update skip locked`);
  return (result.rows ?? result).map((row) => ({
    id: String(row.id),
    eventType: String(row.event_type),
    aggregateKind: String(row.aggregate_kind),
    aggregateId: String(row.aggregate_id),
    payload: row.payload as Record<string, unknown>,
    attempts: Number(row.attempts),
  }));
}

export async function markAllDispatched(tx: DbOrTx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(outboxEvents)
    .set({ dispatchedAt: new Date(), lastError: null })
    .where(inArray(outboxEvents.id, ids));
}

export async function markDispatched(id: string): Promise<void> {
  await db()
    .update(outboxEvents)
    .set({ dispatchedAt: new Date(), lastError: null })
    .where(eq(outboxEvents.id, id));
}

export async function markDispatchFailed(id: string, errorClass: string): Promise<void> {
  await db()
    .update(outboxEvents)
    .set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: errorClass })
    .where(eq(outboxEvents.id, id));
}

/** Queue age in seconds, for readiness and observability (section 19.3). */
export async function outboxQueueAgeSeconds(): Promise<number> {
  const result = await db().execute<{ age: number | null }>(
    sql`select coalesce(max(extract(epoch from (now() - created_at))), 0)::float8 as age
        from outbox_events where dispatched_at is null`,
  );
  const row = (result.rows ?? result)[0] as { age: number | null } | undefined;
  return Number(row?.age ?? 0);
}

/** Retention: dispatched events are pruned after the configured window. */
export async function pruneDispatchedEvents(olderThan: Date): Promise<void> {
  await db()
    .delete(outboxEvents)
    .where(and(sql`${outboxEvents.dispatchedAt} is not null`, lt(outboxEvents.dispatchedAt, olderThan)));
}
