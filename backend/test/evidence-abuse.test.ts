/**
 * Abuse fixtures for the P1 inputs (BACKEND_PRD sections 17.1 and 19.2):
 * request size and nesting, the shared submission quota across transports,
 * and URLs inside builds that the server must never fetch.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, setConfig } from '../src/config.js';
import { createAccount, type TestAccount } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';
import { acceptedRun, api, buildFor, key, publishEvidenceProject, resultFor } from './evidence-fixtures.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});
afterEach(() => {
  setConfig(null);
  vi.restoreAllMocks();
});

const MiB = 1024 * 1024;

describe('request size and nesting', () => {
  it('stops reading a chunked build upload at the body limit when no length is declared', async () => {
    const account = await createAccount();
    const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
    let sent = 0;
    // 64 MiB offered: a server that buffered undeclared bodies would pull all of it.
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"pad":"')); },
      pull(controller) {
        if (sent >= 64 * MiB) { controller.enqueue(new TextEncoder().encode('"}')); controller.close(); return; }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    let outcome: string;
    try {
      const response = await fetch(`${harness.baseUrl}/api/v1/builds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dev-user': account.userId, 'idempotency-key': key('chunked') },
        body,
        duplex: 'half',
      } as RequestInit);
      outcome = `${response.status} ${(await response.json()).error.code}`;
      expect(response.headers.get('connection')).toBe('close');
    } catch (error) {
      // The server may hang up while the client is still writing.
      outcome = `closed ${String((error as { cause?: { code?: string } }).cause?.code)}`;
    }
    expect(['413 PAYLOAD_TOO_LARGE', 'closed EPIPE', 'closed ECONNRESET', 'closed UND_ERR_SOCKET']).toContain(outcome);
    // Read up to the 4 MiB limit plus socket buffers, then no further.
    expect(sent).toBeLessThan(16 * MiB);
    expect((await fetch(`${harness.baseUrl}/health/live`)).status).toBe(200);
  });

  it('rejects a deeply nested build body as invalid and keeps serving', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const account = await createAccount();
    const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
    const text = JSON.stringify(buildFor(project)).replace('"changes":[]', `"changes":${deep}`);
    const response = await fetch(`${harness.baseUrl}/api/v1/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user': account.userId, 'idempotency-key': key('deep') },
      body: text,
    });
    const answer = await response.text();
    expect(response.status, answer.slice(0, 300)).toBe(400);
    expect((await fetch(`${harness.baseUrl}/health/live`)).status).toBe(200);
  });
});

describe('shared submission quota', () => {
  async function mcpCall(account: TestAccount, name: string, args: Record<string, unknown>, clientId = 'abuse-client') {
    const token = await mintToken({ subject: account.userId, audience: config().mcpResource, scopes: ['builds:write', 'tests:submit'], clientId });
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await response.text();
    const payload = text.startsWith('event:') || text.startsWith('data:')
      ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
      : JSON.parse(text);
    return payload.result as { isError?: boolean; structuredContent?: { error?: { code?: string; details?: Record<string, unknown> } } };
  }

  it('counts builds and results over REST and every MCP client against one daily bucket per account', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const current = config();
    setConfig({ ...current, limits: { ...current.limits, submissionsPerDay: 3 } });

    const rest = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    expect(rest.status).toBe(201);
    const buildId = rest.json.data.build_id as string;
    expect((await api(contributor, '/api/v1/test-results', { method: 'POST', body: { result: resultFor(project, buildId), build_id: buildId }, key: key() })).status).toBe(202);
    const viaMcp = await mcpCall(contributor, 'test_submit_result', { result: resultFor(project, buildId, { completed_at: '2026-10-11T21:00:00Z' }), build_id: buildId, idempotency_key: key() });
    expect(viaMcp.isError, JSON.stringify(viaMcp)).toBeFalsy();

    // The fourth submission is refused on both transports.
    const mcpRefused = await mcpCall(contributor, 'build_save', { build: buildFor(project, { configuration_key: 'local-chat' }), idempotency_key: key() });
    expect(mcpRefused.isError).toBe(true);
    expect(mcpRefused.structuredContent?.error?.code).toBe('RATE_LIMITED');
    const restRefused = await api(contributor, '/api/v1/test-results', { method: 'POST', body: { result: resultFor(project, buildId), build_id: buildId }, key: key() });
    expect(restRefused.status).toBe(429);
    expect(restRefused.json.error.code).toBe('RATE_LIMITED');
    expect(Number(restRefused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(restRefused.json.error.details).toMatchObject({ bucket: 'submissions', limit: 3, window_seconds: 86_400 });

    // Authorizing another client does not reset the account's quota.
    const otherClient = await mcpCall(contributor, 'build_save', { build: buildFor(project), idempotency_key: key() }, 'second-client');
    expect(otherClient.structuredContent?.error?.code).toBe('RATE_LIMITED');

    // Another account keeps its own quota.
    const other = await createAccount();
    expect((await api(other, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() })).status).toBe(201);
  });
});

describe('URLs inside builds', () => {
  it('never fetches a source or model URL a build names, through validation, publication, review, and aggregation', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const operator = await createAccount({ operator: true });
    const outbound = vi.spyOn(globalThis, 'fetch');
    const build = buildFor(project, {
      source: { kind: 'documentation', url: 'http://169.254.169.254/latest/meta-data/', revision: null, project_manifest_digest: project.published.contentDigest },
    });
    build.model_bindings[0]!.source_url = 'https://metadata.google.internal/computeMetadata/v1/';
    const { reportId } = await acceptedRun(project, operator, { build });
    expect(reportId).toBeTruthy();
    expect(outbound).not.toHaveBeenCalled();
  });
});
