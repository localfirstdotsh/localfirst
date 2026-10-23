/** The backend supplies session-only JSON read models; Next.js owns browser rendering. */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { publicationApprovals } from '../src/db/schema/registry.js';
import { oauthClientTable, oauthConsentTable } from '../src/db/schema/auth.js';
import { publishEvidenceProject, submitThroughApi } from './evidence-fixtures.js';
import { createRecordDraft } from '../src/services/contributions.js';
import { config, setConfig } from '../src/config.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { createDirectProjectDraft, createApproval } from '../src/services/drafts.js';

afterEach(() => setConfig(null));
const reviewPath = (id: string) => `/api/browser/drafts/${id}/review`;
describe('browser read models', () => {
  it('leaves HTML rendering to the website and returns only uncached configuration', async () => {
    const legacy = await request('/sign-in?next=%2Faccount%2Fprojects');
    expect(legacy.status).toBe(307);
    expect(legacy.headers.get('location')).toBe(`${config().websiteUrl}/sign-in?next=%2Faccount%2Fprojects`);
    expect(legacy.headers.get('cache-control')).toBe('no-store');
    expect(legacy.text).not.toContain('<html');
    const current = config();
    setConfig({ ...current, websiteUrl: current.apiBaseUrl.replace('http:', 'https:') });
    expect((await request('/account/projects')).status).toBe(404);
    setConfig(current);
    expect((await request('/design-system')).status).toBe(404);
    const response = await request('/api/browser/config');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json.data.sign_in_enabled).toBe(true);
    expect(response.json.data.auth_base_path).toBe(config().authBasePath);
    expect(response.text).not.toContain(config().authSecret);
    expect(response.text).not.toContain(config().github.clientSecret);
  });
  it('reports only whether a human session exists, and never treats an agent credential as one', async () => {
    const account = await createAccount();
    const anonymous = await request('/api/browser/session');
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    expect(anonymous.json.data).toEqual({ authenticated: false, handle: null });
    expect((await request('/api/browser/session', { user: account.userId, actorKind: 'token' })).json.data.authenticated).toBe(false);
    expect((await request('/api/browser/session', { user: account.userId })).json.data).toEqual({ authenticated: true, handle: account.handle });
  });
  it('requires a signed-in person for the review page', async () => {
    const account = await createAccount();
    const { draft } = await createDirectProjectDraft({ actor: account.actor, ownerUserId: account.userId, projectId: null, payload: { project_md: projectDocument({ key: 'review-page' }), files: [] } });
    expect((await request(reviewPath(draft.id))).status).toBe(401);
    expect((await request(reviewPath(draft.id), { user: account.userId, actorKind: 'token' })).status).toBe(403);
    const response = await request(reviewPath(draft.id), { user: account.userId });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json.data.draft.payload_digest).toBe(draft.payloadDigest);
    expect(response.json.data.review.content).toBe(draft.payload.project_md);
    expect(response.json.data.review.warningCodes).toEqual(draft.warningCodes);
    expect(response.json.data.decision_allowed).toBe(true);
    expect(response.json.data.status).toBe('review');
    expect((await request('/api/browser/projects', { headers: { authorization: 'Bearer invalid-agent-token' } })).status).toBe(401);
  });
  it('offers no decision on a published draft and says where it was published', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'review-closed' }));
    const response = await request(reviewPath(published.draftId), { user: account.userId });
    expect(response.json.data.status).toBe('published');
    expect(response.json.data.decision_allowed).toBe(false);
    expect(response.json.data.published).toEqual({ slug: published.slug, version_number: 1 });
  });
  it('shows another account’s draft as missing', async () => {
    const owner = await createAccount(), stranger = await createAccount();
    const { draft } = await createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null, payload: { project_md: projectDocument({ key: 'review-private' }), files: [] } });
    const response = await request(reviewPath(draft.id), { user: stranger.userId });
    expect(response.status).toBe(404);
    expect(response.text).not.toContain(draft.payloadDigest);
  });
  it('keeps exact content and bundled files as data for React to escape', async () => {
    const owner = await createAccount();
    const text = projectDocument({ key: 'escaped' }) + '\n<script>alert(1)</script>';
    const { draft } = await createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null, payload: { project_md: text, files: [] } });
    const response = await request(reviewPath(draft.id), { user: owner.userId });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.json.data.review.content).toBe(text);
    expect(response.json.data.blocked).toBe(true);
  });
  it('shows deletion preview only to its own human session without making a mutation', async () => {
    const owner = await createAccount();
    const project = await publishProject(owner, projectDocument({ key: 'deletion-preview' }));
    expect((await request('/api/browser/deletion-preview')).status).toBe(401);
    expect((await request('/api/browser/deletion-preview', { user: owner.userId, actorKind: 'token' })).status).toBe(403);
    const response = await request('/api/browser/deletion-preview', { user: owner.userId });
    expect(response.json.data.handle).toBe(owner.handle);
    expect(response.json.data.managed_projects).toEqual([{ slug: project.slug }]);
    expect((await request(`/api/v1/projects/${project.projectId}`)).status).toBe(200);
  });
  it('uses registered client metadata only in a session, never a name from the query, and keeps unknown requested scopes visible', async () => {
    const account = await createAccount();
    await db().insert(oauthClientTable).values({ id: 'registered', clientId: 'registered', name: 'Registered example', redirectUris: [] });
    const path = '/api/browser/consent?client_id=registered&client_name=Query%20alias&scope=projects:read%20custom:write%20offline_access';
    const signed = await request(path, { user: account.userId });
    expect(signed.json.data.client_name).toBe('Registered example');
    expect(signed.json.data.scopes).toEqual(['projects:read', 'custom:write', 'offline_access']);
    // Without a session nothing about the client is shown, and the query string cannot supply a name.
    const anonymous = (await request(path)).json.data;
    expect(anonymous.client_name).toBeNull();
    expect(anonymous.app).toBeNull();
    const unknown = (await request('/api/browser/consent?client_id=nobody&client_name=Claude', { user: account.userId })).json.data;
    expect(unknown.client_name).toBeNull();
    expect(unknown.app).toBeNull();
  });
  it('tells the person where approval is sent, and flags an imitation of a known app', async () => {
    const account = await createAccount();
    await db().insert(oauthClientTable).values([
      { id: 'imposter', clientId: 'imposter', name: 'Claude', redirectUris: ['https://evil.example/steal'] },
      { id: 'real', clientId: 'real', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] },
      { id: 'cli', clientId: 'cli', name: 'Some CLI', redirectUris: ['http://127.0.0.1:43123/callback'] },
    ]);
    const app = async (clientId: string) => (await request(`/api/browser/consent?client_id=${clientId}&scope=projects:read`, { user: account.userId })).json.data.app;
    expect(await app('imposter')).toEqual({ kind: 'unrecognized', label: null, destinations: ['evil.example'], claims_to_be: 'Claude' });
    expect(await app('real')).toEqual({ kind: 'recognized', label: 'Claude', destinations: ['claude.ai'], claims_to_be: null });
    expect((await app('cli')).kind).toBe('local');
  });
  it('keeps connections private and untrusted labels as JSON, without exposing credentials', async () => {
    const owner = await createAccount(), stranger = await createAccount();
    await db().insert(oauthClientTable).values({ id: 'unsafe', clientId: 'unsafe', name: '<img src=x onerror=alert(1)>', redirectUris: [] });
    await db().insert(oauthConsentTable).values({ id: 'unsafe-consent', clientId: 'unsafe', userId: owner.userId, scopes: ['projects:read', '<script>alert(1)</script>'], createdAt: new Date(), updatedAt: new Date() });
    expect((await request('/api/browser/connections')).status).toBe(401);
    expect((await request('/api/browser/connections', { user: owner.userId, actorKind: 'token' })).status).toBe(403);
    const result = (await request('/api/browser/connections', { user: owner.userId })).json.data;
    expect(result.items[0].client_name).toBe('<img src=x onerror=alert(1)>');
    expect(result.items[0].scopes[1]).toBe('<script>alert(1)</script>');
    expect((await request('/api/browser/connections', { user: stranger.userId })).json.data.items).toEqual([]);
  });
  it('shows a real build summary and preserves its selected exact projection', async () => {
    const author = await createAccount(), contributor = await createAccount();
    const project = await publishEvidenceProject(author);
    const records = await submitThroughApi(contributor, project);
    const { draftRow } = await createRecordDraft({ actor: contributor.actor, kind: 'build', recordId: records.buildId, selection: { hardware: 'coarse' } });
    const response = await request(reviewPath(draftRow.id), { user: contributor.userId });
    expect(response.status).toBe(200);
    expect(response.json.data.draft.kind).toBe('build');
    expect(response.json.data.review.source.project.name).toBe('Local Request Labeler');
    expect(response.json.data.review.contentLabel).toBe('Inspect exact public projection');
    expect(JSON.parse(response.json.data.review.content).build_id).toBe(records.buildId);
  });
  it('renders live, expired and denied approvals from server records', async () => {
    const account = await createAccount();
    const { draft } = await createDirectProjectDraft({ actor: account.actor, ownerUserId: account.userId, projectId: null, payload: { project_md: projectDocument({ key: 'approval-states' }), files: [] } });
    const { approvalId } = await createApproval({ actor: account.actor, draftId: draft.id, draftRevision: draft.revision, payloadDigest: draft.payloadDigest, acknowledgedWarningCodes: draft.warningCodes, decision: 'approved', sessionId: 'test-session' });
    expect((await request(reviewPath(draft.id), { user: account.userId })).json.data.status).toBe('approved');
    expect((await request(reviewPath(draft.id), { user: account.userId })).json.data.decision_allowed).toBe(false);
    await db().update(publicationApprovals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(publicationApprovals.id, approvalId!));
    expect((await request(reviewPath(draft.id), { user: account.userId })).json.data.status).toBe('expired');
    await createApproval({ actor: account.actor, draftId: draft.id, draftRevision: draft.revision, payloadDigest: draft.payloadDigest, acknowledgedWarningCodes: draft.warningCodes, decision: 'denied', sessionId: 'test-session' });
    expect((await request(reviewPath(draft.id), { user: account.userId })).json.data.status).toBe('denied');
    expect((await request(reviewPath(draft.id) + '?review=again', { user: account.userId })).json.data.decision_allowed).toBe(true);
  });
});
describe('shared request controls', () => {
  it('rejects a non-JSON content type on a domain mutation', async () => {
    const account = await createAccount();
    const response = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      headers: { 'content-type': 'text/yaml', 'idempotency-key': 'wrong-type' },
    });
    expect(response.status).toBe(415);
  });

  it('refuses an oversized declared body', async () => {
    const account = await createAccount();
    const response = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      headers: {
        'content-length': String(10 * 1024 * 1024),
        'idempotency-key': 'too-big',
      },
      body: { kind: 'project', project_md: 'x' },
    });
    expect(response.status).toBe(413);
  });

  it('enforces a shared rate limit with Retry-After', async () => {
    const current = config();
    setConfig({
      ...current,
      limits: { ...current.limits, publicCatalogPerMinute: 2 },
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await request('/api/v1/projects')).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(
      0,
    );
    const limited = await request('/api/v1/projects');
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns an envelope and request id on every error', async () => {
    const response = await request(
      '/api/v1/projects/00000000-0000-4000-8000-000000000000',
    );
    expect(response.status).toBe(404);
    expect(response.json.error.code).toBe('NOT_FOUND');
    expect(response.json.error.retryable).toBe(false);
    expect(response.json.meta.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-request-id')).toBe(
      response.json.meta.request_id,
    );
  });

  it('sets conservative security headers', async () => {
    const response = await request('/api/v1/catalog/facets');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('grants CORS only to trusted origins', async () => {
    const allowed = await request('/api/v1/catalog/facets', {
      headers: { origin: config().websiteUrl },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      config().websiteUrl,
    );
    expect(allowed.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );

    const foreign = await request('/api/v1/catalog/facets', {
      headers: { origin: 'https://evil.example.org' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await request('/api/v1/drafts', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.org' },
    });
    expect(preflight.status).toBe(403);
  });

  it('gates the metrics endpoint behind a token when one is configured', async () => {
    const current = config();
    setConfig({ ...current, metricsToken: 'metrics-secret' });
    expect((await request('/metrics')).status).toBe(404);
    const authorized = await request('/metrics', {
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.text).toContain('localfirst_http_requests_total');
  });

  it('serves the published specification schema', async () => {
    const response = await request('/schemas/project/v0.2.json');
    expect(response.status).toBe(200);
    expect(response.json.$id).toContain('/schemas/project/v0.2.json');
    const preview = await request('/schemas/test/v0.1.json');
    // Whether the runner can execute is a per-definition fact, never a blanket claim.
    expect(preview.json['x-localfirst-status']).toMatchObject({
      phase: 'P1',
      runner_available: 'per_definition',
    });
    for (const name of ['build', 'build-report', 'test-result']) {
      const schema = await request(`/schemas/${name}/v0.1.json`);
      expect(schema.status, name).toBe(200);
      expect(schema.json.$id).toContain(`/schemas/${name}/v0.1.json`);
      expect(schema.json['x-localfirst-status'].phase).toBe('P1');
    }
    const result = (await request('/schemas/test-result/v0.1.json')).json;
    for (const forbidden of [
      'verified',
      'badge',
      'review_state',
      'evidence_level',
      'submitter',
    ]) {
      expect(Object.keys(result.properties)).not.toContain(forbidden);
    }
    expect(result.additionalProperties).toBe(false);
  });
});
