import { expect, test } from '@playwright/test';
import c from './constants.json' with { type: 'json' };

/**
 * Per-visitor rate limits (BACKEND_PRD section 19.2). The website's own requests all reach the
 * API from one address, so without forwarding the visitor's address every visitor would share one
 * anonymous allowance. This runs against a separate API with a low limit (10 a minute) that trusts
 * the website's hop, and a website instance that forwards the address in `x-e2e-visitor-ip`.
 */
const SITE = `http://127.0.0.1:${c.webForwardingPort}`;
const LIMIT = c.limitedCatalogPerMinute;
const BLOCKED = /This search was not accepted|The shared rate limit|Projects could not be loaded/;

// Visitor addresses unique to this run: the limiter groups IPv4 by /24, so each gets its own /24.
const run = Math.floor(Math.random() * 200) + 20;
const visitor = (n: number) => `${run}.${n % 250}.7.9`;

test.describe('rate limits are per visitor', () => {
  test.skip(({ isMobile }) => isMobile, 'server-side behaviour; one viewport is enough');

  async function blocked(request: import('@playwright/test').APIRequestContext, headers: Record<string, string>) {
    // A matching query performs one registry read, without an empty-registry probe. Discovery
    // reads are fresh, so repeating the query must still consume the visitor's allowance.
    const response = await request.get(`${SITE}/projects?q=local`, { headers });
    return BLOCKED.test(await response.text());
  }

  test('many different visitors are all served, not capped by one shared allowance', async ({ request }) => {
    const results: boolean[] = [];
    for (let i = 1; i <= LIMIT * 3; i += 1) {
      results.push(await blocked(request, { 'x-e2e-visitor-ip': visitor(i) }));
    }
    expect(results.filter(Boolean)).toHaveLength(0);
  });

  test('one visitor is limited after their own allowance, and others are unaffected', async ({ request }) => {
    const me = `${run}.251.7.9`;
    const results: boolean[] = [];
    for (let i = 1; i <= LIMIT + 5; i += 1) results.push(await blocked(request, { 'x-e2e-visitor-ip': me }));
    expect(results.slice(0, LIMIT).every((b) => !b)).toBe(true);
    expect(results.slice(LIMIT).every(Boolean)).toBe(true);
    // A different visitor, in the same minute, is not affected.
    expect(await blocked(request, { 'x-e2e-visitor-ip': `${run}.252.7.9` })).toBe(false);
  });

  test('a visitor cannot choose their own bucket by sending forwarding headers', async ({ request }) => {
    const me = `${run}.253.7.9`;
    const results: boolean[] = [];
    for (let i = 1; i <= LIMIT + 5; i += 1) {
      results.push(
        await blocked(request, {
          'x-e2e-visitor-ip': me,
          // Rotated on every request, as an abuser would. The site must ignore all of these.
          'x-forwarded-for': `${run + 1}.${i}.0.1`,
          'x-real-ip': `${run + 2}.${i}.0.1`,
          forwarded: `for=${run + 3}.${i}.0.1`,
        }),
      );
    }
    expect(results.slice(LIMIT).every(Boolean)).toBe(true);
  });

  test.describe('links', () => {
    // A context-level header, so the page's own server-side calls count against this visitor and
    // not against the address every other request from this machine shares.
    test.use({ extraHTTPHeaders: { 'x-e2e-visitor-ip': `${run}.254.7.9` } });

    test('browser-facing links use the public API address, not the private one the server calls', async ({ page }) => {
      await page.goto(`${SITE}/projects/${c.ownerProjectSlug}`);
      await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
      await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
      await expect(page.getByRole('link', { name: 'Export PROJECT.md' })).toHaveAttribute('href', new RegExp(`^${c.publicApiOrigin}/api/v1/projects/`));
    });
  });
});
