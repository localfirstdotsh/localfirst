import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { OllamaAdapter } from '../../src/index.js';
import type { ConformanceTarget } from './conformance.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/ollama/', import.meta.url));
const real = (name: string) => JSON.parse(readFileSync(`${FIXTURES}0.35.1/${name}`, 'utf8'));
const synthetic = JSON.parse(readFileSync(`${FIXTURES}synthetic/models.json`, 'utf8'));

export const LOCAL = 'qwen2.5:1.5b';
export const CLOUD = 'gpt-oss:120b-cloud';
export const UNKNOWN_LOCALITY = 'mystery:latest';
export const THINKER = 'thinker:7b';

export interface Recorded {
  method: string;
  path: string;
  body: any;
}

type Json = Record<string, any>;

export interface FakeOllama {
  url: string;
  requests: Recorded[];
  tags: Json[];
  loaded: Json[];
  show: Record<string, Json>;
  /** Overrides the next /api/chat answer. */
  chat: (body: Json) => { status?: number; raw?: string; json?: Json; hang?: boolean; stream?: string[] };
  version: () => { status?: number; json?: unknown; raw?: string };
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(text);
      }
    });
  });
}

/** An HTTP server that answers like Ollama 0.35.1, using the captured fixtures. */
export async function startFakeOllama(): Promise<FakeOllama> {
  const realTags = real('tags.json').models as Json[];
  const fake: FakeOllama = {
    url: '',
    requests: [],
    tags: [
      ...realTags,
      synthetic.cloud.tags,
      synthetic.unknown.tags,
      synthetic.thinking.tags,
    ],
    loaded: real('ps-after.json').models,
    show: {
      [LOCAL]: real('show-qwen2.5-1.5b.json'),
      [CLOUD]: synthetic.cloud.show,
      [UNKNOWN_LOCALITY]: synthetic.unknown.show,
      [THINKER]: synthetic.thinking.show,
    },
    version: () => ({ json: real('version.json') }),
    chat: (body) => ({
      json: { ...real('chat-nonstream.json'), model: body.model },
      // The captured NDJSON stream, served when the request asks for `stream: true`.
      stream: readFileSync(`${FIXTURES}0.35.1/chat-stream.ndjson`, 'utf8')
        .trim().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), model: body.model })),
    }),
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const send = (res: ServerResponse, status: number, body: unknown, raw = false) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(raw ? String(body) : JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const body = await readBody(req);
    fake.requests.push({ method: req.method ?? '', path, body });
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/version') {
      const answer = fake.version();
      return send(res, answer.status ?? 200, answer.raw ?? answer.json, answer.raw !== undefined);
    }
    if (route === 'GET /api/tags') return send(res, 200, { models: fake.tags });
    if (route === 'GET /api/ps') return send(res, 200, { models: fake.loaded });
    if (route === 'POST /api/show') {
      const found = fake.show[body?.model];
      return found ? send(res, 200, found) : send(res, 404, { error: `model '${body?.model}' not found` });
    }
    if (route === 'POST /api/chat') {
      if (!fake.tags.some((tag) => tag.name === body?.model)) {
        return send(res, 404, { error: `model '${body?.model}' not found` });
      }
      const answer = fake.chat(body);
      if (answer.hang) return; // never answers
      if (body?.stream === true && answer.raw === undefined && (answer.status ?? 200) === 200) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/x-ndjson');
        // One event per tick, so a client can observe the first fragment before the reply ends.
        for (const line of answer.stream ?? [JSON.stringify(answer.json)]) {
          res.write(`${line}\n`);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return res.end();
      }
      return send(res, answer.status ?? 200, answer.raw ?? answer.json, answer.raw !== undefined);
    }
    return send(res, 404, { error: `unexpected ${route}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export async function ollamaTarget(): Promise<ConformanceTarget & { fake: FakeOllama }> {
  const fake = await startFakeOllama();
  const adapter = new OllamaAdapter({ endpoint: fake.url });
  const normal = fake.chat;
  return {
    fake,
    adapter,
    models: { local: LOCAL, remote: CLOUD, missing: 'nope:0b' },
    hangNext: () => {
      fake.chat = (body) => {
        fake.chat = normal;
        return { hang: true, json: body };
      };
    },
    malformNext: () => {
      fake.chat = () => {
        fake.chat = normal;
        return { json: { model: LOCAL, message: {}, done: true } };
      };
    },
    streaming: true,
    // Larger than the model's context window, which the adapter refuses instead of truncating.
    unsupportedOption: { context_tokens: 10_000_000 },
    close: () => fake.close(),
  };
}
