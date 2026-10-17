import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, LoopbackClient, RunRegistry, bindModel, capabilityTable } from '../src/index.js';
import { CHECKS, runAdapterConformance } from './support/conformance.js';
import { createFakeTarget, type FakeFlaws } from './support/fake-adapter.js';
import { grant, settings } from './support/conformance.js';

runAdapterConformance('the in-memory fake adapter', async () => createFakeTarget());

describe('the conformance suite detects non-conformant adapters', () => {
  const flaws: Array<[keyof FakeFlaws, string]> = [
    ['remoteAsLocal', 'inspect_model never reports a remote model as local'],
    ['substituteMissing', 'infer on a missing model fails with model_not_found rather than answering from another model'],
    ['dropStream', 'infer streams where supported (first content announced once, before the reply ends) and refuses streaming where not'],
    ['mutatesInventory', 'preflight accepts a local chat model without running inference'],
  ];
  for (const [flaw, checkName] of flaws) {
    it(`flags ${flaw}`, async () => {
      const check = CHECKS.find((candidate) => candidate.name === checkName);
      expect(check, checkName).toBeDefined();
      await expect(check!.run(createFakeTarget({ [flaw]: true }))).rejects.toThrow();
    });
  }
});

describe('capabilityTable', () => {
  it('lists every capability and marks the unreported ones unknown without a source', () => {
    const table = capabilityTable({ chat: { value: 'supported', source: 'provider_metadata' } });
    expect(table.chat.source).toBe('provider_metadata');
    expect(table.vision).toEqual({ value: 'unknown', source: null });
    expect(Object.keys(table)).toHaveLength(9);
  });
});

describe('RunRegistry and bindModel', () => {
  it('aborts only the named run', () => {
    const registry = new RunRegistry();
    const a = registry.begin('a', new AbortController().signal);
    const b = registry.begin('b', new AbortController().signal);
    expect(registry.cancel('a').cancelled).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(registry.cancel('a').cancelled).toBe(false);
  });

  it('binds a model and approval so the harness can call infer without them', async () => {
    const target = createFakeTarget();
    const bound = bindModel(target.adapter, target.models.local, grant);
    const response = await bound.infer(
      { messages: [{ role: 'user', content: 'hi' }], responseSchema: null, settings },
      { signal: new AbortController().signal },
    );
    expect(response.content).toBe('ok');
  });
});

describe('LoopbackClient', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const signal = () => new AbortController().signal;

  it('rejects any endpoint that is not an approved loopback URL', () => {
    for (const endpoint of ['http://192.168.1.5:11434', 'https://example.com', 'http://user:pw@127.0.0.1:1', 'ftp://127.0.0.1', 'nope']) {
      expect(() => new LoopbackClient({ endpoint }), endpoint).toThrow(expect.objectContaining({ code: 'endpoint_not_loopback' }));
    }
  });

  it('sends JSON and the bearer token only to the approved endpoint', async () => {
    let seen: { auth?: string; body?: string; method?: string } = {};
    const endpoint = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString(), method: req.method };
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    const client = new LoopbackClient({ endpoint, credential: 'secret-token' });
    const response = await client.request({ method: 'POST', path: '/x', body: { a: 1 }, signal: signal() });
    expect(response).toEqual({ status: 200, json: { ok: true } });
    expect(seen).toEqual({ auth: 'Bearer secret-token', body: '{"a":1}', method: 'POST' });
  });

  it('refuses paths that could leave the origin', async () => {
    const client = new LoopbackClient({ endpoint: await serve((_, res) => res.end('{}')) });
    for (const path of ['//evil.example/x', 'http://evil.example/x', 'x', '/a\\b']) {
      await expect(client.request({ method: 'GET', path, signal: signal() }), path).rejects.toBeInstanceOf(AdapterError);
    }
  });

  it('does not follow redirects', async () => {
    let other = 0;
    const target = await serve((_, res) => { other += 1; res.end('{}'); });
    const endpoint = await serve((_, res) => { res.statusCode = 302; res.setHeader('location', `${target}/stolen`); res.end(); });
    const client = new LoopbackClient({ endpoint });
    await expect(client.request({ method: 'GET', path: '/', signal: signal() })).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(other).toBe(0);
  });

  it('bounds the response size and requires JSON', async () => {
    const big = await serve((_, res) => res.end('x'.repeat(5000)));
    await expect(new LoopbackClient({ endpoint: big, maxResponseBytes: 1000 }).request({ method: 'GET', path: '/', signal: signal() })).rejects.toMatchObject({ code: 'response_too_large' });
    const text = await serve((_, res) => res.end('not json'));
    await expect(new LoopbackClient({ endpoint: text }).request({ method: 'GET', path: '/', signal: signal() })).rejects.toMatchObject({ code: 'malformed_response' });
    const empty = await serve((_, res) => res.end());
    expect(await new LoopbackClient({ endpoint: empty }).request({ method: 'GET', path: '/', signal: signal() })).toEqual({ status: 200, json: null });
  });

  it('aborts a hung request and reports connection failures with a code', async () => {
    const hung = await serve(() => undefined);
    const controller = new AbortController();
    const pending = new LoopbackClient({ endpoint: hung }).request({ method: 'GET', path: '/', signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(new LoopbackClient({ endpoint: 'http://127.0.0.1:1' }).request({ method: 'GET', path: '/', signal: signal() })).rejects.toMatchObject({ code: 'connection_error' });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(new LoopbackClient({ endpoint: hung }).request({ method: 'GET', path: '/', signal: preAborted.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});
