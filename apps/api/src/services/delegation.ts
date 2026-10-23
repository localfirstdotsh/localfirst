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

import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { ERROR_CODES } from '@localfirst/contracts';
import { drafts, projects, projectVersions, publicationApprovals, publicationDelegations } from '../db/schema/registry.js';
import { oauthClientTable, oauthConsentTable } from '../db/schema/auth.js';
import { buildConfigurations, runReports } from '../db/schema/evidence.js';
import { communityRecords } from '../db/schema/community.js';
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
  /** The project a delegated project version belongs to, for the owner's link and unpublish action. */
  project: { project_id: string; slug: string; version_number: number; visibility: string } | null;
  /** A delegated record's current visibility, so a withdrawn one is shown as such. */
  record_visibility: string | null;
  published_at: string | null;
}

/** Current visibility of published records, by ID, for the kinds a connection can publish. */
async function recordVisibility(ids: { kind: string; id: string }[]): Promise<Map<string, string>> {
  const of = (kinds: string[]) => ids.filter((item) => kinds.includes(item.kind)).map((item) => item.id);
  const [builds, reports, community] = [of(['build']), of(['test_result']), of(['collection', 'troubleshooting'])];
  const rows = await Promise.all([
    builds.length ? db().select({ id: buildConfigurations.id, visibility: buildConfigurations.visibility }).from(buildConfigurations).where(inArray(buildConfigurations.id, builds)) : [],
    reports.length ? db().select({ id: runReports.id, visibility: runReports.visibility }).from(runReports).where(inArray(runReports.id, reports)) : [],
    community.length ? db().select({ id: communityRecords.id, visibility: communityRecords.visibility }).from(communityRecords).where(inArray(communityRecords.id, community)) : [],
  ]);
  return new Map(rows.flat().map((row) => [row.id, row.visibility]));
}

/**
 * For the review page: the connection that created a draft, when the owner
 * still authorizes it, so "approve and let it publish without asking" can
 * name it. Null for a draft made in the browser or by a revoked connection.
 */
export async function creatingConnection(userId: string, clientId: string | null): Promise<{
  connection_id: string;
  client_name: string | null;
  client_name_is_unverified: true;
  publication_delegated: boolean;
} | null> {
  if (!clientId) return null;
  const [row] = await db()
    .select({ id: oauthConsentTable.id, name: oauthClientTable.name, delegation: publicationDelegations.id })
    .from(oauthConsentTable)
    .leftJoin(oauthClientTable, eq(oauthClientTable.clientId, oauthConsentTable.clientId))
    .leftJoin(publicationDelegations, eq(publicationDelegations.consentId, oauthConsentTable.id))
    .where(and(eq(oauthConsentTable.userId, userId), eq(oauthConsentTable.clientId, clientId)))
    .limit(1);
  if (!row) return null;
  return {
    connection_id: row.id,
    client_name: row.name?.trim() || null,
    client_name_is_unverified: true,
    publication_delegated: row.delegation !== null,
  };
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
      projectId: projects.id,
      slug: projects.slug,
      versionNumber: projectVersions.versionNumber,
      visibility: projects.visibility,
    })
    .from(publicationApprovals)
    .innerJoin(drafts, eq(drafts.id, publicationApprovals.draftId))
    .leftJoin(projectVersions, eq(projectVersions.id, drafts.publishedVersionId))
    .leftJoin(projects, eq(projects.id, projectVersions.projectId))
    .where(
      and(
        eq(publicationApprovals.actorUserId, userId),
        eq(publicationApprovals.authorizationKind, 'delegated'),
        isNotNull(publicationApprovals.consumedAt),
      ),
    )
    .orderBy(desc(publicationApprovals.consumedAt))
    .limit(200);
  const recordIdOf = (row: (typeof rows)[number]) => {
    const recordId = (row.payload as { record_id?: unknown } | null)?.record_id;
    return typeof recordId === 'string' ? recordId : null;
  };
  const visibility = await recordVisibility(
    rows.flatMap((row) => {
      const id = recordIdOf(row);
      return id ? [{ kind: row.kind, id }] : [];
    }),
  );
  const publicationsByClient = new Map<string, DelegatedPublication[]>();
  for (const row of rows) {
    if (!row.clientId) continue;
    const list = publicationsByClient.get(row.clientId) ?? [];
    if (list.length >= 20) continue;
    const recordId = recordIdOf(row);
    list.push({
      kind: row.kind,
      draft_id: row.draftId,
      project_version_id: row.versionId,
      record_id: recordId,
      project: row.projectId && row.slug && row.versionNumber !== null && row.visibility
        ? { project_id: row.projectId, slug: row.slug, version_number: row.versionNumber, visibility: row.visibility }
        : null,
      record_visibility: recordId ? visibility.get(recordId) ?? null : null,
      published_at: row.consumedAt?.toISOString() ?? null,
    });
    publicationsByClient.set(row.clientId, list);
  }
  return { delegatedConsents: new Set(delegations.map((row) => row.consentId)), publicationsByClient };
}
