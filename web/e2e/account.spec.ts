import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { API, OWNER_ID, STRANGER_ID, horizontalOverflow } from './helpers';
import { createDeletionAccount, createDraft, fixtureQuery } from './private-fixtures';

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`unified browser pages (${scheme})`, () => {
    test.use({ colorScheme: scheme, extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });
    test('serves a nonce-based CSP and no third-party resources', async ({ page }, info) => {
      const violations: string[] = [];
      page.on('console', (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text()); });
      page.on('pageerror', (error) => violations.push(error.message));
      for (const path of ['/sign-in', '/consent?client_id=example&scope=projects:read%20custom:write%20offline_access', '/account/connections', '/account/devices', '/account/delete', '/privacy']) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        const csp = response?.headers()['content-security-policy'] ?? '';
        expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).toContain("form-action 'self'");
        expect(response?.headers()['cache-control']).toContain('no-store');
        const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1];
        expect(await page.locator('script:not([src])').evaluateAll((elements, expected) => elements.every((element) => (element as HTMLScriptElement).nonce === expected), nonce)).toBe(true);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((node) => node.target) }))).toEqual([]);
        if (process.env.BROWSER_SCREENSHOTS_DIR) await page.screenshot({ path: `${process.env.BROWSER_SCREENSHOTS_DIR}/${info.project.name}-${scheme}-${path.split('?')[0]!.replaceAll('/', '-')}.png`, fullPage: true });
      }
      expect(violations).toEqual([]);
    });
    test('escapes unverified identities, shows exact permissions and recovers from sign-in errors', async ({ page }) => {
      const hostile = '<img src=x onerror=alert(1)>' + 'x'.repeat(200);
      await page.goto(`/consent?client_id=${encodeURIComponent(hostile)}&client_name=${encodeURIComponent(hostile)}&scope=projects:read%20custom:write%20offline_access%20constructor%20__proto__`);
      await expect(page.getByRole('heading', { name: hostile, exact: true })).toBeVisible();
      await expect(page.getByText('Identity not verified', { exact: true })).toBeVisible();
      await expect(page.locator('main img')).toHaveCount(0);
      await page.getByText('Inspect all 5 exact permissions').click();
      await expect(page.locator('code').filter({ hasText: 'custom:write' })).toBeVisible();
      await expect(page.locator('code').filter({ hasText: '__proto__' })).toBeVisible();
      await page.getByText('Technical details', { exact: true }).click();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      await page.goto('/sign-in?next=%2Faccount%2Fprojects');
      await page.route('**/api/auth/sign-in/social', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture provider unavailable' } }) }));
      await page.getByRole('button', { name: 'Continue with GitHub' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Fixture provider unavailable' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry GitHub sign-in' })).toBeEnabled();
    });
    test('reviews exact content, requires acknowledgements, records denial, approval, expiry and revocation', async ({ page, request }, info) => {
      const draft = await createDraft(request);
      const path = `/review/drafts/${draft.draft_id}`;
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Review publication', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve this exact artifact' })).toBeDisabled();
      await page.getByText('Inspect exact documentation', { exact: true }).click();
      await expect(page.getByRole('region', { name: 'Inspect exact documentation' })).toHaveText(draft.markdown);
      await page.getByRole('button', { name: 'Wrap lines', exact: true }).first().click();
      await expect(page.getByRole('region', { name: 'Inspect exact documentation' })).toHaveClass(/artifact-unwrapped/);
      for (const checkbox of await page.locator('#review-acknowledgements input').all()) await checkbox.check();
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(scan.violations.map((v) => v.id)).toEqual([]);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      if (process.env.BROWSER_SCREENSHOTS_DIR) await page.screenshot({ path: `${process.env.BROWSER_SCREENSHOTS_DIR}/${info.project.name}-${scheme}-review.png`, fullPage: true });
      await page.getByRole('button', { name: 'Do not publish', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Publication not approved' })).toBeVisible();
      await expect(page.locator('#approve')).toHaveCount(0);
      await page.reload(); await expect(page.getByRole('heading', { name: 'Publication not approved' })).toBeVisible();
      await page.getByRole('link', { name: 'Review again', exact: true }).click();
      for (const checkbox of await page.locator('#review-acknowledgements input').all()) await checkbox.check();
      await page.getByRole('button', { name: 'Approve this exact artifact', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Publication approved', exact: true })).toBeVisible();
      await expect(page.getByText('Status: Awaiting publication', { exact: true })).toBeVisible();
      await page.reload(); await expect(page.getByRole('heading', { name: 'Publication approved', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Revoke approval', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Approve this exact artifact', exact: true })).toBeDisabled();
      for (const checkbox of await page.locator('#review-acknowledgements input').all()) await checkbox.check();
      await page.getByRole('button', { name: 'Approve this exact artifact', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Publication approved', exact: true })).toBeVisible();
      await fixtureQuery('update publication_approvals set expires_at = now() - interval \'1 second\' where draft_id = $1', [draft.draft_id]);
      await page.reload(); await expect(page.getByRole('heading', { name: 'Approval expired', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve this exact artifact', exact: true })).toBeDisabled();
    });
  });
}

test.describe('browser account mutations and isolation', () => {
  test.use({ extraHTTPHeaders: { 'x-dev-user': OWNER_ID } });
  test('rejects stale review decisions and keeps the current artifact authoritative', async ({ page, request }) => {
    const draft = await createDraft(request);
    await page.goto(`/review/drafts/${draft.draft_id}`);
    for (const checkbox of await page.locator('#review-acknowledgements input').all()) await checkbox.check();
    const edit = await request.patch(`${API}/api/v1/drafts/${draft.draft_id}`, { headers: { 'x-dev-user': OWNER_ID, 'if-match': draft.etag }, data: { project_md: draft.markdown + '\nA new revision.' } });
    expect(edit.ok(), await edit.text()).toBe(true);
    await page.getByRole('button', { name: 'Approve this exact artifact', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Refresh' })).toBeVisible();
    await expect(page.locator('#approve')).toHaveCount(0);
    const current = await request.get(`${API}/api/browser/drafts/${draft.draft_id}/review`, { headers: { 'x-dev-user': OWNER_ID } });
    expect((await current.json()).data.status).not.toBe('approved');
  });
  test('revokes an actual connection only after opening its confirmation', async ({ page }) => {
    const id = `connection-${Date.now()}`;
    const name = `Browser fixture application ${id}`;
    await fixtureQuery('insert into oauth_client (id, "clientId", name, "redirectUris") values ($1, $1, $2, \'[]\'::jsonb)', [id, name]);
    await fixtureQuery('insert into oauth_consent (id, "clientId", "userId", scopes, "createdAt", "updatedAt") values ($1, $2, $3, $4::jsonb, now(), now())', [id, id, OWNER_ID, JSON.stringify(['projects:read'])]);
    await page.goto('/account/connections');
    const card = page.getByRole('article').filter({ hasText: name });
    await card.getByText('Manage access', { exact: true }).click();
    await card.getByText('Revoke access', { exact: true }).click();
    await card.getByRole('button', { name: 'Confirm revocation' }).click();
    await expect(card).toHaveCount(0); await expect(page.getByRole('status').filter({ hasText: 'access revoked' })).toBeVisible();
    expect((await fixtureQuery('select id from oauth_consent where id = $1', [id])).rows).toHaveLength(0);
  });
  test('links and revokes an approval device through the real endpoints', async ({ page, request }) => {
    const started = await request.post('/api/v1/approver-links', { data: { client_label: 'Browser test terminal' } });
    expect(started.ok()).toBe(true); const link = (await started.json()).data;
    await page.goto(`/account/devices?code=${encodeURIComponent(link.user_code)}`);
    await page.getByRole('button', { name: 'Approve this machine', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Return to your terminal' })).toBeVisible();
    const issued = await request.post(`/api/v1/approver-links/${link.link_id}/token`, { data: { poll_secret: link.poll_secret } });
    expect(issued.ok()).toBe(true);
    await page.goto('/account/devices'); const card = page.getByRole('article').filter({ hasText: 'Browser test terminal' });
    await card.getByText('Revoke', { exact: true }).click(); await card.getByRole('button', { name: 'Confirm revocation' }).click();
    await expect(card).toHaveCount(0);
  });
  test('protects private read models, never caches them, and keeps public machine URLs working', async ({ request }) => {
    const draft = await createDraft(request);
    expect((await request.get(`/api/browser/drafts/${draft.draft_id}/review`, { headers: { 'x-dev-user': STRANGER_ID } })).status()).toBe(404);
    expect((await request.get('/api/browser/projects', { headers: { 'x-dev-user': OWNER_ID, 'x-dev-actor': 'token' } })).status()).toBe(403);
    const owned = await request.get('/api/browser/projects'); expect(owned.headers()['cache-control']).toBe('no-store');
    const legacy = await request.get(`${API}/account/projects?days=90`, { maxRedirects: 0 });
    expect(legacy.status()).toBe(307);
    expect(legacy.headers().location).toBe(`${new URL(owned.url()).origin}/account/projects?days=90`);
    const discovery = await request.get('/.well-known/oauth-authorization-server/api/auth'); expect(discovery.ok(), await discovery.text()).toBe(true);
    expect((await discovery.json()).issuer).toContain(new URL(owned.url()).origin);
    expect((await request.get('/schemas/project/v0.2.json')).ok()).toBe(true);
    expect((await request.post(`/api/v1/drafts/${draft.draft_id}/approval`, { headers: { origin: 'https://foreign.example', cookie: 'csrf-fixture=present' }, data: {} })).status()).toBe(403);
  });
});

test('deletion requires a matching handle and confirmation and reports only confirmed completion', async ({ browser, baseURL }) => {
  const id = await createDeletionAccount();
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-dev-user': id } });
  try {
    const page = await context.newPage(); await page.goto('/account/delete');
    await expect(page.getByText(/does not immediately erase all personal data/)).toBeVisible();
    await page.getByLabel(`Type your handle: ${id}`, { exact: true }).fill('wrong-handle');
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Confirm deletion request' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /handle/i })).toBeVisible();
    await page.getByLabel(`Type your handle: ${id}`, { exact: true }).fill(id); await page.getByRole('button', { name: 'Confirm deletion request' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Deletion requested.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm deletion request' })).toHaveCount(0);
    expect((await fixtureQuery('select deletion_requested_at from user_profiles where user_id = $1', [id])).rows[0]?.deletion_requested_at).toBeTruthy();
  } finally { await context.close(); }
});
