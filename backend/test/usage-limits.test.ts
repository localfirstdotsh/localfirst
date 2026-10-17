/**
 * The usage counters (BACKEND_PRD section 19.3.1) are only as trustworthy as the
 * read limits in front of them. These tests prove every counted path is
 * rate limited, and that a refused request is never counted.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config, setConfig } from '../src/config.js';
import { db } from '../src/db/client.js';
import { projectUsageDaily } from '../src/db/schema/registry.js';
import { flushUsage, resetUsageBuffer } from '../src/services/usage.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(() => resetUsageBuffer());
afterEach(() => setConfig(null));

function withLimits(limits: Partial<ReturnType<typeof config>['limits']>) {
  const current = config();
  setConfig({ ...current, limits: { ...current.limits, ...limits } });
}

async function totals(): Promise<{ rest_export: number; mcp_retrieval: number }> {
  await flushUsage();
  const rows = await db().select().from(projectUsageDaily);
  const sum = (channel: string) => rows.filter((row) => row.channel === channel).reduce((n, row) => n + row.count, 0);
  return { rest_export: sum('rest_export'), mcp_retrieval: sum('mcp_retrieval') };
}

async function mcpRaw(token: string, body: unknown): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const getProject = (slug: string, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'project_get', arguments: { project: slug } },
});

async function readerToken(clientId = 'usage-limit-client', userId?: string): Promise<{ token: string; userId: string }> {
  const reader = userId ? { userId } : await createAccount();
  const token = await mintToken({
    subject: reader.userId,
    audience: config().mcpResource,
    clientId,
    scopes: ['projects:read'],
  });
  return { token, userId: reader.userId };
}

describe('read limits protect the counters', () => {
  it('rate limits the public export route and never counts a refused request', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'limited-export' }));
    withLimits({ publicCatalogPerMinute: 2 });

    const path = `/api/v1/projects/${published.projectId}/export`;
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await request(path)).status);

    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(await totals()).toEqual({ rest_export: 2, mcp_retrieval: 0 });
  });

  it('rate limits MCP reads per caller and never counts a refused call', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'limited-mcp' }));
    const { token } = await readerToken();
    withLimits({ authenticatedReadsPerMinute: 2 });

    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await mcpRaw(token, getProject(published.slug, i + 1)));

    expect(results.map((r) => r.status)).toEqual([200, 200, 429, 429]);
    expect(results[2]?.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await totals()).toEqual({ rest_export: 0, mcp_retrieval: 2 });
  });

  it('gives each caller its own allowance, so one caller cannot exhaust another', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'limited-isolation' }));
    const first = await readerToken('client-a');
    const second = await readerToken('client-b');
    withLimits({ authenticatedReadsPerMinute: 1 });

    expect((await mcpRaw(first.token, getProject(published.slug))).status).toBe(200);
    expect((await mcpRaw(first.token, getProject(published.slug))).status).toBe(429);
    expect((await mcpRaw(second.token, getProject(published.slug))).status).toBe(200);
  });

  it('charges a JSON-RPC batch for every call in it, so batching cannot bypass the limit', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'limited-batch' }));
    const { token } = await readerToken();
    withLimits({ authenticatedReadsPerMinute: 3 });

    const batch = Array.from({ length: 10 }, (_, i) => getProject(published.slug, i + 1));
    const refused = await mcpRaw(token, batch);

    expect(refused.status).toBe(429);
    expect(await totals()).toEqual({ rest_export: 0, mcp_retrieval: 0 });
  });
});
