import { and, eq, inArray, like, or } from 'drizzle-orm';
import type { Transaction } from '../db/client.js';
import { db } from '../db/client.js';
import {
  accountTable, oauthAccessTokenTable, oauthConsentTable, oauthRefreshTokenTable, sessionTable,
} from '../db/schema/auth.js';
import {
  approverCredentials, approverLinks, claimRequests, drafts, idempotencyRecords, jobs, operations, projects,
  publicationApprovals, searchDocuments, userProfiles,
} from '../db/schema/registry.js';
import { buildConfigurations, runReports } from '../db/schema/evidence.js';
import { communityRecords } from '../db/schema/community.js';
import type { Actor } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { RETENTION_POLICY_VERSION } from '../domain/policy.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';

/** Serialize contribution writes against deletion, including already-resolved actors. */
export async function lockActiveAccount(tx: Transaction, userId: string): Promise<void> {
  const [profile] = await tx.select().from(userProfiles)
    .where(eq(userProfiles.userId, userId)).for('share');
  if (!profile || profile.deletionRequestedAt || profile.suspendedAt) {
    throw ApiError.forbidden('This account cannot contribute.');
  }
}

/** Withdraw managed contributions and remove private content in one transaction. */
export async function requestAccountDeletion(actor: Actor, handle: string) {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  return db().transaction(async (tx) => {
    const [profile] = await tx.select().from(userProfiles)
      .where(eq(userProfiles.userId, actor.userId)).for('update');
    if (!profile) throw ApiError.notFound();
    if (profile.handle.toLowerCase() !== handle.toLowerCase()) {
      throw ApiError.badRequest('The handle does not match this account.');
    }
    if (profile.deletionRequestedAt) throw ApiError.forbidden('Deletion was already requested.');
    const requestedAt = new Date();
    const managed = await tx.select().from(projects)
      .where(eq(projects.managerUserId, actor.userId)).for('update');
    const ids = managed.map((project) => project.id);
    if (ids.length) {
      // Quarantine remains an operator-only state, even during withdrawal.
      await tx.update(projects).set({ visibility: 'unpublished', unpublishedAt: requestedAt, updatedAt: requestedAt })
        .where(and(inArray(projects.id, ids), eq(projects.visibility, 'published')));
      await tx.delete(searchDocuments).where(inArray(searchDocuments.projectId, ids));
      for (const project of managed) {
        await emitEvent(tx, {
          eventType: 'project.visibility_changed', aggregateKind: 'project', aggregateId: project.id,
          payload: { visibility: project.visibility === 'quarantined' ? 'quarantined' : 'unpublished', reason: 'account_deletion', retention_policy_version: RETENTION_POLICY_VERSION },
        });
      }
    }
    // Public evidence is withdrawn (and reaggregated); private builds and reports are removed.
    const withdrawn = await tx.update(runReports)
      .set({ visibility: 'withdrawn', reviewState: 'withdrawn', evidenceLevel: null, withdrawnAt: requestedAt, updatedAt: requestedAt })
      .where(and(eq(runReports.submitterUserId, actor.userId), eq(runReports.visibility, 'public')))
      .returning({ projectId: runReports.projectId });
    const withdrawnBuilds = await tx.update(buildConfigurations)
      .set({ visibility: 'withdrawn', withdrawnAt: requestedAt })
      .where(and(eq(buildConfigurations.ownerUserId, actor.userId), eq(buildConfigurations.visibility, 'public')))
      .returning({ projectId: buildConfigurations.projectId });
    for (const projectId of new Set([...withdrawn, ...withdrawnBuilds].map((row) => row.projectId))) {
      await emitEvent(tx, {
        eventType: 'evidence.changed', aggregateKind: 'project', aggregateId: projectId,
        payload: { cause: 'account_deletion', retention_policy_version: RETENTION_POLICY_VERSION },
      });
    }
    await tx.delete(runReports).where(and(eq(runReports.submitterUserId, actor.userId), eq(runReports.visibility, 'private')));
    await tx.delete(buildConfigurations).where(and(eq(buildConfigurations.ownerUserId, actor.userId), eq(buildConfigurations.visibility, 'private')));
    // Collections and troubleshooting notes: public ones leave public reads (quarantine stays in force);
    // private ones are removed. Approvals for them are deleted below.
    const withdrawnRecords = await tx.update(communityRecords).set({ visibility: 'withdrawn' })
      .where(and(eq(communityRecords.ownerUserId, actor.userId), eq(communityRecords.visibility, 'public')))
      .returning({ id: communityRecords.id });
    await tx.delete(communityRecords).where(and(eq(communityRecords.ownerUserId, actor.userId), eq(communityRecords.visibility, 'private')));
    const ownedOperations = tx.select({ id: operations.id }).from(operations)
      .where(eq(operations.actorUserId, actor.userId));
    await tx.delete(jobs).where(inArray(jobs.operationId, ownedOperations));
    await tx.delete(operations).where(eq(operations.actorUserId, actor.userId));
    await tx.delete(idempotencyRecords).where(or(
      eq(idempotencyRecords.actorKey, `user:${actor.userId}`),
      // Escape LIKE metacharacters in identities supplied by the auth provider.
      like(idempotencyRecords.actorKey, `user:${actor.userId.replace(/[\\%_]/g, '\\$&')}:client:%`),
    ));
    await tx.delete(publicationApprovals).where(eq(publicationApprovals.actorUserId, actor.userId));
    await tx.delete(drafts).where(eq(drafts.ownerUserId, actor.userId));
    await tx.delete(claimRequests).where(eq(claimRequests.requesterUserId, actor.userId));
    await tx.delete(approverCredentials).where(eq(approverCredentials.userId, actor.userId));
    await tx.delete(approverLinks).where(eq(approverLinks.userId, actor.userId));
    await tx.delete(oauthConsentTable).where(eq(oauthConsentTable.userId, actor.userId));
    await tx.delete(oauthAccessTokenTable).where(eq(oauthAccessTokenTable.userId, actor.userId));
    await tx.delete(oauthRefreshTokenTable).where(eq(oauthRefreshTokenTable.userId, actor.userId));
    await tx.delete(sessionTable).where(eq(sessionTable.userId, actor.userId));
    await tx.delete(accountTable).where(eq(accountTable.userId, actor.userId));
    await tx.update(userProfiles).set({ deletionRequestedAt: requestedAt, externalIdentities: [], updatedAt: requestedAt })
      .where(eq(userProfiles.userId, actor.userId));
    await writeAudit(tx, actor, {
      action: 'account.deletion_requested', targetKind: 'user', targetId: actor.userId,
      policyVersion: RETENTION_POLICY_VERSION, metadata: { withdrawn_projects: ids.length },
    });
    return {
      requested_at: requestedAt.toISOString(),
      effects: {
        private_records: 'Drafts, approvals, claims, private builds, test results and community records, operations, import jobs, and replay records are removed.',
        agent_grants: 'Sessions, provider credentials, consent, access and refresh authorizations, and linked approval devices are removed.',
        public_contributions: managed.map((project) => ({ project_id: project.id, slug: project.slug, handling: 'withdrawn' })),
        public_evidence: { handling: 'withdrawn', withdrawn_reports: withdrawn.length, withdrawn_builds: withdrawnBuilds.length },
        public_community_records: { handling: 'withdrawn', withdrawn_records: withdrawnRecords.length },
        audit_metadata: 'Identity, immutable version history, and audit metadata await final retention-policy processing.',
      },
      retention_policy_version: RETENTION_POLICY_VERSION,
    };
  });
}
