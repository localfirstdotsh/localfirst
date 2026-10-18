/**
 * Moderation, claims, and the operator audit view (BACKEND_PRD sections 3.3,
 * 17.4, 12.3).
 *
 * Operator roles are administratively assigned, never derived from an email or
 * profile field. Every decision records actor, target, reason, and policy.
 * Quarantine blocks discovery and new versions; claims never transfer
 * management automatically.
 */

import { lockActiveAccount } from './accounts.js';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { ERROR_CODES } from '@localfirst/contracts';
import {
  auditEvents,
  claimRequests,
  projects,
  projectVersions,
  userProfiles,
} from '../db/schema/registry.js';
import { db } from '../db/client.js';
import { communityRecords } from '../db/schema/community.js';
import { config } from '../config.js';
import { runReports } from '../db/schema/evidence.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { CLAIM_POLICY_VERSION, MODERATION_POLICY_VERSION } from '../domain/policy.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { enqueueJob } from './jobs.js';
import { removeSearchDocument } from './search.js';

export interface ModerationInput {
  actor: Actor;
  projectId: string;
  action: 'quarantine' | 'restore';
  reason: string;
}

export async function moderateProject(input: ModerationInput): Promise<{ visibility: string }> {
  if (input.reason.trim().length < 5) {
    throw ApiError.badRequest('A moderation decision requires a reason.');
  }
  return db().transaction(async (tx) => {
    const [manager] = await tx.select({ id: projects.managerUserId }).from(projects).where(eq(projects.id, input.projectId));
    if (manager && input.action === 'restore') await lockActiveAccount(tx, manager.id);
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update');
    if (!project) throw ApiError.notFound();

    const now = new Date();
    if (input.action === 'quarantine') {
      await tx
        .update(projects)
        .set({
          visibility: 'quarantined',
          quarantinedAt: now,
          quarantineReason: input.reason,
          updatedAt: now,
        })
        .where(eq(projects.id, input.projectId));
      await removeSearchDocument(tx, input.projectId);
      await emitEvent(tx, {
        eventType: 'project.quarantined',
        aggregateKind: 'project',
        aggregateId: input.projectId,
        payload: { reason_recorded: true },
      });
    } else {
      if (project.visibility !== 'quarantined') {
        throw new ApiError({
          code: ERROR_CODES.INVALID_LIFECYCLE,
          message: 'This project is not quarantined.',
        });
      }
      const visibility = project.currentVersionId ? 'published' : 'unpublished';
      await tx
        .update(projects)
        .set({
          visibility,
          quarantinedAt: null,
          quarantineReason: null,
          updatedAt: now,
        })
        .where(eq(projects.id, input.projectId));
      await enqueueJob(tx, {
        kind: 'publication_index',
        payload: { project_id: input.projectId },
        dedupeKey: `publication_index:${input.projectId}:restore:${now.getTime()}`,
      });
      await emitEvent(tx, {
        eventType: 'project.restored',
        aggregateKind: 'project',
        aggregateId: input.projectId,
        payload: { visibility },
      });
    }

    await writeAudit(tx, input.actor, {
      action: `moderation.${input.action}`,
      targetKind: 'project',
      targetId: input.projectId,
      reason: input.reason,
      policyVersion: MODERATION_POLICY_VERSION,
      metadata: { previous_visibility: project.visibility },
    });

    const visibility =
      input.action === 'quarantine'
        ? 'quarantined'
        : project.currentVersionId
          ? 'published'
          : 'unpublished';
    return { visibility };
  });
}

export interface ClaimRequestInput {
  actor: Actor;
  projectId: string;
  kind: 'manager' | 'author';
  evidence: string;
}

/**
 * An evidence-backed claim. A GitHub login proves no control of an
 * organization or document, so nothing transfers until an operator reviews it.
 */
