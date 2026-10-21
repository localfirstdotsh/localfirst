import { expect, test } from '@playwright/test';
import { clipboardText, selectedText, SETUP_COMMAND, WEB_UNRELEASED, OWNER_SLUG } from './helpers';

test.describe('home setup command', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('shows the configured connection command with no client selector', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('group', { name: 'Agent client' })).toHaveCount(0);
    await expect(page.locator('.command-line code')).toHaveText(SETUP_COMMAND);
  });

  test('copies exactly the command to the clipboard, says so, and keeps focus on the button', async ({ page }) => {
    await page.goto('/');
    const copy = page.getByRole('button', { name: 'Copy' });
    // Before the click, the page must not claim a copy happened.
    await expect(page.getByText(/^Copied\./)).toHaveCount(0);
    await copy.click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
    expect(await clipboardText(page)).toBe(SETUP_COMMAND);
    // No prompt decoration, no trailing text, and focus has not been moved away.
    expect(await clipboardText(page)).not.toMatch(/^\$|\s$/);
    await expect(copy).toBeFocused();
  });

  test('allows repeated copies', async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Copy' }).click();
      await expect(page.getByText('Copied.')).toBeVisible();
    }
  });

  test('falls back to a manual copy, never claiming success, when the clipboard refuses', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')), readText: () => Promise.resolve('') },
        configurable: true,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Select and copy manually.')).toBeVisible();
    await expect(page.getByText('Copied.')).toHaveCount(0);
    // The command is selected, so the person can copy it with the keyboard.
    expect(await selectedText(page)).toBe(SETUP_COMMAND);
  });

  test('can be used from the keyboard alone', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Copy' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Copied.')).toBeVisible();
  });
});

test.describe('home page content', () => {
  test('has no Publish link or button anywhere', async ({ page }) => {
    for (const path of ['/', '/projects', '/docs/connect']) {
      await page.goto(path);
      await expect(page.locator('a[href="/publish"], a[href$="/publish"]')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /^publish$/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^publish$/i })).toHaveCount(0);
    }
  });

  test('offers commands and docs without catalog links or project previews', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'localfirst', exact: true })).toBeVisible();
    await expect(page.locator('.result-title')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('a[href="/projects"], a[href="/models"], a[href="/hardware"], a[href="/builds"]')).toHaveCount(0);
    await expect(page.locator('.site-footer')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Get started', exact: false })).toHaveAttribute('href', '/docs/connect');
    await expect(page.getByRole('link', { name: 'Read the docs', exact: true })).toHaveAttribute('href', '/docs');
    await expect(page.getByText('Open to everyone. Sign in with GitHub when you contribute.')).toHaveCount(0);
    await page.getByRole('link', { name: 'Read the docs', exact: true }).click();
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('.site-footer')).toBeVisible();
  });

  test('reveals the navbar after the hero settles', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('.site-header');
    await expect(page.locator('.landing')).toHaveAttribute('data-intro', 'running');
    await expect(header).toBeHidden();
    await expect(page.locator('.landing-intro')).toBeHidden();
    await expect(page.locator('.landing-copy')).toHaveCSS('opacity', '1');
    await expect(header).toBeVisible();
    await expect(header).toHaveCSS('opacity', '1');
  });

  test('public catalog URLs lead to docs while shared project URLs stay readable', async ({ page }) => {
    for (const path of ['/projects?q=anything', '/models', '/hardware', '/builds']) {
      await page.goto(`${WEB_UNRELEASED}${path}`);
      await expect(page).toHaveURL(`${WEB_UNRELEASED}/docs`);
      await expect(page.getByRole('heading', { name: 'Documentation', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox')).toHaveCount(0);
    }
    await page.goto(`${WEB_UNRELEASED}/projects/${OWNER_SLUG}`);
    await expect(page.getByRole('link', { name: 'Export PROJECT.md' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  });

  test('unreleased setup uses a real source command and links to build instructions', async ({ page }) => {
    await page.goto(`${WEB_UNRELEASED}/`);
    await expect(page.locator('.command-line code')).toContainText('node packages/runner/dist/cli/bin.js mcp add --client claude-code');
    await expect(page.getByText('Run from a built repository checkout. Requires Node.js 22+.')).toBeVisible();
    await page.getByRole('link', { name: 'Get started', exact: false }).click();
    await expect(page.getByRole('heading', { name: 'Before you connect' })).toBeVisible();
  });

  test('reduced motion shows the complete hero immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.landing')).not.toHaveAttribute('data-intro', 'running');
    await expect(page.locator('.landing-intro')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read the docs', exact: true })).toBeVisible();
  });

  test('marks the current section in the navigation', async ({ page, isMobile }) => {
    await page.goto('/docs/connect');
    if (isMobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});
