import { config } from '../src/config.js';
import { mintToken, startTestServer } from './server-harness.js';
import { oauthAccessTokenTable, oauthClientTable, oauthConsentTable, oauthRefreshTokenTable, sessionTable, accountTable } from '../src/db/schema/auth.js';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { drafts, publicationApprovals, projects, projectVersions, searchDocuments, userProfiles } from '../src/db/schema/registry.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { reindexProject } from '../src/services/search.js';
import { createDirectProjectDraft } from '../src/services/drafts.js';
import { requestAccountDeletion } from '../src/services/accounts.js';
import { changeOwnVisibility } from '../src/services/projects.js';
import { resolveSessionActor } from '../src/auth/actor.js';

describe('account deletion', () => {
  it('withdraws contributions and removes private content without touching another account', async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const published = await publishProject(owner);
    const untouched = await publishProject(other);
    await reindexProject(published.projectId);
    await reindexProject(untouched.projectId);
    await createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null,
      payload: { project_md: projectDocument({ key: 'private-work' }), files: [] } });
    const denied = await request('/api/v1/me/deletion-requests', {
      user: owner.userId, method: 'POST', body: { confirm: true, handle: 'wrong-handle' },
    });
    expect(denied.status).toBe(400);
    expect((await request(`/api/v1/projects/${published.projectId}`)).status).toBe(200);
    const result = await request('/api/v1/me/deletion-requests', {
      user: owner.userId, method: 'POST', body: { confirm: true, handle: owner.handle.toUpperCase() },
    });
    expect(result.status).toBe(202);
    expect(result.json.data.effects.public_contributions[0].handling).toBe('withdrawn');
    expect(await db().select().from(drafts).where(eq(drafts.ownerUserId, owner.userId))).toHaveLength(0);
    expect(await db().select().from(publicationApprovals).where(eq(publicationApprovals.actorUserId, owner.userId))).toHaveLength(0);
    expect(await db().select().from(searchDocuments).where(eq(searchDocuments.projectId, published.projectId))).toHaveLength(0);
    expect((await request(`/api/v1/projects/${published.projectId}`)).status).toBe(404);
    expect((await request(`/api/v1/projects/${published.projectId}/export`)).status).toBe(404);
    expect((await request(`/api/v1/projects/${untouched.projectId}`)).status).toBe(200);
    // Already signed credentials and already-resolved actors cannot revive contributions.
    expect((await request('/api/v1/me', { user: owner.userId, actorKind: 'token' })).status).toBe(403);
    await expect(changeOwnVisibility({ actor: owner.actor, projectId: published.projectId, action: 'republish' })).rejects.toThrow('cannot contribute');
    await expect(createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null,
      payload: { project_md: projectDocument({ key: 'late-write' }), files: [] } })).rejects.toThrow('cannot contribute');
    // Withdrawal retains immutable history for the unresolved final retention policy.
    const [version] = await db().select().from(projectVersions).where(eq(projectVersions.id, published.projectVersionId));
    expect(version?.contentDigest).toBe(published.contentDigest);
  });

  it('removes real credentials and rejects a previously signed access token', async () => {
    const owner = await createAccount();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await db().insert(sessionTable).values({ id: 'deletion-session', token: 'deletion-session-token', userId: owner.userId, createdAt: now, updatedAt: now, expiresAt });
    await db().insert(accountTable).values({ id: 'deletion-provider', accountId: 'github-identity', providerId: 'github', userId: owner.userId, accessToken: 'fake-provider-credential', createdAt: now, updatedAt: now });
    await db().insert(oauthClientTable).values({ id: 'deletion-client', clientId: 'deletion-client', redirectUris: [] });
    await db().insert(oauthConsentTable).values({ id: 'deletion-consent', clientId: 'deletion-client', userId: owner.userId, scopes: ['profile:read'], createdAt: now, updatedAt: now });
    await db().insert(oauthRefreshTokenTable).values({ id: 'deletion-refresh', clientId: 'deletion-client', userId: owner.userId, token: 'fake-refresh', scopes: ['profile:read'], createdAt: now, expiresAt });
    await db().insert(oauthAccessTokenTable).values({ id: 'deletion-access', clientId: 'deletion-client', userId: owner.userId, token: 'fake-access', refreshId: 'deletion-refresh', scopes: ['profile:read'], createdAt: now, expiresAt });
    const server = await startTestServer();
    try {
      const token = await mintToken({ subject: owner.userId, audience: config().restResource, scopes: ['profile:read'] });
      const headers = { authorization: `Bearer ${token}` };
      expect((await fetch(`${server.baseUrl}/api/v1/me`, { headers })).status).toBe(200);
      await requestAccountDeletion(owner.actor, owner.handle);
      expect((await fetch(`${server.baseUrl}/api/v1/me`, { headers })).status).toBe(403);
      for (const table of [sessionTable, accountTable, oauthConsentTable, oauthAccessTokenTable, oauthRefreshTokenTable]) {
        expect(await db().select().from(table)).toHaveLength(0);
      }
    } finally { await server.close(); }
  });

  it('checks deletion against the database even after the actor cache has been warmed', async () => {
    const owner = await createAccount();
    const headers = new Headers({ 'x-dev-user': owner.userId });
    expect((await resolveSessionActor(headers))?.kind).toBe('session');
    // Represents another replica changing the row; no local cache invalidation.
    await db().update(userProfiles).set({ deletionRequestedAt: new Date() }).where(eq(userProfiles.userId, owner.userId));
    await expect(resolveSessionActor(headers)).rejects.toThrow('requested deletion');
  });

  it('preserves quarantine and serializes deletion with an in-flight contribution', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner);
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, published.projectId));
    const writes = await Promise.allSettled([
      createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null,
        payload: { project_md: projectDocument({ key: 'racing-write' }), files: [] } }),
      requestAccountDeletion(owner.actor, owner.handle),
    ]);
    expect(writes[1]?.status).toBe('fulfilled');
    expect(await db().select().from(drafts).where(eq(drafts.ownerUserId, owner.userId))).toHaveLength(0);
    const [project] = await db().select().from(projects).where(eq(projects.id, published.projectId));
    expect(project?.visibility).toBe('quarantined');
  });
});
