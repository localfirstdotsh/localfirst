import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXAMPLE_PROJECT_MD,
  EXAMPLE_TEST_PATH,
  EXAMPLE_TEST_YAML,
  digestOfBytes,
  testDigests,
  validateProjectBundle,
} from '@localfirst/contracts';
import type { CliEnv } from '../../src/cli/context.js';
import { refusal } from '../../src/cli/errors.js';
import type { Io } from '../../src/cli/io.js';
import type { Keychain } from '../../src/cli/keychain.js';
import { resolveHome } from '../../src/cli/paths.js';
import type { CommandResult, CommandRunner } from '../../src/cli/process.js';
import { compareReports } from '../../src/reports/compare.js';

export interface ScriptedIo extends Io {
  stdout: string[];
  stderr: string[];
  questions: string[];
  text(): string;
}

/** A terminal that answers `ask` from a script. Anything but "yes" is a no. */
export function scriptedIo(options: { tty: boolean; answers?: string[]; secret?: string }): ScriptedIo {
  const answers = [...(options.answers ?? [])];
  const io: ScriptedIo = {
    isTTY: options.tty,
    stdout: [],
    stderr: [],
    questions: [],
    out: (text) => void io.stdout.push(text),
    err: (text) => void io.stderr.push(text),
    ask: async (question) => {
      io.questions.push(question);
      return answers.shift() === 'yes';
    },
    readSecret: async () => {
      if (!options.tty) throw refusal('Reading a secret needs an interactive terminal.');
      return options.secret ?? '';
    },
    text: () => io.stdout.join(''),
  };
  return io;
}

export class MemoryKeychain implements Keychain {
  readonly items = new Map<string, string>();
  readonly reads: string[] = [];
  async get(account: string) {
    this.reads.push(account);
    return this.items.get(account) ?? null;
  }
  async set(account: string, secret: string) {
    this.items.set(account, secret);
  }
}

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** The bundle digest and definition detail the fake registry serves for the PRD example. */
export function exampleRegistryDefinition() {
  const validated = validateProjectBundle({ project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] });
  const manifest = validated.tests[0]!.manifest;
  const digests = testDigests(manifest);
  const bundleDigest = validated.content_digest as string;
  const detail = {
    test_definition_id: 'test_example',
    key: manifest.key,
    project_id: 'project_example',
    project_version_id: 'version_example',
    runner_available: true,
    manifest_digest: digests.manifest_digest,
    fixture_digest: digests.fixture_digest,
    evaluator_digest: digests.evaluator_digest,
    bundle_digest: bundleDigest,
    bundle_files: [
      { path: EXAMPLE_TEST_PATH, kind: 'test_manifest', content: EXAMPLE_TEST_YAML, content_digest: digestOfBytes(EXAMPLE_TEST_YAML) },
    ],
  };
  return { bundleDigest, detail };
}

export interface FakeRegistry {
  origin: string;
  requests: Recorded[];
  /** The test definition detail served at /api/v1/test-definitions/test_example. */
  definition: Record<string, unknown>;
  /** HTTP status for the definition route; 404 models a withdrawn or removed definition. */
  definitionStatus: number;
  /** The `PROJECT.md` text served by the export route. */
  projectMd: string;
  /** Override the answer for POST /api/v1/test-results. */
  submit: (body: unknown) => { status: number; json: unknown };
  draft: Record<string, unknown>;
  /** The `resource` the MCP protected-resource metadata advertises; defaults to `<origin>/mcp`. */
  mcpResource: string | null;
  /** Answers a request before the built-in routes; return undefined to fall through. */
  custom?: (method: string, path: string, body: any) => { status: number; json: unknown } | undefined;
  close(): Promise<void>;
}

const PHASE = { error: { code: 'PHASE_UNAVAILABLE', message: 'Not available in this phase.', retryable: false }, meta: { request_id: 'r' } };

