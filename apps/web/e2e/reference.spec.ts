import { expect, test } from '@playwright/test';
import { horizontalOverflow } from './helpers';

test.describe('models and hardware', () => {
  test('models explains an empty registry instead of inventing rows', async ({ page }) => {
    await page.goto('/models');
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    await expect(page.getByText('Explore the AI models powering local projects.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No models yet' })).toBeVisible();
    await expect(page.locator('.row-title')).toHaveCount(0);
  });

  test('hardware lists devices with units, unknowns, and counts that link into the catalog', async ({ page }) => {
    await page.goto('/hardware');
    const rows = page.locator('.row-list > li');
    expect(await rows.count()).toBeGreaterThan(1);
    await expect(page.getByText('Discover the devices and hardware used to run local AI.')).toBeVisible();
    await page.getByText('About this hardware information', { exact: true }).click();
    await expect(page.getByText(/declared by project authors, not measured/)).toBeVisible();
    // Missing memory is stated, never shown as zero.
    await expect(page.getByText('Memory not supplied').first()).toBeVisible();
    await expect(page.getByText(/\b0 GiB\b/)).toHaveCount(0);

    const first = rows.first();
    const title = (await first.locator('.row-title').textContent())!.trim();
    await first.getByRole('link', { name: /\d+ projects?/ }).click();
    await expect(page).toHaveURL(/\/projects\?hardware=[a-z0-9-]+$/);
    await expect(page.locator('.result-title').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^Remove filter Hardware:/ })).toBeVisible();
    expect(title.length).toBeGreaterThan(0);
  });

  test('both pages fit the viewport', async ({ page }) => {
    for (const path of ['/models', '/hardware']) {
      await page.goto(path);
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
  });
});
