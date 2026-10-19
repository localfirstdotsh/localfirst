import { expect, test } from '@playwright/test';
import { filterBox, horizontalOverflow, openFilters } from './helpers';

const searchbox = (page: import('@playwright/test').Page) => page.getByRole('searchbox', { name: 'Search projects' });

test.describe('catalog search', () => {
  test('searching updates the URL, narrows the list, and shows a removable chip', async ({ page }) => {
    await page.goto('/projects');
    const total = await page.locator('.result-title').count();
    expect(total).toBeGreaterThan(2);

    await searchbox(page).fill('request labeler');
    await searchbox(page).press('Enter');
    await expect(page).toHaveURL(/\/projects\?q=request(\+|%20)labeler/);
    await expect(page.locator('.result-title')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Local Request Labeler' })).toBeVisible();

    await page.getByRole('link', { name: /Remove filter Search: request labeler/ }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('.result-title')).toHaveCount(total);
  });

  test('the clear action empties the query and keeps the other filters', async ({ page }) => {
    await page.goto('/projects?q=local&runtime=ollama');
    await page.getByRole('link', { name: 'Clear search' }).click();
    await expect(page).toHaveURL(/\/projects\?runtime=ollama$/);
    await expect(searchbox(page)).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Clear search' })).toHaveCount(0);
  });

  test('searching keeps the category, filters, and sort that were already applied', async ({ page }) => {
    await page.goto('/projects?type=application&runtime=ollama&sort=updated_at');
    await searchbox(page).fill('local');
    await searchbox(page).press('Enter');
    await expect(page).toHaveURL(/q=local/);
    await expect(page).toHaveURL(/type=application/);
    await expect(page).toHaveURL(/runtime=ollama/);
    await expect(page).toHaveURL(/sort=updated_at/);
  });

  test('a no-match search keeps the query and explains itself', async ({ page }) => {
    await page.goto('/projects?q=zzzzqqqq');
    await expect(page.getByRole('heading', { name: 'No results for "zzzzqqqq"' })).toBeVisible();
    await expect(searchbox(page)).toHaveValue('zzzzqqqq');
    await expect(page.locator('.result-title')).toHaveCount(0);
    await page.getByRole('link', { name: 'Clear search' }).last().click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('filters with no results get their own message and a way out', async ({ page }) => {
    await page.goto('/projects?type=documentation&runtime=vllm&evidence_level=independently_verified&os=windows');
    await expect(page.getByRole('heading', { name: 'No matching projects' })).toBeVisible();
    await page.getByRole('link', { name: 'Clear filters' }).last().click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('unsupported parameters and values are reported, not silently broadened', async ({ page }) => {
    await page.goto('/projects?runtime=not-a-runtime&page=2&sort=popularity');
    const note = page.getByRole('alert').filter({ hasText: 'Some filters were ignored' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('runtime=not-a-runtime');
    await expect(note).toContainText('page');
    await expect(note).toContainText('sort=popularity');
    // The query that actually ran was unfiltered.
    await expect(page.locator('.result-title').first()).toBeVisible();
  });
});

test.describe('categories', () => {
  test('All is selected by default and a category narrows the results', async ({ page }) => {
    await page.goto('/projects');
    const nav = page.getByRole('navigation', { name: 'Project categories' });
    await expect(nav.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    const total = await page.locator('.result-title').count();

    await nav.getByRole('link', { name: 'Experiments' }).click();
    await expect(page).toHaveURL(/\/projects\?type=experiment$/);
    await expect(nav.getByRole('link', { name: 'Experiments' })).toHaveAttribute('aria-current', 'true');
    await expect(nav.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.results-skeleton')).toHaveCount(0);
    // The list swaps in once the new page streams; wait for it rather than reading a transition.
    await expect.poll(() => page.locator('.result-title').count()).toBeLessThan(total);
    expect(await page.locator('.result-title').count()).toBeGreaterThan(0);
    // The selected category is the tab itself; it is not repeated as a chip.
    await expect(page.locator('.chip-link')).toHaveCount(0);

    await nav.getByRole('link', { name: 'All' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(nav.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.results-skeleton')).toHaveCount(0);
    await expect(page.locator('.result-title')).toHaveCount(total);
  });

  test('switching category keeps search, filters, and sort', async ({ page }) => {
    await page.goto('/projects?q=local&runtime=ollama&sort=updated_at');
    await page.getByRole('navigation', { name: 'Project categories' }).getByRole('link', { name: 'Applications' }).click();
    await expect(page).toHaveURL(/q=local/);
    await expect(page).toHaveURL(/runtime=ollama/);
    await expect(page).toHaveURL(/type=application/);
    await expect(page).toHaveURL(/sort=updated_at/);
  });

  test('the category row never overflows the page', async ({ page }) => {
    await page.goto('/projects');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('advanced filters', () => {
  test('are closed by default: no checkbox is on the page until Filters is opened', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeHidden();
    await openFilters(page, 'Runtime');
    await expect(filterBox(page, 'Ollama')).toBeVisible();
  });

  test('Apply commits every selected value at once, and the URL is shareable', async ({ page }) => {
    await page.goto('/projects');
    await openFilters(page, 'Runtime');
    await filterBox(page, 'Ollama').check();
    await openFilters(page, 'Test support');
    await filterBox(page, 'Manual').check();
    // Nothing is applied until Apply.
    await expect(page).toHaveURL(/\/projects$/);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/runtime=ollama/);
    await expect(page).toHaveURL(/test_support=manual/);
    await expect(page.locator('.popover-trigger .count')).toHaveText('2');
    await expect(page.getByRole('link', { name: /Remove filter Runtime: Ollama/ })).toBeVisible();
    await openFilters(page, 'Runtime');
    await expect(filterBox(page, 'Ollama')).toBeChecked();
  });

  test('applying keeps the category and the search text', async ({ page }) => {
    await page.goto('/projects?q=local&type=application');
    await openFilters(page, 'Runtime');
    await filterBox(page, 'Ollama').check();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/q=local/);
    await expect(page).toHaveURL(/type=application/);
    await expect(page).toHaveURL(/runtime=ollama/);
  });

  test('Clear filters inside the popover removes only the advanced filters', async ({ page }) => {
    await page.goto('/projects?q=local&type=application&runtime=ollama');
    await openFilters(page);
    await page.getByRole('dialog', { name: 'Filters' }).getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/projects\?q=local&type=application$/);
  });

  test('closing without applying discards the draft; the URL never changed', async ({ page }) => {
    await page.goto('/projects?runtime=ollama');
    await openFilters(page, 'Runtime');
    await filterBox(page, 'Ollama').uncheck();
    await filterBox(page, 'LM Studio').check();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeHidden();
    await openFilters(page, 'Runtime');
    await expect(filterBox(page, 'Ollama')).toBeChecked();
    await expect(filterBox(page, 'LM Studio')).not.toBeChecked();
    await expect(page).toHaveURL(/runtime=ollama$/);
  });

  test('a click outside closes the popover', async ({ page }) => {
    test.skip(!!test.info().project.use.isMobile, 'the sheet closes through its backdrop');
    await page.goto('/projects');
    await openFilters(page);
    await page.getByRole('heading', { name: 'Projects', level: 1 }).click();
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeHidden();
  });

  test('opening the popover does not move the results', async ({ page }) => {
    await page.goto('/projects');
    const first = page.locator('.result-title').first();
    const before = await first.boundingBox();
    await openFilters(page, 'Runtime');
    const after = await first.boundingBox();
    expect(after?.y).toBe(before?.y);
  });

  test('every chip removes only itself, and Clear all removes them all', async ({ page }) => {
    await page.goto('/projects?runtime=ollama&evidence_level=documented&q=local');
    await expect(page.locator('.chip-link')).toHaveCount(3);
    await page.getByRole('link', { name: /Remove filter Runtime: Ollama/ }).click();
    await expect(page.locator('.chip-link')).toHaveCount(2);
    await expect(page).toHaveURL(/evidence_level=documented/);
    await expect(page).not.toHaveURL(/runtime=/);
    await page.getByRole('link', { name: 'Clear all', exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('.chip-link')).toHaveCount(0);
  });

  test('Back and Forward restore earlier filter states and a reload keeps them', async ({ page }) => {
    await page.goto('/projects');
    await page.goto('/projects?runtime=ollama');
    await page.goto('/projects?runtime=ollama&evidence_level=documented');
    await expect(page.getByRole('link', { name: /Remove filter Evidence: Documented/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/runtime=ollama$/);
    await expect(page.getByRole('link', { name: /Remove filter Evidence/ })).toHaveCount(0);
    await page.goForward();
    await page.reload();
    await expect(page.getByRole('link', { name: /Remove filter Evidence: Documented/ })).toBeVisible();
    await openFilters(page, 'Evidence');
    await expect(filterBox(page, 'Documented')).toBeChecked();
  });
});

test.describe('sorting and results', () => {
  test('sort is disabled with nothing to rank, and enabled and URL-backed once narrowed', async ({ page }) => {
    await page.goto('/projects');
    const sort = page.getByLabel('Sort');
    await expect(sort).toBeDisabled();
    await expect(sort).toContainText('Recently updated');

    await page.goto('/projects?type=application');
    await expect(sort).toBeEnabled();
    await sort.click();
    await expect(page.getByRole('option')).toContainText(['Best match', 'Recently updated', 'Recent evidence']);
    await page.getByRole('option', { name: 'Recently updated', exact: true }).click();
    await expect(page).toHaveURL(/type=application/);
    await expect(page).toHaveURL(/sort=updated_at/);
    await expect(sort).toContainText('Recently updated');
  });

  test('the count is the number loaded, never an invented total', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('status').filter({ hasText: /^\d+\+? projects?/ })).toBeVisible();
    await expect(page.getByText(/of \d+ projects|\d+ total/)).toHaveCount(0);
  });

  test('a result is one link, shows compatibility and evidence, and hides zero counts', async ({ page }) => {
    await page.goto('/projects?q=request labeler');
    const result = page.locator('.result').first();
    await expect(result.getByRole('link')).toHaveCount(1);
    await expect(result.getByLabel('Compatibility')).toBeVisible();
    await expect(result.locator('.status')).toBeVisible();
    await expect(page.getByText(/\b0 (exports?|agent retrievals?)\b/)).toHaveCount(0);
    await result.getByRole('link').click();
    await expect(page).toHaveURL(/\/projects\/[^/?]+$/);
  });

  test('the footer is never above the content, and the page does not scroll sideways', async ({ page }) => {
    for (const url of ['/projects', '/projects?q=zzzzqqqq']) {
      await page.goto(url);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      const footer = await page.locator('footer').boundingBox();
      const viewport = page.viewportSize()!;
      // A short page ends at the bottom of the viewport; a long one ends below it. Never a gap.
      const bottom = (footer?.y ?? 0) + (footer?.height ?? 0);
      expect(bottom).toBeGreaterThanOrEqual(viewport.height - 1);
    }
  });
});
