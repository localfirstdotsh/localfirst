import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { API, WEB_UNRELEASED, horizontalOverflow } from './helpers';

const evidenceDir = process.env.LOCALFIRST_SCREENSHOT_DIR;

test('Shift alone keeps pointer-focused header links quiet; Tab and Shift+Tab remain visible', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard modality');
  await page.goto('/docs');
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const link = nav.getByRole('link', { name: 'Docs', exact: true });
  await link.click();
  await expect(link).toBeFocused();
  const outline = () => link.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(await outline()).toBe('none');
  await page.keyboard.press('Shift');
  await expect(link).toBeFocused();
  expect(await outline()).toBe('none');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(link).toBeFocused();
  expect(await outline()).toBe('solid');
  await page.getByRole('link', { name: 'localfirst.sh' }).click();
  await page.keyboard.press('Shift');
  await expect(page.getByRole('link', { name: 'localfirst.sh' })).toHaveCSS('outline-style', 'none');
  await expect(nav.locator('[aria-current]')).toHaveCount(0);
});

test('sort supports keyboard selection, Escape, and outside dismissal', async ({ page }) => {
  await page.goto('/projects?type=application');
  const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
  await sort.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Best match', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'Recent evidence', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(sort).toBeFocused();
  await sort.click();
  await page.getByRole('heading', { name: 'Projects', level: 1 }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await sort.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sort=updated_at/);
  await expect(sort).toContainText('Recently updated');
});

test('mobile navigation opens, follows real routes, and returns focus on Escape', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone disclosure');
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Menu', exact: true });
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeHidden();
  await expect(button).toHaveText('');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeHidden();
  await button.click();
  await expect(nav).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(nav).toBeHidden();
  await button.click();
  await nav.getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(nav).toBeHidden();
});

test('hero integrations are logo-only with tooltips and reach client-specific instructions', async ({ page, isMobile }) => {
  await page.goto('/');
  const row = page.locator('.landing .integration-row');
  await expect(row.locator('a')).toHaveCount(8);
  await expect(row.locator('a')).toHaveText(['', '', '', '', '', '', '', '']);
  for (const image of await row.locator('img').all()) expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const claude = row.getByRole('link', { name: 'Claude Code' });
  if (isMobile) await claude.focus();
  else await claude.hover();
  await expect(claude).toHaveAttribute('data-tip', 'Claude Code');
  await expect.poll(() => claude.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');
  await claude.click();
  await expect(page).toHaveURL(/\/docs\/connect#claude-code$/);
  await expect(page.locator('#claude-code')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose your client' })).toBeVisible();
});

test('component gallery is gated and uses the live reusable controls', async ({ page }) => {
  await page.goto('/design-system');
  await expect(page.getByRole('heading', { name: 'Design system', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Example select', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Example select' })).toBeVisible();
  const response = await page.goto(`${WEB_UNRELEASED}/design-system`);
  expect(response?.status()).toBe(404);
});

test('responsive layouts, real screenshots, and trusted font delivery', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Six explicit viewport widths');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 1280, 1024, 768, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, path] of [['home', '/'], ['projects', '/projects']] as const) {
      await page.goto(path === '/' ? `${WEB_UNRELEASED}/` : path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      expect(await horizontalOverflow(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      await page.evaluate(() => document.fonts.ready);
      if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-${name}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const homeAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(homeAxe.violations).toEqual([]);
  await page.goto('/projects?type=application');
  await page.getByRole('combobox', { name: 'Sort', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeInViewport();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations).toEqual([]);
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-sort-open.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Sort', exact: true }).focus();
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-focus.png`, fullPage: true });
  await page.goto('/projects?q=zzzzqqqq');
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-empty.png`, fullPage: true });
  await page.goto('/design-system');
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-gallery.png`, fullPage: true });
  await page.goto('/sign-in');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('15px Inter'))).toBe(true);
  const font = await page.locator('link[rel=preload][as=font]').first().getAttribute('href');
  expect(font).toMatch(/\.woff2$/);
  expect((await page.request.get(font!)).status()).toBe(200);
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-sign-in.png`, fullPage: true });
});
