import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, LoopbackClient, OllamaAdapter, bindModel, measurementsFor, runTest, type InferenceAdapter } from '../src/index.js';
import { ollamaStreamCollector } from '../src/adapters/ollama/stream.js';
import { openAiStreamCollector } from '../src/adapters/lmstudio/stream.js';
import { grant } from './support/conformance.js';
import { LOCAL, startFakeOllama } from './support/fake-ollama.js';
import { exampleManifest, manifestWith } from './helpers.js';

const streaming = () => manifestWith((raw) => (raw.inference.stream = true));
const signal = () => new AbortController().signal;

describe('LoopbackClient.stream', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); }));
  });
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const collect = async (client: LoopbackClient) => {
    const lines: string[] = [];
    const response = await client.stream({ method: 'POST', path: '/s', body: {}, signal: signal() }, 'text/event-stream', (line) => lines.push(line));
    return { lines, response };
  };

  it('delivers lines as they arrive, across chunk boundaries and a split multibyte character, without CR', async () => {
    const bytes = Buffer.from('data: a 😊\r\n\r\ndata: b\n', 'utf8');
    const emoji = bytes.indexOf(0xf0);
    const endpoint = await serve(async (_, res) => {
      res.write(bytes.subarray(0, emoji + 2)); // splits the four-byte character
      await new Promise((resolve) => setTimeout(resolve, 10));
      res.write(bytes.subarray(emoji + 2, bytes.length - 3));
      await new Promise((resolve) => setTimeout(resolve, 10));
      res.end(bytes.subarray(bytes.length - 3));
    });
    const { lines, response } = await collect(new LoopbackClient({ endpoint }));
    expect(lines).toEqual(['data: a 😊', '', 'data: b']);
    expect(response).toEqual({ status: 200, json: null });
  });

  it('emits a final line that has no trailing newline', async () => {
    const endpoint = await serve((_, res) => res.end('first\nlast'));
    expect((await collect(new LoopbackClient({ endpoint }))).lines).toEqual(['first', 'last']);
  });

  it('buffers and parses a non-2xx body like request(), without calling onLine', async () => {
    const endpoint = await serve((_, res) => { res.statusCode = 404; res.end('{"error":"nope"}'); });
    const { lines, response } = await collect(new LoopbackClient({ endpoint }));
    expect(lines).toEqual([]);
    expect(response).toEqual({ status: 404, json: { error: 'nope' } });
  });

  it('bounds the whole stream and a single unterminated line', async () => {
    const endpoint = await serve((_, res) => res.end('x'.repeat(4096) + '\n' + 'y'.repeat(4096) + '\n'));
    await expect(collect(new LoopbackClient({ endpoint, maxResponseBytes: 5000 }))).rejects.toMatchObject({ code: 'response_too_large' });
    const noNewline = await serve((_, res) => res.end('z'.repeat(9000)));
    await expect(collect(new LoopbackClient({ endpoint: noNewline, maxResponseBytes: 5000 }))).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('stops reading and fails with the callback error', async () => {
    let seen = 0;
    const endpoint = await serve(async (_, res) => {
      for (let i = 0; i < 20; i += 1) {
        res.write(`line ${i}\n`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      res.end();
    });
    const client = new LoopbackClient({ endpoint });
    await expect(
      client.stream({ method: 'POST', path: '/s', body: {}, signal: signal() }, 'text/event-stream', () => {
        seen += 1;
        throw new AdapterError('malformed_response', 'bad event');
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
    expect(seen).toBe(1);
  });

  it('keeps the loopback guards: no redirects, no foreign paths, abort honoured', async () => {
    const target = await serve((_, res) => res.end('stolen'));
    const redirect = await serve((_, res) => { res.statusCode = 302; res.setHeader('location', `${target}/x`); res.end(); });
    await expect(collect(new LoopbackClient({ endpoint: redirect }))).rejects.toMatchObject({ code: 'redirect_rejected' });
    const client = new LoopbackClient({ endpoint: await serve((_, res) => res.end('x')) });
    await expect(client.stream({ method: 'POST', path: '//evil.example/x', signal: signal() }, '*/*', () => undefined)).rejects.toMatchObject({ code: 'invalid_path' });
    const hung = new LoopbackClient({ endpoint: await serve(() => undefined) });
    await expect(hung.stream({ method: 'POST', path: '/s', signal: AbortSignal.timeout(50) }, '*/*', () => undefined)).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Ollama NDJSON collector', () => {
  const chunk = (content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ model: LOCAL, message: { role: 'assistant', content, ...extra }, done: false });
  const last = JSON.stringify({ model: LOCAL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 2, eval_duration: 8_000_000 });

  it('announces the first non-empty content once; empty keep-alives and thinking chunks are not the first token', () => {
    let announced = 0;
    const collector = ollamaStreamCollector(LOCAL, () => (announced += 1));
    collector.push(chunk('', { thinking: 'hmm' }));
    collector.push(chunk(''));
    expect(announced).toBe(0);
    collector.push(chunk('Ok'));
    collector.push(chunk('ay'));
    collector.push('');
    collector.push(last);
    expect(announced).toBe(1);
    const response = collector.finish();
    expect(response.content).toBe('Okay');
    expect(response.providerStats).toMatchObject({ provider: 'ollama_native_v1', eval_count: 2, done_reason: 'stop' });
  });

  it('rejects a stream that errors, names another model, is not JSON, ends early, or continues after done', () => {
    expect(() => ollamaStreamCollector(LOCAL, undefined).push('{"error":"boom"}')).toThrow(expect.objectContaining({ code: 'provider_error' }));
    expect(() => ollamaStreamCollector(LOCAL, undefined).push(JSON.stringify({ model: 'other:1b', message: { content: 'x' }, done: false }))).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    expect(() => ollamaStreamCollector(LOCAL, undefined).push('not json')).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    const early = ollamaStreamCollector(LOCAL, undefined);
    early.push(chunk('Ok'));
    expect(() => early.finish()).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    const extra = ollamaStreamCollector(LOCAL, undefined);
    extra.push(last);
    expect(() => extra.push(chunk('late'))).toThrow(expect.objectContaining({ code: 'malformed_response' }));
  });
});

describe('OpenAI-compatible SSE collector', () => {
  const model = 'google/gemma-3-1b';
  const event = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}`;

  it('does not announce on the role-only opening chunk or reasoning deltas, only on the first content', () => {
    let announced = 0;
    const collector = openAiStreamCollector(model, () => (announced += 1));
    collector.push(': keep-alive');
    collector.push(event({ role: 'assistant', content: '' }));
    collector.push(event({ reasoning_content: 'thinking' }));
    collector.push('');
    expect(announced).toBe(0);
    collector.push(event({ content: 'Ok' }));
    collector.push(event({ content: '!' }));
    collector.push(event({}, 'stop'));
    collector.push(`data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`);
    collector.push('data: [DONE]');
    expect(announced).toBe(1);
    const response = collector.finish();
    expect(response.content).toBe('Ok!');
    expect(response.providerStats).toEqual({
      provider: 'lmstudio_openai_compat_v1', finish_reason: 'stop', usage_prompt_tokens: 3, usage_completion_tokens: 2, usage_total_tokens: 5,
    });
  });

  it('rejects an error event, a substituted model, bad JSON, a stream with no [DONE], and data after [DONE]', () => {
    expect(() => openAiStreamCollector(model, undefined).push('data: {"error":{"message":"x"}}')).toThrow(expect.objectContaining({ code: 'runtime_error' }));
    const other = `data: ${JSON.stringify({ model: 'other/model', choices: [{ delta: { content: 'x' } }] })}`;
    expect(() => openAiStreamCollector(model, undefined).push(other)).toThrow(expect.objectContaining({ code: 'model_not_found' }));
    expect(() => openAiStreamCollector(model, undefined).push('data: nope')).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    const early = openAiStreamCollector(model, undefined);
    early.push(event({ content: 'Ok' }));
    expect(() => early.finish()).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    const after = openAiStreamCollector(model, undefined);
    after.push('data: [DONE]');
    expect(() => after.push(event({ content: 'late' }))).toThrow(expect.objectContaining({ code: 'malformed_response' }));
  });
});

describe('streamed runs end to end', () => {
  it('sends stream:true to Ollama and records the first-token time from the real captured stream', async () => {
    const fake = await startFakeOllama();
    try {
      const adapter = bindModel(new OllamaAdapter({ endpoint: fake.url }), LOCAL, grant);
      const manifest = streaming();
      const run = await runTest({ manifest, adapter });
      expect(fake.requests.find((request) => request.path === '/api/chat')?.body).toMatchObject({ stream: true });
      const entry = run.cases[0]!;
      expect(entry.provider_stats).toMatchObject({ provider: 'ollama_native_v1', eval_count: 2 });
      expect(entry.first_token_ms).toBeGreaterThan(0);
      expect(entry.first_token_ms).toBeLessThanOrEqual(entry.latency_ms as number);
      const measurements = measurementsFor(run, manifest);
      expect(measurements.time_to_first_token_ms).toMatchObject({ method: 'client_monotonic_first_content_chunk_v1', samples: 1 });
    } finally {
      await fake.close();
    }
  });

  it('measures from request start with the injected clock, and records nothing for a non-streamed run', async () => {
    let now = 0;
    const adapter: InferenceAdapter = {
      async infer(_request, options) {
        now += 7; // time to the first content fragment
        options.onFirstContent?.();
        options.onFirstContent?.(); // a second announcement must not move the recorded time
        now += 30;
        return { content: '{"label":"billing"}', providerStats: {} };
      },
    };
    const run = await runTest({ manifest: streaming(), adapter, nowMs: () => now });
    expect(run.cases[0]).toMatchObject({ first_token_ms: 7, latency_ms: 37 });

    const plain = await runTest({ manifest: exampleManifest(), adapter: { infer: async (_r, o) => { o.onFirstContent?.(); return { content: '{"label":"billing"}', providerStats: {} }; } } });
    // A non-streaming adapter never announces; even if one did, the metric stays unavailable.
    expect(measurementsFor(plain, exampleManifest()).time_to_first_token_ms).toEqual({ value: null, reason: 'nonstreaming_run' });
  });

  it('keeps a failed streamed case out of the metric', async () => {
    const adapter: InferenceAdapter = {
      async infer(_request, options) {
        options.onFirstContent?.();
        throw new AdapterError('malformed_response', 'stream broke');
      },
    };
    const run = await runTest({ manifest: streaming(), adapter });
    expect(run.cases[0]).toMatchObject({ outcome: 'error', error_code: 'malformed_response', first_token_ms: null });
    expect(measurementsFor(run, streaming()).time_to_first_token_ms).toEqual({ value: null, reason: 'no_content_event' });
  });
});
