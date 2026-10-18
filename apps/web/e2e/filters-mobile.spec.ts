import { expect, test } from '@playwright/test';
import { filterBox, horizontalOverflow, openFilters } from './helpers';

test.describe('filters on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone behaviour');

  test('open as a bottom sheet with Apply visible, and the page behind does not scroll', async ({ page }) => {
    await page.goto('/projects');
    const dialog = await openFilters(page, 'Runtime');
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    await expect(page.getByRole('button', { name: 'Apply filters' })).toBeInViewport();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  });

  test('opens, applies once, and the count follows', async ({ page }) => {
    await page.goto('/projects');
    await openFilters(page, 'Runtime');
    await filterBox(page, 'Ollama').check();
    await openFilters(page, 'Evidence');
    await filterBox(page, 'Documented').check();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/runtime=ollama/);
    await expect(page).toHaveURL(/evidence_level=documented/);
    await expect(page.locator('.popover-trigger .count')).toHaveText('2');
  });

  test('tapping the backdrop closes the sheet', async ({ page }) => {
    await page.goto('/projects');
    await openFilters(page);
    await page.locator('.popover-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeHidden();
  });

  test('stay inside the viewport: no horizontal scroll with the sheet open', async ({ page }) => {
    await page.goto('/projects');
    await openFilters(page, 'Runtime');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('every control is a comfortable touch target', async ({ page }) => {
    await page.goto('/projects');
    await openFilters(page);
    const controls = [page.locator('.popover-trigger'), page.getByRole('button', { name: 'Apply filters' }), page.locator('.filter-group > summary').first()];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    }
  });
});
