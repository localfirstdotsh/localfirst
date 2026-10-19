import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './discovery-fixture';
import { horizontalOverflow } from './helpers';

const pages = [
  { path: '/projects', title: 'Projects', description: 'Discover local AI applications, workflows, and builds.', empty: 'No projects yet' },
  { path: '/models', title: 'Models', description: 'Explore the AI models powering local projects.', empty: 'No models yet' },
  { path: '/hardware', title: 'Hardware', description: 'Discover the devices and hardware used to run local AI.', empty: 'No hardware yet' },
  { path: '/builds', title: 'Builds', description: 'Explore how local AI projects are configured and run.', empty: 'Build discovery is coming soon' },
] as const;

test('all four discovery pages share centered, borderless empty states and aligned footers', async ({ page, discovery }, info) => {
  for (const entry of pages) {
    await page.goto(`${discovery.origin}${entry.path}`);
    const region = page.locator('.discovery-results');
    const state = region.locator('.empty-state');
    await expect(page.getByRole('heading', { level: 1, name: entry.title, exact: true })).toBeVisible();
    await expect(page.getByText(entry.description, { exact: true })).toBeVisible();
    await expect(state.getByRole('heading', { name: entry.empty, exact: true })).toBeVisible();
    await expect(state).toHaveAttribute('role', 'status');
    await expect(state).toHaveCSS('border-top-width', '0px');
    await expect(region.locator('.panel, .notice, [role="alert"]')).toHaveCount(0);
    const content = (await region.boundingBox())!;
    const box = (await state.boundingBox())!;
    const footer = page.getByRole('contentinfo');
    const footerBox = (await footer.boundingBox())!;
    const headerContainer = (await page.locator('.site-header .container').boundingBox())!;
    const footerContainer = (await footer.locator('.container').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - content.y - content.height / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(footerBox.y + footerBox.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(footerContainer.x).toBe(headerContainer.x);
    expect(footerContainer.width).toBe(headerContainer.width);
    await expect(footer).toContainText(`© ${new Date().getFullYear()} Localfirst.sh`);
    for (const [name, href] of [['Docs', '/docs'], ['GitHub', 'https://github.com/localfirstdotsh/localfirst'], ['Privacy', '/privacy']]) {
      await expect(footer.getByRole('link', { name, exact: true })).toHaveAttribute('href', href!);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const violations = (await new AxeBuilder({ page }).analyze()).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${entry.title.toLowerCase()}-${info.project.name}.png`), fullPage: true, scale: 'css' });
    if (entry.path !== '/projects') {
      await state.getByRole('link', { name: entry.path === '/builds' ? 'Browse projects' : 'Explore projects' }).click();
      await expect(page).toHaveURL(`${discovery.origin}/projects`);
      await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
    }
  }
});

test('data pages keep the introduction visible during loading and the footer stable when empty', async ({ page, discovery }) => {
  discovery.mode('delayed');
  for (const entry of pages.filter((item) => item.path !== '/builds')) {
    await page.goto(`${discovery.origin}${entry.path}`, { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { level: 1, name: entry.title, exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: `Loading ${entry.title.toLowerCase()}` })).toBeVisible();
    const loadingFooter = (await page.getByRole('contentinfo').boundingBox())!;
    await expect(page.getByRole('heading', { name: entry.empty, exact: true })).toBeVisible();
    const readyFooter = (await page.getByRole('contentinfo').boundingBox())!;
    expect(readyFooter.y).toBe(loadingFooter.y);
    expect(Math.abs(readyFooter.y + readyFooter.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
  }
});

for (const failure of ['network', 'unavailable', 'invalid'] as const) {
  test(`${failure} responses show retry feedback and never masquerade as empty results`, async ({ page, discovery }) => {
    for (const entry of pages.filter((item) => item.path !== '/builds')) {
      discovery.mode(failure);
      await page.goto(`${discovery.origin}${entry.path}`);
      const region = page.locator('.discovery-results');
      await expect(region.getByRole('alert')).toBeVisible();
      await expect(region.locator('.empty-state')).toHaveCount(0);
      await expect(region.getByRole('heading', { name: entry.empty, exact: true })).toHaveCount(0);
      await expect(region.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', entry.path);
      discovery.mode('empty');
      await region.getByRole('link', { name: 'Try again' }).click();
      await expect(page).toHaveURL(`${discovery.origin}${entry.path}`);
      await expect(region.getByRole('heading', { name: entry.empty, exact: true })).toBeVisible();
    }
  });
}

test('tablet and narrow mobile empty states reflow without overflow', async ({ page, discovery }) => {
  for (const width of [768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const entry of pages) {
      await page.goto(`${discovery.origin}${entry.path}`);
      await expect(page.getByRole('heading', { name: entry.empty, exact: true })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      const footer = (await page.getByRole('contentinfo').boundingBox())!;
      expect(Math.abs(footer.y + footer.height - 900)).toBeLessThanOrEqual(1);
    }
  }
});
