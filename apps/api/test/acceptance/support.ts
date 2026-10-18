/**
 * Support for the Phase 2 acceptance suite.
 *
 * These tests drive the REAL pieces together: the backend app on a real
 * listening socket (with its request log), the first-party CLI
 * (`packages/runner/src/cli`), the real Ollama and LM Studio adapters talking over
 * loopback HTTP to the runner's fake runtime servers, and the real contracts.
 *
 * Importing runner source and runner test fixtures by relative path is
 * deliberate and confined to this directory: the runner stays independently
 * distributed (it depends only on `@localfirst/contracts`), while this suite
 * proves the two halves agree.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { registryAccount } from '../../../../packages/runner/src/cli/keychain.js';
import { runCli } from '../../../../packages/runner/src/cli/main.js';
import { makeHarness, MemoryKeychain, type Harness, type HarnessOptions } from '../../../../packages/runner/test/support/cli-harness.js';
import { LOCAL as OLLAMA_MODEL, startFakeOllama, type FakeOllama } from '../../../../packages/runner/test/support/fake-ollama.js';
import { startFakeLmStudio, type FakeLmStudio } from '../../../../packages/runner/test/support/fake-lmstudio.js';
import { mintToken } from '../server-harness.js';
import type { TestAccount } from '../factories.js';

export { OLLAMA_MODEL, MemoryKeychain, registryAccount };
export { LOCAL_MODEL as LMSTUDIO_MODEL } from '../../../../packages/runner/test/support/fake-lmstudio.js';

export interface LoggedRequest {
  method: string;
  path: string;
  authorized: boolean;
}

export interface Registry {
  origin: string;
  /** Every request the backend received, as the backend saw it. */
  log: LoggedRequest[];
  close(): Promise<void>;
}

/** The real backend on a real socket, with a registry-side request log. */
export async function startRegistry(): Promise<Registry> {
  const cfg = config();
  const app = createApp();
  const log: LoggedRequest[] = [];
  const server = serve({
    fetch: (request: Request) => {
      const url = new URL(request.url);
      log.push({ method: request.method, path: url.pathname + url.search, authorized: request.headers.has('authorization') });
      return app.fetch(request);
    },
    hostname: cfg.host,
    port: cfg.port,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${cfg.apiBaseUrl}/health/live`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  log.length = 0;
  return {
    origin: cfg.apiBaseUrl,
    log,
    close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
  };
}

export const newRoot = () => mkdtemp(join(tmpdir(), 'lf-acceptance-'));

export interface CliResult {
  code: number;
  h: Harness;
  out: string;
  err: string;
}

/** One CLI invocation; invocations sharing a root share a home and cwd. */
export async function cli(root: string, argv: string[], options: HarnessOptions = {}): Promise<CliResult> {
  const h = await makeHarness({ root, ...options });
  const code = await runCli(argv, h.env);
  return { code, h, out: h.io.text(), err: h.io.stderr.join('') };
}

export const planPathOf = (out: string): string => /Plan written to (.+)\n/.exec(out)?.[1] as string;
export const reportPathOf = (out: string): string => /Local report: (.+)\n/.exec(out)?.[1] as string;
export const exportPathOf = (out: string): string => /Export written to (.+)\n/.exec(out)?.[1] as string;

/** A fake Ollama whose chat endpoint answers with this model message. */
export async function ollamaReplying(
  content: string,
  closers: Array<() => Promise<void> | void>,
  model: string = OLLAMA_MODEL,
): Promise<FakeOllama> {
  const fake = await startFakeOllama();
  closers.push(() => fake.close());
  fake.chat = () => ({
    json: {
      model,
      created_at: '2026-10-11T00:00:00Z',
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: 10,
      prompt_eval_duration: 1_000_000,
      eval_count: 5,
      eval_duration: 1_000_000,
    },
  });
  return fake;
}

export const chatsOf = (fake: FakeOllama) => fake.requests.filter((request) => request.path === '/api/chat');

export async function lmStudioReplying(content: string, closers: Array<() => Promise<void> | void>): Promise<FakeLmStudio> {
  const fake = await startFakeLmStudio({ content });
  closers.push(() => fake.close());
  return fake;
}

export const lmChatsOf = (fake: FakeLmStudio) => fake.requests.filter((request) => request.path.includes('chat'));

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'runner', 'test', 'fixtures', 'lmstudio');

/** Offline `lms` / plist command output from the M0 captures, for authorized discovery. */
export function lmStudioCommands(command: string, args: string[]) {
  const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
  const line = `${command} ${args.join(' ')}`;
  if (line === 'lms version') return { code: 0, stdout: read('lms-version.txt'), stderr: '', errorCode: null };
  if (line === 'lms runtime ls') return { code: 0, stdout: read('lms-runtime-ls.txt'), stderr: '', errorCode: null };
  if (command === 'plutil') return { code: 0, stdout: read('app-info-plist-excerpt.txt'), stderr: '', errorCode: null };
  return { code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' };
}

/** A real bearer token for a REST call, signed with the deployment key. */
export async function bearer(account: TestAccount, scopes: string[]): Promise<string> {
  return mintToken({ subject: account.userId, audience: config().restResource, scopes });
}

/** A keychain that already holds this account's token for the registry. */
export async function keychainFor(origin: string, account: TestAccount, scopes: string[]): Promise<MemoryKeychain> {
  const keychain = new MemoryKeychain();
  keychain.items.set(registryAccount(origin), await bearer(account, scopes));
  return keychain;
}