export async function createClaimRequest(
  input: ClaimRequestInput,
): Promise<{ claim_id: string; state: string }> {
  if (input.actor.kind === 'anonymous') throw ApiError.notFound();
  if (input.evidence.trim().length < 20) {
    throw ApiError.badRequest(
      'A claim needs a description of the evidence an operator can check (at least 20 characters).',
    );
  }
  const requesterUserId = input.actor.userId;

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, requesterUserId);
    const [project] = await tx
      .select({ id: projects.id, managerUserId: projects.managerUserId, visibility: projects.visibility })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project || project.visibility === 'quarantined') throw ApiError.notFound();
    if (project.managerUserId === requesterUserId) {
      throw new ApiError({
        code: ERROR_CODES.CONFLICT,
        message: 'You already manage this project.',
      });
    }
    const [claim] = await tx
      .insert(claimRequests)
      .values({
        projectId: input.projectId,
        requesterUserId,
        kind: input.kind,
        evidence: input.evidence.slice(0, 4000),
      })
      .onConflictDoNothing()
      .returning({ id: claimRequests.id, state: claimRequests.state });
    if (!claim) {
      throw new ApiError({
        code: ERROR_CODES.CONFLICT,
        message: 'You already have a pending claim for this project.',
      });
    }
    await writeAudit(tx, input.actor, {
      action: 'claim.requested',
      targetKind: 'project',
      targetId: input.projectId,
      policyVersion: CLAIM_POLICY_VERSION,
      metadata: { claim_id: claim.id, kind: input.kind },
    });
    return { claim_id: claim.id, state: claim.state };
  });
}

export interface ClaimReviewInput {
  actor: Actor;
  claimId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  /** Explicit transfer of management; never implied by acceptance alone. */
  transferManagement: boolean;
}

export async function reviewClaimRequest(
  input: ClaimReviewInput,
): Promise<{ state: string; manager_changed: boolean }> {
  if (input.actor.kind === 'anonymous') throw ApiError.notFound();
  if (input.reason.trim().length < 5) {
    throw ApiError.badRequest('A claim review requires a reason.');
  }
  const reviewerUserId = input.actor.userId;

  return db().transaction(async (tx) => {
    const [candidate] = await tx.select().from(claimRequests).where(eq(claimRequests.id, input.claimId));
    if (!candidate) throw ApiError.notFound();
    // Match deletion's account-before-project/claim lock order.
    await lockActiveAccount(tx, candidate.requesterUserId);

    const [claim] = await tx
      .select()
      .from(claimRequests)
      .where(eq(claimRequests.id, input.claimId))
      .for('update');
    if (!claim) throw ApiError.notFound();
    if (claim.state !== 'pending') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: `This claim is already \`${claim.state}\`.`,
      });
    }

    await tx
      .update(claimRequests)
      .set({
        state: input.decision,
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        reviewReason: input.reason,
      })
      .where(eq(claimRequests.id, input.claimId));

    let managerChanged = false;
    if (input.decision === 'accepted' && input.transferManagement && claim.kind === 'manager') {
      await tx
        .update(projects)
        .set({ managerUserId: claim.requesterUserId, updatedAt: new Date() })
        .where(eq(projects.id, claim.projectId));
      managerChanged = true;
      await emitEvent(tx, {
        eventType: 'project.manager_changed',
        aggregateKind: 'project',
        aggregateId: claim.projectId,
        payload: { claim_id: claim.id },
      });
    }

    await writeAudit(tx, input.actor, {
      action: `claim.${input.decision}`,
      targetKind: 'project',
      targetId: claim.projectId,
      reason: input.reason,
      policyVersion: CLAIM_POLICY_VERSION,
      metadata: {
        claim_id: claim.id,
        kind: claim.kind,
        manager_transferred: managerChanged,
      },
    });
    return { state: input.decision, manager_changed: managerChanged };
  });
}

export interface ReviewQueueFilters {
  kind: 'claims' | 'quarantined' | 'evidence' | 'community' | 'all';
  limit: number;
}

