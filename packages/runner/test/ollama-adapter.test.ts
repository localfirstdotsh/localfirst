import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_TEST_YAML, parseSafeYaml, testManifestSchema } from '@localfirst/contracts';
import {
  AdapterError,
  OLLAMA_ALLOWED_ROUTES,
  OllamaAdapter,
  bindModel,
  mapOllamaResponseSchema,
  runTest,
  toOllamaProviderStats,
} from '../src/index.js';
import { grant, runAdapterConformance, settings } from './support/conformance.js';
import { CLOUD, LOCAL, THINKER, UNKNOWN_LOCALITY, ollamaTarget, startFakeOllama } from './support/fake-ollama.js';

runAdapterConformance('Ollama adapter', ollamaTarget);

const msg = [{ role: 'user' as const, content: 'Reply with exactly: ok' }];
const live = () => new AbortController().signal;
const ask = (adapter: OllamaAdapter, model: string, extra: Partial<typeof settings> = {}, schema: unknown = null) =>
  adapter.infer({ model, grant, messages: msg, responseSchema: schema, settings: { ...settings, ...extra } }, { signal: live() });
const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', (cause) => (cause as AdapterError).code);
const req = (local: string) => ({ model: local, requirements: { capabilities: ['chat'] as never, locality: 'local_required' as const, settings, structured_output: false } });

describe('probe and discovery', () => {
  it('reads the server version from /api/version and leaves CLI and engine unobserved', async () => {
    const fake = await startFakeOllama();
    const probe = await new OllamaAdapter({ endpoint: fake.url }).probe();
    expect(probe).toMatchObject({ family: 'ollama', api_profile: 'ollama-native/v0.1', reachable: true, failure: null });
    expect(probe.versions).toEqual({
      application: { value: '0.35.1', source: 'GET /api/version' },
      cli: { value: null, source: null },
      engine: { value: null, source: null },
    });
    fake.version = () => ({ raw: 'not json' });
    expect(await new OllamaAdapter({ endpoint: fake.url }).probe()).toMatchObject({ reachable: false, failure: 'malformed_response' });
    fake.version = () => ({ json: { version: 42 } });
    expect((await new OllamaAdapter({ endpoint: fake.url }).probe()).reachable).toBe(false);
    await fake.close();
    expect(await new OllamaAdapter({ endpoint: fake.url }).probe()).toMatchObject({ reachable: false, failure: 'connection_error' });
  });

  it('keeps loaded and available apart and carries the manifest digest as runtime identity', async () => {
    const fake = await startFakeOllama();
    const entries = await new OllamaAdapter({ endpoint: fake.url }).list_models();
    const byId = Object.fromEntries(entries.map((entry) => [entry.runtime_model_id, entry]));
    expect(byId[LOCAL]?.state).toBe('loaded');
    expect(byId['qwen3.6:27b']?.state).toBe('available');
    expect(byId[LOCAL]?.artifact_identity).toEqual({
      scheme: 'ollama_manifest_sha256',
      digest: 'sha256:65ec06548149b04c096a120e4a6da9d4017ea809c91734ea5631e89f96ddc57b',
      reference: null,
    });
    expect(byId[UNKNOWN_LOCALITY]?.artifact_identity).toBeNull();
    expect(byId[LOCAL]?.context_tokens).toBe(32768);
    await fake.close();
  });

  it('maps reported capabilities with a source and leaves the rest unknown', async () => {
    const fake = await startFakeOllama();
    const details = await new OllamaAdapter({ endpoint: fake.url }).inspect_model(LOCAL);
    expect(details.capabilities.chat).toEqual({ value: 'supported', source: 'provider_metadata' });
    expect(details.capabilities.tool_calls).toEqual({ value: 'supported', source: 'provider_metadata' });
    expect(details.capabilities.json_output).toEqual({ value: 'supported', source: 'tested_adapter_profile' });
    expect(details.capabilities.vision).toEqual({ value: 'unknown', source: null });
    expect(details.capabilities.reasoning).toEqual({ value: 'unknown', source: null });
    expect(details).toMatchObject({ quantization: 'Q4_K_M', format: 'gguf', context_tokens: 32768 });
    expect(details.effective_options.max_context_tokens).toEqual({ value: 32768, source: 'POST /api/show' });
    expect((await new OllamaAdapter({ endpoint: fake.url }).inspect_model(THINKER)).capabilities.reasoning.value).toBe('supported');
    await fake.close();
  });
});

