import { expect, test, type Page } from '@playwright/test';
import { OWNER_SLUG, openFilters } from './helpers';

/** True when the focused element draws an outline or a box shadow, i.e. focus is visible. */
async function focusIndicator(page: Page): Promise<{ tag: string; label: string; visible: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: 'none', label: '', visible: false };
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const shadow = style.boxShadow !== 'none';
    return {
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().slice(0, 40),
      visible: outline || shadow,
    };
  });
}

test.describe('keyboard', () => {
  test('the first Tab reaches the skip link, which moves past the header', async ({ page, isMobile }) => {
    test.skip(isMobile, 'no keyboard on a phone');
    await page.goto('/projects');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await page.keyboard.press('Tab');
    const inMain = await page.evaluate(() => !!document.activeElement?.closest('main'));
    expect(inMain).toBe(true);
  });

  test('every focused control on the main pages shows a visible focus indicator', async ({ page, isMobile }) => {
    test.skip(isMobile, 'no keyboard on a phone');
    for (const path of ['/', '/projects', `/projects/${OWNER_SLUG}`]) {
      await page.goto(path);
      const missing: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Tab');
        const focus = await focusIndicator(page);
        if (focus.tag === 'body') break;
        if (!focus.visible) missing.push(`${focus.tag} "${focus.label}"`);
      }
      expect(missing, `${path}: no visible focus on ${missing.join(', ')}`).toEqual([]);
    }
  });

  test('tabbing reaches the footer without getting trapped', async ({ page, isMobile }) => {
    test.skip(isMobile, 'no keyboard on a phone');
    await page.goto('/projects');
    let reached = false;
    for (let i = 0; i < 80 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => !!document.activeElement?.closest('footer'));
    }
    expect(reached).toBe(true);
  });

  test('the catalog filters can be set and applied with the keyboard alone', async ({ page }) => {
    await page.goto('/projects');
    await page.locator('.popover-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
    // Runtime is the first group; open it from its own summary.
    // Focus moves into the popover on open; wait for that before driving the keyboard.
    const runtime = page.locator('.filter-group > summary', { hasText: 'Runtime' });
    await expect(runtime).toBeFocused();
    await page.keyboard.press('Enter');
    const ollama = page.getByRole('checkbox', { name: 'Ollama', exact: true });
    await ollama.focus();
    await page.keyboard.press('Space');
    await expect(ollama).toBeChecked();
    await page.getByRole('button', { name: 'Apply filters' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/runtime=ollama/);
  });

  test('Escape closes the filters, discards drafts, and returns focus to the trigger', async ({ page }) => {
    await page.goto('/projects');
    await page.locator('.popover-trigger').focus();
    await page.keyboard.press('Enter');
    await page.locator('.filter-group > summary', { hasText: 'Runtime' }).click();
    await page.getByRole('checkbox', { name: 'Ollama', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeHidden();
    await expect(page.locator('.popover-trigger')).toBeFocused();
    await openFilters(page, 'Runtime');
    await expect(page.getByRole('checkbox', { name: 'Ollama', exact: true })).not.toBeChecked();
    await expect(page).not.toHaveURL(/runtime=/);
  });

  test('search submits with Enter and keeps the typed text', async ({ page }) => {
    await page.goto('/projects');
    const box = page.getByRole('searchbox', { name: 'Search projects' });
    await box.focus();
    await page.keyboard.type('labeler');
    await expect(box).toHaveValue('labeler');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/q=labeler/);
    await expect(box).toHaveValue('labeler');
  });
});
