import { readFileSync, readdirSync } from 'node:fs';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_REQUESTS,
  AdapterError,
  LmStudioAdapter,
  bindModel,
  engineFacts,
  mapNativeRequest,
  mapOpenAiRequest,
  parseAppVersion,
  parseLmsVersion,
  parseNativeChat,
  parseNativeModels,
  parseOpenAiChat,
  parseRuntimeList,
  runTest,
  summarizeEngines,
  unobserved,
  type PreflightRequest,
  type VersionSource,
} from '../src/index.js';
import { grant, settings } from './support/conformance.js';
import {
  EMBEDDING_MODEL,
  LOCAL_MODEL,
  MISSING_MODEL,
  REMOTE_MODEL,
  UNKNOWN_ORIGIN_MODEL,
  startFakeLmStudio,
  type FakeLmStudio,
  type FakeOptions,
} from './support/fake-lmstudio.js';
import { exampleManifest } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/lmstudio/', import.meta.url));
const read = (name: string) => readFileSync(`${FIXTURES}${name}`, 'utf8');

const open: FakeLmStudio[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});
async function start(options: FakeOptions = {}) {
  const fake = await startFakeLmStudio(options);
  open.push(fake);
  return fake;
}

const signal = () => new AbortController().signal;
const preflight = (model: string, over: Partial<PreflightRequest['requirements']> = {}): PreflightRequest => ({
  model,
  requirements: { capabilities: ['chat'], locality: 'local_required', settings, structured_output: false, ...over },
});
const message = [{ role: 'user' as const, content: 'Reply with exactly: ok' }];
const codes = (findings: Array<{ code: string }>) => findings.map((finding) => finding.code);

describe('discovery', () => {
  it('uses native discovery: loaded versus available, capabilities with sources, no embedding models', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const models = await adapter.list_models();
    expect(models.map((model) => model.runtime_model_id)).not.toContain(EMBEDDING_MODEL);

    const local = models.find((model) => model.runtime_model_id === LOCAL_MODEL)!;
    expect(local.state).toBe('loaded');
    expect(local.context_tokens).toBe(8192);
    expect(local.size_bytes).toBe(771933305);
    expect(local.capabilities.chat).toEqual({ value: 'supported', source: 'provider_metadata' });
    expect(local.capabilities.vision).toEqual({ value: 'unsupported', source: 'provider_metadata' });
    expect(local.capabilities.tool_calls).toEqual({ value: 'unsupported', source: 'provider_metadata' });
    expect(local.capabilities.json_output).toEqual({ value: 'supported', source: 'tested_adapter_profile' });
    expect(local.capabilities.reasoning).toEqual({ value: 'unknown', source: null });
    // A runtime key is not a weight hash.
    expect(local.artifact_identity).toEqual({ scheme: 'lmstudio_model_key', digest: null, reference: 'google/gemma-3-1b@4bit' });

    const available = models.find((model) => model.runtime_model_id === REMOTE_MODEL)!;
    expect(available.state).toBe('available');
    expect(available.context_tokens).toBeNull();
    expect(fake.requests.map((request) => request.path)).toEqual(['/api/v1/models']);
  });

  it('inspects effective options from the loaded instance and reports unknown models', async () => {
    const adapter = new LmStudioAdapter({ endpoint: (await start()).endpoint });
    const details = await adapter.inspect_model(`${LOCAL_MODEL}@4bit`);
    expect(details).toMatchObject({ quantization: '4bit', format: 'mlx' });
    expect(details.effective_options.context_length).toEqual({ value: 8192, source: 'GET /api/v1/models' });
    expect(details.effective_options.max_context_length?.value).toBe(32768);
    await expect(adapter.inspect_model(MISSING_MODEL)).rejects.toMatchObject({ code: 'model_not_found' });
  });

  it('falls back to /v1/models with every capability unknown and locality unestablished', async () => {
    const fake = await start({ native: false });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const models = await adapter.list_models();
    const local = models.find((model) => model.runtime_model_id === LOCAL_MODEL)!;
    for (const capability of Object.values(local.capabilities)) expect(capability).toEqual({ value: 'unknown', source: null });
    expect(local.locality).toEqual({ value: 'unknown', method: 'unknown', reason: 'no_origin_metadata' });
    expect(local.context_tokens).toBeNull();
    expect(fake.requests.map((request) => request.path)).toEqual(['/api/v1/models', '/v1/models']);

    const result = await adapter.preflight(preflight(LOCAL_MODEL));
    expect(result.ok).toBe(false);
    expect(codes(result.blockers)).toEqual(expect.arrayContaining(['locality_unknown', 'capability_unknown']));
    expect((await adapter.probe()).api_profile).toBe('lmstudio-openai-compat/v1');
  });

  it('falls back when the native listing is malformed, and reports an unreachable runtime', async () => {
    expect(parseNativeModels({ models: [{ no: 'key' }] })).toBeNull();
    expect(parseNativeModels('nope')).toBeNull();
    const adapter = new LmStudioAdapter({ endpoint: 'http://127.0.0.1:1' });
    const probe = await adapter.probe();
    expect(probe).toMatchObject({ reachable: false, failure: 'connection_error' });
    const result = await adapter.preflight(preflight(LOCAL_MODEL));
    expect(codes(result.blockers)).toEqual(['runtime_unreachable']);
  });
});

