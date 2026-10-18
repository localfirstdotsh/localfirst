/**
 * Authorization acceptance checks (BACKEND_PRD sections 10, 20.1).
 *
 * Tokens are minted with the deployment's real signing key and verified
 * through its real JWKS endpoint, so audience, issuer, expiry, signature, and
 * scope behaviour is exercised end to end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createAccount, projectDocument, publishProject } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startTestServer();
});

afterAll(async () => {
  await harness.close();
});

async function api(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json: json as any, headers: response.headers };
}

function bearer(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('bearer verification', () => {
  it('accepts a REST-audience token for the REST adapter', async () => {
    const account = await createAccount();
    const token = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['profile:read'],
    });
    const response = await api('/api/v1/me', bearer(token));
    expect(response.status).toBe(200);
    expect(response.json.data.handle).toBe(account.handle);
    expect(response.json.data.actor_kind).toBe('token');
    expect(response.json.data.granted_scopes).toEqual(['profile:read']);
  });

  it('refuses an MCP-audience token at the REST resource', async () => {
    const account = await createAccount();
    const token = await mintToken({
      subject: account.userId,
      audience: config().mcpResource,
      scopes: ['profile:read'],
    });
    const response = await api('/api/v1/me', bearer(token));
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe('INVALID_CREDENTIAL');
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses a wrong issuer, an expired token, and a tampered signature', async () => {
    const account = await createAccount();
    const wrongIssuer = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      issuer: 'https://evil.example.org/api/auth',
    });
    expect((await api('/api/v1/me', bearer(wrongIssuer))).status).toBe(401);

    const expired = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      expiresInSeconds: -120,
    });
    expect((await api('/api/v1/me', bearer(expired))).status).toBe(401);

    const valid = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['profile:read'],
    });
    const tampered = `${valid.slice(0, -4)}AAAA`;
    expect((await api('/api/v1/me', bearer(tampered))).status).toBe(401);
  });

  it('refuses an identity token used as an access token', async () => {
    const account = await createAccount();
    const idToken = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['profile:read'],
      extra: { nonce: 'n-0S6_WzA2Mj', at_hash: 'fake' },
    });
    const response = await api('/api/v1/me', bearer(idToken));
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe('INVALID_CREDENTIAL');
  });

  it('does not fall back to a session when a bearer token is invalid', async () => {
    const account = await createAccount();
    // `X-Dev-User` stands in for a valid browser session here: an invalid
    // Authorization header must still be rejected outright.
    const response = await api('/api/v1/me', {
      headers: { authorization: 'Bearer not-a-token', 'x-dev-user': account.userId },
    });
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe('INVALID_CREDENTIAL');
  });

  it('rejects an unsupported authorization scheme', async () => {
    const response = await api('/api/v1/me', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(response.status).toBe(401);
  });

  it('challenges an unauthenticated private read', async () => {
    const response = await api('/api/v1/me');
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe('UNAUTHENTICATED');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('enforces scopes per operation', async () => {
    const account = await createAccount();
    const readOnly = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['projects:read'],
    });
    const denied = await api('/api/v1/drafts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${readOnly}`,
        'content-type': 'application/json',
        'idempotency-key': 'scope-test',
      },
      body: JSON.stringify({ kind: 'project', project_md: projectDocument() }),
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('INSUFFICIENT_SCOPE');
    // Any one draft-writing scope admits the route; the kind then decides which one is needed.
    expect(denied.json.error.details.required_scopes).toEqual(['projects:draft', 'builds:write', 'tests:submit', 'community:write']);
    expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('refuses a suspended account', async () => {
    const account = await createAccount({ suspended: true });
    const token = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['profile:read'],
    });
    const response = await api('/api/v1/me', bearer(token));
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses a token whose subject has no Localfirst profile', async () => {
    const token = await mintToken({
      subject: 'user-does-not-exist',
      audience: config().restResource,
      scopes: ['profile:read'],
    });
    const response = await api('/api/v1/me', bearer(token));
    expect(response.status).toBe(403);
  });

  it('keeps the human-only approval route closed to tokens', async () => {
    const account = await createAccount();
    const token = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['projects:draft', 'projects:publish'],
    });
    const created = await api('/api/v1/drafts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'human-boundary',
      },
      body: JSON.stringify({ kind: 'project', project_md: projectDocument({ key: 'human-only-token' }) }),
    });
    expect(created.status).toBe(201);
    const approval = await api(`/api/v1/drafts/${created.json.data.draft_id}/approval`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        draft_revision: 1,
        payload_digest: created.json.data.payload_digest,
        acknowledged_warning_codes: created.json.data.warning_codes,
      }),
    });
    expect(approval.status).toBe(403);
  });
});

describe('operator boundaries', () => {
  it('hides operator routes from non-operators and serves them to operators', async () => {
    const operator = await createAccount({ operator: true });
    const user = await createAccount();

    const asUser = await api('/api/v1/admin/reviews', {
      headers: { 'x-dev-user': user.userId },
    });
    expect(asUser.status).toBe(404);

    const asOperator = await api('/api/v1/admin/reviews', {
      headers: { 'x-dev-user': operator.userId },
    });
    expect(asOperator.status).toBe(200);
    expect(asOperator.json.data.evidence_reviews).toEqual({ phase: 'P1', available: true, pending: [] });
  });

  it('records a moderation reason and an audit trail', async () => {
    const operator = await createAccount({ operator: true });
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'moderated' }));

    const moderated = await api(`/api/v1/admin/projects/${published.projectId}/moderation`, {
      method: 'POST',
      headers: { 'x-dev-user': operator.userId, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'quarantine', reason: 'Test moderation decision.' }),
    });
    expect(moderated.status).toBe(200);
    expect(moderated.json.data.visibility).toBe('quarantined');

    const audit = await api('/api/v1/admin/audit-events?action=moderation.quarantine', {
      headers: { 'x-dev-user': operator.userId },
    });
    expect(audit.json.data.items[0]).toMatchObject({
      action: 'moderation.quarantine',
      reason: 'Test moderation decision.',
      policy_version: 'localfirst/moderation/v0.1',
    });
  });

  it('requires a reason for moderation', async () => {
    const operator = await createAccount({ operator: true });
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'no-reason' }));
    const response = await api(`/api/v1/admin/projects/${published.projectId}/moderation`, {
      method: 'POST',
      headers: { 'x-dev-user': operator.userId, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'quarantine', reason: 'x' }),
    });
    expect(response.status).toBe(400);
  });

  it('transfers management only when an operator says so explicitly', async () => {
    const operator = await createAccount({ operator: true });
    const author = await createAccount();
    const claimant = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'claimed-project' }));

    const claim = await api(`/api/v1/projects/${published.projectId}/claim-requests`, {
      method: 'POST',
      headers: { 'x-dev-user': claimant.userId, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'manager',
        evidence: 'I maintain the upstream documentation this listing describes; see the commit history.',
      }),
    });
    expect(claim.status).toBe(201);
    expect(claim.json.data.state).toBe('pending');

    const acceptedWithoutTransfer = await api(
      `/api/v1/admin/claim-requests/${claim.json.data.claim_id}/review`,
      {
        method: 'POST',
        headers: { 'x-dev-user': operator.userId, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accepted', reason: 'Evidence checked.' }),
      },
    );
    expect(acceptedWithoutTransfer.json.data.manager_changed).toBe(false);

    // The original manager still manages it.
    const update = await api(`/api/v1/projects/${published.projectId}/unpublish`, {
      method: 'POST',
      headers: { 'x-dev-user': claimant.userId },
    });
    expect(update.status).toBe(403);
  });
});

describe('discovery and metadata', () => {
  it('serves REST protected-resource metadata with distinct audiences', async () => {
    const response = await api('/.well-known/oauth-protected-resource/api/v1');
    expect(response.status).toBe(200);
    expect(response.json.resource).toBe(config().restResource);
    expect(response.json.resource).not.toBe(config().mcpResource);
    expect(response.json.authorization_servers).toEqual([config().authIssuer]);
    expect(response.json.scopes_supported).toContain('projects:read');
    // P1 scopes are advertised because the evidence surface is implemented.
    for (const scope of ['builds:write', 'builds:publish', 'tests:submit', 'tests:publish']) {
      expect(response.json.scopes_supported).toContain(scope);
    }
  });

  it('serves authorization server metadata at the path-based and issuer-local aliases', async () => {
    const root = await api('/.well-known/oauth-authorization-server/api/auth');
    expect(root.status).toBe(200);
    expect(root.json.issuer).toBeTruthy();
    const local = await api('/api/auth/.well-known/oauth-authorization-server');
    expect(local.status).toBe(200);
  });

  it('serves MCP protected-resource metadata', async () => {
    const response = await api('/.well-known/oauth-protected-resource/mcp');
    expect(response.status).toBe(200);
    expect(response.json.resource).toBe(config().mcpResource);
  });

  it('publishes only signing keys at the JWKS endpoint', async () => {
    const response = await api('/api/auth/jwks');
    expect(response.status).toBe(200);
    const keys = response.json.keys as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.d).toBeUndefined();
      expect(key.k).toBeUndefined();
    }
  });

  it('documents only implemented routes in the OpenAPI contract', async () => {
    const response = await api('/openapi.json');
    const paths = Object.keys(response.json.paths);
    expect(paths).toContain('/api/v1/drafts/{draft_id}/publish');
    for (const path of [
      '/api/v1/builds',
      '/api/v1/builds/{build_id}/withdraw',
      '/api/v1/test-results',
      '/api/v1/test-results/{result_id}/withdraw',
      '/api/v1/test-definitions/{test_id}/plan',
      '/api/v1/projects/{project_id}/compatibility-reports',
    ]) {
      expect(paths).toContain(path);
    }
    // Implemented community routes are advertised.
    expect(paths.some((path) => path.includes('comparisons'))).toBe(true);
    expect(paths.some((path) => path.includes('derivative'))).toBe(true);
    expect(paths.some((path) => path.includes('collections'))).toBe(true);
    const scopes = response.json.components.securitySchemes.localfirstOAuth.flows.authorizationCode.scopes;
    expect(Object.keys(scopes)).toContain('tests:submit');
    expect(Object.keys(scopes)).not.toContain('runtime:execute');
  });
});
