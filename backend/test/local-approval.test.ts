/**
 * Local publication approval (BACKEND_PRD section 10.4): a linked machine can
 * record its owner's decision and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { approverCredentials, approverLinks, auditEvents, publicationApprovals } from '../src/db/schema/registry.js';
import { createDirectProjectDraft, revalidateDraft } from '../src/services/drafts.js';
import { pruneApprovers } from '../src/services/approvers.js';
import { createAccount, projectDocument, request, type TestAccount } from './factories.js';

async function link(account: TestAccount, label = 'laptop') {
  const started = await request('/api/v1/approver-links', { method: 'POST', body: { client_label: label } });
  expect(started.status).toBe(201);
  const { link_id, user_code, poll_secret } = started.json.data;
  const pending = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret } });
  expect(pending.status).toBe(202);
  expect(pending.json.data.status).toBe('authorization_pending');
  const decided = await request('/api/v1/approver-links/decision', {
    method: 'POST', user: account.userId, body: { user_code, decision: 'approved' },
  });
  expect(decided.status).toBe(200);
  const issued = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret } });
  expect(issued.status).toBe(200);
  return { linkId: link_id as string, userCode: user_code as string, pollSecret: poll_secret as string, credential: issued.json.data.credential as string, credentialId: issued.json.data.credential_id as string };
}

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });

async function draftFor(account: TestAccount) {
  const { draft } = await createDirectProjectDraft({
    actor: account.actor, ownerUserId: account.userId, projectId: null,
    payload: { project_md: projectDocument(), files: [] },
  });
  const { draft: validated, validation } = await revalidateDraft(account.actor, draft.id);
  return { draft: validated, warnings: validation.warning_codes };
}

describe('linking a machine', () => {
  it('issues a credential once, only after a browser session approves the code', async () => {
    const account = await createAccount();
    const done = await link(account);
    expect(done.credential).toMatch(/^lfh_/);
    expect(done.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // The secret is never stored.
    const rows = await db().select().from(approverCredentials).where(eq(approverCredentials.userId, account.userId));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(done.credential);

    const again = await request(`/api/v1/approver-links/${done.linkId}/token`, { method: 'POST', body: { poll_secret: done.pollSecret } });
    expect(again.status).toBe(410);
    expect(again.json.error.details.reason).toBe('redeemed');
    const audit = await db().select().from(auditEvents).where(eq(auditEvents.action, 'approver.credential_issued'));
    expect(audit).toHaveLength(1);
  });

  it('refuses a wrong poll secret and a code nobody approved', async () => {
    const account = await createAccount();
    const started = await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'x' } });
    const { link_id, poll_secret } = started.json.data;
    const wrong = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret: `${poll_secret}x` } });
    expect(wrong.status).toBe(410);
    expect(wrong.json.error.details.reason).toBe('unknown');
    const still = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret } });
    expect(still.status).toBe(202);
    expect(await db().select().from(approverCredentials).where(eq(approverCredentials.userId, account.userId))).toHaveLength(0);
  });

  it('records a denial and never issues a credential for it', async () => {
    const account = await createAccount();
    const started = await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'x' } });
    const { link_id, user_code, poll_secret } = started.json.data;
    const denied = await request('/api/v1/approver-links/decision', { method: 'POST', user: account.userId, body: { user_code, decision: 'denied' } });
    expect(denied.status).toBe(200);
    const poll = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret } });
    expect(poll.status).toBe(410);
    expect(poll.json.error.details.reason).toBe('denied');
    const decideAgain = await request('/api/v1/approver-links/decision', { method: 'POST', user: account.userId, body: { user_code, decision: 'approved' } });
    expect(decideAgain.status).toBe(404);
  });

  it('expires an unanswered link', async () => {
    const account = await createAccount();
    const started = await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'x' } });
    const { link_id, user_code, poll_secret } = started.json.data;
    await db().update(approverLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approverLinks.id, link_id));
    const decided = await request('/api/v1/approver-links/decision', { method: 'POST', user: account.userId, body: { user_code, decision: 'approved' } });
    expect(decided.status).toBe(404);
    const poll = await request(`/api/v1/approver-links/${link_id}/token`, { method: 'POST', body: { poll_secret } });
    expect(poll.json.error.details.reason).toBe('expired');
    expect(await pruneApprovers()).toBeGreaterThanOrEqual(1);
  });

  it('only a browser session can decide a code or manage devices', async () => {
    const account = await createAccount();
    const started = await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'x' } });
    const { user_code } = started.json.data;
    const body = { user_code, decision: 'approved' };
    expect((await request('/api/v1/approver-links/decision', { method: 'POST', body })).status).toBe(401);
    expect((await request('/api/v1/approver-links/decision', { method: 'POST', body, user: account.userId, actorKind: 'token', scopes: ['projects:draft'] })).status).toBe(403);
    const done = await link(account);
    expect((await request('/api/v1/approver-links/decision', { method: 'POST', body, headers: bearer(done.credential) })).status).toBe(403);
    expect((await request('/api/v1/me/approver-devices', { headers: bearer(done.credential) })).status).toBe(403);
  });
});

describe('what an approval credential can do', () => {
  it('reviews and approves the exact artifact, and the decision is attributed to the device', async () => {
    const account = await createAccount();
    const { credential, credentialId } = await link(account);
    const { draft, warnings } = await draftFor(account);

    const review = await request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) });
    expect(review.status).toBe(200);
    expect(review.json.data.content).toContain('# ');
    expect(review.json.data.draft.payload_digest).toBe(draft.payloadDigest);
    expect(review.json.data.warning_codes).toEqual(warnings);

    const approved = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST', headers: bearer(credential),
      body: { draft_revision: draft.revision, payload_digest: draft.payloadDigest, acknowledged_warning_codes: warnings },
    });
    expect(approved.status).toBe(201);
    const [row] = await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, draft.id));
    expect(row).toMatchObject({ approverCredentialId: credentialId, sessionId: null, decision: 'approved' });
    const audit = await db().select().from(auditEvents)
      .where(and(eq(auditEvents.targetId, draft.id), eq(auditEvents.action, 'draft.approved')));
    expect(audit.map((event) => event.actorKind)).toContain('approver');

    // Publication still goes through the normal publish route with its own checks.
    const published = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST', user: account.userId, idempotencyKey: 'local-approval-publish',
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payloadDigest },
    });
    expect(published.status).toBe(201);
  });

  it('still requires every warning to be acknowledged, and honours denial', async () => {
    const account = await createAccount();
    const { credential } = await link(account);
    const { draft } = await draftFor(account);
    const decision = { draft_revision: draft.revision, payload_digest: draft.payloadDigest, acknowledged_warning_codes: [] };
    const unacknowledged = await request(`/api/v1/drafts/${draft.id}/approval`, { method: 'POST', headers: bearer(credential), body: decision });
    expect(unacknowledged.json.error.code).toBe('APPROVAL_WARNINGS_UNACKNOWLEDGED');
    const denied = await request(`/api/v1/drafts/${draft.id}/approval`, { method: 'POST', headers: bearer(credential), body: { ...decision, decision: 'denied' } });
    expect(denied.status).toBe(200);
    expect(denied.json.data.approval_id).toBeNull();
  });

  it('is refused everywhere else, including routes an agent token may use', async () => {
    const account = await createAccount();
    const { credential } = await link(account);
    const { draft } = await draftFor(account);
    const auth = { headers: bearer(credential) };
    const refused: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/projects'],
      ['GET', `/api/v1/drafts/${draft.id}`],
      ['POST', '/api/v1/drafts', { kind: 'project', project_md: projectDocument() }],
      ['PATCH', `/api/v1/drafts/${draft.id}`, { project_md: projectDocument() }],
      ['DELETE', `/api/v1/drafts/${draft.id}`],
      ['POST', `/api/v1/drafts/${draft.id}/publish`, { approval_id: draft.id, draft_revision: 1, payload_digest: draft.payloadDigest }],
      ['DELETE', '/api/v1/me/connections/x'],
      ['POST', '/api/v1/approver-links/decision', { user_code: 'AAAAAAAA', decision: 'approved' }],
    ];
    for (const [method, path, body] of refused) {
      const response = await request(path, { method, ...auth, ...(body === undefined ? {} : { body }) });
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
  });

  it('cannot see or decide another person\'s draft', async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const { credential } = await link(other);
    const { draft } = await draftFor(owner);
    expect((await request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) })).status).toBe(404);
    const attempt = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST', headers: bearer(credential),
      body: { draft_revision: draft.revision, payload_digest: draft.payloadDigest, acknowledged_warning_codes: [], decision: 'denied' },
    });
    expect(attempt.status).toBe(404);
  });

  it('stops working when revoked, expired, or unknown, and is not a downgrade to anonymous', async () => {
    const account = await createAccount();
    const first = await link(account, 'first');
    const second = await link(account, 'second');
    const { draft } = await draftFor(account);
    const probe = (credential: string) => request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) });
    expect((await probe(first.credential)).status).toBe(200);

    const devices = await request('/api/v1/me/approver-devices', { user: account.userId });
    expect(devices.json.data.map((device: { label: string }) => device.label).sort()).toEqual(['first', 'second']);
    expect(JSON.stringify(devices.json)).not.toContain('lfh_');

    expect((await request(`/api/v1/me/approver-devices/${first.credentialId}`, { method: 'DELETE', user: account.userId })).status).toBe(204);
    expect((await probe(first.credential)).status).toBe(401);
    expect((await probe(second.credential)).status).toBe(200);

    await db().update(approverCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approverCredentials.id, second.credentialId));
    expect((await probe(second.credential)).status).toBe(401);
    expect((await probe('lfh_notarealcredential')).status).toBe(401);
  });

  it('cannot be revoked by someone else', async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const { credentialId, credential } = await link(owner);
    expect((await request(`/api/v1/me/approver-devices/${credentialId}`, { method: 'DELETE', user: other.userId })).status).toBe(404);
    const { draft } = await draftFor(owner);
    expect((await request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) })).status).toBe(200);
  });

  it('stops working when the account is suspended', async () => {
    const account = await createAccount();
    const { credential } = await link(account);
    const { draft } = await draftFor(account);
    const { userProfiles } = await import('../src/db/schema/registry.js');
    await db().update(userProfiles).set({ suspendedAt: new Date() }).where(eq(userProfiles.userId, account.userId));
    const response = await request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) });
    expect(response.status).toBe(403);
  });
});

describe('account deletion', () => {
  it('removes linked devices and open links, and the credential stops working at once', async () => {
    const account = await createAccount();
    const { credential } = await link(account);
    await request('/api/v1/approver-links', { method: 'POST', body: { client_label: 'open' } });
    const { draft } = await draftFor(account);
    const { requestAccountDeletion } = await import('../src/services/accounts.js');
    await requestAccountDeletion(account.actor, account.handle);
    expect(await db().select().from(approverCredentials).where(eq(approverCredentials.userId, account.userId))).toHaveLength(0);
    expect(await db().select().from(approverLinks).where(eq(approverLinks.userId, account.userId))).toHaveLength(0);
    const response = await request(`/api/v1/drafts/${draft.id}/review`, { headers: bearer(credential) });
    expect(response.status).toBe(401);
  });
});
