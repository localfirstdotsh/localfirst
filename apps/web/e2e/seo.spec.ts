import { expect, test } from '@playwright/test';
import { OWNER_SLUG } from './helpers';

test.describe('discovery metadata', () => {
  test('sitemap lists static pages and visible projects with absolute URLs, but no exact versions', async ({ request, baseURL }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('xml');
    const locs = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.length).toBeGreaterThan(8);
    for (const loc of locs) expect(loc.startsWith(baseURL!)).toBe(true);
    expect(locs).toContain(`${baseURL}/projects/${OWNER_SLUG}`);
    expect(locs).toContain(`${baseURL}/models`);
    expect(locs.some((loc) => loc.includes('/versions/'))).toBe(false);
  });

  test('robots keeps private surfaces out and points at the sitemap', async ({ request, baseURL }) => {
    const text = await (await request.get('/robots.txt')).text();
    for (const path of ['/account', '/review', '/consent', '/sign-in']) expect(text).toContain(`Disallow: ${path}`);
    expect(text).toContain(`Sitemap: ${baseURL}/sitemap.xml`);
  });

  test('a project page is canonical to itself, and an exact version never points at the current one', async ({ page, baseURL }) => {
    await page.goto(`/projects/${OWNER_SLUG}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${baseURL}/projects/${OWNER_SLUG}`);

    await page.goto(`/projects/${OWNER_SLUG}/versions`);
    await page.getByRole('link', { name: 'v0.1.0' }).click();
    await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', page.url());
  });

  test('pages have distinct, descriptive titles', async ({ page }) => {
    const titles = new Set<string>();
    for (const path of ['/', '/projects', '/models', '/hardware', '/builds', '/docs/connect', `/projects/${OWNER_SLUG}`]) {
      await page.goto(path);
      const title = await page.title();
      expect(title.length, path).toBeGreaterThan(3);
      titles.add(title);
    }
    expect(titles.size).toBe(7);
  });

  test('security headers are present on pages', async ({ request }) => {
    const headers = (await request.get('/')).headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
