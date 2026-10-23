/**
 * Publication delegation (BACKEND_PRD section 10.4): an owner lets one
 * connection publish their drafts without a per-artifact approval. Only a
 * browser session changes it, every other publication check still applies,
 * and a delegated version says so publicly.
 */

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/client.js';
import { oauthClientTable, oauthConsentTable } from '../src/db/schema/auth.js';
import { auditEvents, projectVersions, publicationApprovals, publicationDelegations } from '../src/db/schema/registry.js';
import { createAccount, projectDocument, request, type TestAccount } from './factories.js';
import { api, key, publishEvidenceProject, submitThroughApi } from './evidence-fixtures.js';

async function connect(account: TestAccount, name = 'Example Agent') {
  const clientId = `client-${randomUUID()}`;
  const connectionId = `consent-${randomUUID()}`;
  const now = new Date();
  await db().insert(oauthClientTable).values({ id: clientId, clientId, name, redirectUris: [] });
  await db().insert(oauthConsentTable).values({
    id: connectionId, clientId, userId: account.userId,
    scopes: ['projects:read', 'projects:draft', 'projects:publish'], createdAt: now, updatedAt: now,
  });
  return { clientId, connectionId };
}

/** The connection's own requests: an agent token for that client. */
const asAgent = (account: TestAccount, clientId: string) => ({ user: account.userId, actorKind: 'token' as const, client: clientId });

async function agentDraft(account: TestAccount, clientId: string, projectKey: string) {
  const created = await request('/api/v1/drafts', {
    method: 'POST', ...asAgent(account, clientId), idempotencyKey: `draft-${randomUUID()}`,
    body: { kind: 'project', project_md: projectDocument({ key: projectKey }) },
  });
  expect(created.status).toBe(201);
  return created.json.data as { draft_id: string; revision: number; payload_digest: string; warning_codes: string[] };
}

function publishAs(account: TestAccount, clientId: string, draft: { draft_id: string; revision: number; payload_digest: string }, extra: Record<string, unknown> = {}) {
  return request(`/api/v1/drafts/${draft.draft_id}/publish`, {
    method: 'POST', ...asAgent(account, clientId), idempotencyKey: `publish-${randomUUID()}`,
    body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, ...extra },
  });
}

const delegate = (account: TestAccount, connectionId: string, method: 'PUT' | 'DELETE' = 'PUT') =>
  request(`/api/v1/me/connections/${connectionId}/publication-delegation`, { method, user: account.userId });

