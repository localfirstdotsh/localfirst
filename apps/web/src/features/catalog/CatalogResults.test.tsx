import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiContractError, ApiRequestError, ApiUnavailableError, listProjects } from '../../lib/api';
import { emptyQuery, parseCatalogQuery, type RawSearchParams } from '../../lib/catalog-query';
import type { ProjectPage } from '../../lib/schemas';
import { CatalogResults } from './CatalogResults';
import { ResultsSkeleton } from './ResultsSkeleton';

vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), listProjects: vi.fn() }));

const empty: ProjectPage = { items: [], has_more: false, next_cursor: null };
const populated: ProjectPage = { ...empty, items: [{
  project_id: 'p1', slug: 'edge-rig', name: 'Edge Rig', summary: 'A rig.', type: 'hardware_build',
  categories: [], spec_version: '0.1.0', license: { state: 'unknown', id: null },
  test_support: { declared_kind: 'manual', runner_available: false }, evidence_level: 'documented',
  listing_origin: 'creator_submitted', sources_pinned: false, offline_declared: 'unknown',
  runtime_families: [], architectures: [], operating_systems: [], required_capabilities: [],
  updated_at: '2026-10-15T00:00:00.000Z', url: 'http://localhost:8787/api/v1/projects/p1',
}] };
const list = vi.mocked(listProjects);
const render = async (raw: RawSearchParams = {}) => renderToStaticMarkup(await CatalogResults({ query: parseCatalogQuery(raw).query }));

beforeEach(() => { list.mockReset(); });

describe('catalog result states', () => {
  it.each([{}, { type: 'demo' }, { q: 'missing', runtime: 'ollama' }, { sort: 'updated_at' }])(
    'shows a truly empty registry without an irrelevant action for %j', async (raw) => {
      list.mockResolvedValue(empty);
      const out = await render(raw);
      expect(out).toContain('No projects yet');
      expect(out).toContain('Projects will appear here once');
      expect(out).not.toContain('Clear filters');
      expect(out).not.toContain('Clear search');
      expect(out).not.toContain('Explore all projects');
    },
  );

  it.each([['demo', 'demos'], ['hardware_build', 'hardware'], ['workflow', 'workflows']])(
    'uses the selected category label for %s', async (type, label) => {
      list.mockResolvedValueOnce(empty).mockResolvedValueOnce(populated);
      const out = await render({ type });
      expect(out).toContain(`No ${label} yet`);
      expect(out).toContain('There aren&#x27;t any projects in this category yet.');
      expect(out).toContain('Explore all projects');
      expect(list).toHaveBeenLastCalledWith(emptyQuery(), 1);
    },
  );

  it('prioritizes search over combined filters and clears only search and the cursor', async () => {
    list.mockResolvedValueOnce(empty).mockResolvedValueOnce(populated);
    const out = await render({ q: '<missing>', type: 'demo', runtime: 'ollama', sort: 'updated_at', cursor: 'old' });
    expect(out).toContain('No results for &quot;&lt;missing&gt;&quot;');
    expect(out).toContain('href="/projects?type=demo&amp;runtime=ollama&amp;sort=updated_at"');
    expect(out).toContain('Clear search');
    expect(out).not.toContain('Clear filters');
    expect(out).not.toContain('cursor=');
  });

  it.each([{ runtime: 'ollama' }, { type: 'demo', os: 'windows' }, { type: ['demo', 'workflow'] }])(
    'offers working filter removal for %j', async (raw) => {
      list.mockResolvedValueOnce(empty).mockResolvedValueOnce(populated);
      const out = await render({ ...raw, sort: 'updated_at', cursor: 'old' });
      expect(out).toContain('No matching projects');
      expect(out).toContain('href="/projects?sort=updated_at"');
      expect(out).toContain('Clear filters');
    },
  );

  it('does not call an exhausted cursor an empty registry', async () => {
    list.mockResolvedValueOnce(empty).mockResolvedValueOnce(populated);
    expect(await render({ cursor: 'old' })).toContain('No more projects');
  });

  it.each([
    new ApiUnavailableError('Offline', 'req-offline'),
    new ApiContractError('Invalid response'),
    new ApiRequestError('Slow down', 429, 'RATE_LIMITED', 'req-limited'),
    new Error('Network failure'),
  ])('keeps failures separate from empty responses, with a retry for the same query: %s', async (error) => {
    list.mockRejectedValue(error);
    const out = await render({ q: 'missing', type: 'demo' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Try again');
    expect(out).toContain('href="/projects?q=missing&amp;type=demo"');
    expect(out).not.toContain('No projects yet');
    expect(out).not.toContain('Clear filters');
    if (error instanceof ApiUnavailableError || error instanceof ApiRequestError) expect(out).toContain(error.requestId!);
  });

  it('shows a retry if checking registry availability fails', async () => {
    list.mockResolvedValueOnce(empty).mockRejectedValueOnce(new ApiUnavailableError('Offline'));
    const out = await render({ type: 'demo' });
    expect(out).toContain('The registry is unavailable');
    expect(out).not.toContain('No demos yet');
  });

  it('renders populated results without an extra availability request or empty state', async () => {
    list.mockResolvedValue(populated);
    const out = await render({ q: 'rig' });
    expect(out).toContain('Edge Rig');
    expect(out).toContain('result-list');
    expect(out).not.toContain('empty-state');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('identifies loading separately from an empty response', () => {
    const out = renderToStaticMarkup(<ResultsSkeleton />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Loading projects');
    expect(out).not.toContain('No projects');
  });
});