describe('locality fails closed', () => {
  it('rejects cloud models for local-only runs, by marker and by name', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    expect((await adapter.inspect_model(CLOUD)).locality).toEqual({ value: 'remote', method: 'adapter_preflight', reason: 'cloud_model' });
    const result = await adapter.preflight(req(CLOUD));
    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toContain('model_remote');

    // Name-only cloud routing, without remote_* fields.
    const bare = { ...fake.tags.find((tag) => tag.name === CLOUD)! };
    delete bare.remote_host;
    delete bare.remote_model;
    bare.name = bare.model = 'other:cloud';
    fake.tags.push({ ...bare, details: { format: 'gguf' }, size: 5 });
    fake.show['other:cloud'] = { details: { format: 'gguf' }, capabilities: ['completion'], model_info: {} };
    expect((await adapter.inspect_model('other:cloud')).locality.value).toBe('remote');
    await fake.close();
  });

  it('treats a model with no locality signal as unknown and blocks it', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    expect((await adapter.inspect_model(UNKNOWN_LOCALITY)).locality).toMatchObject({ value: 'unknown', reason: 'no_locality_signal' });
    const strict = await adapter.preflight(req(UNKNOWN_LOCALITY));
    expect(strict.blockers.map((blocker) => blocker.code)).toContain('locality_unknown');
    const relaxed = await adapter.preflight({ ...req(UNKNOWN_LOCALITY), requirements: { ...req(UNKNOWN_LOCALITY).requirements, locality: 'local_preferred' } });
    expect(relaxed.blockers.map((blocker) => blocker.code)).not.toContain('locality_unknown');
    expect(relaxed.unknowns.map((finding) => finding.code)).toContain('locality_unknown');
    await fake.close();
  });
});

describe('preflight', () => {
  it('blocks context above the model limit and unreachable runtimes, without inference', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    const big = { ...req(LOCAL), requirements: { ...req(LOCAL).requirements, settings: { ...settings, context_tokens: 100_000 } } };
    expect((await adapter.preflight(big)).blockers.map((blocker) => blocker.code)).toContain('context_exceeded');
    expect(fake.requests.some((request) => request.path === '/api/chat')).toBe(false);
    const ok = await adapter.preflight(req(LOCAL));
    expect(ok.effects).toEqual({ may_load_model: false, model_state: 'loaded' });
    await fake.close();
    const down = await adapter.preflight(req(LOCAL));
    expect(down.blockers.map((blocker) => blocker.code)).toEqual(['runtime_unreachable']);
  });

  it('reports that an installed but unloaded model may need loading', async () => {
    const fake = await startFakeOllama();
    fake.loaded = [];
    const result = await new OllamaAdapter({ endpoint: fake.url }).preflight(req(LOCAL));
    expect(result.effects).toEqual({ may_load_model: true, model_state: 'available' });
    await fake.close();
  });
});

