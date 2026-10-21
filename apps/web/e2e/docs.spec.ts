import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const guides = [
  ['/docs/connect', 'Connect your agent'],
  ['/docs/project-spec', 'Project specification'],
  ['/docs/testing', 'Testing guide'],
  ['/docs/environments/create', 'Create an environment'],
  ['/docs/environments/setup', 'Set up for your business'],
] as const;

test('Docs opens the hub and all guides share working navigation', async ({ page }, info) => {
  await page.goto('/docs/connect');
  if (process.env.LOCALFIRST_SCREENSHOT_DIR) {
    await page.getByRole('tabpanel', { name: 'Claude Code', exact: true }).waitFor();
    await page.screenshot({ path: `${process.env.LOCALFIRST_SCREENSHOT_DIR}/docs-connect-${info.project.name}.png` });
  }
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Documentation');
  for (const [path, title] of guides) {
    await page.locator('.docs-content').getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.locator('.site-header a[href="/docs"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.docs-nav').getByRole('link', { name: title, exact: true, includeHidden: true })).toHaveAttribute('aria-current', 'page');
    const guides = page.getByRole('button', { name: /^Browse guides/ });
    if (await guides.isVisible()) await guides.click();
    await page.getByRole('navigation', { name: 'Documentation', exact: true }).getByRole('link', { name: 'Overview', exact: true }).click();
  }
});

test('unavailable toolkit promotion is omitted and its route remains unavailable', async ({ page, request }) => {
  await page.goto('/docs');
  await expect(page.getByRole('heading', { name: 'Agent toolkit' })).toHaveCount(0);
  await expect(page.locator('a[href="/docs/toolkit"]')).toHaveCount(0);
  expect((await request.get('/docs/toolkit')).status()).toBe(404);
});

test('the complete starter can be inspected without overflowing the page', async ({ page }) => {
  await page.goto('/docs/environments/create');
  await page.locator('summary').filter({ hasText: 'PROJECT.md' }).click();
  await expect(page.locator('details[open] pre')).toContainText('localfirst/project/v0.3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('AI instructions copy only after the clipboard accepts them', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/environments/setup');
  await page.getByRole('button', { name: 'Copy instructions for my AI' }).click();
  await expect(page.getByRole('status')).toContainText('Copied. Paste into your chosen client.');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('exact version [version-id]');
  expect(text).toContain('never approve on my behalf');
});

test('unavailable clipboard selects the AI instructions for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Denied'); } } });
  });
  await page.goto('/docs/environments/create');
  await page.getByRole('button', { name: 'Copy instructions for my AI' }).click();
  await expect(page.getByRole('status')).toHaveText('Select and copy the text manually.');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Help me author a Localfirst environment');
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`docs are accessible and fit the viewport (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    for (const path of ['/docs', ...guides.map(([path]) => path)]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), path).toEqual([]);
    }
  });
}
