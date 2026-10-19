import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';

type Mode = 'empty' | 'delayed' | 'network' | 'unavailable' | 'invalid';
interface DiscoverySite { origin: string; mode: (value: Mode) => void }

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP address');
  return address.port;
}

/** Real production Next server with a fresh, controlled upstream per test. Only empty/error
 * responses are synthesized; populated catalogs are covered against the real registry separately.
 * A fresh upstream origin also isolates Next's data cache without deleting shared cache files. */
export const test = base.extend<{ discovery: DiscoverySite }>({
  discovery: async ({ page }, use) => {
    // Keep a neighboring navigation link from warming the data cache before a forced failure.
    await page.route('**/*', (route) => {
      const headers = route.request().headers();
      return headers['next-router-prefetch'] || headers.purpose === 'prefetch' ? route.abort() : route.continue();
    });
    let mode: Mode = 'empty';
    const api = createServer(async (request, response) => {
      if (mode === 'network') { request.socket.destroy(); return; }
      if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 2000));
      response.writeHead(mode === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(mode === 'unavailable'
        ? { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Unavailable' }, meta: { request_id: 'req-discovery' } }
        : { data: mode === 'invalid' ? {} : { items: [], has_more: false, next_cursor: null }, meta: { request_id: 'req-discovery' } }));
    });
    const apiPort = await listen(api);
    const reservation = createServer();
    const webPort = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${webPort}`;
    const require = createRequire(import.meta.url);
    const web = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, LOCALFIRST_API_URL: `http://127.0.0.1:${apiPort}`, LOCALFIRST_SITE_URL: origin, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    web.stdout.on('data', (chunk) => { log += chunk; });
    web.stderr.on('data', (chunk) => { log += chunk; });
    try {
      await expect.poll(async () => {
        if (web.exitCode !== null) throw new Error(`Discovery server exited: ${log}`);
        try { return (await fetch(`${origin}/health`)).ok; } catch { return false; }
      }, { timeout: 15_000 }).toBe(true);
      await use({ origin, mode: (value) => { mode = value; } });
    } finally {
      if (web.exitCode === null && web.signalCode === null) {
        web.kill('SIGTERM');
        await once(web, 'exit');
      }
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  },
});
export { expect };
