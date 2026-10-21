import { afterEach, describe, expect, it, vi } from 'vitest';
import sitemap from './sitemap';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sitemap', () => {
  it('lists public documentation without exposing a project directory or reading the registry', () => {
    vi.stubEnv('LOCALFIRST_SITE_URL', 'https://localfirst.sh');
    // An unavailable registry must not affect documentation discovery.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain('https://localfirst.sh');
    for (const path of ['/privacy', '/docs', '/docs/connect', '/docs/project-spec', '/docs/testing', '/docs/environments/create', '/docs/environments/setup']) {
      expect(urls).toContain(`https://localfirst.sh${path}`);
    }
    expect(urls).not.toContain('https://localfirst.sh/docs/toolkit');
    expect(urls.some((url) => /\/(projects|models|hardware|builds)(\/|$)/.test(new URL(url).pathname))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the deployment origin on each request, including on catalog preview deployments', () => {
    vi.stubEnv('LOCALFIRST_CATALOG_PREVIEW', 'true');
    vi.stubEnv('LOCALFIRST_SITE_URL', 'https://first.example');
    expect(sitemap()[0]?.url).toBe('https://first.example');
    vi.stubEnv('LOCALFIRST_SITE_URL', 'https://second.example');
    const urls = sitemap().map((entry) => entry.url);
    expect(urls.every((url) => url.startsWith('https://second.example'))).toBe(true);
    expect(urls).not.toContain('https://second.example/projects');
  });
});
