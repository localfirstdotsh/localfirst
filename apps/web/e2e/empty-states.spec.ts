import { expect, test } from '@playwright/test';
import { horizontalOverflow } from './helpers';

test('an empty category is centered in the results area with the footer at the viewport bottom', async ({ page }, testInfo) => {
  await page.goto('/projects?type=demo');
  const state = page.locator('.empty-state');
  await expect(state.getByRole('heading', { name: 'No demos yet' })).toBeVisible();
  await expect(state).toContainText("There aren't any projects in this category yet.");
  await expect(state.getByRole('link', { name: 'Clear filters' })).toHaveCount(0);

  const content = (await page.locator('.discovery-results').boundingBox())!;
  const box = (await state.boundingBox())!;
  const footer = (await page.locator('footer').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - (content.y + content.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(footer.y + footer.height - viewport.height)).toBeLessThanOrEqual(1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height + 1);
  await page.screenshot({ path: testInfo.outputPath(`empty-category-${testInfo.project.name}.png`), fullPage: true });

  await state.getByRole('link', { name: 'Explore all projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator('.result-title').first()).toBeVisible();
});

test('combined search and filters clear in steps and update the actual results', async ({ page }) => {
  await page.goto('/projects?q=zzzzqqqq&type=experiment&runtime=ollama&sort=updated_at');
  const state = page.locator('.empty-state');
  await expect(state.getByRole('heading', { name: 'No results for "zzzzqqqq"' })).toBeVisible();
  await state.getByRole('link', { name: 'Clear search' }).click();
  await expect(page).toHaveURL(/\/projects\?type=experiment&runtime=ollama&sort=updated_at$/);
  await expect(page.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('');
  await expect(page.locator('.result-title').first()).toBeVisible();

  await page.goto('/projects?type=demo&runtime=ollama&sort=updated_at');
  await expect(state.getByRole('heading', { name: 'No matching projects' })).toBeVisible();
  await state.getByRole('link', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/projects\?sort=updated_at$/);
  await expect(page.locator('.result-title').first()).toBeVisible();
});

test('the footer shares the header container on short and long page types', async ({ page }) => {
  for (const path of ['/projects?type=demo', '/projects', '/privacy', '/docs']) {
    await page.goto(path);
    if (path.startsWith('/projects')) await expect(page.locator('.results-skeleton')).toHaveCount(0);
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText(`© ${new Date().getFullYear()} Localfirst.sh`);
    await expect(footer.getByRole('navigation', { name: 'Footer' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/localfirstdotsh/localfirst');
    await expect(footer).not.toContainText('request counts');
    const headerBox = (await page.locator('.site-header .container').boundingBox())!;
    const footerBox = (await footer.locator('.container').boundingBox())!;
    const mainBox = (await page.locator('main').boundingBox())!;
    const footerOuter = (await footer.boundingBox())!;
    expect(footerBox.x).toBe(headerBox.x);
    expect(footerBox.width).toBe(headerBox.width);
    expect(footerOuter.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
    expect(footerOuter.y + footerOuter.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(footerOuter.y + footerOuter.height + 1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
});

test('empty results and footer wrap cleanly on tablet and narrow mobile screens', async ({ page }) => {
  for (const width of [768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/projects?type=demo');
    await expect(page.getByRole('heading', { name: 'No demos yet' })).toBeVisible();
    const footer = (await page.getByRole('contentinfo').boundingBox())!;
    expect(Math.abs(footer.y + footer.height - 900)).toBeLessThanOrEqual(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const label of ['Docs', 'GitHub', 'Privacy']) {
      await expect(page.getByRole('contentinfo').getByRole('link', { name: label })).toBeInViewport();
    }
  }
});
