/**
 * Contribution quotas across transports (BACKEND_PRD sections 17.1 "Spam/
 * abusive content" and 19.2): drafts, publications, and concurrent imports
 * draw on one per-account allowance whether they arrive over REST, a
 * session, or any MCP client.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config, setConfig } from '../src/config.js';
import { createAccount, projectDocument, request, type TestAccount } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
afterEach(() => setConfig(null));

function withLimits(limits: Partial<ReturnType<typeof config>['limits']>) {
  const current = config();
  setConfig({ ...current, limits: { ...current.limits, ...limits } });
}

async function mcpCall(account: TestAccount, name: string, args: Record<string, unknown>, clientId: string) {
  const token = await mintToken({
    subject: account.userId, audience: config().mcpResource, clientId,
    scopes: ['projects:read', 'projects:draft', 'projects:publish'],
  });
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
    : JSON.parse(text);
  return payload.result as { isError?: boolean; structuredContent?: Record<string, any> };
}

const restDraft = (account: TestAccount, body: Record<string, unknown>) =>
  request('/api/v1/drafts', { method: 'POST', user: account.userId, body, idempotencyKey: randomUUID() });

const importDescriptor = { provider: 'github', repository_url: 'https://github.com/acme/widget', ref: 'main', manifest_path: 'PROJECT.md' };

describe('contribution quotas shared across transports and clients', () => {
  it('counts project and record drafts over REST and every MCP client against one hourly bucket', async () => {
    const account = await createAccount();
    withLimits({ draftsPerHour: 2 });
    expect((await restDraft(account, { kind: 'project', project_md: projectDocument({ key: 'quota-rest' }) })).status).toBe(201);
    const viaMcp = await mcpCall(account, 'contribution_create_draft', { kind: 'project', project_md: projectDocument({ key: 'quota-mcp' }), idempotency_key: randomUUID() }, 'client-a');
    expect(viaMcp.isError, JSON.stringify(viaMcp)).toBeFalsy();

    const otherClient = await mcpCall(account, 'contribution_create_draft', { kind: 'project', project_md: projectDocument({ key: 'quota-b' }), idempotency_key: randomUUID() }, 'client-b');
    expect(otherClient.structuredContent?.error?.code).toBe('RATE_LIMITED');
    const rest = await restDraft(account, { kind: 'project', project_md: projectDocument({ key: 'quota-rest-2' }) });
    expect(rest.status).toBe(429);
    expect(Number(rest.headers.get('retry-after'))).toBeGreaterThan(0);

    // Another account keeps its own allowance.
    expect((await restDraft(await createAccount(), { kind: 'project', project_md: projectDocument({ key: 'quota-other' }) })).status).toBe(201);
  });

  it('counts publication attempts over REST and MCP against one daily bucket', async () => {
    const account = await createAccount();
    const created = await restDraft(account, { kind: 'project', project_md: projectDocument({ key: 'quota-publish' }) });
    const draft = created.json.data as { draft_id: string; revision: number; payload_digest: string };
    withLimits({ publicationsPerDay: 1 });
    // An attempt with an approval that does not exist still counts, as it does on REST.
    const attempt = { approval_id: randomUUID(), draft_revision: draft.revision, payload_digest: draft.payload_digest };
    const first = await request(`/api/v1/drafts/${draft.draft_id}/publish`, { method: 'POST', user: account.userId, body: attempt, idempotencyKey: randomUUID() });
    expect(first.status).not.toBe(429);

    const viaMcp = await mcpCall(account, 'contribution_publish', { draft_id: draft.draft_id, ...attempt, idempotency_key: randomUUID() }, 'client-a');
    expect(viaMcp.structuredContent?.error?.code).toBe('RATE_LIMITED');
    const rest = await request(`/api/v1/drafts/${draft.draft_id}/publish`, { method: 'POST', user: account.userId, body: attempt, idempotencyKey: randomUUID() });
    expect(rest.status).toBe(429);
  });

  it('applies the two-concurrent-imports cap to MCP imports', async () => {
    const account = await createAccount();
    // No worker runs here, so both imports stay in progress.
    for (let index = 0; index < 2; index += 1) {
      expect((await restDraft(account, { kind: 'project', source_import: importDescriptor })).status).toBe(202);
    }
    const viaMcp = await mcpCall(account, 'contribution_create_draft', { kind: 'project', source_import: importDescriptor, idempotency_key: randomUUID() }, 'client-a');
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.structuredContent?.error?.code).toBe('RATE_LIMITED');
    expect(viaMcp.structuredContent?.error?.details).toMatchObject({ concurrent_imports: 2, limit: 2 });
  });
});
