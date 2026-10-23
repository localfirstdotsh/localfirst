/**
 * Publication delegation (BACKEND_PRD section 10.4).
 *
 * An owner can let one connection publish their own drafts without a
 * per-artifact approval, the way a developer lets an agent push to a
 * repository. Only a browser session turns it on or off; a token can only
 * learn whether its own connection is delegated. A delegated publication
 * still names the exact revision and digest and acknowledges every warning,
 * and it is recorded as a delegated approval that the publish transaction
 * consumes at once, so every published artifact has exactly one approval.
 */

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ERROR_CODES } from '@localfirst/contracts';
import { drafts, publicationApprovals, publicationDelegations } from '../db/schema/registry.js';
import { oauthClientTable, oauthConsentTable } from '../db/schema/auth.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { config } from '../config.js';
import { assertWarningsAcknowledged } from '../domain/approval.js';
import { APPROVAL_POLICY_VERSION } from '../domain/policy.js';
import { writeAudit } from './audit.js';

/** The connection that creates a draft, recorded so the owner can delegate to it. */
export const creatingClient = (actor: Actor): string | null => (actor.kind === 'token' ? actor.clientId : null);

/** Whether this actor is a connection its owner delegated publication to. */
export async function isDelegated(actor: Actor, conn: DbOrTx = db()): Promise<boolean> {
  if (actor.kind !== 'token') return false;
  const [row] = await conn
    .select({ id: publicationDelegations.id })
    .from(publicationDelegations)
    .where(and(eq(publicationDelegations.userId, actor.userId), eq(publicationDelegations.clientId, actor.clientId)))
    .limit(1);
  return row !== undefined;
}

async function ownedConsent(conn: DbOrTx, userId: string, connectionId: string) {
  const [consent] = await conn
    .select({ id: oauthConsentTable.id, clientId: oauthConsentTable.clientId })
    .from(oauthConsentTable)
    .where(and(eq(oauthConsentTable.id, connectionId), eq(oauthConsentTable.userId, userId)))
    .limit(1);
  if (!consent) throw ApiError.notFound();
  return consent;
}

/** Turn delegation on for one of the person's connections. Browser session only. */
export async function enableDelegation(actor: Actor, connectionId: string): Promise<void> {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  await insertDelegation(db(), actor, await ownedConsent(db(), actor.userId, connectionId));
}

/**
 * From the review page, inside the approval transaction: also let the
 * connection that created the draft publish without asking.
 */
export async function delegateCreatingConnection(tx: DbOrTx, actor: Actor, clientId: string): Promise<void> {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const [consent] = await tx
    .select({ id: oauthConsentTable.id, clientId: oauthConsentTable.clientId })
    .from(oauthConsentTable)
    .where(and(eq(oauthConsentTable.userId, actor.userId), eq(oauthConsentTable.clientId, clientId)))
    .limit(1);
  if (!consent) {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: 'The connection that created this draft is no longer authorized. Nothing was approved or delegated.',
    });
  }
  await insertDelegation(tx, actor, consent);
}

async function insertDelegation(
  conn: DbOrTx,
  actor: Extract<Actor, { kind: 'session' }>,
  consent: { id: string; clientId: string },
): Promise<void> {
  const inserted = await conn
    .insert(publicationDelegations)
    .values({ userId: actor.userId, consentId: consent.id, clientId: consent.clientId, enabledBySessionId: actor.sessionId })
    .onConflictDoNothing()
    .returning({ id: publicationDelegations.id });
  if (inserted.length > 0) {
    await writeAudit(conn, actor, {
      action: 'connection.publication_delegated',
      targetKind: 'oauth_client',
      targetId: consent.clientId,
      metadata: { connection_id: consent.id },
    });
  }
}

/** Turn delegation off. Already published artifacts are unchanged. Browser session only. */
export async function disableDelegation(actor: Actor, connectionId: string): Promise<void> {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const consent = await ownedConsent(db(), actor.userId, connectionId);
  await db().transaction(async (tx) => {
    const removed = await tx
      .delete(publicationDelegations)
      .where(and(eq(publicationDelegations.consentId, consent.id), eq(publicationDelegations.userId, actor.userId)))
      .returning({ id: publicationDelegations.id });
    if (removed.length > 0) {
      await writeAudit(tx, actor, {
        action: 'connection.publication_delegation_revoked',
        targetKind: 'oauth_client',
        targetId: consent.clientId,
        metadata: { connection_id: consent.id },
      });
    }
  });
}

export interface DelegatedApprovalInput {
  actor: Actor;
  draft: { id: string; kind: string; state: string; revision: number; payloadDigest: string; ownerUserId: string };
  /** The warnings on the exact artifact, as revalidated inside the publish transaction. */
  warningCodes: string[];
  acknowledgedWarningCodes: string[];
  draftRevision: number;
  payloadDigest: string;
}

