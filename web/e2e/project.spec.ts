import { expect, test } from '@playwright/test';
import { OWNER_SLUG, horizontalOverflow } from './helpers';

const PROJECT = `/projects/${OWNER_SLUG}`;

test.describe('project and exact versions', () => {
  test('the project page names the current version and links to history and the spec', async ({ page }) => {
    await page.goto(PROJECT);
    await expect(page.getByRole('heading', { level: 1, name: 'Local Request Labeler' })).toBeVisible();
    await expect(page.getByText(/Viewing\s*v0\.2\.0\s*\(current\)/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'All versions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View specification' })).toBeVisible();
  });

  test('history lists newest first, marking current and historical', async ({ page }) => {
    await page.goto(PROJECT);
    await page.getByRole('link', { name: 'All versions' }).click();
    await expect(page).toHaveURL(/\/versions$/);
    const rows = page.locator('.row-list > li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('v0.2.0');
    await expect(rows.nth(0)).toContainText('Current version');
    await expect(rows.nth(1)).toContainText('v0.1.0');
    await expect(rows.nth(1)).toContainText('Historical version');
  });

  test('a historical version announces the newer one but never swaps its content in', async ({ page }) => {
    await page.goto(`${PROJECT}/versions`);
    await page.getByRole('link', { name: 'v0.1.0' }).click();
    await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
    const versionUrl = page.url();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('v0.1.0');
    await expect(page.getByText('This is a historical version.')).toBeVisible();
    const notice = page.getByRole('note').filter({ hasText: 'A newer version is available' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('v0.2.0');
    // Still on the same exact version after the page settles.
    await page.waitForLoadState('networkidle');
    expect(page.url()).toBe(versionUrl);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('v0.1.0');

    await notice.getByRole('link', { name: 'View the current version' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('v0.2.0');
    await expect(page.getByText('This is the current version.')).toBeVisible();
    await expect(page.getByText('A newer version is available')).toHaveCount(0);
  });

  test('digests are readable in short form and inspectable in full', async ({ page }) => {
    await page.goto(`${PROJECT}/versions`);
    await page.getByRole('link', { name: 'v0.2.0' }).click();
    const digest = page.locator('details', { has: page.locator('summary.mono') }).first();
    await expect(digest.locator('summary')).toHaveText(/^sha256:b{8}…b{6}$/);
    await expect(digest.locator('code')).toBeHidden();
    await digest.locator('summary').click();
    await expect(digest.locator('code')).toHaveText(`sha256:${'b'.repeat(64)}`);
  });

  test('documentation renders as Markdown with one h1, while the raw text stays available', async ({ page }) => {
    await page.goto(`${PROJECT}/versions`);
    await page.getByRole('link', { name: 'v0.2.0' }).click();
    await expect(page.locator('h1')).toHaveCount(1);
    const docs = page.locator('.markdown');
    await expect(docs.getByRole('heading', { name: 'Purpose' })).toBeVisible();
    await expect(docs.locator('h1, h2')).toHaveCount(0);
    // Nothing in the rendered documentation loads an image or runs a script.
    await expect(docs.locator('img, script, iframe')).toHaveCount(0);
    const raw = page.locator('details', { hasText: 'View the raw PROJECT.md text' });
    await expect(raw.locator('pre')).toBeHidden();
    await raw.locator('summary').click();
    await expect(raw.locator('pre')).toContainText('Purpose');
  });

  test('exports PROJECT.md for exactly the version shown', async ({ page }) => {
    await page.goto(`${PROJECT}/versions`);
    await page.getByRole('link', { name: 'v0.1.0' }).click();
    await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
    const shownVersionId = page.url().split('/').pop()!;
    // The export targets exactly the version on screen, not whatever is current.
    await expect(page.getByRole('link', { name: 'Export PROJECT.md' })).toHaveAttribute('href', new RegExp(`[?&]version=${shownVersionId}$`));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export PROJECT.md' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('PROJECT.md');
    const { createReadStream } = await import('node:fs');
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream((await download.path()) as string)) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text.startsWith('---')).toBe(true);
    expect(text).toMatch(/schema: "?localfirst\/project\/v0\.2"?/);
    expect(text).toContain('Local Request Labeler');
  });

  test('external source links open safely in a new tab', async ({ page, context }) => {
    await page.goto(`${PROJECT}/versions`);
    await page.getByRole('link', { name: 'v0.2.0' }).click();
    const links = page.locator('main a[target="_blank"]');
    const count = await links.count();
    for (let i = 0; i < count; i += 1) {
      await expect(links.nth(i)).toHaveAttribute('rel', /noopener/);
      await expect(links.nth(i)).toHaveAttribute('href', /^https?:\/\//);
    }
    expect(context.pages().length).toBe(1);
  });

  test('unknown projects and mismatched versions are plain not-found pages', async ({ page }) => {
    const missing = await page.goto('/projects/does-not-exist');
    expect(missing?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    await page.goto(`${PROJECT}/versions`);
    const href = await page.getByRole('link', { name: 'v0.2.0' }).getAttribute('href');
    const versionId = href!.split('/').pop()!;
    // A real version id under a different project, and an unknown id under the right one.
    const other = await page.goto(`/projects/jetbot/versions/${versionId}`);
    expect(other?.status()).toBe(404);
    const unknown = await page.goto(`${PROJECT}/versions/00000000-0000-0000-0000-000000000000`);
    expect(unknown?.status()).toBe(404);
  });

  test('fits the viewport with no horizontal scroll', async ({ page }) => {
    for (const path of [PROJECT, `${PROJECT}/versions`]) {
      await page.goto(path);
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
  });
});