describe('infer request mapping', () => {
  const manifest = testManifestSchema.parse(parseSafeYaml(EXAMPLE_TEST_YAML));

  it('sends the exact native body for the PRD example manifest', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    await runTest({ manifest, adapter: bindModel(adapter, LOCAL, grant) });
    const chat = fake.requests.find((request) => request.path === '/api/chat');
    expect(chat?.body).toEqual({
      model: LOCAL,
      messages: [
        { role: 'system', content: 'Return a JSON object with label billing, support, or other.' },
        { role: 'user', content: 'Please explain the charge on my invoice.' },
      ],
      stream: false,
      format: {
        type: 'object',
        properties: { label: { type: 'string', enum: ['billing', 'support', 'other'] } },
        required: ['label'],
        additionalProperties: false,
      },
      options: { temperature: 0, num_predict: 32, num_ctx: 4096 },
    });
    await fake.close();
  });

  it('runs the PRD example end to end: the fixture reply "ok" is not the JSON label, so the case fails honestly', async () => {
    const fake = await startFakeOllama();
    const run = await runTest({ manifest, adapter: bindModel(new OllamaAdapter({ endpoint: fake.url }), LOCAL, grant) });
    expect(run.state).toBe('completed');
    expect(run.cases[0]).toMatchObject({ outcome: 'fail', error_code: 'invalid_json', output_text: 'ok' });
    fake.chat = (body) => ({ json: { ...JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/ollama/0.35.1/chat-structured.json', import.meta.url)), 'utf8')), model: body.model, message: { role: 'assistant', content: '{"label":"billing"}' } } });
    const passing = await runTest({ manifest, adapter: bindModel(new OllamaAdapter({ endpoint: fake.url }), LOCAL, grant) });
    expect(passing.cases[0]).toMatchObject({ outcome: 'pass' });
    expect(passing.cases[0]?.provider_stats).toMatchObject({ provider: 'ollama_native_v1', eval_count: 7 });
    await fake.close();
  });

  it('adds seed and think:false only when they apply', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    await ask(adapter, LOCAL, { seed: 7, reasoning: 'disabled' });
    await ask(adapter, THINKER, { reasoning: 'disabled', context_tokens: 4096 });
    const bodies = fake.requests.filter((request) => request.path === '/api/chat').map((request) => request.body);
    expect(bodies[0].options.seed).toBe(7);
    expect(bodies[0]).not.toHaveProperty('think');
    expect(bodies[1].think).toBe(false);
    expect(bodies[1].options).not.toHaveProperty('seed');
    await fake.close();
  });

  it('fails on options it cannot honour instead of dropping them', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    expect(await code(ask(adapter, LOCAL, {}, { type: 'object', patternProperties: {} }))).toBe('option_unsupported');
    expect(await code(ask(adapter, LOCAL, {}, { type: 'object', properties: { a: { type: 'null' } } }))).toBe('option_unsupported');
    expect(await code(ask(adapter, LOCAL, { context_tokens: 100_000 }))).toBe('option_unsupported');
    expect(fake.requests.some((request) => request.path === '/api/chat')).toBe(false);
    expect(() => mapOllamaResponseSchema({ type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } } } } } })).toThrow(/deeply/);
    await fake.close();
  });
});

describe('provider statistics', () => {
  const body = { eval_count: 2, eval_duration: 7_130_000, total_duration: 1_469_404_167, load_duration: 1_291_984_459, prompt_eval_count: 34, prompt_eval_duration: 167_514_000, done_reason: 'stop' };

  it('keeps native nanoseconds and adds clearly named derived values', () => {
    const stats = toOllamaProviderStats(body);
    expect(stats).toMatchObject({ provider: 'ollama_native_v1', eval_duration: 7_130_000, total_duration: 1_469_404_167, done_reason: 'stop' });
    expect(stats.derived_total_ms).toBeCloseTo(1469.404167, 6);
    expect(stats.derived_load_ms).toBeCloseTo(1291.984459, 6);
    expect(stats.derived_eval_ms).toBeCloseTo(7.13, 6);
    expect(stats.derived_tokens_per_second).toBeCloseTo(280.5, 1);
  });

  it('rejects a zero or missing generation duration instead of reporting infinity', () => {
    expect(toOllamaProviderStats({ ...body, eval_duration: 0 }).derived_tokens_per_second).toBeNull();
    expect(toOllamaProviderStats({ eval_count: 5 }).derived_tokens_per_second).toBeNull();
    expect(toOllamaProviderStats({ ...body, eval_count: 0 }).derived_tokens_per_second).toBeNull();
    expect(toOllamaProviderStats({ ...body, eval_duration: -5 }).derived_tokens_per_second).toBeNull();
  });
});

