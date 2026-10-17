/**
 * Usage counters (BACKEND_PRD section 19.3.1): request counts for published
 * versions, never people, installs, or runs.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';
import { oauthClientTable, oauthConsentTable } from '../src/db/schema/auth.js';
import { projects, projectUsageDaily } from '../src/db/schema/registry.js';
import { changeOwnVisibility } from '../src/services/projects.js';
import { flushUsage, recordUsage, resetUsageBuffer } from '../src/services/usage.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startTestServer();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  resetUsageBuffer();
});

async function rpc(method: string, params: unknown, token: string): Promise<any> {
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  return text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(
        text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join(''),
      )
    : JSON.parse(text);
}

async function mcpToken(): Promise<string> {
  const reader = await createAccount();
  return mintToken({ subject: reader.userId, audience: config().mcpResource, scopes: ['projects:read'] });
}

async function usageOf(projectId: string): Promise<{ spec_exports: number; agent_retrievals: number; since: string | null }> {
  await flushUsage();
  const detail = await request(`/api/v1/projects/${projectId}`);
  return detail.json.data.usage;
}

describe('request counting', () => {
  it('counts a successful anonymous export once and ignores HEAD, owner previews, and failures', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'counted' }));
    const path = `/api/v1/projects/${published.projectId}/export`;

    expect((await request(path)).status).toBe(200);
    await request(path, { method: 'HEAD' });
    expect((await request(path, { user: owner.userId })).status).toBe(200);
    expect((await request(`${path}?version=${randomUUID()}`)).status).toBeGreaterThanOrEqual(400);
    expect((await request(`/api/v1/projects/${randomUUID()}/export`)).status).toBe(404);

    expect(await usageOf(published.projectId)).toMatchObject({ spec_exports: 1, agent_retrievals: 0 });
  });

  it('counts MCP project_get and resource reads as retrievals, not exports', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'agent-read' }));
    const token = await mcpToken();

    const fetched = await rpc('tools/call', { name: 'project_get', arguments: { project: published.slug } }, token);
    expect(fetched.result.structuredContent.version.content_digest).toBe(published.contentDigest);
    const uri = `localfirst://projects/${published.projectId}/versions/${published.projectVersionId}/documentation`;
    expect((await rpc('resources/read', { uri }, token)).result.contents).toHaveLength(1);

    expect(await usageOf(published.projectId)).toMatchObject({ spec_exports: 0, agent_retrievals: 2 });
  });

  it('does not count hidden projects or reads that fail visibility', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'hidden-later' }));
    await changeOwnVisibility({ actor: owner.actor, projectId: published.projectId, action: 'unpublish' });

    expect((await request(`/api/v1/projects/${published.projectId}/export`)).status).toBe(404);
    const [row] = await db().select().from(projects).where(eq(projects.id, published.projectId));
    recordUsage(owner.actor, { id: row!.id, visibility: row!.visibility, managerUserId: 'someone-else' }, published.projectVersionId, 'rest_export');
    await flushUsage();

    expect(await db().select().from(projectUsageDaily)).toHaveLength(0);
  });

  it('accumulates concurrent increments across interleaved flushes', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'accumulate' }));
    const project = { id: published.projectId, visibility: 'published', managerUserId: owner.userId };
    const anonymous = { kind: 'anonymous' } as const;

    for (let i = 0; i < 3; i += 1) recordUsage(anonymous, project, published.projectVersionId, 'rest_export');
    const first = flushUsage();
    for (let i = 0; i < 4; i += 1) recordUsage(anonymous, project, published.projectVersionId, 'rest_export');
    await first;

    expect((await usageOf(published.projectId)).spec_exports).toBe(7);
  });

  it('drops a failed flush without throwing', async () => {
    const anonymous = { kind: 'anonymous' } as const;
    recordUsage(anonymous, { id: randomUUID(), visibility: 'published', managerUserId: 'x' }, randomUUID(), 'rest_export');
    await expect(flushUsage()).resolves.toBeUndefined();
    expect(await db().select().from(projectUsageDaily)).toHaveLength(0);
  });
});

describe('exposure', () => {
  it('shows lifetime totals on the list and detail, and the per-day series only to the manager', async () => {
    const owner = await createAccount();
    const stranger = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'exposed' }));
    await request(`/api/v1/projects/${published.projectId}/export`);
    await flushUsage();

    const list = await request('/api/v1/projects');
    const item = list.json.data.items.find((entry: { project_id: string }) => entry.project_id === published.projectId);
    expect(item.usage).toMatchObject({ spec_exports: 1, agent_retrievals: 0 });
    expect(item.usage.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const series = await request(`/api/v1/projects/${published.projectId}/usage`, { user: owner.userId });
    expect(series.status).toBe(200);
    expect(series.json.data.days[0]).toMatchObject({ spec_exports: 1, agent_retrievals: 0 });
    expect((await request(`/api/v1/projects/${published.projectId}/usage`, { user: stranger.userId })).status).toBe(404);
    expect((await request(`/api/v1/projects/${published.projectId}/usage`)).status).toBeGreaterThanOrEqual(401);
  });

  it('removes counts with the project', async () => {
    const owner = await createAccount();
    const published = await publishProject(owner, projectDocument({ key: 'cascade' }));
    await request(`/api/v1/projects/${published.projectId}/export`);
    await flushUsage();
    expect(await db().select().from(projectUsageDaily)).toHaveLength(1);
    await db().delete(projects).where(eq(projects.id, published.projectId));
    expect(await db().select().from(projectUsageDaily)).toHaveLength(0);
  });
});

describe('connections authorized', () => {
  it('counts a new consent once, ignores updates, and survives revocation', async () => {
    const owner = await createAccount();
    const now = new Date();
    await db().insert(oauthClientTable).values({ id: 'usage-client', clientId: 'usage-client', redirectUris: [] });
    const facets = async () => (await request('/api/v1/catalog/facets')).json.data.counts.connections_authorized;
    expect(await facets()).toBe(0);

    await db().insert(oauthConsentTable).values({ id: 'usage-consent', clientId: 'usage-client', userId: owner.userId, scopes: ['projects:read'], createdAt: now, updatedAt: now });
    expect(await facets()).toBe(1);

    await db().update(oauthConsentTable).set({ scopes: ['projects:read', 'projects:draft'], updatedAt: new Date() }).where(eq(oauthConsentTable.id, 'usage-consent'));
    expect(await facets()).toBe(1);

    await db().delete(oauthConsentTable).where(eq(oauthConsentTable.id, 'usage-consent'));
    expect(await facets()).toBe(1);
  });
});
