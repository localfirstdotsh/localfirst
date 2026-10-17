import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LmStudioAdapter, type LmStudioAdapterOptions } from '../../src/index.js';
import type { ConformanceTarget } from './conformance.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/lmstudio/', import.meta.url));

/** Parse a fixture, ignoring a trailing `HTTP <code>` line added by `curl -w`. */
function fixture(name: string): any {
  const text = readFileSync(`${FIXTURES}${name}`, 'utf8');
  return JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
}

const fixtureText = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');

export const LOCAL_MODEL = 'google/gemma-3-1b';
export const EMBEDDING_MODEL = 'text-embedding-nomic-embed-text-v1.5';
export const MISSING_MODEL = 'nope/missing';
/** SYNTHETIC: no remote-linked model could be captured. Marker names follow LM Studio's style but are invented. */
export const REMOTE_MODEL = 'acme/remote-linked-7b';
/** SYNTHETIC: a native listing entry with no origin facts (no format, no size). */
export const UNKNOWN_ORIGIN_MODEL = 'mystery/model';

const syntheticRemote = {
  type: 'llm',
  publisher: 'acme',
  key: REMOTE_MODEL,
  display_name: 'Remote Linked 7B',
  format: 'mlx',
  size_bytes: 4_000_000_000,
  loaded_instances: [],
  max_context_length: 32768,
  capabilities: { vision: false, trained_for_tool_use: false },
  variants: [],
  remote_link: { host: 'https://llm.example' },
};
const syntheticUnknown = {
  type: 'llm',
  publisher: 'mystery',
  key: UNKNOWN_ORIGIN_MODEL,
  loaded_instances: [],
  capabilities: { vision: false, trained_for_tool_use: false },
};

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  authorization: string | undefined;
}

export interface FakeLmStudio {
  endpoint: string;
  requests: RecordedRequest[];
  hangNext(): void;
  malformNext(): void;
  /** Serve a mutated copy of the native listing. */
  editNativeModels(edit: (models: any[]) => void): void;
  /** Change the message content of later successful chat replies. */
  setContent(content: string): void;
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Without the native listing, `/api/v1/models` answers 404 like an older server. */
  native?: boolean;
  /** Require this bearer token; otherwise answer 401 with a body that echoes the header. */
  token?: string;
  /** Extra latency before answering, in ms. */
  delayMs?: number;
  /** Replace the model message content in successful /v1/chat/completions replies. */
  content?: string;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(text);
      }
    });
  });
}

export async function startFakeLmStudio(options: FakeOptions = {}): Promise<FakeLmStudio> {
  const requests: RecordedRequest[] = [];
  let hang = false;
  let malform = false;
  const nativeModels = fixture('native-models.json');
  nativeModels.models.push(structuredClone(syntheticRemote), structuredClone(syntheticUnknown));
  const openAiModels = fixture('openai-models.json');
  openAiModels.data.push({ id: REMOTE_MODEL, object: 'model', owned_by: 'organization_owner' });
  const pending = new Set<() => void>();

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = req.method === 'POST' ? await readBody(req) : null;
    requests.push({ method: req.method ?? '', path, body, authorization: req.headers.authorization });
    const send = (status: number, json: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    };
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));

    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
      return send(401, { error: { message: `bad credentials: ${req.headers.authorization ?? 'none'}`, code: 'unauthorized' } });
    }

    if (req.method === 'GET' && path === '/api/v1/models') {
      return options.native === false
        ? send(404, { error: 'Unexpected endpoint or method. (GET /api/v1/models)' })
        : send(200, nativeModels);
    }
    if (req.method === 'GET' && path === '/v1/models') return send(200, openAiModels);

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      if (hang) {
        hang = false;
        const release = () => res.destroy();
        pending.add(release);
        return;
      }
      if (malform) {
        malform = false;
        if (body?.stream === true) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          return res.end('data: {"id":"chatcmpl-x","object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n');
        }
        return send(200, { id: 'chatcmpl-x', object: 'chat.completion' });
      }
      if (body?.stream === true) {
        // The captured SSE stream (real LM Studio, model google/gemma-3-1b), one event per tick.
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        const events = fixtureText('chat-stream.sse').split('\n\n').filter((event) => event.length > 0);
        for (const event of events) {
          res.write(`${event.replaceAll('google/gemma-3-1b', body.model)}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return res.end();
      }
      const known = body?.model === LOCAL_MODEL || body?.model === REMOTE_MODEL || body?.model === `${LOCAL_MODEL}@4bit`;
      // M0 finding: an unknown model is silently answered by the loaded one, with HTTP 200.
      const source = body?.response_format ? 'chat-json-schema.json' : 'chat-completions.json';
      const reply = fixture(known ? source : 'chat-unknown-model-substituted.txt');
      if (known) reply.model = body.model;
      if (known && options.content !== undefined) reply.choices[0].message.content = options.content;
      return send(200, reply);
    }

    if (req.method === 'POST' && path === '/api/v1/chat') {
      if (hang) {
        hang = false;
        pending.add(() => res.destroy());
        return;
      }
      if (malform) {
        malform = false;
        return send(200, { output: 'nope' });
      }
      if (body?.model !== LOCAL_MODEL) return send(404, fixture('native-chat-missing-model.txt'));
      return send(200, fixture('native-chat.txt'));
    }
    return send(404, { error: `Unexpected endpoint or method. (${req.method} ${path})` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    hangNext: () => void (hang = true),
    malformNext: () => void (malform = true),
    editNativeModels: (edit) => edit(nativeModels.models),
    setContent: (content) => void (options.content = content),
    close: () =>
      new Promise<void>((resolve) => {
        for (const release of pending) release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Conformance target: a real adapter talking to the fake over loopback HTTP. */
export async function createLmStudioTarget(
  fake: FakeOptions = {},
  adapterOptions: Partial<LmStudioAdapterOptions> = {},
): Promise<ConformanceTarget & { fake: FakeLmStudio }> {
  const server = await startFakeLmStudio(fake);
  const adapter = new LmStudioAdapter({ endpoint: server.endpoint, ...adapterOptions });
  return {
    adapter,
    models: { local: LOCAL_MODEL, remote: REMOTE_MODEL, missing: MISSING_MODEL },
    hangNext: server.hangNext,
    malformNext: server.malformNext,
    // The native instrumentation profile has no tested streaming mapping; the OpenAI-compatible one does.
    streaming: adapterOptions.chatProfile !== 'native_v1',
    unsupportedOption: { reasoning: 'disabled' },
    close: server.close,
    fake: server,
  };
}
