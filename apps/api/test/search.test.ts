/**
 * Search and discovery checks (BACKEND_PRD sections 18.1, 20.1).
 */

import { describe, expect, it } from 'vitest';
import {
  createAccount,
  projectDocument,
  publishProject,
  request,
} from './factories.js';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { projects } from '../src/db/schema/registry.js';
import { reindexProject } from '../src/services/search.js';

const WITH_RUNTIMES = `{state: declared, supported: [{family: ollama, version_constraint: null}]}`;
const WITH_HARDWARE = `{state: declared, architectures: [arm64], minimum_memory_bytes: 8589934592, minimum_vram_bytes: null, accelerator: optional, devices: [NVIDIA Jetson Orin Nano]}`;
const WITH_MODELS = `{state: declared, roles: [{key: assistant, required_capabilities: [chat, json_output], minimum_context_tokens: 4096, substitution: allowed_for_task_test, preferred: "llama3.2:3b"}]}`;

async function seedCatalog(): Promise<Record<string, string>> {
  const account = await createAccount();
  const edge = await publishProject(
    account,
    projectDocument({
      key: 'edge-detector',
      name: 'Edge Object Detector',
      type: 'application',
      categories: ['object-detection'],
      runtimes: WITH_RUNTIMES,
      hardware: WITH_HARDWARE,
      models: WITH_MODELS,
      dataBoundary: '{inference: local_required, storage: local, runtime_network: none, external_services: []}',
    }),
  );
  const notes = await publishProject(
    account,
    projectDocument({
      key: 'hardware-notes',
      name: 'Quiet Workstation Notes',
      type: 'hardware_build',
      categories: ['hardware-setup'],
    }),
  );
  const other = await createAccount();
  const chat = await publishProject(
    other,
    projectDocument({
      key: 'chat-helper',
      name: 'Local Chat Helper',
      type: 'experiment',
      categories: ['chat-assistant'],
      runtimes: WITH_RUNTIMES,
    }),
  );
  for (const project of [edge, notes, chat]) await reindexProject(project.projectId);
  return { edge: edge.slug, notes: notes.slug, chat: chat.slug };
}

