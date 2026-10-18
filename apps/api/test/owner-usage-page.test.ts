/**
 * The owner usage screen (FRONTEND_PRD sections 12.3 and 19, BACKEND_PRD 19.3.1):
 * only a project's manager sees its request series, and the read models are uncached JSON.
 */

import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { projectUsageDaily } from '../src/db/schema/registry.js';
import { fillDays, type UsageDay } from '../src/services/usage.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seedUsage(projectId: string, versionId: string, rows: Array<[string, 'rest_export' | 'mcp_retrieval', number]>) {
  await db()
    .insert(projectUsageDaily)
    .values(rows.map(([dayUtc, channel, count]) => ({ projectId, versionId, dayUtc, channel, count })));
}

describe('fillDays', () => {
  const at = new Date('2026-10-15T12:00:00Z');

  it('returns exactly N consecutive UTC days ending today, oldest first, with quiet days as zero', () => {
    const series: UsageDay[] = [
      { day: '2026-10-15', spec_exports: 4, agent_retrievals: 1 },
      { day: '2026-10-13', spec_exports: 2, agent_retrievals: 0 },
    ];
    const filled = fillDays(series, 5, at);
    expect(filled.map((d) => d.day)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    expect(filled.map((d) => d.spec_exports)).toEqual([0, 0, 2, 0, 4]);
    expect(filled[4]?.agent_retrievals).toBe(1);
  });

  it('drops stored days outside the window and crosses month boundaries', () => {
    const filled = fillDays([{ day: '2026-09-01', spec_exports: 9, agent_retrievals: 9 }], 3, new Date('2026-10-01T00:30:00Z'));
    expect(filled.map((d) => d.day)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(filled.every((d) => d.spec_exports === 0)).toBe(true);
  });
});

describe('owner usage read models', () => {
  it('requires a browser session for projects and usage', async () => {
    expect((await request('/api/browser/projects')).status).toBe(401);
    const owner = await createAccount();
    expect((await request('/api/browser/projects', { user: owner.userId, actorKind: 'token' })).status).toBe(403);
    expect((await request('/api/browser/projects/00000000-0000-4000-8000-000000000000/usage')).status).toBe(401);
  });
  it('lists only owned projects, preserving exact names and lifetime totals', async () => {
    const owner = await createAccount(), other = await createAccount();
    const mine = await publishProject(owner, projectDocument({ key: 'mine', name: 'My <b>Own</b> Project' }));
    await publishProject(other, projectDocument({ key: 'theirs', name: 'Somebody Elses Project' }));
    await seedUsage(mine.projectId, mine.projectVersionId, [[today(), 'rest_export', 1204], [today(), 'mcp_retrieval', 1]]);
    const response = await request('/api/browser/projects', { user: owner.userId });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json.data.items).toHaveLength(1);
    expect(response.json.data.items[0]).toMatchObject({ project_id: mine.projectId, name: 'My <b>Own</b> Project', usage: { spec_exports: 1204, agent_retrievals: 1 } });
  });
  it('returns an honest empty list', async () => {
    const owner = await createAccount();
    expect((await request('/api/browser/projects', { user: owner.userId })).json.data.items).toEqual([]);
  });
  it('returns lifetime totals and a consecutive UTC series with quiet days filled', async () => {
    const owner = await createAccount();
    const project = await publishProject(owner, projectDocument({ key: 'usage-owner' }));
    await seedUsage(project.projectId, project.projectVersionId, [[today(), 'rest_export', 7], [daysAgo(2), 'rest_export', 3], [daysAgo(2), 'mcp_retrieval', 5]]);
    const response = await request(`/api/browser/projects/${project.projectId}/usage`, { user: owner.userId });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json.data.project.usage).toMatchObject({ spec_exports: 10, agent_retrievals: 5 });
    expect(response.json.data.days).toHaveLength(30);
    expect(response.json.data.days.at(-1)).toEqual({ day: today(), spec_exports: 7, agent_retrievals: 0 });
    expect(response.json.data.days.at(-2)).toMatchObject({ spec_exports: 0, agent_retrievals: 0 });
    expect((await request(`/api/browser/projects/${project.projectId}/usage?days=90`, { user: owner.userId })).json.data.days).toHaveLength(90);
    expect((await request(`/api/browser/projects/${project.projectId}/usage?days=abc`, { user: owner.userId })).json.data.days).toHaveLength(30);
  });
  it('gives strangers and malformed IDs the same not-found response without disclosing counts', async () => {
    const owner = await createAccount(), stranger = await createAccount();
    const project = await publishProject(owner, projectDocument({ key: 'usage-private' }));
    await seedUsage(project.projectId, project.projectVersionId, [[today(), 'rest_export', 987654]]);
    for (const id of [project.projectId, 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const response = await request(`/api/browser/projects/${id}/usage`, { user: stranger.userId });
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('987654');
      expect(response.text).not.toContain(project.slug);
    }
  });
});
