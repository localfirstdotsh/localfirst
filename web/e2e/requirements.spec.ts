import { expect, test } from '@playwright/test';
import { OWNER_SLUG } from './helpers';

const PROJECT = `/projects/${OWNER_SLUG}`;

/** The real browser path: React's server-action submit, not a hand-built POST. */
test.describe('check requirements', () => {
  test('is optional, starts as unknown, and pins the version being viewed', async ({ page }) => {
    await page.goto(PROJECT);
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Check' }) });
    for (const name of ['CPU architecture', 'Operating system', 'Runtime', 'Unified memory']) {
      await expect(form.getByRole('combobox', { name, exact: true })).toContainText('Unknown');
    }
    await expect(form.getByLabel('System memory (GiB)')).toHaveValue('');
    await expect(form.getByLabel('Inference must stay on this machine')).not.toBeChecked();
    await expect(form.getByLabel('It must work offline')).not.toBeChecked();
    // The viewed (current) version is in the form, not whatever is newest when you press the button.
    const pinned = await form.locator('input[name="project_version_id"]').inputValue();
    expect(pinned).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('returns an assessment with outcome, evidence, and per-requirement status', async ({ page }) => {
    await page.goto(PROJECT);
    await page.getByRole('combobox', { name: 'CPU architecture', exact: true }).click();
    await page.getByRole('option', { name: 'arm64', exact: true }).click();
    await page.getByRole('combobox', { name: 'Operating system', exact: true }).click();
    await page.getByRole('option', { name: 'macOS', exact: true }).click();
    await page.getByRole('combobox', { name: 'Runtime', exact: true }).click();
    await page.getByRole('option', { name: 'Ollama', exact: true }).click();
    await page.getByLabel('System memory (GiB)').fill('16');
    await page.getByLabel('Inference must stay on this machine').check();
    await page.getByRole('button', { name: 'Check' }).click();

    const result = page.locator('[aria-labelledby="check-result"]');
    await expect(page.locator('#check-result')).toBeVisible();
    await expect(page.locator('#check-result')).toHaveText(/Matching test evidence|Candidate configuration|Requirement failed|More information needed/);
    await expect(result).toContainText('not a benchmark or permission to install');
    // Each requirement has a symbol AND a word, so status never relies on colour.
    const rows = page.locator('[aria-labelledby="check-result"] li');
    expect(await rows.count()).toBeGreaterThan(3);
    await expect(rows.filter({ hasText: 'Pass' }).first()).toContainText('✓');
    await expect(rows.filter({ hasText: 'Unknown' }).first()).toContainText('?');
    // The entered values never reach the URL.
    expect(page.url()).toBe(new URL(PROJECT, page.url()).toString());
    expect(page.url()).not.toMatch(/arm64|memory|ollama|16/);
  });

  test('an empty form is "more information needed", not a failure', async ({ page }) => {
    await page.goto(PROJECT);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('#check-result')).toHaveText('More information needed');
    await expect(page.locator('[aria-labelledby="check-result"]')).not.toContainText('Requirement failed');
  });

  test('can be submitted repeatedly without the page or server stalling', async ({ page }) => {
    // Regression: binding the project id into the action once made form posts wedge the server.
    await page.goto(PROJECT);
    for (const memory of ['4', '8', '16', '32', '64']) {
      await page.getByLabel('System memory (GiB)').fill(memory);
      await page.getByRole('button', { name: 'Check' }).click();
      await expect(page.locator('#check-result')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Check' })).toBeEnabled();
    }
    // And the site still answers afterwards.
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('rejects a value the server will not accept, without calling the registry', async ({ page }) => {
    const compatibilityCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/compatibility-checks')) compatibilityCalls.push(request.url());
    });
    await page.goto(PROJECT);
    await page.getByLabel('System memory (GiB)').fill('0');
    await page.getByRole('button', { name: 'Check' }).click();
    // Next adds its own hidden route-announcer alert, so select ours by content.
    const alert = page.getByRole('alert').filter({ hasText: 'The check did not run' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/between 0 and/);
    expect(compatibilityCalls).toHaveLength(0);
  });

  test('works with the keyboard alone', async ({ page }) => {
    await page.goto(PROJECT);
    await page.getByLabel('CPU architecture').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByLabel('System memory (GiB)').focus();
    await page.keyboard.type('8');
    await page.keyboard.press('Enter');
    await expect(page.locator('#check-result')).toBeVisible();
  });

  test('announces the result politely to assistive technology', async ({ page }) => {
    await page.goto(PROJECT);
    await expect(page.locator('section[aria-labelledby="check"] [aria-live="polite"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('section[aria-labelledby="check"] [aria-live="polite"] #check-result')).toBeVisible();
  });
});
