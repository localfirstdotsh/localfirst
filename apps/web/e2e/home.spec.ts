import { expect, test } from '@playwright/test';
import { clipboardText, selectedText, SETUP_COMMAND, WEB_UNRELEASED } from './helpers';

test.describe('home setup command', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('shows the configured setup command with no client selector', async ({ page }) => {
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

  test('shows the standalone hero and links to real setup and documentation', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'localfirst', exact: true })).toBeVisible();
    await expect(page.locator('.result-title')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('.site-header')).toBeHidden();
    await expect(page.locator('.site-footer')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Get started', exact: false })).toHaveAttribute('href', '/docs/connect');
    await page.getByRole('link', { name: 'Read the docs', exact: true }).click();
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('.site-footer')).toBeVisible();
  });

  test('uses the source-build command when no CLI release is configured', async ({ page }) => {
    await page.goto(`${WEB_UNRELEASED}/`);
    await expect(page.locator('.command-line code')).toContainText('node packages/runner/dist/cli/bin.js mcp add --client claude-code');
    await expect(page.getByRole('status')).toContainText('Run from a built repository checkout. Requires Node.js 22+.');
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
    await page.goto('/models');
    if (isMobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });
});
