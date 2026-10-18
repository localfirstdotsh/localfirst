/** Starts the real Next.js website against the disposable verification API. Requires a current web build. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { config, setConfig } from '../config.js';
import { resetAuth } from '../auth/instance.js';

export async function startWebsite(apiUrl: string) {
  const reserve = createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const address = reserve.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate website port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const current = config();
  setConfig({ ...current, apiBaseUrl: baseUrl, websiteUrl: baseUrl, authIssuer: `${baseUrl}${current.authBasePath}`, mcpResource: `${baseUrl}/mcp`, restResource: `${baseUrl}/api/v1`, trustedOrigins: [baseUrl] });
  resetAuth();
  const webDir = fileURLToPath(new URL('../../../web/', import.meta.url));
  const next = fileURLToPath(new URL('../../../web/node_modules/next/dist/bin/next', import.meta.url));
  const child = spawn(process.execPath, [next, 'start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webDir, env: { ...process.env, NODE_ENV: 'production', LOCALFIRST_API_URL: apiUrl, LOCALFIRST_SITE_URL: baseUrl, LOCALFIRST_PUBLIC_API_URL: baseUrl, LOCALFIRST_DESIGN_SYSTEM: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + String(chunk)).slice(-4000); });
  child.stderr.on('data', (chunk) => { output = (output + String(chunk)).slice(-4000); });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit');
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Website exited. Build web first. ${output}`);
      const ready = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
      if (ready) return { baseUrl, close };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Website did not start. ${output}`);
  } catch (error) { await close(); throw error; }
}
