import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { OWNER_ID, OWNER_SLUG } from './helpers';

/**
 * Automated WCAG 2.2 AA checks (FRONTEND_PRD section 14.2) in a real browser, in both colour
 * schemes. This catches what static analysis cannot: computed colour contrast, accessible names,
 * landmark structure. It is not a substitute for a manual screen-reader pass.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(0, 2).join(' / ')}`),
  }));
  expect(summary, `${label}\n${JSON.stringify(summary, null, 2)}`).toEqual([]);
}

const PAGES: Array<[string, string]> = [
  ['home', '/'],
  ['projects', '/projects'],
  ['projects, filtered', '/projects?runtime=ollama&type=experiment'],
  ['projects, no match', '/projects?q=zzzzqqqq'],
  ['projects, ignored filters', '/projects?runtime=bogus&page=2'],
  ['project', `/projects/${OWNER_SLUG}`],
  ['versions', `/projects/${OWNER_SLUG}/versions`],
  ['models', '/models'],
  ['hardware', '/hardware'],
  ['builds', '/builds'],
  ['connect docs', '/docs/connect'],
  ['not found', '/projects/does-not-exist'],
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    for (const [name, path] of PAGES) {
      test(`${name}`, async ({ page }) => {
        await page.goto(path);
        await scan(page, `${name} (${scheme})`);
      });
    }

    test('exact version page', async ({ page }) => {
      await page.goto(`/projects/${OWNER_SLUG}/versions`);
      await page.getByRole('link', { name: 'v0.1.0' }).click();
      await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
      await scan(page, `historical version (${scheme})`);
    });

    test('the requirements result and its error state', async ({ page }) => {
      await page.goto(`/projects/${OWNER_SLUG}`);
      await page.getByRole('combobox', { name: 'CPU architecture', exact: true }).click();
    await page.getByRole('option', { name: 'arm64', exact: true }).click();
      await page.getByLabel('System memory (GiB)').fill('16');
      await page.getByRole('button', { name: 'Check' }).click();
      await expect(page.locator('#check-result')).toBeVisible();
      await scan(page, `requirements result (${scheme})`);
      await page.getByLabel('System memory (GiB)').fill('0');
      await page.getByRole('button', { name: 'Check' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'The check did not run' })).toBeVisible();
      await scan(page, `requirements error (${scheme})`);
    });

    test('the filters popover when opened', async ({ page }) => {
      await page.goto('/projects?runtime=ollama');
      await page.getByText('Filters', { exact: false }).first().click();
      await expect(page.getByRole('button', { name: 'Apply filters' })).toBeVisible();
      await scan(page, `open filters (${scheme})`);
    });

    test('projects with no results', async ({ page }) => {
      await page.goto('/projects?q=zzzzqqqq');
      await expect(page.getByRole('heading', { name: 'No results for "zzzzqqqq"' })).toBeVisible();
      await scan(page, `no results (${scheme})`);
    });

    test('the privacy page and the owner screens', async ({ page, browser }) => {
      await page.goto('/privacy');
      await scan(page, `privacy (${scheme})`);
      const owner = await browser.newContext({ colorScheme: scheme, extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });
      const ownerPage = await owner.newPage();
      await ownerPage.goto(`${new URL(page.url()).origin}/account/projects`);
      await scan(ownerPage, `my projects (${scheme})`);
      await ownerPage.getByRole('link', { name: 'See requests per day' }).click();
      await expect(ownerPage.locator('svg.chart')).toHaveCount(2);
      await scan(ownerPage, `usage (${scheme})`);
      await owner.close();
    });
  });
}
