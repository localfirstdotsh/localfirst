import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WEB_UNRELEASED, horizontalOverflow } from './helpers';

const CLIENTS = [
  ['Claude Code', 'claude-code'], ['Codex CLI', 'codex'], ['Gemini CLI', 'gemini-cli'], ['Cursor', 'cursor'], ['OpenCode', 'opencode'], ['GitHub Copilot', 'github-copilot'], ['Windsurf', 'windsurf'], ['Cline', 'cline'],
] as const;

test('all integrations load their mark and link to the corresponding instructions', async ({ page }) => {
  for (const [label, id] of CLIENTS) {
    await page.goto('/');
    const link = page.locator('.integration-row').getByRole('link', { name: label, exact: true });
    expect(await link.locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/docs/connect#${id}$`));
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#${id}`).getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
});

test('source setup offers the real Gemini registration command and copies it exactly', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${WEB_UNRELEASED}/docs/connect`);
  await page.getByRole('tab', { name: 'Gemini CLI', exact: true }).click();
  const setup = page.getByRole('tabpanel', { name: 'Gemini CLI', exact: true });
  const command = await setup.locator('.command-line:visible code').textContent();
  expect(command).toContain('mcp add --client gemini-cli --registry');
  if (process.env.LOCALFIRST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.LOCALFIRST_SCREENSHOT_DIR}/source-setup-${info.project.name}.png` });
  await setup.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await page.getByRole('tab', { name: 'Cursor', exact: true }).click();
  // This site's public origin intentionally differs from the advertised MCP origin.
  // Native configuration must stay unavailable rather than guessing an endpoint.
  await expect(page.getByRole('tabpanel', { name: 'Cursor', exact: true }).getByRole('heading', { name: 'Connection configuration unavailable' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Cursor', exact: true }).locator('.command-line')).toHaveCount(0);
});

test('native configs copy valid JSON with the discovered public MCP endpoint', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/connect');
  for (const client of ['cursor', 'opencode', 'github-copilot', 'windsurf', 'cline']) {
    const section = page.locator(`#${client}`);
    await page.locator(`[role="tab"][aria-controls="${client}"]`).click();
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

test('client tabs support keyboard selection, deep links, reload, and back navigation', async ({ page }) => {
  await page.goto('/docs/connect#cursor');
  const cursor = page.getByRole('tab', { name: 'Cursor', exact: true });
  await expect(cursor).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await cursor.focus();
  await page.keyboard.press('ArrowLeft');
  const gemini = page.getByRole('tab', { name: 'Gemini CLI', exact: true });
  await expect(gemini).toBeFocused();
  await expect(gemini).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#gemini-cli$/);
  await page.reload();
  await expect(gemini).toHaveAttribute('aria-selected', 'true');
  await gemini.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'VS Code', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toBeFocused();
  await page.getByRole('navigation', { name: 'Continue reading' }).getByRole('link', { name: /Project specification/ }).click();
  await expect(page).toHaveURL(/\/docs\/project-spec$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/docs\/connect#claude-code$/);
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('URL setup copies the endpoint with settings-specific feedback', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/connect#chatgpt');
  const panel = page.getByRole('tabpanel', { name: 'ChatGPT', exact: true });
  await panel.getByRole('button', { name: 'Copy URL' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:3015/mcp');
  await expect(panel.getByRole('status')).toContainText('Paste this URL into your client’s MCP settings');
  await expect(panel.locator('.command-prompt')).toHaveCount(0);
});

test('setup instructions remain readable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL, viewport: { width: 375, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto('/docs/connect');
    for (const [name, id] of CLIENTS) await expect(page.locator(`#${id}`).getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('tablist')).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Documentation', exact: true })).toBeVisible();
  } finally { await context.close(); }
});
