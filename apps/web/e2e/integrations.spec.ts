import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WEB_UNRELEASED, horizontalOverflow } from './helpers';

const CLIENTS = [
  ['Claude Code', 'claude-code'], ['Codex CLI', 'codex'], ['Gemini CLI', 'gemini-cli'], ['Cursor', 'cursor'], ['OpenCode', 'opencode'], ['GitHub Copilot', 'github-copilot'], ['Windsurf', 'windsurf'], ['Cline', 'cline'],
] as const;

test('all integrations load their mark and link to the corresponding instructions', async ({ page }) => {
  for (const [label, id] of CLIENTS) {
    await page.goto('/docs/connect');
    const link = page.locator('.integration-list').getByRole('link', { name: label, exact: true });
    expect(await link.locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/docs/connect#${id}$`));
    await expect(page.locator(`#${id}`).getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
});

test('source setup offers the real Gemini registration command and copies it exactly', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${WEB_UNRELEASED}/docs/connect`);
  await page.getByRole('button', { name: 'Gemini CLI', exact: true }).click();
  const setup = page.locator('.setup-section');
  const command = await setup.locator('.command-line code').textContent();
  expect(command).toContain('mcp add --client gemini-cli --registry');
  await setup.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await expect(page.getByRole('button', { name: 'Cursor', exact: true })).toHaveCount(0);
  for (const name of ['OpenCode', 'GitHub Copilot', 'Windsurf', 'Cline']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});

test('native configs copy valid JSON with the discovered public MCP endpoint', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/connect');
  for (const client of ['cursor', 'opencode', 'github-copilot', 'windsurf', 'cline']) {
    const section = page.locator(`#${client}`);
    const code = section.locator('pre code');
    await section.getByLabel('MCP configuration').focus();
    await expect(section.getByLabel('MCP configuration')).toBeFocused();
    const expected = await code.textContent();
    await section.getByRole('button', { name: 'Copy config', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(expected);
    const config = JSON.parse(copied);
    const server = (config.mcpServers ?? config.mcp).localfirst;
    expect(server.url ?? server.serverUrl).toBe('http://127.0.0.1:3015/mcp');
    if (client === 'github-copilot') { expect(server.type).toBe('http'); expect(server.tools).toEqual(['*']); }
    if (client === 'cline') { expect(server.type).toBe('streamableHttp'); expect(server.autoApprove).toEqual([]); expect(server.disabled).toBe(false); }
    if (client === 'opencode') { expect(server.type).toBe('remote'); expect(server.enabled).toBe(true); }
    expect(server).not.toHaveProperty('headers');
    await expect(section.getByRole('status').filter({ hasText: 'Copied. Merge this entry' })).toBeVisible();
  }
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
});

test('config copying has a selectable fallback and the guide remains accessible', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }));
  await page.goto('/docs/connect#cursor');
  const cursor = page.locator('#cursor');
  await cursor.getByRole('button', { name: 'Copy config', exact: true }).click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(await cursor.locator('pre code').textContent());
  await expect(cursor.getByRole('status')).toContainText('Select and copy manually');
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
});
