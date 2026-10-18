/**
 * Logs on the P1 submission paths (BACKEND_PRD sections 17.1 "Credential/log
 * leakage" and 19.3): a real REST and MCP submission with a bearer token, a
 * cookie, and recognisable build and result content, and none of it in a log
 * line. Logging is raised to `info` for this file only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'info';
});

import { config } from '../src/config.js';
import { observeLogLines } from '../src/observability/logger.js';
import { createAccount } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';
import { buildFor, drainWorker, key, publishEvidenceProject, resultFor } from './evidence-fixtures.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
afterEach(() => observeLogLines(null));

describe('logs', () => {
  it('carry no bearer token, cookie, or submitted build or result content', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const lines: string[] = [];
    observeLogLines((line) => lines.push(line));

    const scopes = ['builds:write', 'tests:submit'];
    const restToken = await mintToken({ subject: contributor.userId, audience: config().restResource, scopes });
    const mcpToken = await mintToken({ subject: contributor.userId, audience: config().mcpResource, scopes });
    const build = buildFor(project);
    build.hardware.cpu_model = 'Canary chip 6d1e';
    build.model_bindings[0]!.runtime_model_id = 'canary-model-6d1e:1b';
    const headers = (token: string) => ({
      'content-type': 'application/json', authorization: `Bearer ${token}`, cookie: 'localfirst.session=canary-cookie-6d1e',
    });
    const saved = await fetch(`${harness.baseUrl}/api/v1/builds`, { method: 'POST', headers: { ...headers(restToken), 'idempotency-key': key() }, body: JSON.stringify(build) });
    expect(saved.status).toBe(201);
    const buildId = (await saved.json()).data.build_id as string;
    const result = resultFor(project, buildId, { client_run_id: 'run_canary_6d1e' });
    const submitted = await fetch(`${harness.baseUrl}/api/v1/test-results`, { method: 'POST', headers: { ...headers(restToken), 'idempotency-key': key() }, body: JSON.stringify(result) });
    expect(submitted.status).toBe(202);
    const viaMcp = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers(mcpToken), accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build_save', arguments: { build: { ...build, configuration_key: 'local-chat' }, idempotency_key: key() } } }),
    });
    expect(viaMcp.status).toBe(200);
    await drainWorker();

    const logged = lines.join('');
    // The capture works: the submissions and the validation job were logged.
    expect(logged).toContain('/api/v1/test-results');
    expect(logged).toContain('"component":"mcp"');
    for (const secret of [restToken, mcpToken, 'canary-cookie-6d1e', 'Canary chip 6d1e', 'canary-model-6d1e', 'run_canary_6d1e']) {
      expect(logged, secret.slice(0, 24)).not.toContain(secret);
    }
  });
});
