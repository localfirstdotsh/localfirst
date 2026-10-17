import type { Page } from '@playwright/test';
import c from './constants.json' with { type: 'json' };

export const API = `http://127.0.0.1:${c.apiPort}`;
export const WEB_UNRELEASED = `http://127.0.0.1:${c.webUnreleasedPort}`;
export const OWNER_SLUG = c.ownerProjectSlug;
export const SETUP_COMMAND = c.setupCommand;
export const CLIENT_COMMAND = c.clientCommand;
export const OWNER_ID = c.ownerId;
export const STRANGER_ID = c.strangerId;

/** No horizontal page scroll: the document is never wider than the viewport (WCAG reflow). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** What the clipboard actually holds. Requires the clipboard permissions on the context. */
export async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The text currently selected on the page. */
export async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** A filter checkbox by its visible name. Not getByLabel: the active-filter chips share the name. */
export function filterBox(page: Page, name: string) {
  return page.getByRole('checkbox', { name, exact: true });
}

/** Opens the Filters popover (or sheet) and one of its accordion groups. */
export async function openFilters(page: Page, group?: string) {
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  if (!(await dialog.isVisible())) await page.locator('.popover-trigger').click();
  await dialog.waitFor();
  if (group) {
    const summary = page.locator('.filter-group > summary', { hasText: group });
    const open = await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
    if (!open) await summary.click();
  }
  return dialog;
}