export async function reviewQueue(filters: ReviewQueueFilters): Promise<Record<string, unknown>> {
  const wantClaims = filters.kind === 'claims' || filters.kind === 'all';
  const wantQuarantine = filters.kind === 'quarantined' || filters.kind === 'all';
  const wantEvidence = filters.kind === 'evidence' || filters.kind === 'all';

  const claims = wantClaims
    ? await db()
        .select({
          claim_id: claimRequests.id,
          project_id: claimRequests.projectId,
          project_slug: projects.slug,
          kind: claimRequests.kind,
          evidence: claimRequests.evidence,
          requester_handle: userProfiles.handle,
          created_at: claimRequests.createdAt,
        })
        .from(claimRequests)
        .innerJoin(projects, eq(projects.id, claimRequests.projectId))
        .leftJoin(userProfiles, eq(userProfiles.userId, claimRequests.requesterUserId))
        .where(eq(claimRequests.state, 'pending'))
        .orderBy(desc(claimRequests.createdAt))
        .limit(filters.limit)
    : [];

  const quarantined = wantQuarantine
    ? await db()
        .select({
          project_id: projects.id,
          slug: projects.slug,
          reason: projects.quarantineReason,
          quarantined_at: projects.quarantinedAt,
        })
        .from(projects)
        .where(eq(projects.visibility, 'quarantined'))
        .orderBy(desc(projects.quarantinedAt))
        .limit(filters.limit)
    : [];

  // Published reports awaiting an operator decision. Private reports are never queued.
  const evidence = wantEvidence
    ? await db()
        .select({
          report_id: runReports.id,
          kind: runReports.kind,
          project_id: runReports.projectId,
          outcome: runReports.outcome,
          validation_state: runReports.validationState,
          published_at: runReports.publishedAt,
        })
        .from(runReports)
        .where(and(eq(runReports.visibility, 'public'), eq(runReports.reviewState, 'pending')))
        .orderBy(desc(runReports.publishedAt))
        .limit(filters.limit)
    : [];

  const community = config().features.communityNetwork && ['community', 'all'].includes(filters.kind)
    ? await db().select({ record_id: communityRecords.id, kind: communityRecords.kind, payload: communityRecords.payload, curator_user_id: communityRecords.ownerUserId, published_at: communityRecords.publishedAt }).from(communityRecords).where(and(eq(communityRecords.visibility, 'public'), eq(communityRecords.reviewState, 'pending'))).orderBy(desc(communityRecords.publishedAt)).limit(filters.limit) : [];
  return {
    community_reviews: { phase: 'P2', available: config().features.communityNetwork, pending: community },
    claims: claims.map((claim) => ({
      ...claim,
      created_at: claim.created_at.toISOString(),
    })),
    quarantined: quarantined.map((row) => ({
      ...row,
      quarantined_at: row.quarantined_at?.toISOString() ?? null,
    })),
    // P1/P2 queues are listed as absent rather than silently empty.
    evidence_reviews: {
      phase: 'P1',
      available: true,
      pending: evidence.map((row) => ({ ...row, published_at: row.published_at?.toISOString() ?? null })),
    },
    source_reviews: { phase: 'P1', available: false },
  };
}

export interface AuditSearchFilters {
  action?: string | undefined;
  targetId?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  limit: number;
}

export async function searchAuditEvents(
  filters: AuditSearchFilters,
): Promise<Array<Record<string, unknown>>> {
  const conditions = [sql`true`];
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  if (filters.targetId) conditions.push(eq(auditEvents.targetId, filters.targetId));
  if (filters.since) conditions.push(gte(auditEvents.createdAt, filters.since));
  if (filters.until) conditions.push(lte(auditEvents.createdAt, filters.until));

  const rows = await db()
    .select({
      id: auditEvents.id,
      actor_kind: auditEvents.actorKind,
      actor_handle: userProfiles.handle,
      actor_client_id: auditEvents.actorClientId,
      action: auditEvents.action,
      target_kind: auditEvents.targetKind,
      target_id: auditEvents.targetId,
      reason: auditEvents.reason,
      policy_version: auditEvents.policyVersion,
      metadata: auditEvents.metadata,
      created_at: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(userProfiles, eq(userProfiles.userId, auditEvents.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt))
    .limit(filters.limit);

  return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}

/** Operator view of one project, including hidden state and version history. */
export async function operatorProjectView(projectId: string): Promise<Record<string, unknown>> {
  const [project] = await db().select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw ApiError.notFound();
  const versions = await db()
    .select({
      project_version_id: projectVersions.id,
      version_number: projectVersions.versionNumber,
      content_digest: projectVersions.contentDigest,
      published_at: projectVersions.publishedAt,
    })
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(desc(projectVersions.versionNumber));
  return {
    project_id: project.id,
    slug: project.slug,
    visibility: project.visibility,
    quarantine_reason: project.quarantineReason,
    listing_origin: project.listingOrigin,
    versions: versions.map((version) => ({
      ...version,
      published_at: version.published_at.toISOString(),
    })),
  };
}