/**
 * Inside the publish transaction: record a delegated approval of the exact
 * current artifact for a delegated connection and return its ID. Anything
 * else is the same conflict as a missing human approval.
 */
export async function recordDelegatedApproval(tx: DbOrTx, input: DelegatedApprovalInput): Promise<string> {
  const { actor, draft } = input;
  if (actor.kind !== 'token' || !(await isDelegated(actor, tx))) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'Publishing needs a human approval of this exact artifact, or a connection its owner lets publish without asking.',
      details: { draft_id: draft.id, delegated: false },
    });
  }
  if (draft.state !== 'ready_for_review' && draft.state !== 'approved') {
    throw new ApiError({
      code: ERROR_CODES.INVALID_LIFECYCLE,
      message: `A draft in state \`${draft.state}\` cannot be published.`,
    });
  }
  if (input.draftRevision !== draft.revision || input.payloadDigest !== draft.payloadDigest) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_STALE,
      message: 'Publication must name the exact current draft revision and payload digest.',
      details: { current_revision: draft.revision, current_payload_digest: draft.payloadDigest },
    });
  }
  assertWarningsAcknowledged(input.warningCodes, input.acknowledgedWarningCodes);

  // At most one live approval per draft: a delegated one replaces any other.
  await tx
    .update(publicationApprovals)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(publicationApprovals.draftId, draft.id),
        isNull(publicationApprovals.consumedAt),
        isNull(publicationApprovals.revokedAt),
      ),
    );
  const [approval] = await tx
    .insert(publicationApprovals)
    .values({
      draftId: draft.id,
      kind: draft.kind,
      actorUserId: draft.ownerUserId,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: input.acknowledgedWarningCodes,
      policyVersion: APPROVAL_POLICY_VERSION,
      decision: 'approved',
      sessionId: null,
      authorizationKind: 'delegated',
      clientId: actor.clientId,
      expiresAt: new Date(Date.now() + config().ttl.approvalSeconds * 1000),
    })
    .returning({ id: publicationApprovals.id });
  if (!approval) throw ApiError.internal('The delegated approval could not be recorded.');
  await writeAudit(tx, actor, {
    action: 'draft.approved_by_delegation',
    targetKind: 'draft',
    targetId: draft.id,
    policyVersion: APPROVAL_POLICY_VERSION,
    metadata: {
      approval_id: approval.id,
      revision: draft.revision,
      payload_digest: draft.payloadDigest,
      acknowledged_warnings: input.acknowledgedWarningCodes.length,
    },
  });
  return approval.id;
}

/** The connection's self-reported display name, stored with a delegated version. */
export async function clientDisplayName(conn: DbOrTx, clientId: string): Promise<string> {
  const [client] = await conn
    .select({ name: oauthClientTable.name })
    .from(oauthClientTable)
    .where(eq(oauthClientTable.clientId, clientId))
    .limit(1);
  return client?.name?.trim().slice(0, 120) || clientId.slice(0, 120);
}

export interface DelegatedPublication {
  kind: string;
  draft_id: string;
  project_version_id: string | null;
  record_id: string | null;
  published_at: string | null;
}

/** For the owner's connections page: which connections are delegated and what they published. */
export async function delegationSummary(userId: string): Promise<{
  delegatedConsents: Set<string>;
  publicationsByClient: Map<string, DelegatedPublication[]>;
}> {
  const delegations = await db()
    .select({ consentId: publicationDelegations.consentId })
    .from(publicationDelegations)
    .where(eq(publicationDelegations.userId, userId));
  const rows = await db()
    .select({
      clientId: publicationApprovals.clientId,
      kind: drafts.kind,
      draftId: drafts.id,
      versionId: drafts.publishedVersionId,
      payload: drafts.payload,
      consumedAt: publicationApprovals.consumedAt,
    })
    .from(publicationApprovals)
    .innerJoin(drafts, eq(drafts.id, publicationApprovals.draftId))
    .where(
      and(
        eq(publicationApprovals.actorUserId, userId),
        eq(publicationApprovals.authorizationKind, 'delegated'),
        isNotNull(publicationApprovals.consumedAt),
      ),
    )
    .orderBy(desc(publicationApprovals.consumedAt))
    .limit(200);
  const publicationsByClient = new Map<string, DelegatedPublication[]>();
  for (const row of rows) {
    if (!row.clientId) continue;
    const list = publicationsByClient.get(row.clientId) ?? [];
    if (list.length >= 20) continue;
    const recordId = (row.payload as { record_id?: unknown } | null)?.record_id;
    list.push({
      kind: row.kind,
      draft_id: row.draftId,
      project_version_id: row.versionId,
      record_id: typeof recordId === 'string' ? recordId : null,
      published_at: row.consumedAt?.toISOString() ?? null,
    });
    publicationsByClient.set(row.clientId, list);
  }
  return { delegatedConsents: new Set(delegations.map((row) => row.consentId)), publicationsByClient };
}