describe('preflight', () => {
  it('accepts a loaded local MLX model with structured output and reports the effect', async () => {
    const adapter = new LmStudioAdapter({ endpoint: (await start()).endpoint });
    const result = await adapter.preflight(preflight(LOCAL_MODEL, { capabilities: ['chat', 'json_output'], structured_output: true }));
    expect(result).toMatchObject({ ok: true, blockers: [], effects: { may_load_model: false, model_state: 'loaded' } });
  });

  it('blocks a case when the structured-output profile is untested for the model format', async () => {
    const fake = await start();
    fake.editNativeModels((models) => {
      models.find((model) => model.key === LOCAL_MODEL).format = 'gguf';
    });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const result = await adapter.preflight(preflight(LOCAL_MODEL, { structured_output: true }));
    expect(codes(result.blockers)).toEqual(['profile_untested']);
    await expect(
      adapter.infer(
        { model: LOCAL_MODEL, grant, messages: message, responseSchema: { type: 'object' }, settings },
        { signal: signal() },
      ),
    ).rejects.toMatchObject({ code: 'option_unsupported' });
    expect(fake.requests.some((request) => request.path === '/v1/chat/completions')).toBe(false);
    // Plain chat on the same model is still fine.
    expect((await adapter.preflight(preflight(LOCAL_MODEL))).ok).toBe(true);
  });

  it('fails local-only runs for remote-linked and unknown-origin models (synthetic fixtures)', async () => {
    const adapter = new LmStudioAdapter({ endpoint: (await start()).endpoint });
    const remote = await adapter.preflight(preflight(REMOTE_MODEL));
    expect(codes(remote.blockers)).toContain('model_remote');
    expect((await adapter.inspect_model(REMOTE_MODEL)).locality).toEqual({ value: 'remote', method: 'adapter_preflight', reason: 'remote_linked' });

    const unknown = await adapter.preflight(preflight(UNKNOWN_ORIGIN_MODEL));
    expect(codes(unknown.blockers)).toContain('locality_unknown');
    expect((await adapter.inspect_model(UNKNOWN_ORIGIN_MODEL)).locality.value).toBe('unknown');

    const preferred = await adapter.preflight(
      preflight(REMOTE_MODEL, { locality: 'local_preferred' }),
    );
    expect(codes(preferred.blockers)).not.toContain('model_remote');
    expect(codes(preferred.unknowns)).toContain('model_remote');
  });

  it('never treats a non-local format or a zero-sized entry as local', async () => {
    const fake = await start();
    fake.editNativeModels((models) => {
      models.find((model) => model.key === LOCAL_MODEL).format = 'cloud-proxy';
    });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    expect((await adapter.inspect_model(LOCAL_MODEL)).locality.value).toBe('remote');
    fake.editNativeModels((models) => {
      const entry = models.find((model) => model.key === LOCAL_MODEL);
      entry.format = 'mlx';
      entry.size_bytes = 0;
    });
    expect((await adapter.inspect_model(LOCAL_MODEL)).locality.value).toBe('unknown');
  });

  it('blocks unsupported critical options and too-small loaded context instead of dropping them', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const reasoning = await adapter.preflight(preflight(LOCAL_MODEL, { settings: { ...settings, reasoning: 'disabled' } }));
    expect(codes(reasoning.blockers)).toEqual(['option_unsupported']);
    // Streaming is mapped on the OpenAI-compatible profile and refused on the untested native one.
    const stream = await adapter.preflight(preflight(LOCAL_MODEL, { settings: { ...settings, stream: true } }));
    expect(codes(stream.blockers)).toEqual([]);
    const native = new LmStudioAdapter({ endpoint: fake.endpoint, chatProfile: 'native_v1' });
    const nativeStream = await native.preflight(preflight(LOCAL_MODEL, { settings: { ...settings, stream: true } }));
    expect(codes(nativeStream.blockers)).toEqual(['stream_unsupported']);
    const context = await adapter.preflight(preflight(LOCAL_MODEL, { settings: { ...settings, context_tokens: 16384 } }));
    expect(codes(context.blockers)).toEqual(['context_exceeded']);
    const audio = await adapter.preflight(preflight(LOCAL_MODEL, { capabilities: ['audio_input'] }));
    expect(codes(audio.blockers)).toEqual(['capability_unknown']);
    const embedding = await adapter.preflight(preflight(EMBEDDING_MODEL));
    expect(codes(embedding.blockers)).toContain('capability_unsupported');
  });

  it('notes that context for an unloaded model is unknown rather than guessing', async () => {
    const adapter = new LmStudioAdapter({ endpoint: (await start()).endpoint });
    const result = await adapter.preflight(preflight(REMOTE_MODEL, { locality: 'local_preferred' }));
    expect(codes(result.unknowns)).toContain('context_exceeded');
    expect(result.effects).toEqual({ may_load_model: true, model_state: 'available' });
  });
});

