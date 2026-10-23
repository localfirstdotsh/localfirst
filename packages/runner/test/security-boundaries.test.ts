import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBundleSource, validateBundle } from '../src/cli/bundle.js';
import { terminalSafe } from '../src/cli/io.js';
import { registryAccount } from '../src/cli/keychain.js';
import { runCli } from '../src/cli/main.js';
import { makeHarness, MemoryKeychain, startFakeRegistry, type FakeRegistry, type HarnessOptions } from './support/cli-harness.js';
import { LOCAL, startFakeOllama, type FakeOllama } from './support/fake-ollama.js';

/**
 * Release-gate regressions for the runner's trust boundaries: content an agent
 * or registry controls must not spoof what a person reads, redirect where the
 * CLI connects, or write through a planted symlink.
 */

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function registry(): Promise<FakeRegistry> {
  const reg = await startFakeRegistry();
  closers.push(() => reg.close());
  return reg;
}

async function cli(argv: string[], options: HarnessOptions = {}) {
  const h = await makeHarness(options);
  const code = await runCli(argv, h.env);
  return { code, h, out: h.io.text(), err: h.io.stderr.join('') };
}

// The characters a draft author could use to move the cursor, recolor, or hide text.
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

describe('terminalSafe', () => {
  it('shows every cursor-moving, recoloring, or invisible character as a visible escape', () => {
    expect(terminalSafe('a\rb\u001b[2Kc\u009bd\u200be\u202ef\u007f')).toBe('a\\u{000d}b\\u{001b}[2Kc\\u{009b}d\\u{200b}e\\u{202e}f\\u{007f}');
  });

  it('keeps ordinary text, tabs, newlines and non-Latin scripts unchanged', () => {
    const text = 'Line one\n\tindented — café, 日本語, emoji 🚀\n';
    expect(terminalSafe(text)).toBe(text);
  });
});

describe('contribution review: registry content cannot spoof the terminal', () => {
  it('escapes registry error messages and draft fields', async () => {
    const reg = await registry();
    reg.draft = { kind: 'project', state: 'ready\u001b]0;pwned\u0007', revision: 1, payload_digest: 'sha256:' + 'a'.repeat(64), review_url: null };
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'agent-token');
    const review = await cli(['contribution', 'review', 'draft-1', '--registry', reg.origin], { keychain });
    expect(review.code, review.err).toBe(0);
    expect(review.out).not.toMatch(RAW_CONTROL);
    expect(review.out).toContain('ready\\u{001b}]0;pwned\\u{0007}');

    reg.custom = () => ({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Denied\u001b[2K\rApproved.' }, meta: { request_id: 'r' } } });
    const denied = await cli(['contribution', 'review', 'draft-1', '--registry', reg.origin], { keychain });
    expect(denied.code).toBe(1);
    expect(denied.err).not.toMatch(RAW_CONTROL);
    expect(denied.err).toContain('Denied\\u{001b}[2K\\u{000d}Approved.');
  });
});

describe('environment run: the workspace cannot redirect the freshness check', () => {
  let runtime: FakeOllama | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it('refuses a registry_origin in the workspace metadata that is not https or loopback, and contacts nothing', async () => {
    const prep = await makeHarness({ answers: ['yes'] });
    expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'bakery'], prep.env), prep.io.stderr.join('')).toBe(0);
    const workspace = prep.dir('bakery');
    const testKey = validateBundle(await new LocalBundleSource(workspace).load()).workflow_tests![0]!.manifest.key;
    // The metadata file is not covered by the bundle digest, so anyone who can write the workspace can edit it.
    const metaPath = join(workspace, '.localfirst-bundle.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    await writeFile(metaPath, JSON.stringify({ ...meta, registry_origin: 'http://198.51.100.7', test_definition_ids: { [testKey]: '00000000-0000-4000-8000-000000000009' } }));

    runtime = await startFakeOllama();
    const planner = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'plan', 'bakery', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', runtime.url], planner.env), planner.io.stderr.join('')).toBe(0);
    const planPath = /Plan saved: (.+)\n/.exec(planner.io.text())![1]!;

    const runner = await makeHarness({ root: prep.root, answers: ['yes'] });
    const contacted: string[] = [];
    runner.env.fetch = async (input) => {
      contacted.push(String(input));
      throw new TypeError('network blocked by test');
    };
    const code = await runCli(['environment', 'run', planPath], runner.env);
    expect(code).not.toBe(0);
    expect(contacted).toEqual([]);
    expect(runner.io.stderr.join('')).toContain('registry must be https');
    expect(runner.io.questions).toEqual([]);
    expect(runtime.requests.filter((request) => request.path === '/api/chat')).toHaveLength(0);
  });
});

describe('bundle writes never follow a planted symlink', () => {
  it('refuses to write bundle metadata through a symlink in the output directory', async () => {
    const reg = await registry();
    const h = await makeHarness();
    const victim = join(h.root, 'victim.txt');
    await writeFile(victim, 'original\n');
    await mkdir(h.dir('out'));
    await symlink(victim, join(h.dir('out'), '.localfirst-bundle.json'));
    const code = await runCli(['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin], h.env);
    expect(code).not.toBe(0);
    expect(await readFile(victim, 'utf8')).toBe('original\n');
    expect((await lstat(join(h.dir('out'), '.localfirst-bundle.json'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a registry bundle path that escapes the output directory, writing nothing', async () => {
    const reg = await registry();
    const files = reg.definition.bundle_files as Array<Record<string, unknown>>;
    reg.definition = { ...reg.definition, bundle_files: files.map((file) => ({ ...file, path: '../escaped.yaml' })) };
    const result = await cli(['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin]);
    expect(result.code).toBe(3);
    await expect(lstat(join(result.h.env.cwd, 'escaped.yaml'))).rejects.toThrow();
    await expect(lstat(result.h.dir('out'))).rejects.toThrow();
  });
});

describe('command execution stays an argument vector', () => {
  it('rejects shell metacharacters in an MCP server name before contacting anything', async () => {
    const reg = await registry();
    for (const name of ['x;touch /tmp/pwned', '$(id)', '`id`', 'a b', '--help', 'x\nclaude']) {
      const result = await cli(['mcp', 'add', '--client', 'claude-code', '--registry', reg.origin, '--name', name], { tty: true, answers: ['yes'] });
      expect(result.code, name).toBe(2);
      expect(result.h.spawned, name).toEqual([]);
    }
    expect(reg.requests).toEqual([]);
  });
});

describe('package lifecycle', () => {
  it('declares no install-time scripts, so installing the package runs nothing', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string> };
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish']) {
      expect(manifest.scripts?.[hook], hook).toBeUndefined();
    }
  });
});
