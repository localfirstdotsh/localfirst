/**
 * Shared rate limits (BACKEND_PRD section 19.2).
 *
 * Counters live in PostgreSQL so limits hold across replicas. Buckets are
 * coarse: an unauthenticated caller is limited per ingress bucket, an
 * authenticated caller per actor and client.
 */

import { sql } from 'drizzle-orm';
import { ERROR_CODES } from '@localfirst/contracts';
import { db } from '../db/client.js';
import { ApiError } from './errors.js';
import { actorKey, type Actor } from './context.js';

export interface LimitSpec {
  name: string;
  max: number;
  windowSeconds: number;
}

export interface LimitResult {
  bucket: string;
  remaining: number;
  resetSeconds: number;
}

/** Coarse ingress bucket for anonymous callers: no per-IP user tracking. */
export function ingressBucket(ip: string | undefined): string {
  if (!ip) return 'ingress:unknown';
  const trimmed = ip.split(',')[0]?.trim() ?? '';
  if (trimmed.includes(':')) {
    // IPv6: group by /64 so one host cannot rotate addresses cheaply.
    return `ingress:${trimmed.split(':').slice(0, 4).join(':')}`;
  }
  return `ingress:${trimmed.split('.').slice(0, 3).join('.')}`;
}

/**
 * Atomic fixed-window counter. A full window is returned to the caller with
 * Retry-After so shared networks receive an honest wait, not a silent drop.
 */
export async function consumeLimit(
  bucketPrefix: string,
  spec: LimitSpec,
  /** Units to charge: a request carrying several calls pays for each of them. */
  cost = 1,
): Promise<LimitResult> {
  const bucketKey = `${spec.name}:${bucketPrefix}`;
  const windowMs = spec.windowSeconds * 1000;
  const rows = await db().execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limit_counters (bucket_key, window_start, count, expires_at)
    values (
      ${bucketKey},
      to_timestamp(floor(extract(epoch from now()) / ${spec.windowSeconds}) * ${spec.windowSeconds}),
      ${cost},
      to_timestamp(floor(extract(epoch from now()) / ${spec.windowSeconds}) * ${spec.windowSeconds}) + make_interval(secs => ${spec.windowSeconds})
    )
    on conflict (bucket_key) do update set
      count = case
        when rate_limit_counters.window_start <
             to_timestamp(floor(extract(epoch from now()) / ${spec.windowSeconds}) * ${spec.windowSeconds})
        then ${cost}
        else rate_limit_counters.count + ${cost}
      end,
      window_start = greatest(
        rate_limit_counters.window_start,
        to_timestamp(floor(extract(epoch from now()) / ${spec.windowSeconds}) * ${spec.windowSeconds})
      ),
      expires_at = greatest(
        rate_limit_counters.window_start,
        to_timestamp(floor(extract(epoch from now()) / ${spec.windowSeconds}) * ${spec.windowSeconds})
      ) + make_interval(secs => ${spec.windowSeconds})
    returning count, window_start
  `);
  const row = (rows.rows ?? rows)[0] as { count: number; window_start: Date } | undefined;
  const count = Number(row?.count ?? 1);
  const windowStart = row?.window_start ? new Date(row.window_start).getTime() : Date.now();
  const resetSeconds = Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000));

  if (count > spec.max) {
    throw new ApiError({
      code: ERROR_CODES.RATE_LIMITED,
      message: 'The shared rate limit for this operation has been reached.',
      headers: { 'Retry-After': String(resetSeconds) },
      details: { limit: spec.max, window_seconds: spec.windowSeconds, bucket: spec.name },
    });
  }
  return { bucket: bucketKey, remaining: Math.max(0, spec.max - count), resetSeconds };
}

export function bucketForActor(actor: Actor, ip: string | undefined): string {
  return actor.kind === 'anonymous' ? ingressBucket(ip) : actorKey(actor);
}

/** Remove expired counters; called by the retention job. */
export async function pruneRateLimits(): Promise<number> {
  const result = await db().execute<{ count: string }>(
    sql`with deleted as (delete from rate_limit_counters where expires_at < now() returning 1)
        select count(*)::text as count from deleted`,
  );
  const row = (result.rows ?? result)[0] as { count: string } | undefined;
  return Number(row?.count ?? '0');
}
