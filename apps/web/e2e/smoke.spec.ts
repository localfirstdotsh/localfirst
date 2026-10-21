import { expect, test } from '@playwright/test';

test('the home page loads with its wordmark and setup links', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'localfirst', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Get started' })).toBeVisible();
});

test.describe('health check', () => {
  test('reports liveness, uncached, with no dependence on the registry', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers()['cache-control']).toBe('no-store');
  });

  test('stays healthy when the registry cannot be reached', async ({ request }) => {
    // A website instance whose API address points nowhere. Only /health is asked of it here;
    // the pages' own "registry unavailable" states are covered by the unit tests.
    const { spawn } = await import('node:child_process');
    const port = 3099;
    const server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(port)], {
      env: { ...process.env, LOCALFIRST_API_URL: 'http://127.0.0.1:1', LOCALFIRST_SITE_URL: `http://127.0.0.1:${port}` },
      stdio: 'ignore',
      // Its own process group, so the whole tree (pnpm and the Next server it starts) can be killed.
      detached: true,
    });
    try {
      let status = 0;
      for (let i = 0; i < 40 && status !== 200; i += 1) {
        status = await request.get(`http://127.0.0.1:${port}/health`).then((r) => r.status(), () => 0);
        if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(status).toBe(200);
    } finally {
      if (server.pid) process.kill(-server.pid, 'SIGKILL');
    }
  });
});