describe('failures', () => {
  it('maps a missing model to model_not_found on infer, inspect and preflight', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    expect(await code(ask(adapter, 'nope:0b'))).toBe('model_not_found');
    expect(await code(adapter.inspect_model('nope:0b'))).toBe('model_not_found');
    expect((await adapter.preflight(req('nope:0b'))).blockers[0]?.code).toBe('model_not_found');
    fake.chat = () => ({ status: 404, json: { error: "model 'x' not found" } });
    fake.tags.push({ ...fake.tags[0]!, name: 'ghost:1b', model: 'ghost:1b' });
    fake.show['ghost:1b'] = fake.show[LOCAL]!;
    expect(await code(ask(adapter, 'ghost:1b'))).toBe('model_not_found');
    await fake.close();
  });

  it('turns malformed responses into malformed_response', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    const cases: Array<() => ReturnType<(typeof fake)['chat']>> = [
      () => ({ raw: '{not json' }),
      () => ({ raw: '' , status: 200 }),
      () => ({ json: { model: LOCAL, done: true } }),
      () => ({ json: { model: LOCAL, message: { content: 5 }, done: true } }),
      () => ({ json: { model: LOCAL, message: { content: 'ok' }, done: false } }),
      () => ({ json: { model: 'some-other-model:1b', message: { content: 'ok' }, done: true } }),
      () => ({ json: [] }),
    ];
    for (const answer of cases) {
      fake.chat = answer;
      expect(await code(ask(adapter, LOCAL))).toBe('malformed_response');
    }
    fake.chat = () => ({ status: 500, json: { error: 'boom' } });
    expect(await code(ask(adapter, LOCAL))).toBe('provider_error');
    fake.tags = 'nope' as never;
    expect(await code(adapter.list_models())).toBe('malformed_response');
    await fake.close();
  });

  it('accepts the implicit :latest tag in the response model name', async () => {
    const fake = await startFakeOllama();
    fake.tags.push({ ...fake.tags[0]!, name: 'plain:latest', model: 'plain:latest' });
    fake.show['plain:latest'] = fake.show[LOCAL]!;
    fake.chat = () => ({ json: { model: 'plain:latest', message: { content: 'ok' }, done: true } });
    expect((await ask(new OllamaAdapter({ endpoint: fake.url }), 'plain:latest')).content).toBe('ok');
    await fake.close();
  });

  it('bounds a hung request with the caller signal and surfaces a cancel as aborted', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    fake.chat = () => ({ hang: true });
    const timed = adapter.infer({ model: LOCAL, grant, messages: msg, responseSchema: null, settings }, { signal: AbortSignal.timeout(60) });
    expect(await code(timed)).toBe('aborted');
    const run = await runTest({
      manifest: testManifestSchema.parse({ ...(parseSafeYaml(EXAMPLE_TEST_YAML) as object), limits: { max_cases: 1, request_timeout_ms: 50, run_timeout_ms: 1000, max_response_bytes: 65536 } }),
      adapter: bindModel(adapter, LOCAL, grant),
    });
    expect(run.cases[0]).toMatchObject({ outcome: 'error', error_code: 'request_timeout' });
    await fake.close();
  });
});

describe('boundaries', () => {
  it('only ever requests the allowed read and chat routes, never pull, create, delete, or copy', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url });
    await adapter.probe();
    await adapter.list_models();
    await adapter.inspect_model(LOCAL);
    await adapter.preflight(req(LOCAL));
    await ask(adapter, LOCAL);
    await adapter.measure({ metric: 'peak_memory_bytes', intervalMs: 10 });
    await code(ask(adapter, 'nope:0b'));
    const seen = new Set(fake.requests.map((request) => `${request.method} ${request.path}`));
    for (const route of seen) expect(OLLAMA_ALLOWED_ROUTES as readonly string[]).toContain(route);
    expect([...seen].join(' ')).not.toMatch(/pull|create|delete|copy|push|blobs/);
    await fake.close();
  });

  it('refuses a non-loopback endpoint at construction', () => {
    for (const endpoint of ['http://192.168.1.5:11434', 'https://ollama.com', 'http://user:pw@127.0.0.1:11434']) {
      expect(() => new OllamaAdapter({ endpoint })).toThrow(expect.objectContaining({ code: 'endpoint_not_loopback' }));
    }
  });

  it('never sends the credential anywhere but the approved endpoint and does not leak it in errors', async () => {
    const fake = await startFakeOllama();
    const adapter = new OllamaAdapter({ endpoint: fake.url, credential: 'tok-secret-123' });
    fake.chat = () => ({ status: 500, json: { error: 'boom' } });
    const error = await ask(adapter, LOCAL).then(() => null, (cause: Error) => cause);
    expect(String((error as Error).message)).not.toContain('tok-secret-123');
    await fake.close();
  });
});
