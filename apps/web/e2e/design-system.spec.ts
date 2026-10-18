import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WEB_UNRELEASED, horizontalOverflow } from './helpers';

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`component reference (${colorScheme})`, () => {
    test.use({ colorScheme });
    test('uses accessible production controls and fits the viewport', async ({ page }) => {
      await page.goto('/design-system');
      await expect(page.getByRole('heading', { name: 'Design system', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Checking…' })).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByLabel('Memory (GiB)')).toHaveAccessibleDescription('Enter a positive number, or leave it blank.');
      await page.getByLabel('Runtime', { exact: true }).selectOption('ollama');
      await expect(page.getByLabel('Runtime', { exact: true })).toHaveValue('ollama');
      const alternate = page.getByRole('button', { name: 'Alternate command', exact: true });
      await alternate.focus();
      await expect(alternate).toBeFocused();
      await page.keyboard.press('Space');
      await expect(alternate).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.command-line code')).toHaveText('example --version');
      await page.locator('summary').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('details').first()).toHaveAttribute('open', '');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      expect(scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    });
  });
}

test('gallery is unindexed and stays unavailable on deployments without the flag', async ({ page, request }) => {
  await page.goto('/design-system');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  expect((await request.get(`${WEB_UNRELEASED}/design-system`)).status()).toBe(404);
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain('/design-system');
});