describe('infer', () => {
  it('maps the PRD example request exactly and returns usage tagged by provider', async () => {
    const fake = await start({ content: '{"label":"billing"}' });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const manifest = exampleManifest();
    const response = await adapter.infer(
      {
        model: LOCAL_MODEL,
        grant,
        messages: manifest.cases[0]!.messages,
        responseSchema: manifest.response_schema,
        settings: { ...manifest.inference },
      },
      { signal: signal() },
    );
    const chat = fake.requests.find((request) => request.path === '/v1/chat/completions')!;
    expect(chat.body).toEqual({
      model: LOCAL_MODEL,
      messages: manifest.cases[0]!.messages,
      stream: false,
      temperature: 0,
      max_tokens: 32,
      response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: manifest.response_schema } },
    });
    expect(response.content).toBe('{"label":"billing"}');
    expect(response.providerStats).toMatchObject({
      provider: 'lmstudio_openai_compat_v1',
      finish_reason: 'stop',
      usage_prompt_tokens: 13,
      usage_completion_tokens: 7,
    });
  });

  it('sends a seed only when one is set and resolves a key@variant request', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    await adapter.infer({ model: `${LOCAL_MODEL}@4bit`, grant, messages: message, responseSchema: null, settings: { ...settings, seed: 7 } }, { signal: signal() });
    expect(fake.requests.at(-1)!.body).toMatchObject({ model: `${LOCAL_MODEL}@4bit`, seed: 7 });
  });

  it('detects the silent substitution of an unknown model by the loaded one', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    await expect(
      adapter.infer({ model: MISSING_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'model_not_found' });
    // The server really did answer HTTP 200 with content: only the model comparison caught it.
    expect(fake.requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(1);
    expect(() => parseOpenAiChat('a/b', JSON.parse(read('chat-completions.json')))).toThrow(/different model/);
    expect(parseOpenAiChat(LOCAL_MODEL, JSON.parse(read('chat-completions.json'))).content).toBe('ok\n');
  });

  it('rejects malformed provider bodies', () => {
    const good = JSON.parse(read('chat-completions.json'));
    const bad: unknown[] = [
      null,
      'text',
      {},
      { ...good, model: undefined },
      { ...good, choices: [] },
      { ...good, choices: [{ message: { content: 42 } }] },
      { ...good, choices: [{ message: {} }] },
    ];
    for (const body of bad) {
      expect(() => parseOpenAiChat(LOCAL_MODEL, body), JSON.stringify(body)).toThrow(expect.objectContaining({ code: expect.stringMatching(/malformed_response/) }));
    }
    for (const body of [null, {}, { model_instance_id: LOCAL_MODEL }, { model_instance_id: LOCAL_MODEL, output: [{ type: 'reasoning', content: 'x' }] }]) {
      expect(() => parseNativeChat(LOCAL_MODEL, body)).toThrow(AdapterError);
    }
  });

  it('maps HTTP errors to stable codes', async () => {
    const adapter = new LmStudioAdapter({ endpoint: (await start({ token: 'right' })).endpoint });
    await expect(adapter.infer({ model: LOCAL_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(adapter.list_models()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('times out a slow runtime through the caller signal and bounds discovery', async () => {
    const fake = await start({ delayMs: 400 });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint, discoveryTimeoutMs: 60 });
    await expect(
      adapter.infer({ model: LOCAL_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: AbortSignal.timeout(60) }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(await adapter.probe()).toMatchObject({ reachable: false, failure: 'aborted' });
  });

  it('refuses options it cannot honour before sending anything', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const native = new LmStudioAdapter({ endpoint: fake.endpoint, chatProfile: 'native_v1' });
    for (const [target, bad] of [
      [adapter, { ...settings, reasoning: 'disabled' as const }],
      [native, { ...settings, stream: true }],
    ] as const) {
      await expect(target.infer({ model: LOCAL_MODEL, grant, messages: message, responseSchema: null, settings: bad }, { signal: signal() })).rejects.toMatchObject({ code: 'option_unsupported' });
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('server token', () => {
  const token = 'lms-secret-TOKEN-8f3a1c';

  it('is sent as a bearer only to the approved endpoint and works when correct', async () => {
    const fake = await start({ token });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint, credential: token });
    expect((await adapter.list_models()).length).toBeGreaterThan(0);
    expect(fake.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
  });

  it('never appears in errors, serialization, or inspection', async () => {
    const fake = await start({ token: 'a-different-token' });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint, credential: token });
    const failure = await adapter.list_models().then(() => null, (cause: unknown) => cause as AdapterError);
    expect(failure).toBeInstanceOf(AdapterError);
    const probe = await adapter.probe();
    for (const text of [
      String(failure),
      (failure as Error).message,
      (failure as Error).stack ?? '',
      JSON.stringify(adapter),
      inspect(adapter, { depth: 10 }),
      JSON.stringify(probe),
    ]) {
      expect(text).not.toContain(token);
    }
    // The fake echoes the Authorization header in its 401 body; the adapter must not relay it.
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${token}`);
  });
});

describe('native chat profile', () => {
  it('sends only the evidenced fields with storage off, and tags native statistics', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint, chatProfile: 'native_v1' });
    const response = await adapter.infer({ model: LOCAL_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() });
    const sent = fake.requests.find((request) => request.path === '/api/v1/chat')!.body;
    expect(sent).toEqual({ model: LOCAL_MODEL, input: 'Reply with exactly: ok', store: false, temperature: 0, max_output_tokens: 32 });
    for (const inherited of ['integrations', 'tools', 'previous_response_id', 'chat_id', 'mcp', 'system_prompt']) {
      expect(sent).not.toHaveProperty(inherited);
    }
    expect(response.content).toBe('ok\n');
    expect(response.providerStats).toEqual({
      provider: 'lmstudio_native_v1',
      'provider_native.tokens_per_second': 263.6619052842064,
      'provider_native.time_to_first_token_seconds': 0.189,
      'provider_native.input_tokens': 14,
      'provider_native.total_output_tokens': 3,
      'provider_native.reasoning_output_tokens': 0,
    });
  });

  it('maps its 404 to model_not_found and refuses untested mappings', async () => {
    const fake = await start();
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint, chatProfile: 'native_v1' });
    await expect(adapter.infer({ model: MISSING_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() })).rejects.toMatchObject({ code: 'model_not_found' });
    const refused = [
      { messages: [...message, { role: 'user' as const, content: 'again' }], responseSchema: null, settings },
      { messages: [{ role: 'system' as const, content: 's' }, ...message], responseSchema: null, settings },
      { messages: message, responseSchema: { type: 'object' }, settings },
      { messages: message, responseSchema: null, settings: { ...settings, seed: 1 } },
    ];
    for (const request of refused) {
      await expect(adapter.infer({ model: LOCAL_MODEL, grant, ...request }, { signal: signal() })).rejects.toMatchObject({ code: 'option_unsupported' });
    }
    const blocked = await adapter.preflight(preflight(LOCAL_MODEL, { structured_output: true }));
    expect(codes(blocked.blockers)).toEqual(['profile_untested']);
    expect(() => mapNativeRequest(LOCAL_MODEL, { messages: message, responseSchema: null, settings })).not.toThrow();
  });
});

describe('versions', () => {
  it('parses the CLI commit and never reports it as an engine', () => {
    const cli = parseLmsVersion(read('lms-version.txt'));
    expect(cli).toEqual({ value: '71bd99c', source: 'lms version' });
    expect(parseLmsVersion('no version here')).toEqual(unobserved());
  });

  it('parses the selected engine per model format from the runtime list', () => {
    const list = parseRuntimeList(read('lms-runtime-ls.txt'));
    expect(list.engines).toHaveLength(5);
    expect(list.selected).toEqual({
      gguf: 'llama.cpp-mac-arm64-apple-metal-advsimd@2.51.0',
      mlx: 'mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0',
    });
    expect(list.engines.filter((engine) => engine.selected).map((engine) => engine.version)).toEqual(['2.51.0', '1.11.0']);
    expect(summarizeEngines(engineFacts(list))).toEqual({
      value: 'gguf=llama.cpp-mac-arm64-apple-metal-advsimd@2.51.0;mlx=mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0',
      source: 'lms runtime ls',
    });
    expect(parseRuntimeList('garbage\n\n')).toEqual({ engines: [], selected: {} });
    expect(summarizeEngines({})).toEqual(unobserved());
  });

  it('parses the app version from plutil and XML plist text', () => {
    expect(parseAppVersion(read('app-info-plist-excerpt.txt'))).toEqual({ value: '0.4.20+1', source: 'Info.plist CFBundleShortVersionString' });
    expect(parseAppVersion('<key>CFBundleShortVersionString</key>\n<string>0.9.1</string>').value).toBe('0.9.1');
    expect(parseAppVersion('<key>CFBundleVersion</key><string>5</string>')).toEqual(unobserved());
  });

  it('keeps application, CLI, and engine separate in the probe, defaulting to unobserved', async () => {
    const fake = await start();
    const bare = await new LmStudioAdapter({ endpoint: fake.endpoint }).probe();
    expect(bare.versions).toEqual({ application: unobserved(), cli: unobserved(), engine: unobserved() });
    expect(bare).toMatchObject({ reachable: true, api_profile: 'lmstudio-native/v1', family: 'lmstudio' });

    const source: VersionSource = {
      read: async () => ({
        application: parseAppVersion(read('app-info-plist-excerpt.txt')),
        cli: parseLmsVersion(read('lms-version.txt')),
        engines: engineFacts(parseRuntimeList(read('lms-runtime-ls.txt'))),
      }),
    };
    const probe = await new LmStudioAdapter({ endpoint: fake.endpoint, versions: source }).probe();
    expect(probe.versions.application.value).toBe('0.4.20+1');
    expect(probe.versions.cli.value).toBe('71bd99c');
    expect(probe.versions.engine.value).toContain('mlx=mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0');
    expect(probe.versions.engine.value).not.toContain('71bd99c');
  });
});

describe('request mapping', () => {
  it('rejects mappings that would drop a setting', () => {
    const request = { messages: message, responseSchema: null, settings };
    expect(() => mapNativeRequest(LOCAL_MODEL, { ...request, settings: { ...settings, stream: true } })).toThrow(/no tested streaming mapping/);
    expect(mapOpenAiRequest(LOCAL_MODEL, request, 'mlx')).toMatchObject({ stream: false });
    expect(mapOpenAiRequest(LOCAL_MODEL, request, 'mlx')).not.toHaveProperty('stream_options');
    expect(mapOpenAiRequest(LOCAL_MODEL, { ...request, settings: { ...settings, stream: true } }, 'mlx')).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(() => mapOpenAiRequest(LOCAL_MODEL, { ...request, responseSchema: { type: 'object' } }, 'gguf')).toThrow(/profile_untested/);
    expect(() => mapOpenAiRequest(LOCAL_MODEL, { ...request, responseSchema: { type: 'object' } }, null)).toThrow(AdapterError);
    expect(mapOpenAiRequest(LOCAL_MODEL, { ...request, responseSchema: { type: 'object' } }, 'mlx')).toHaveProperty('response_format.json_schema.strict', true);
  });
});

describe('network and mutation boundary', () => {
  it('only ever requests read and chat endpoints across a full session', async () => {
    const fake = await start();
    const openai = new LmStudioAdapter({ endpoint: fake.endpoint });
    const native = new LmStudioAdapter({ endpoint: fake.endpoint, chatProfile: 'native_v1' });
    for (const adapter of [openai, native]) {
      await adapter.probe();
      await adapter.list_models();
      await adapter.inspect_model(LOCAL_MODEL);
      await adapter.preflight(preflight(LOCAL_MODEL));
      await adapter.infer({ model: LOCAL_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() });
      await adapter.infer({ model: MISSING_MODEL, grant, messages: message, responseSchema: null, settings }, { signal: signal() }).catch(() => undefined);
      await adapter.measure({ metric: 'peak_memory_bytes', intervalMs: 100 });
    }
    const allowed = new Set(ALLOWED_REQUESTS.map((entry) => `${entry.method} ${entry.path}`));
    const seen = new Set(fake.requests.map((request) => `${request.method} ${request.path}`));
    expect(seen.size).toBeGreaterThan(2);
    for (const request of seen) expect(allowed.has(request), request).toBe(true);
    expect([...seen].some((request) => /load|unload|download|config|server\/|pull|delete/i.test(request))).toBe(false);
  });

  it('contains no model-management endpoint in the adapter source', () => {
    const dir = fileURLToPath(new URL('../src/adapters/lmstudio/', import.meta.url));
    for (const file of readdirSync(dir)) {
      // Code only: comments may describe what the adapter does not do.
      const source = readFileSync(`${dir}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/['"`]\/(?:api\/v\d\/)?models\/(?:load|unload|download)|\/download|\/unload|spawn|execFile|child_process/);
    }
  });

  it('refuses a non-loopback endpoint at construction', () => {
    expect(() => new LmStudioAdapter({ endpoint: 'http://192.168.1.9:1234' })).toThrow(expect.objectContaining({ code: 'endpoint_not_loopback' }));
    expect(() => new LmStudioAdapter({ endpoint: 'https://lm.example.com' })).toThrow(AdapterError);
  });
});

describe('PRD example end to end', () => {
  it('runs the request-label test through bindModel and runTest against the fake', async () => {
    const fake = await start({ content: '{"label":"billing"}' });
    const adapter = new LmStudioAdapter({ endpoint: fake.endpoint });
    const manifest = exampleManifest();
    const gate = await adapter.preflight({
      model: LOCAL_MODEL,
      requirements: {
        capabilities: [...manifest.required_capabilities],
        locality: 'local_required',
        settings: { ...manifest.inference },
        structured_output: manifest.response_schema !== null,
      },
    });
    expect(gate.ok).toBe(true);

    const run = await runTest({ manifest, adapter: bindModel(adapter, LOCAL_MODEL, grant) });
    expect(run.state).toBe('completed');
    expect(run.cases[0]).toMatchObject({ key: 'billing-001', outcome: 'pass', output_text: '{"label":"billing"}' });
    expect(run.cases[0]!.provider_stats).toMatchObject({ provider: 'lmstudio_openai_compat_v1', usage_total_tokens: 20 });

    const wrong = await start({ content: '{"label":"support"}' });
    const failing = await runTest({ manifest, adapter: bindModel(new LmStudioAdapter({ endpoint: wrong.endpoint }), LOCAL_MODEL, grant) });
    expect(failing.cases[0]).toMatchObject({ outcome: 'fail', error_code: 'value_mismatch' });

    const missing = await runTest({ manifest, adapter: bindModel(adapter, MISSING_MODEL, grant) });
    expect(missing.cases[0]).toMatchObject({ outcome: 'error', error_code: 'model_not_found' });
  });
});
