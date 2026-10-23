import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { OWNER_ID, horizontalOverflow } from './helpers';

const PAGES = [['My projects', '/account/projects'], ['Connections', '/account/connections'], ['Approval devices', '/account/devices'], ['Danger zone', '/account/delete']] as const;
const WIDTHS = [1440, 1024, 768, 390];

test.describe('account area layout', () => {
  test.use({ extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });

  for (const width of WIDTHS) {
    test(`shares one frame and never overflows or overlaps at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      let navBox: { x: number; y: number; width: number } | null = null;
      for (const [label, path] of PAGES) {
        await page.goto(path);
        const nav = page.getByRole('navigation', { name: 'Account' });
        await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        const box = (await nav.boundingBox())!;
        // The navigation is in the same place on every account page.
        if (navBox) expect(box).toMatchObject({ x: navBox.x, y: navBox.y, width: navBox.width });
        navBox = box;
        // The floating header sits entirely above the navigation and the page content.
        const header = (await page.locator('.site-header').boundingBox())!;
        expect(header.y + header.height).toBeLessThanOrEqual(box.y);
        const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
        expect(header.y + header.height).toBeLessThanOrEqual(title.y);
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(scan.violations.map((v) => v.id), path).toEqual([]);
      }
    });
  }

  test('keeps the sidebar clear of the floating header while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.goto('/account/delete');
    await page.evaluate(() => window.scrollTo(0, 400));
    const header = (await page.locator('.site-header').boundingBox())!;
    const nav = (await page.getByRole('navigation', { name: 'Account' }).boundingBox())!;
    expect(nav.y).toBeGreaterThanOrEqual(header.y + header.height);
  });

  test('keeps the footer at the bottom of a short page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto('/account/connections');
    const footer = (await page.locator('.site-footer').boundingBox())!;
    expect(Math.round(footer.y + footer.height)).toBe(1400);
  });

  test('links a device only with a complete code and reports an unknown one', async ({ page }) => {
    await page.goto('/account/devices');
    await expect(page.getByRole('heading', { name: 'No linked devices' })).toBeVisible();
    await page.getByRole('button', { name: 'Link a device' }).first().click();
    await expect(page.getByText('localfirstdotsh auth approver-login')).toBeVisible();
    const check = page.getByRole('button', { name: 'Check code' });
    await expect(check).toBeDisabled();
    await page.getByLabel('Link code').fill('abcd-23');
    await expect(check).toBeDisabled();
    await page.getByLabel('Link code').fill('zzzz-9999');
    await expect(check).toBeEnabled();
    await check.click();
    await expect(page).toHaveURL(/code=zzzz-9999/i);
    await expect(page.getByRole('alert').filter({ hasText: 'unknown, already used, or expired' })).toBeVisible();
    await expect(page.getByLabel('Link code')).toHaveAttribute('aria-invalid', 'true');
  });
});
