import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signJWT } from 'better-auth/plugins';
import { auth } from '../auth/instance.js';
import { config } from '../config.js';
import { runSeed } from '../seed/seed.js';
import { isolatedDatabases, startServer } from './harness.js';

const exec = promisify(execFile);
const resources = await isolatedDatabases();
const directory = await mkdtemp(join(tmpdir(), 'localfirst-claude-'));
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const seed = await runSeed();
  assert.equal(seed.skipped.length, 0);
  const calls: Array<{ method: string; status: number; negotiated_protocol?: string }> = [];
  server = await startServer(async (request, response) => {
    if (new URL(request.url).pathname !== '/mcp' || request.method !== 'POST') return;
    const body = await request.json() as { method?: string };
    const result = await response.json().catch(() => null) as { result?: { protocolVersion?: string } } | null;
    calls.push({ method: body.method ?? 'unknown', status: response.status,
      ...(result?.result?.protocolVersion ? { negotiated_protocol: result.result.protocolVersion } : {}) });
  });
  const cfg = config();
  const context = await (auth() as unknown as { $context: Promise<unknown> }).$context;
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ context } as never, { payload: {
    iss: cfg.authIssuer, sub: 'seed-user-builder', aud: cfg.mcpResource,
    iat: now, exp: now + 300, jti: 'isolated-client-verification',
    client_id: 'claude-code-verification', scope: 'projects:read',
  } });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
  const options = { cwd: directory, env, timeout: 30_000 };
  const version = (await exec('claude', ['--version'], options)).stdout.trim();
  await exec('claude', ['mcp', 'add-json', '--scope', 'user', 'localfirst-verification', JSON.stringify({
    type: 'http', url: cfg.mcpResource, headers: { Authorization: `Bearer ${token}` },
  })], options);
  const result = await exec('claude', ['mcp', 'get', 'localfirst-verification'], options);
  assert.match(result.stdout, /connected/i, 'Claude Code did not report a connected server');
  assert.ok(calls.some((call) => call.method === 'initialize' && call.status === 200));
  assert.ok(calls.some((call) => call.method === 'tools/list' && call.status === 200));
  console.log(JSON.stringify({ verification: 'p0-real-mcp-client', client: version, calls, passed: true,
    limitation: 'Actual application transport health check using a minted audience-bound test token. Browser OAuth and interactive contribution flow remain unverified.' }, null, 2));
} finally {
  if (server) await server.close();
  await resources.cleanup();
  await rm(directory, { recursive: true, force: true });
}
