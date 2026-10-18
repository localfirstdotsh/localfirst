/**
 * Usage counters (BACKEND_PRD section 19.3.1).
 *
 * Counts requests served for published project versions, never people,
 * installs, or runs. Nothing identifying is stored. Reads have no write
 * transaction, so increments are buffered in process and flushed as batched
 * additive upserts; a failed flush is logged and dropped so counting can never
 * delay or fail a response. A crash can lose a few seconds of counts.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectUsageDaily, siteCounters } from '../db/schema/registry.js';
import type { Actor } from '../http/context.js';
import { createLogger } from '../observability/logger.js';
import { incrementCounter } from '../observability/metrics.js';

const log = createLogger('usage');

export type UsageChannel = 'rest_export' | 'mcp_retrieval';

export interface UsageTotals {
  spec_exports: number;
  agent_retrievals: number;
  /** Earliest UTC day with a recorded request; null when none were counted. */
  since: string | null;
}

interface CountableProject {
  id: string;
  visibility: string;
  managerUserId: string;
}

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFERED_KEYS = 5_000;

interface BufferedCount {
  projectId: string;
  versionId: string;
  dayUtc: string;
  channel: UsageChannel;
  count: number;
}

let buffer = new Map<string, BufferedCount>();
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Record one successful read of a published version. Failed requests, hidden or
 * quarantined projects, and the project manager's own previews never count.
 * Synchronous and non-throwing by design.
 */
export function recordUsage(
  actor: Actor,
  project: CountableProject,
  versionId: string,
  channel: UsageChannel,
): void {
  try {
    if (project.visibility !== 'published') return;
    if (actor.kind !== 'anonymous' && actor.userId === project.managerUserId) return;
    const dayUtc = utcDay();
    const key = `${project.id}|${versionId}|${dayUtc}|${channel}`;
    const existing = buffer.get(key);
    if (existing) existing.count += 1;
    else if (buffer.size < MAX_BUFFERED_KEYS)
      buffer.set(key, { projectId: project.id, versionId, dayUtc, channel, count: 1 });
    else incrementCounter('usage.buffer_full');
  } catch {
    // Counting must never affect a response.
  }
}