describe('publication delegation', () => {
  it('refuses publishing without an approval until the owner delegates, and only a browser session can delegate', async () => {
    const owner = await createAccount();
    const { clientId, connectionId } = await connect(owner);
    const draft = await agentDraft(owner, clientId, 'delegation-off');

    const refused = await publishAs(owner, clientId, draft, { acknowledged_warning_codes: draft.warning_codes });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('APPROVAL_REQUIRED');
    expect(refused.json.error.details.delegated).toBe(false);

    // The agent cannot grant itself the permission, or see the connections page.
    const selfGrant = await request(`/api/v1/me/connections/${connectionId}/publication-delegation`, { method: 'PUT', ...asAgent(owner, clientId) });
    expect(selfGrant.status).toBe(403);
    expect((await request('/api/v1/me/connections', asAgent(owner, clientId))).status).toBe(403);
    expect(await db().select().from(publicationDelegations).where(eq(publicationDelegations.userId, owner.userId))).toEqual([]);

    // Another person cannot delegate someone else's connection.
    expect((await delegate(await createAccount(), connectionId)).status).toBe(404);

    const read = await request(`/api/v1/drafts/${draft.draft_id}`, asAgent(owner, clientId));
    expect(read.json.data.publication_delegated).toBe(false);
  });

  it('lets a delegated connection publish the exact artifact it names, with its own warning acknowledgements, and labels the version', async () => {
    const owner = await createAccount();
    const { clientId, connectionId } = await connect(owner, 'Example Agent');
    expect((await delegate(owner, connectionId)).status).toBe(204);
    const draft = await agentDraft(owner, clientId, 'delegation-on');
    expect(draft.warning_codes.length).toBeGreaterThan(0);
    expect((await request(`/api/v1/drafts/${draft.draft_id}`, asAgent(owner, clientId))).json.data.publication_delegated).toBe(true);

    const unacknowledged = await publishAs(owner, clientId, draft);
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.json.error.code).toBe('APPROVAL_WARNINGS_UNACKNOWLEDGED');

    const stale = await publishAs(owner, clientId, { ...draft, revision: draft.revision + 1 }, { acknowledged_warning_codes: draft.warning_codes });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('APPROVAL_STALE');

    const both = await publishAs(owner, clientId, draft, { approval_id: randomUUID(), acknowledged_warning_codes: draft.warning_codes });
    expect(both.status).toBe(400);

    const published = await publishAs(owner, clientId, draft, { acknowledged_warning_codes: draft.warning_codes });
    expect(published.status).toBe(201);
    expect(published.json.data.publication_authorization).toBe('delegated');

    const [approval] = await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, draft.draft_id));
    expect(approval).toMatchObject({ authorizationKind: 'delegated', clientId, sessionId: null, decision: 'approved' });
    expect(approval?.consumedAt).not.toBeNull();
    const [version] = await db().select().from(projectVersions).where(eq(projectVersions.id, published.json.data.project_version_id));
    expect(version).toMatchObject({ publicationAuthorization: 'delegated', publishedViaClientName: 'Example Agent', approvalId: approval?.id });
    const audit = await db().select().from(auditEvents)
      .where(and(eq(auditEvents.targetId, draft.draft_id), eq(auditEvents.action, 'draft.approved_by_delegation')));
    expect(audit).toHaveLength(1);

    // Everyone can see that this version had no per-version human review.
    const projectId = published.json.data.project_id;
    const detail = await request(`/api/v1/projects/${projectId}/versions/${published.json.data.project_version_id}`);
    expect(detail.json.data.publication).toEqual({ authorization: 'delegated', via_client_name: 'Example Agent', via_client_name_is_unverified: true });
    const history = await request(`/api/v1/projects/${projectId}/versions`);
    expect(history.json.data.items[0].publication.authorization).toBe('delegated');

    // The owner sees what the connection published.
    const connections = await request('/api/v1/me/connections', { user: owner.userId });
    const row = connections.json.data.items.find((item: { connection_id: string }) => item.connection_id === connectionId);
    expect(row.publication_delegated).toBe(true);
    expect(row.delegated_publications).toEqual([
      expect.objectContaining({
        kind: 'project', draft_id: draft.draft_id, project_version_id: published.json.data.project_version_id,
        project: { project_id: projectId, slug: published.json.data.slug, version_number: 1, visibility: 'published' },
        record_visibility: null,
      }),
    ]);
  });

  it('keeps human-approved versions labeled as such', async () => {
    const owner = await createAccount();
    const { clientId } = await connect(owner);
    const draft = await agentDraft(owner, clientId, 'human-label');
    const approved = await request(`/api/v1/drafts/${draft.draft_id}/approval`, {
      method: 'POST', user: owner.userId,
      body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes },
    });
    const published = await publishAs(owner, clientId, draft, { approval_id: approved.json.data.approval_id });
    expect(published.status).toBe(201);
    expect(published.json.data.publication_authorization).toBe('human');
    const detail = await request(`/api/v1/projects/${published.json.data.project_id}/versions/${published.json.data.project_version_id}`);
    expect(detail.json.data.publication).toEqual({ authorization: 'human', via_client_name: null, via_client_name_is_unverified: false });
  });

  it('is scoped to one connection, and ends when the owner turns it off or revokes the connection', async () => {
    const owner = await createAccount();
    const delegated = await connect(owner);
    const other = await connect(owner, 'Other Agent');
    expect((await delegate(owner, delegated.connectionId)).status).toBe(204);

    // A different connection of the same person is not delegated, and neither is a session.
    const otherDraft = await agentDraft(owner, other.clientId, 'other-connection');
    expect((await publishAs(owner, other.clientId, otherDraft, { acknowledged_warning_codes: otherDraft.warning_codes })).status).toBe(409);
    const sessionPublish = await request(`/api/v1/drafts/${otherDraft.draft_id}/publish`, {
      method: 'POST', user: owner.userId, idempotencyKey: `publish-${randomUUID()}`,
      body: { draft_revision: otherDraft.revision, payload_digest: otherDraft.payload_digest, acknowledged_warning_codes: otherDraft.warning_codes },
    });
    expect(sessionPublish.status).toBe(409);

    // Turning it off stops further delegated publication.
    expect((await delegate(owner, delegated.connectionId, 'DELETE')).status).toBe(204);
    const offDraft = await agentDraft(owner, delegated.clientId, 'turned-off');
    expect((await publishAs(owner, delegated.clientId, offDraft, { acknowledged_warning_codes: offDraft.warning_codes })).status).toBe(409);

    // Revoking the connection removes its delegation with it.
    expect((await delegate(owner, delegated.connectionId)).status).toBe(204);
    expect((await request(`/api/v1/me/connections/${delegated.connectionId}`, { method: 'DELETE', user: owner.userId })).status).toBe(204);
    expect(await db().select().from(publicationDelegations).where(eq(publicationDelegations.userId, owner.userId))).toEqual([]);
    const revokedDraft = await agentDraft(owner, delegated.clientId, 'revoked');
    expect((await publishAs(owner, delegated.clientId, revokedDraft, { acknowledged_warning_codes: revokedDraft.warning_codes })).status).toBe(409);
  });

  it('can be enabled while approving, only for the connection that created the draft, atomically', async () => {
    const owner = await createAccount();
    const { clientId } = await connect(owner);
    const draft = await agentDraft(owner, clientId, 'approve-and-delegate');
    const body = { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes, delegate_connection: true };

    // An agent token cannot use the review page's delegation.
    const byAgent = await request(`/api/v1/drafts/${draft.draft_id}/approval`, { method: 'POST', ...asAgent(owner, clientId), body });
    expect(byAgent.status).toBe(403);

    // The review page names the creating connection, so the person knows whom they would delegate to.
    const reviewPath = `/api/browser/drafts/${draft.draft_id}/review`;
    expect((await request(reviewPath, { user: owner.userId })).json.data.creating_connection).toEqual({
      connection_id: expect.any(String), client_name: 'Example Agent', client_name_is_unverified: true, publication_delegated: false,
    });

    const approved = await request(`/api/v1/drafts/${draft.draft_id}/approval`, { method: 'POST', user: owner.userId, body });
    expect(approved.status).toBe(201);
    expect((await request(reviewPath, { user: owner.userId })).json.data.creating_connection.publication_delegated).toBe(true);
    const [delegation] = await db().select().from(publicationDelegations).where(eq(publicationDelegations.userId, owner.userId));
    expect(delegation?.clientId).toBe(clientId);

    // A draft made in the browser has no connection to delegate to; nothing is recorded.
    const sessionDraft = await request('/api/v1/drafts', {
      method: 'POST', user: owner.userId, idempotencyKey: `draft-${randomUUID()}`,
      body: { kind: 'project', project_md: projectDocument({ key: 'browser-made' }) },
    });
    const sessionBody = { ...body, draft_revision: sessionDraft.json.data.revision, payload_digest: sessionDraft.json.data.payload_digest, acknowledged_warning_codes: sessionDraft.json.data.warning_codes };
    expect((await request(`/api/browser/drafts/${sessionDraft.json.data.draft_id}/review`, { user: owner.userId })).json.data.creating_connection).toBeNull();
    const noClient = await request(`/api/v1/drafts/${sessionDraft.json.data.draft_id}/approval`, { method: 'POST', user: owner.userId, body: sessionBody });
    expect(noClient.status).toBe(409);
    expect(await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, sessionDraft.json.data.draft_id))).toEqual([]);

    // A connection revoked after creating the draft: neither the approval nor the delegation is recorded.
    const second = await connect(owner, 'Second Agent');
    const orphan = await agentDraft(owner, second.clientId, 'orphaned');
    await db().delete(oauthConsentTable).where(eq(oauthConsentTable.id, second.connectionId));
    const orphanBody = { ...body, draft_revision: orphan.revision, payload_digest: orphan.payload_digest, acknowledged_warning_codes: orphan.warning_codes };
    expect((await request(`/api/browser/drafts/${orphan.draft_id}/review`, { user: owner.userId })).json.data.creating_connection).toBeNull();
    const gone = await request(`/api/v1/drafts/${orphan.draft_id}/approval`, { method: 'POST', user: owner.userId, body: orphanBody });
    expect(gone.status).toBe(409);
    expect(await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, orphan.draft_id))).toEqual([]);
  });

  it('covers build drafts too, with the authorization recorded on the approval', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { buildId } = await submitThroughApi(contributor, project);
    const { clientId, connectionId } = await connect(contributor);
    expect((await delegate(contributor, connectionId)).status).toBe(204);
    const agent = { 'x-dev-client': clientId };

    const created = await api(contributor, '/api/v1/drafts', { method: 'POST', token: true, headers: agent, body: { kind: 'build', record_id: buildId }, key: key('draft') });
    expect(created.status).toBe(201);
    const draft = created.json.data;
    const published = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST', token: true, headers: agent, key: key(),
      body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes },
    });
    expect(published.status).toBe(201);
    expect(published.json.data).toMatchObject({ kind: 'build', visibility: 'public', review_state: 'pending', publication_authorization: 'delegated' });
    const [approval] = await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, draft.draft_id));
    expect(approval).toMatchObject({ authorizationKind: 'delegated', clientId });

    // The owner sees the record's current state, before and after withdrawing it.
    const recordRow = async () => (await request('/api/v1/me/connections', { user: contributor.userId })).json.data.items
      .find((item: { connection_id: string }) => item.connection_id === connectionId).delegated_publications[0];
    expect(await recordRow()).toMatchObject({ kind: 'build', record_id: buildId, project: null, record_visibility: 'public' });
    expect((await request(`/api/v1/builds/${buildId}/withdraw`, { method: 'POST', user: contributor.userId })).status).toBe(200);
    expect((await recordRow()).record_visibility).toBe('withdrawn');
  });

  it('has no local approval channel: the device routes are gone and an approval credential is not a credential', async () => {
    const owner = await createAccount();
    const { clientId } = await connect(owner);
    const draft = await agentDraft(owner, clientId, 'no-approval-device');
    expect((await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'laptop' } })).status).toBe(404);
    expect((await request('/api/v1/me/approver-devices', { user: owner.userId })).status).toBe(404);
    const decision = { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes, decision: 'approved' };
    for (const path of [`/api/v1/drafts/${draft.draft_id}/review`, `/api/v1/drafts/${draft.draft_id}/approval`]) {
      const method = path.endsWith('/approval') ? 'POST' : 'GET';
      const body = method === 'POST' ? decision : undefined;
      expect((await request(path, { method, body, headers: { authorization: 'Bearer lfh_retiredcredential' } })).status).toBe(401);
      expect((await request(path, { method, body, ...asAgent(owner, clientId) })).status).toBe(403);
    }
    expect(await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, draft.draft_id))).toEqual([]);
  });
});
