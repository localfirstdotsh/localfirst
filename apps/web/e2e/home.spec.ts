import { expect, test } from '@playwright/test';
import { clipboardText, selectedText } from './helpers';

test.describe('home setup command', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('shows a single npx command with no client selector', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('group', { name: 'Agent client' })).toHaveCount(0);
    await expect(page.locator('.command-line code')).toHaveText('npx localfirstdotsh');
  });

  test('copies exactly the command to the clipboard, says so, and keeps focus on the button', async ({ page }) => {
    await page.goto('/');
    const copy = page.getByRole('button', { name: 'Copy' });
    // Before the click, the page must not claim a copy happened.
    await expect(page.getByText(/^Copied\./)).toHaveCount(0);
    await copy.click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
    expect(await clipboardText(page)).toBe('npx localfirstdotsh');
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
    expect(await selectedText(page)).toBe('npx localfirstdotsh');
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

  test('previews four projects and sends discovery to the directory', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.result-title').first()).toBeVisible();
    await expect(page.locator('.result-title')).toHaveCount(4);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View all projects' })).toHaveAttribute('href', '/projects');
  });

  test('marks the current section in the navigation', async ({ page, isMobile }) => {
    await page.goto('/models');
    if (isMobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });
});