describe('search', () => {
  it('filters by type, category, runtime, hardware, model, and offline state', async () => {
    const slugs = await seedCatalog();

    const byType = await request('/api/v1/projects?type=hardware_build');
    expect(byType.json.data.items.map((item: { slug: string }) => item.slug)).toEqual([slugs.notes]);

    const byCategory = await request('/api/v1/projects?category=object-detection');
    expect(byCategory.json.data.items.map((item: { slug: string }) => item.slug)).toEqual([slugs.edge]);

    const byRuntime = await request('/api/v1/projects?runtime=ollama');
    const runtimeSlugs = byRuntime.json.data.items.map((item: { slug: string }) => item.slug);
    expect(runtimeSlugs).toContain(slugs.edge);
    expect(runtimeSlugs).toContain(slugs.chat);
    expect(runtimeSlugs).not.toContain(slugs.notes);

    const byHardware = await request('/api/v1/projects?hardware=nvidia-jetson-orin-nano');
    expect(byHardware.json.data.items.map((item: { slug: string }) => item.slug)).toEqual([slugs.edge]);

    const byModel = await request('/api/v1/projects?model=llama3.2:3b');
    expect(byModel.json.data.items.map((item: { slug: string }) => item.slug)).toEqual([slugs.edge]);

    const offline = await request('/api/v1/projects?offline=yes');
    expect(offline.json.data.items.map((item: { slug: string }) => item.slug)).toEqual([slugs.edge]);
  });

  it('combines fields with AND and values within a field with OR', async () => {
    const slugs = await seedCatalog();
    const both = await request('/api/v1/projects?category=object-detection&category=chat-assistant');
    const slugList = both.json.data.items.map((item: { slug: string }) => item.slug).sort();
    expect(slugList).toEqual([slugs.chat, slugs.edge].sort());

    const conflicting = await request('/api/v1/projects?category=object-detection&type=hardware_build');
    expect(conflicting.json.data.items).toHaveLength(0);
  });

  it('returns nothing for evidence levels that Phase 1 cannot reach', async () => {
    await seedCatalog();
    const reproducible = await request('/api/v1/projects?evidence_level=reproducible_test');
    expect(reproducible.status).toBe(200);
    expect(reproducible.json.data.items).toHaveLength(0);

    const claimed = await request('/api/v1/projects?evidence_level=claimed');
    expect(claimed.json.data.items.length).toBeGreaterThan(0);
  });

  it('ranks text matches and paginates with a filter-bound cursor', async () => {
    await seedCatalog();
    const first = await request('/api/v1/projects?q=local&limit=1');
    expect(first.json.data.items).toHaveLength(1);
    expect(first.json.meta.sort).toBe('relevance');

    if (first.json.data.has_more) {
      const second = await request(
        `/api/v1/projects?q=local&limit=1&cursor=${encodeURIComponent(first.json.data.next_cursor)}`,
      );
      expect(second.status).toBe(200);
      expect(second.json.data.items[0]?.slug).not.toBe(first.json.data.items[0]?.slug);

      // The same cursor against different filters is rejected, not reinterpreted.
      const mismatched = await request(
        `/api/v1/projects?q=different&limit=1&cursor=${encodeURIComponent(first.json.data.next_cursor)}`,
      );
      expect(mismatched.status).toBe(400);
    }
  });

  it('paginates the unfiltered listing', async () => {
    await seedCatalog();
    const first = await request('/api/v1/projects?limit=2');
    expect(first.json.data.items).toHaveLength(2);
    expect(first.json.data.has_more).toBe(true);
    const second = await request(
      `/api/v1/projects?limit=2&cursor=${encodeURIComponent(first.json.data.next_cursor)}`,
    );
    const firstSlugs = first.json.data.items.map((item: { slug: string }) => item.slug);
    const secondSlugs = second.json.data.items.map((item: { slug: string }) => item.slug);
    expect(secondSlugs.some((slug: string) => firstSlugs.includes(slug))).toBe(false);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await request('/api/v1/projects?limit=0')).status).toBe(400);
    expect((await request('/api/v1/projects?limit=500')).status).toBe(400);
    expect((await request('/api/v1/projects?limit=abc')).status).toBe(400);
  });

  it('keeps unpublished projects out of the projection', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'hidden-later' }));
    await reindexProject(published.projectId);
    expect(
      (await request('/api/v1/projects')).json.data.items.some(
        (item: { slug: string }) => item.slug === published.slug,
      ),
    ).toBe(true);

    await request(`/api/v1/projects/${published.projectId}/unpublish`, {
      method: 'POST',
      user: account.userId,
    });
    const after = await request('/api/v1/projects');
    expect(
      after.json.data.items.some((item: { slug: string }) => item.slug === published.slug),
    ).toBe(false);
  });

  it('reports facets with this deployment’s honest phase support', async () => {
    const facets = await request('/api/v1/catalog/facets');
    expect(facets.json.data.phase_support).toMatchObject({
      phase: 'P2',
      test_definitions: true,
      test_results: true,
      comparisons: true,
      derivatives: true,
      local_runner_distribution: 'unpublished',
      // Independent qualification has a separate operator-reviewed reproduction workflow.
      evidence_levels_reachable: ['claimed', 'documented', 'community_reported', 'reproducible_test', 'independently_verified'],
    });
    expect(facets.json.data.category).toContain('object-detection');
  });

  it('lists reference pillars derived from published records', async () => {
    await seedCatalog();
    const models = await request('/api/v1/models');
    expect(models.json.data.items.some((item: { key: string }) => item.key === 'llama3-2-3b')).toBe(true);

    const runtimes = await request('/api/v1/runtimes');
    const ollama = runtimes.json.data.items.find((item: { family: string }) => item.family === 'ollama');
    expect(ollama).toMatchObject({ support_status: 'declared_only', adapter_available: false });
    expect(ollama.project_count).toBeGreaterThan(0);

    const hardware = await request('/api/v1/hardware');
    expect(
      hardware.json.data.items.some((item: { key: string }) => item.key === 'nvidia-jetson-orin-nano'),
    ).toBe(true);
  });

  it('lists and counts model and hardware references only through visible current projects', async () => {
    const author = await createAccount();
    const declares = (key: string, model: string, device: string) => projectDocument({
      key,
      models: `{state: declared, roles: [{key: chat, required_capabilities: [chat], substitution: allowed_for_task_test, preferred: "${model}"}]}`,
      hardware: `{state: declared, architectures: [arm64], minimum_memory_bytes: null, accelerator: optional, devices: ["${device}"]}`,
    });
    const shared = await publishProject(author, declares('catalog-shared-a', 'catalog-shared:1b', 'Catalog Shared Board'));
    await publishProject(author, declares('catalog-shared-b', 'catalog-shared:1b', 'Catalog Shared Board'));
    const hidden = await publishProject(author, declares('catalog-hidden', 'catalog-hidden:1b', 'Catalog Hidden Board'));
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, hidden.projectId));
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, shared.projectId));

    const models = (await request('/api/v1/models')).json.data.items as Array<{ key: string; project_count: number }>;
    const hardware = (await request('/api/v1/hardware')).json.data.items as Array<{ key: string; project_count: number }>;
    expect(models.find((item) => item.key === 'catalog-shared-1b')?.project_count).toBe(1);
    expect(hardware.find((item) => item.key === 'catalog-shared-board')?.project_count).toBe(1);
    expect(models.some((item) => item.key === 'catalog-hidden-1b')).toBe(false);
    expect(hardware.some((item) => item.key === 'catalog-hidden-board')).toBe(false);
  });

  it('counts runtimes and published versions only through visible projects', async () => {
    const runtimeCount = async () => ((await request('/api/v1/runtimes')).json.data.items as Array<{ family: string; project_count: number }>)
      .find((item) => item.family === 'ollama')?.project_count ?? 0;
    const counts = async () => (await request('/api/v1/catalog/facets')).json.data.counts as { published_projects: number; published_versions: number };
    const author = await createAccount();
    const visible = await publishProject(author, projectDocument({ key: 'counts-visible', runtimes: WITH_RUNTIMES }));
    const hidden = await publishProject(author, projectDocument({ key: 'counts-hidden', runtimes: WITH_RUNTIMES }));
    const before = { runtime: await runtimeCount(), ...(await counts()) };

    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, hidden.projectId));
    expect(await runtimeCount()).toBe(before.runtime - 1);
    expect(await counts()).toMatchObject({ published_projects: before.published_projects - 1, published_versions: before.published_versions - 1 });

    // A family whose only declaring project is hidden stays listed, with no count.
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, visible.projectId));
    const ollama = ((await request('/api/v1/runtimes')).json.data.items as Array<{ family: string; project_count: number }>).find((item) => item.family === 'ollama');
    expect(ollama?.project_count).toBe(before.runtime - 2);
  });

  it('normalizes a supplied hardware summary without persisting it', async () => {
    const response = await request('/api/v1/hardware-profiles/validate', {
      method: 'POST',
      body: { cpu_architecture: 'arm64', memory_bytes: 17179869184, unified_memory: true },
    });
    expect(response.status).toBe(200);
    expect(response.json.data.normalized.cpu_architecture).toBe('arm64');
    expect(response.json.data.unknown_fields).toContain('vram_bytes');
    expect(response.json.data.notes.join(' ')).toMatch(/never counted twice/);
  });

  it('rejects an unknown hardware field rather than ignoring it', async () => {
    const response = await request('/api/v1/hardware-profiles/validate', {
      method: 'POST',
      body: { hostname: 'my-laptop', serial_number: 'ABC123' },
    });
    expect(response.status).toBe(400);
  });
});
