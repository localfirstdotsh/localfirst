import { expect, test } from '@playwright/test';
import { OWNER_ID, OWNER_SLUG, STRANGER_ID, horizontalOverflow } from './helpers';

/**
 * The root website's session-aware account pages. The browser, not a test double, enforces their CSP,
 * so these also prove the SVG charts and styles are accepted under it.
 */
test.describe('owner usage screen', () => {
  test.use({ extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });

  test('lists the owner\'s projects and opens a usage page with two charts and a table', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await page.goto('/account/projects');
    await expect(page.getByRole('heading', { level: 1, name: 'My projects' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'My projects' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Local Request Labeler' })).toBeVisible();
    await expect(page.getByText('Specification exports', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Agent retrievals', { exact: true }).first()).toBeVisible();
    // A signed-in person sees their account control, not a Sign in button.
    await expect(page.locator('.account-menu-trigger')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: 'Requests per day' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
    const charts = page.locator('svg.chart');
    await expect(charts).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
      await expect(charts.nth(i)).toHaveAttribute('role', 'img');
      await expect(charts.nth(i).locator('title')).toContainText('per day');
      expect(await charts.nth(i).locator('rect.bar').count()).toBeGreaterThan(5);
    }
    // The bars were actually painted with the design colours, so the stylesheet was not blocked.
    const fill = await charts.nth(0).locator('rect.bar').first().evaluate((el) => getComputedStyle(el).fill);
    expect(fill).not.toBe('rgb(0, 0, 0)');
    // The same numbers are in a table.
    expect(await page.locator('table.data tbody tr').count()).toBeGreaterThan(5);
    await page.getByText('About these numbers', { exact: true }).click();
    await expect(page.getByText(/Two separate charts, so no meaning depends on colour/)).toBeVisible();
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('switches between 30 and 90 days with plain links', async ({ page }) => {
    await page.goto('/account/projects');
    await page.getByRole('link', { name: 'Requests per day' }).first().click();
    await expect(page.locator('svg.chart desc').first()).toContainText('over 30 days');
    await page.getByRole('link', { name: '90 days' }).click();
    await expect(page).toHaveURL(/days=90$/);
    await expect(page.locator('svg.chart desc').first()).toContainText('over 90 days');
    await expect(page.getByRole('link', { name: '90 days' })).toHaveAttribute('aria-current', 'page');
  });

  test('stays inside the viewport and keeps the navigation tabs whole', async ({ page }) => {
    await page.goto('/account/projects');
    await page.getByRole('link', { name: 'Requests per day' }).first().click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    // No tab label is broken across lines (they wrap as whole items).
    const heights = await page.locator('.account-nav a').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeLessThan(80);
  });

  test('links to the public explanation of how counting works', async ({ page }) => {
    await page.goto('/account/projects');
    await page.getByText('About these counts', { exact: true }).click();
    await page.getByRole('link', { name: 'How counting works' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    await expect(page.getByText(/Nothing identifies who made the requests/)).toBeVisible();
  });
});

test.describe('owner usage screen: access', () => {
  test.describe('a different signed-in person', () => {
    test.use({ extraHTTPHeaders: { 'x-dev-user': STRANGER_ID } });

    test('sees none of the owner\'s projects and gets a plain not-found for the usage page', async ({ page, browser }) => {
      await page.goto('/account/projects');
      await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
      await expect(page.getByText('Local Request Labeler')).toHaveCount(0);

      // Find the real project id as the owner, then try it as the stranger.
      const ownerContext = await browser.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto('/account/projects');
      const href = (await ownerPage.getByRole('link', { name: 'Requests per day' }).first().getAttribute('href'))!;
      await ownerContext.close();

      const response = await page.goto(href);
      expect(response?.status()).toBe(404);
      await expect(page.locator('svg.chart')).toHaveCount(0);
      await expect(page.getByText(OWNER_SLUG)).toHaveCount(0);
    });
  });

  test.describe('no session', () => {
    test.use({ extraHTTPHeaders: {} });

    test('is asked to sign in', async ({ page }) => {
      const response = await page.goto('/account/projects');
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      await expect(page.getByRole('heading', { name: 'Sign in to Localfirst' })).toBeVisible();
      await expect(page.locator('svg.chart')).toHaveCount(0);
    });
  });
});

test.describe('privacy page', () => {
  test('is public and reachable from the website footer', async ({ page }) => {
    await page.goto('/docs');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    await expect(page.getByText(/not a number of people, installs, builds, or runs/)).toBeVisible();
  });
});
