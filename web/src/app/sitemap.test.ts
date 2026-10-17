import { afterEach, describe, expect, it, vi } from 'vitest';
import sitemap from './sitemap';

const meta = { request_id: 'req_test' };
const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const project = (slug: string) => ({
  project_id: `id-${slug}`,
  slug,
  name: slug,
  summary: 's',
  type: 'experiment',
  categories: [],
  spec_version: '0.1.0',
  license: { state: 'unknown', id: null },
  test_support: { declared_kind: 'none', runner_available: false },
  evidence_level: 'claimed',
  listing_origin: 'creator_submitted',
  sources_pinned: false,
  offline_declared: 'unknown',
  runtime_families: [],
  architectures: [],
  operating_systems: [],
  required_capabilities: [],
  updated_at: '2026-10-15T00:00:00.000Z',
  url: 'u',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sitemap', () => {
  it('lists the static pages and every visible project across pages, with absolute URLs', async () => {
    vi.stubEnv('LOCALFIRST_SITE_URL', 'https://localfirst.sh');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { data: { items: [project('alpha')], has_more: true, next_cursor: 'c1' }, meta }))
      .mockResolvedValueOnce(respond(200, { data: { items: [project('beta gamma')], has_more: false, next_cursor: null }, meta }));
    vi.stubGlobal('fetch', fetchMock);

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls).toContain('https://localfirst.sh');
    expect(urls).toContain('https://localfirst.sh/models');
    for (const path of ['/docs', '/docs/connect', '/docs/project-spec', '/docs/testing', '/docs/environments/create', '/docs/environments/setup']) {
      expect(urls).toContain(`https://localfirst.sh${path}`);
    }
    expect(urls).not.toContain('https://localfirst.sh/docs/toolkit');
    expect(urls).toContain('https://localfirst.sh/projects/alpha');
    expect(urls).toContain('https://localfirst.sh/projects/beta%20gamma');
    expect(urls.some((url) => url.includes('/versions/'))).toBe(false);
    // The second request carried the cursor from the first, and used the larger page size.
    const second = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(second.searchParams.get('cursor')).toBe('c1');
    expect(second.searchParams.get('limit')).toBe('100');
  });

  it('still lists the static pages when the registry is unreachable', async () => {
    vi.stubEnv('LOCALFIRST_SITE_URL', 'https://localfirst.sh');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain('https://localfirst.sh/projects');
    expect(urls).toContain('https://localfirst.sh/docs');
    expect(urls).toContain('https://localfirst.sh/docs/environments/create');
    expect(urls.some((url) => url.includes('/projects/'))).toBe(false);
  });
});