/** Write buffered counts. Safe to call concurrently; failures are logged and dropped. */
export function flushUsage(): Promise<void> {
  if (flushing) return flushing;
  if (buffer.size === 0) return Promise.resolve();
  const batch = [...buffer.values()];
  buffer = new Map();
  flushing = db()
    .insert(projectUsageDaily)
    .values(batch)
    .onConflictDoUpdate({
      target: [
        projectUsageDaily.projectId,
        projectUsageDaily.versionId,
        projectUsageDaily.dayUtc,
        projectUsageDaily.channel,
      ],
      set: { count: sql`${projectUsageDaily.count} + excluded.count` },
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      // A project deleted between request and flush fails the foreign key; the
      // whole batch is dropped, which is acceptable for approximate counters.
      incrementCounter('usage.flush_failed');
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'usage flush failed');
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/** Start the periodic flush. Idempotent; the timer never keeps the process alive. */
export function startUsageFlush(intervalMs = FLUSH_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void flushUsage(), intervalMs);
  timer.unref();
}

/** Stop the timer and write whatever is buffered. Call during graceful shutdown. */
export async function stopUsageFlush(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (flushing) await flushing;
  await flushUsage();
}

/** Drop buffered counts without writing; used by tests. */
export function resetUsageBuffer(): void {
  buffer = new Map();
}

/** Lifetime request totals for many projects in one grouped query. */
export async function usageTotalsFor(projectIds: string[]): Promise<Map<string, UsageTotals>> {
  const result = new Map<string, UsageTotals>();
  if (projectIds.length === 0) return result;
  const rows = await db().execute<{
    project_id: string;
    spec_exports: string;
    agent_retrievals: string;
    since: string | null;
  }>(sql`
    select project_id,
      coalesce(sum(count) filter (where channel = 'rest_export'), 0)::text as spec_exports,
      coalesce(sum(count) filter (where channel = 'mcp_retrieval'), 0)::text as agent_retrievals,
      min(day_utc) as since
    from project_usage_daily
    where project_id in (${sql.join(projectIds.map((id) => sql`${id}::uuid`), sql`, `)})
    group by project_id
  `);
  for (const row of (rows.rows ?? rows) as Array<{
    project_id: string;
    spec_exports: string;
    agent_retrievals: string;
    since: string | null;
  }>) {
    result.set(row.project_id, {
      spec_exports: Number(row.spec_exports),
      agent_retrievals: Number(row.agent_retrievals),
      since: row.since,
    });
  }
  return result;
}

export const EMPTY_USAGE: UsageTotals = { spec_exports: 0, agent_retrievals: 0, since: null };

/** Per-day request series for the project's manager and operators. */
export async function usageSeries(projectId: string, days = 90): Promise<UsageDay[]> {
  const rows = await db().execute<{ day_utc: string; spec_exports: string; agent_retrievals: string }>(sql`
    select day_utc,
      coalesce(sum(count) filter (where channel = 'rest_export'), 0)::text as spec_exports,
      coalesce(sum(count) filter (where channel = 'mcp_retrieval'), 0)::text as agent_retrievals
    from project_usage_daily
    where project_id = ${projectId}::uuid
      and day_utc >= ${utcDay(new Date(Date.now() - days * 86_400_000))}
    group by day_utc
    order by day_utc desc
  `);
  return ((rows.rows ?? rows) as Array<{ day_utc: string; spec_exports: string; agent_retrievals: string }>).map(
    (row) => ({
      day: row.day_utc,
      spec_exports: Number(row.spec_exports),
      agent_retrievals: Number(row.agent_retrievals),
    }),
  );
}

/** Site-wide consents ever granted; revocation and deletion never lower it. */
export async function connectionsAuthorized(): Promise<number> {
  const [row] = await db()
    .select({ value: siteCounters.value })
    .from(siteCounters)
    .where(sql`${siteCounters.key} = 'connections_authorized'`)
    .limit(1);
  return row?.value ?? 0;
}

/** Consents that currently exist (the owner/operator-visible active figure). */
export async function connectionsActive(): Promise<number> {
  const rows = await db().execute<{ n: string }>(sql`select count(*)::text as n from oauth_consent`);
  return Number(((rows.rows ?? rows) as Array<{ n: string }>)[0]?.n ?? '0');
}

export interface UsageDay {
  day: string;
  spec_exports: number;
  agent_retrievals: number;
}

/**
 * Exactly `days` consecutive UTC days ending at `today`, oldest first, with days that
 * had no requests shown as zero. The stored series omits quiet days, which would
 * otherwise draw a chart as if the busy days were adjacent.
 */
export function fillDays(series: UsageDay[], days: number, today = new Date()): UsageDay[] {
  const byDay = new Map(series.map((row) => [row.day, row]));
  const result: UsageDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = utcDay(new Date(today.getTime() - offset * 86_400_000));
    result.push(byDay.get(day) ?? { day, spec_exports: 0, agent_retrievals: 0 });
  }
  return result;
}

export interface OwnedProjectUsage {
  project_id: string;
  slug: string;
  name: string;
  visibility: string;
  usage: UsageTotals;
}

async function ownedProjects(userId: string, projectId?: string): Promise<OwnedProjectUsage[]> {
  const only = projectId ? sql`and p.id = ${projectId}::uuid` : sql``;
  const rows = await db().execute<{ project_id: string; slug: string; name: string | null; visibility: string }>(sql`
    select p.id as project_id, p.slug, v.derived->>'name' as name, p.visibility
    from projects p
    left join project_versions v on v.id = p.current_version_id
    where p.manager_user_id = ${userId} ${only}
    order by p.created_at desc, p.id desc
    limit 200
  `);
  const owned = (rows.rows ?? rows) as Array<{ project_id: string; slug: string; name: string | null; visibility: string }>;
  const totals = await usageTotalsFor(owned.map((row) => row.project_id));
  return owned.map((row) => ({
    project_id: row.project_id,
    slug: row.slug,
    name: row.name ?? row.slug,
    visibility: row.visibility,
    usage: totals.get(row.project_id) ?? EMPTY_USAGE,
  }));
}

/** The caller's own projects, newest first, with lifetime request totals. */
export function listOwnedProjectsWithUsage(userId: string): Promise<OwnedProjectUsage[]> {
  return ownedProjects(userId);
}

/** One project, only if the caller manages it; anyone else gets null, as if it did not exist. */
export async function getOwnedProjectWithUsage(userId: string, projectId: string): Promise<OwnedProjectUsage | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return null;
  return (await ownedProjects(userId, projectId))[0] ?? null;
}
