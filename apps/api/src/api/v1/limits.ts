/**
 * Route-level rate limits (BACKEND_PRD section 19.2).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { ERROR_CODES } from '@localfirst/contracts';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { drafts } from '../../db/schema/registry.js';
import { ApiError } from '../../http/errors.js';
import { bucketForActor, consumeLimit } from '../../http/rate-limit.js';
import type { Actor, AppContext } from '../../http/context.js';

/** The client address behind trusted proxies (`src/http/client-ip.ts`), never a raw header. */
function clientIp(c: AppContext): string | undefined {
  return c.get('clientIp');
}

export async function limitPublicRead(c: AppContext): Promise<void> {
  const actor = c.get('actor');
  const limits = config().limits;
  const result = await consumeLimit(
    bucketForActor(actor, clientIp(c)),
    actor.kind === 'anonymous'
      ? { name: 'public_catalog', max: limits.publicCatalogPerMinute, windowSeconds: 60 }
      : { name: 'authenticated_read', max: limits.authenticatedReadsPerMinute, windowSeconds: 60 },
  );
  c.set('rateLimitBucket', result.bucket);
}

export async function limitCompatibility(c: AppContext): Promise<void> {
  const result = await consumeLimit(bucketForActor(c.get('actor'), clientIp(c)), {
    name: 'public_compatibility',
    max: config().limits.publicCompatibilityPerMinute,
    windowSeconds: 60,
  });
  c.set('rateLimitBucket', result.bucket);
}

/**
 * Contribution quotas (drafts, publications, build and result submissions)
 * are per account, whichever transport or OAuth client carries the request:
 * a session, the REST API, and every MCP client of one account draw on the
 * same bucket, so authorizing more clients does not multiply them.
 */
function accountBucket(actor: Actor, ip?: string): string {
  return actor.kind === 'anonymous' ? bucketForActor(actor, ip) : `user:${actor.userId}`;
}

export function consumeDraftQuota(actor: Actor, ip?: string) {
  return consumeLimit(accountBucket(actor, ip), { name: 'drafts', max: config().limits.draftsPerHour, windowSeconds: 3600 });
}

export function consumePublicationQuota(actor: Actor, ip?: string) {
  return consumeLimit(accountBucket(actor, ip), { name: 'publications', max: config().limits.publicationsPerDay, windowSeconds: 24 * 3600 });
}

/**
 * Section 19.2: opt-in test reports, 100 a day by default. Saving a build
 * counts too; the CLI uploads a result with its build in one request, which
 * counts once.
 */
export function consumeSubmissionQuota(actor: Actor, ip?: string) {
  return consumeLimit(accountBucket(actor, ip), { name: 'submissions', max: config().limits.submissionsPerDay, windowSeconds: 24 * 3600 });
}

export async function limitDraftCreation(c: AppContext): Promise<void> {
  const result = await consumeDraftQuota(c.get('actor'), clientIp(c));
  c.set('rateLimitBucket', result.bucket);
}

export async function limitPublication(c: AppContext): Promise<void> {
  const result = await consumePublicationQuota(c.get('actor'), clientIp(c));
  c.set('rateLimitBucket', result.bucket);
}

export async function limitSubmission(c: AppContext): Promise<void> {
  const result = await consumeSubmissionQuota(c.get('actor'), clientIp(c));
  c.set('rateLimitBucket', result.bucket);
}

/** At most two concurrent imports per user (section 19.2). */
export async function assertImportSlotAvailable(userId: string): Promise<void> {
  const active = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.ownerUserId, userId), inArray(drafts.state, ['ingesting'])));
  if (active.length >= config().limits.concurrentImports) {
    throw new ApiError({
      code: ERROR_CODES.RATE_LIMITED,
      message: 'Too many imports are already running for this account.',
      headers: { 'Retry-After': '30' },
      details: { concurrent_imports: active.length, limit: config().limits.concurrentImports },
    });
  }
}
