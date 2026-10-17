import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputSchema, digestOf, testResultSubmissionSchema } from '@localfirst/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { registryAccount, runtimeAccount } from '../src/cli/keychain.js';
import { buildLocalReport, runTest, saveLocalReport, type ComparisonResult } from '../src/index.js';
import { LOCAL, startFakeOllama, type FakeOllama } from './support/fake-ollama.js';
import { exampleManifest, planFor, scriptedAdapter } from './helpers.js';
import { makeHarness, MemoryKeychain, startFakeRegistry, writeBundle, type FakeRegistry, type HarnessOptions } from './support/cli-harness.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const newRoot = () => mkdtemp(join(tmpdir(), 'lf-report-'));

async function cli(root: string, argv: string[], options: HarnessOptions = {}) {
  const h = await makeHarness({ root, ...options });
  const code = await runCli(argv, h.env);
  return { code, h, out: h.io.text(), err: h.io.stderr.join('') };
}

async function registry(): Promise<FakeRegistry> {
  const reg = await startFakeRegistry();
  closers.push(() => reg.close());
  return reg;
}

/** Produce a real local report by running the CLI end to end against the fake Ollama. */
async function realReport(root: string): Promise<string> {
  const fake: FakeOllama = await startFakeOllama();
  closers.push(() => fake.close());
  fake.chat = () => ({
    json: {
      model: LOCAL,
      created_at: '2026-10-11T00:00:00Z',
      message: { role: 'assistant', content: '{"label":"billing"}' },
      done: true,
      done_reason: 'stop',
      total_duration: 1,
      load_duration: 0,
      prompt_eval_count: 1,
      prompt_eval_duration: 1,
      eval_count: 1,
      eval_duration: 1,
    },
  });
  const bundle = await writeBundle(join(root, 'cwd', 'bundle'));
  const planned = await cli(root, ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--bundle', bundle], { answers: ['yes'] });
  const planPath = /Plan written to (.+)\n/.exec(planned.out)?.[1] as string;
  const ran = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
  expect(ran.code, ran.err).toBe(0);
  return /Local report: (.+)\n/.exec(ran.out)?.[1] as string;
}

const IDS = ['--test-definition-id', 'test_abc123'];

describe('report show', () => {
  it('summarises a report and shows model output only on request', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const brief = await cli(root, ['report', 'show', path]);
    expect(brief.code).toBe(0);
    expect(brief.out).toContain('Outcome: pass');
    expect(brief.out).toContain('billing-001 #1: pass');
    expect(brief.out).not.toContain('"label"');
    expect((await cli(root, ['report', 'show', path, '--outputs'])).out).toContain('output: "{\\"label\\":\\"billing\\"}"');
  });

  it('fails clearly on a file that is not a local report', async () => {
    const root = await newRoot();
    await writeFile(join(root, 'bad.json'), '{"nope":true}');
    const result = await cli(root, ['report', 'show', join(root, 'bad.json')]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('valid local report');
  });

  it('fails clearly on a missing file or a file that is not JSON, without an unexpected-error trace', async () => {
    const root = await newRoot();
    const missing = await cli(root, ['report', 'show', join(root, 'missing.json')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Could not read a local report');
    expect(missing.err).not.toContain('Unexpected error');
    await writeFile(join(root, 'text.json'), 'not json');
    const text = await cli(root, ['report', 'show', join(root, 'text.json')]);
    expect(text.code).toBe(1);
    expect(text.err).toContain('not valid JSON');
    expect(text.err).not.toContain('Unexpected error');
  });
});

describe('report compare', () => {
  const sample: ComparisonResult = {
    eligible: false,
    reasons: [{ code: 'settings_unknown', dimension: 'effective_settings', detail: 'temperature is unknown in one report' }],
    confounders: [{ code: 'runtime_version_differs', dimension: 'runtime', detail: '0.35.1 vs 0.36.0' }],
    varies: ['model'],
    dimensions: [{ dimension: 'model', status: 'differs', a: 'x', b: 'y' }],
  };

  it('prints eligibility with reasons and never a score', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const calls: unknown[] = [];
    const result = await cli(root, ['report', 'compare', path, path, '--varies', 'model'], {
      compare: (a, b, options) => (calls.push(options), sample),
    });
    expect(result.code).toBe(1);
    expect(calls).toEqual([{ intentionallyVaries: ['model'] }]);
    expect(result.out).toContain('Eligible for comparison: no');
    expect(result.out).toContain('[effective_settings] settings_unknown');
    expect(result.out).toContain('Confounders');
    expect(result.out).toContain('No combined score is produced');
    expect(result.out).not.toMatch(/score:\s*\d/i);
  });

  it('rejects a --varies dimension the comparison does not know, before comparing anything', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    let called = false;
    const result = await cli(root, ['report', 'compare', path, path, '--varies', 'model,colour'], {
      compare: () => ((called = true), sample),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('--varies accepts');
    expect(result.err).toContain('colour');
    expect(called).toBe(false);
  });

  it('handles a comparison that cannot be computed', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const result = await cli(root, ['report', 'compare', path, path], {
      compare: () => {
        throw new Error('not available');
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Comparison is unavailable');
  });
});

describe('report export', () => {
  it('requires --review and a registry test definition ID for a locally planned report', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    expect((await cli(root, ['report', 'export', path, ...IDS])).code).toBe(2);
    const noId = await cli(root, ['report', 'export', path, '--review'], { answers: ['no'] });
    expect(noId.code).toBe(3);
    expect(noId.err).toContain('test_definition_unresolved');
  });

  it('shows the exact upload (result and inline build) under one digest, and writes it only after an interactive yes', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const dir = join(root, 'home', 'data', 'exports');

    const noTty = await cli(root, ['report', 'export', path, '--review', ...IDS], { tty: false });
    expect(noTty.code).toBe(3);
    await expect(readdir(dir)).rejects.toThrow();

    const declined = await cli(root, ['report', 'export', path, '--review', ...IDS], { answers: ['no', 'no'] });
    expect(declined.code).toBe(3);
    expect(declined.out).toContain('Payload digest: sha256:');
    await expect(readdir(dir)).rejects.toThrow();

    const approved = await cli(root, ['report', 'export', path, '--review', ...IDS], { answers: ['no', 'yes'] });
    expect(approved.code, approved.err).toBe(0);
    const [name] = await readdir(dir);
    const file = JSON.parse(await readFile(join(dir, name as string), 'utf8'));
    expect((await stat(join(dir, name as string))).mode & 0o777).toBe(0o600);
    const payload = testResultSubmissionSchema.parse(file.payload);
    expect(file.payload_digest).toBe(digestOf(payload));
    expect(approved.out).toContain(file.payload_digest);
    expect(approved.h.io.questions[1]).toContain(file.payload_digest);
    expect(JSON.stringify(file)).not.toContain('{\\"label\\"');

    // The result names the build with the local placeholder; the registry assigns the real ID.
    expect(payload.result).toMatchObject({ build_id: 'local', test_definition_id: 'test_abc123', visibility_requested: 'private' });
    // The build comes from the approved plan snapshot only: the selected model, versions, settings.
    expect(payload.build).toMatchObject({
      project_id: 'project_example',
      project_version_id: 'version_example',
      configuration_key: 'local-chat',
      source: { kind: 'documentation', url: 'https://example.org/request-labeler', revision: null },
      runtime: { family: 'ollama', application_version: '0.35.1', cli_version: null },
      hardware: null,
      parent_build_id: null,
      manual_report: null,
    });
    expect(payload.build.model_bindings).toHaveLength(1);
    expect(payload.build.model_bindings[0]).toMatchObject({ runtime_model_id: LOCAL, execution_location: 'local', source_url: null });
    expect(buildInputSchema.safeParse(payload.build).success).toBe(true);
  });

  it('shares hardware only when you opt in at review, and shows it in the digested payload', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const none = await cli(root, ['report', 'export', path, '--review', ...IDS, '--out', 'none.json'], { answers: ['no', 'yes'] });
    const shared = await cli(root, ['report', 'export', path, '--review', ...IDS, '--out', 'shared.json'], { answers: ['yes', 'yes'] });
    expect(shared.code, shared.err).toBe(0);
    expect(shared.h.io.questions[0]).toContain('coarse hardware summary');
    expect(shared.out).toContain('"cpu_architecture": "arm64"');
    expect(none.out).toContain('"hardware": null');
    const a = JSON.parse(await readFile(join(root, 'cwd', 'none.json'), 'utf8'));
    const b = JSON.parse(await readFile(join(root, 'cwd', 'shared.json'), 'utf8'));
    expect(b.payload.build.hardware).toMatchObject({ os: { name: 'macos' }, memory_bytes: 17179869184, cpu_model: null, accelerators: [] });
    expect(b.payload_digest).not.toBe(a.payload_digest);
    // No hostname, path, or device list is ever part of the payload.
    expect(JSON.stringify(b)).not.toMatch(/hostname|\/Users\/|\/home\//);
  });

  it('shares an upstream model source only when you declare one, and rejects anything but a public https address', async () => {
    const root = await newRoot();
    const path = await realReport(root);
    const declared = await cli(
      root,
      ['report', 'export', path, '--review', ...IDS, '--model-source-url', 'https://ollama.com/library/qwen2.5', '--out', 'declared.json'],
      { answers: ['no', 'yes'] },
    );
    expect(declared.code, declared.err).toBe(0);
    const file = JSON.parse(await readFile(join(root, 'cwd', 'declared.json'), 'utf8'));
    expect(file.payload.build.model_bindings[0].source_url).toBe('https://ollama.com/library/qwen2.5');
    for (const bad of ['http://ollama.com/x', 'https://user:pw@ollama.com/x', 'https://ollama.com/x?token=1', 'not a url', 'file:///etc/passwd']) {
      const result = await cli(root, ['report', 'export', path, '--review', ...IDS, '--model-source-url', bad], { answers: ['no', 'yes'] });
      expect(result.code, bad).toBe(2);
    }
  });

  it('refuses a private local report', async () => {
    const root = await newRoot();
    const manifest = exampleManifest();
    const plan = planFor(undefined, (body) => (body.data_class = 'private_local'));
    const run = await runTest({ manifest, adapter: scriptedAdapter(() => '{"label":"billing"}') });
    const report = buildLocalReport({ plan, manifest, run, clientRunId: 'run_private_0001', completedAt: '2026-10-11T20:00:00Z' });
    const saved = await saveLocalReport(join(root, 'home', 'data', 'reports'), report);
    const result = await cli(root, ['report', 'export', saved.path, '--review', ...IDS], { answers: ['no', 'yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('private_data_class');
  });
});

describe('report submit', () => {
  async function exportFile(root: string): Promise<string> {
    const path = await realReport(root);
    const approved = await cli(root, ['report', 'export', path, '--review', ...IDS], { answers: ['no', 'yes'] });
    return /Export written to (.+)\n/.exec(approved.out)?.[1] as string;
  }

  it('needs its own interactive consent naming the registry and digest, and sends nothing without it', async () => {
    const reg = await registry();
    const root = await newRoot();
    const file = await exportFile(root);
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    expect((await cli(root, ['report', 'submit', file, '--registry', reg.origin], { tty: false, keychain })).code).toBe(3);
    const declined = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['no'], keychain });
    expect(declined.code).toBe(3);
    expect(reg.requests).toEqual([]);
    expect(keychain.reads).toEqual([]);
    const digest = JSON.parse(await readFile(file, 'utf8')).payload_digest;
    expect(declined.out).toContain(digest);
    expect(declined.h.io.questions[0]).toContain(reg.origin);
  });

  it('needs a stored token', async () => {
    const reg = await registry();
    const root = await newRoot();
    const file = await exportFile(root);
    const result = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('auth set-token');
    expect(result.err).toContain('builds:write');
    expect(reg.requests).toEqual([]);
  });

  it('posts the reviewed upload with the bearer token and a stable idempotency key', async () => {
    const reg = await registry();
    reg.submit = () => ({
      status: 202,
      json: { data: { report_id: 'result_1', review_state: 'pending', visibility: 'private' }, meta: { request_id: 'r', operation_id: 'op_1', replayed: false } },
    });
    const root = await newRoot();
    const file = await exportFile(root);
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    const first = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'], keychain });
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('result_1');
    expect(first.out).toContain('operation op_1');
    expect(first.out).toContain('review: pending');
    expect(first.out + first.err).not.toContain('tok_secret');
    await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'], keychain });
    const posts = reg.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.path).toBe('/api/v1/test-results');
    expect(posts[0]!.headers.authorization).toBe('Bearer tok_secret');
    expect(posts[0]!.headers['idempotency-key']).toMatch(/^lf-[0-9a-f]{32}$/);
    expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
    expect(posts[0]!.body).toEqual(JSON.parse(await readFile(file, 'utf8')).payload);
  });

  it('explains PHASE_UNAVAILABLE and token problems without crashing', async () => {
    const reg = await registry();
    const root = await newRoot();
    const file = await exportFile(root);
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    const phase = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'], keychain });
    expect(phase.err).toContain('does not accept test results');
    reg.submit = () => ({ status: 403, json: { error: { code: 'INSUFFICIENT_SCOPE', message: 'no', retryable: false } } });
    const scope = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'], keychain });
    expect(scope.err).toContain('tests:submit and builds:write');
  });

  it('refuses an export file edited after review', async () => {
    const reg = await registry();
    const root = await newRoot();
    const file = await exportFile(root);
    const edited = JSON.parse(await readFile(file, 'utf8'));
    edited.payload.build.hardware = { platform: null, os: { name: 'linux', version: null }, cpu_architecture: 'x86_64', cpu_model: null, memory_bytes: 8589934592, unified_memory: null, accelerators: [] };
    await writeFile(file, JSON.stringify(edited));
    const result = await cli(root, ['report', 'submit', file, '--registry', reg.origin], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(reg.requests).toEqual([]);
  });
});

describe('contribution review', () => {
  const draft = {
    draft_id: 'draft_1',
    kind: 'test_result',
    state: 'ready_for_review',
    revision: 3,
    payload_digest: `sha256:${'b'.repeat(64)}`,
    warning_codes: ['offline_unverified'],
    approval: null,
  };

  it('shows the draft and the browser URL, and does not open anything by default', async () => {
    const reg = await registry();
    reg.draft = { ...draft, review_url: `${reg.origin}/review/drafts/draft_1` };
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    const root = await newRoot();
    const result = await cli(root, ['contribution', 'review', 'draft_1', '--registry', reg.origin], { keychain });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`${reg.origin}/review/drafts/draft_1`);
    expect(result.out).toContain('No approval on record');
    expect(result.out).toContain('offline_unverified');
    expect(result.h.opened).toEqual([]);
    expect(reg.requests[0]!.headers.authorization).toBe('Bearer tok_secret');
  });

  it('opens the page only with --open and only on the registry origin', async () => {
    const reg = await registry();
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    const root = await newRoot();
    reg.draft = { ...draft, review_url: `${reg.origin}/review/drafts/draft_1` };
    const opened = await cli(root, ['contribution', 'review', 'draft_1', '--registry', reg.origin, '--open'], { keychain });
    expect(opened.h.opened).toEqual([`${reg.origin}/review/drafts/draft_1`]);
    reg.draft = { ...draft, review_url: 'https://evil.example/review/drafts/draft_1' };
    const foreign = await cli(root, ['contribution', 'review', 'draft_1', '--registry', reg.origin, '--open'], { keychain });
    expect(foreign.code).toBe(3);
    expect(foreign.h.opened).toEqual([]);
  });

  it('flags a stale approval and needs a token', async () => {
    const reg = await registry();
    reg.draft = { ...draft, review_url: `${reg.origin}/r`, approval: { payload_digest: `sha256:${'c'.repeat(64)}`, expires_at: '2026-10-11T21:00:00Z' } };
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'tok_secret');
    const root = await newRoot();
    expect((await cli(root, ['contribution', 'review', 'draft_1', '--registry', reg.origin], { keychain })).out).toContain('DIFFERENT payload (stale)');
    const noToken = await cli(root, ['contribution', 'review', 'draft_1', '--registry', reg.origin]);
    expect(noToken.code).toBe(1);
  });
});

describe('auth set-token', () => {
  it('stores a token for a registry or an LM Studio endpoint without echoing it', async () => {
    const root = await newRoot();
    const keychain = new MemoryKeychain();
    const registryResult = await cli(root, ['auth', 'set-token', '--registry', 'https://registry.example'], { secret: 'tok_123', keychain });
    expect(registryResult.code).toBe(0);
    expect(keychain.items.get(registryAccount('https://registry.example'))).toBe('tok_123');
    expect(registryResult.out + registryResult.err).not.toContain('tok_123');
    await cli(root, ['auth', 'set-token', '--lmstudio-endpoint', 'http://127.0.0.1:1234'], { secret: 'lm_456', keychain });
    expect(keychain.items.get(runtimeAccount('http://127.0.0.1:1234'))).toBe('lm_456');
  });

  it('needs a terminal and a non-empty token, and takes no token argument', async () => {
    const root = await newRoot();
    const keychain = new MemoryKeychain();
    expect((await cli(root, ['auth', 'set-token', '--registry', 'https://registry.example'], { tty: false, secret: 'x', keychain })).code).toBe(3);
    expect((await cli(root, ['auth', 'set-token', '--registry', 'https://registry.example'], { secret: '  ', keychain })).code).toBe(2);
    expect((await cli(root, ['auth', 'set-token', '--registry', 'https://registry.example', '--token', 'abc'], { keychain })).code).toBe(2);
    expect(keychain.items.size).toBe(0);
  });
});