export async function startFakeRegistry(): Promise<FakeRegistry> {
  const example = exampleRegistryDefinition();
  const registry: FakeRegistry = {
    origin: '',
    requests: [],
    definition: example.detail,
    definitionStatus: 200,
    projectMd: EXAMPLE_PROJECT_MD,
    submit: () => ({ status: 404, json: PHASE }),
    draft: {},
    mcpResource: null,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const url = new URL(req.url ?? '/', 'http://x');
      registry.requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body: text ? JSON.parse(text) : null });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/markdown' : 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return send(200, { resource: registry.mcpResource ?? `${registry.origin}/mcp`, authorization_servers: [`${registry.origin}/api/auth`] });
      }
      const custom = registry.custom?.(req.method ?? '', url.pathname, text ? JSON.parse(text) : null);
      if (custom) return send(custom.status, custom.json);
      if (req.method === 'GET' && url.pathname === '/api/v1/projects/project_example') {
        return send(200, { data: { current_version: { project_version_id: 'version_example', content_digest: example.bundleDigest } }, meta: { request_id: 'r' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/projects/project_example/export') {
        return send(200, registry.projectMd, { etag: `"${example.bundleDigest}"` });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/projects/project_example/tests') {
        return send(200, {
          data: { items: [{ key: 'request-label-v1', test_definition_id: 'test_example', runner_available: true }], has_more: false, next_cursor: null },
          meta: { request_id: 'r', project_version_id: 'version_example' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/test-definitions/test_example') {
        if (registry.definitionStatus !== 200) {
          return send(registry.definitionStatus, { error: { code: 'NOT_FOUND', message: 'not found', retryable: false }, meta: { request_id: 'r' } });
        }
        return send(200, { data: registry.definition, meta: { request_id: 'r' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/test-definitions/')) return send(404, PHASE);
      if (req.method === 'POST' && url.pathname === '/api/v1/test-results') {
        const answer = registry.submit(text ? JSON.parse(text) : null);
        return send(answer.status, answer.json);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/drafts/')) {
        return send(200, { data: registry.draft, meta: { request_id: 'r' } });
      }
      return send(404, { error: { code: 'NOT_FOUND', message: 'no route', retryable: false }, meta: { request_id: 'r' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return registry;
}

/** Records every socket connection the process opens. */
export function startNetworkGuard() {
  const connections: string[] = [];
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // Node passes already-normalized arguments as `[options, callback]`.
    const raw = args[0];
    const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string | undefined;
    if (typeof first === 'object' && first !== null) connections.push(first.path ?? `${first.host ?? 'localhost'}:${first.port}`);
    else if (typeof first === 'number') connections.push(`${(args[1] as string) ?? 'localhost'}:${first}`);
    else connections.push(String(first));
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return {
    connections,
    stop: () => void (net.Socket.prototype.connect = original),
  };
}

export const hostPort = (url: string) => new URL(url).host;

export interface Harness {
  env: CliEnv;
  io: ScriptedIo;
  root: string;
  keychain: MemoryKeychain;
  spawned: string[][];
  fetched: string[];
  opened: string[];
  dir: (name: string) => string;
}

export interface HarnessOptions {
  tty?: boolean;
  answers?: string[];
  secret?: string;
  vars?: Record<string, string | undefined>;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  root?: string;
  keychain?: MemoryKeychain;
  runCommand?: (command: string, args: string[]) => CommandResult;
  /** Result of a terminal-attached program; defaults to "not installed". */
  runInteractive?: (command: string, args: string[]) => { code: number | null; errorCode: string | null };
  compare?: CliEnv['compare'];
  watchNetwork?: CliEnv['watchNetwork'];
}

let counter = 0;

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'lf-cli-')));
  const io = scriptedIo({ tty: options.tty ?? true, answers: options.answers ?? [], ...(options.secret !== undefined ? { secret: options.secret } : {}) });
  const keychain = options.keychain ?? new MemoryKeychain();
  const spawned: string[][] = [];
  const fetched: string[] = [];
  const opened: string[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    spawned.push([command, ...args]);
    return options.runCommand?.(command, args) ?? { code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' };
  };
  const env: CliEnv = {
    io,
    home: resolveHome({ LOCALFIRST_HOME: join(root, 'home') }),
    vars: options.vars ?? {},
    fetch: async (input, init) => {
      fetched.push(String(input));
      return fetch(input, init);
    },
    keychain,
    runCommand,
    runInteractive: async (command, args) => {
      spawned.push([command, ...args]);
      return options.runInteractive?.(command, args) ?? { code: null, errorCode: 'ENOENT' };
    },
    platform: options.platform ?? 'linux',
    userHome: join(root, 'user'),
    now: () => new Date('2026-10-11T20:00:00.000Z'),
    ...(options.signal ? { signal: options.signal } : {}),
    compare: options.compare ?? compareReports,
    hardware: () => ({
      platform: 'apple-silicon',
      os: { name: 'macos', version: '25.5.0' },
      cpu_architecture: 'arm64',
      cpu_model: null,
      memory_bytes: 17179869184,
      unified_memory: true,
      accelerators: [],
    }),
    // Deterministic: the real sampler would report whatever the test machine's network is doing.
    watchNetwork: options.watchNetwork ?? (() => ({ stop: () => ({ observation: 'not_run' as const, samples: 2 }) })),
    sleep: async () => undefined,
    openUrl: async (url) => void opened.push(url),
    randomId: () => `t${++counter}`.padEnd(8, '0'),
    cwd: join(root, 'cwd'),
  };
  await mkdir(env.cwd, { recursive: true });
  return { env, io, root, keychain, spawned, fetched, opened, dir: (name) => join(env.cwd, name) };
}

/** Write a saved bundle directory the CLI can plan from. */
export async function writeBundle(dir: string, options: { testYaml?: string; meta?: boolean } = {}): Promise<string> {
  await mkdir(join(dir, 'TESTS'), { recursive: true });
  await writeFile(join(dir, 'PROJECT.md'), EXAMPLE_PROJECT_MD);
  await writeFile(join(dir, EXAMPLE_TEST_PATH), options.testYaml ?? EXAMPLE_TEST_YAML);
  if (options.meta !== false) {
    await writeFile(
      join(dir, '.localfirst-bundle.json'),
      JSON.stringify({
        schema: 'localfirst/bundle-meta/v0.1',
        project_id: 'project_example',
        project_version_id: 'version_example',
        registry_origin: null,
        content_digest: null,
        exported_at: '2026-10-11T20:00:00.000Z',
      }),
    );
  }
  return dir;
}
