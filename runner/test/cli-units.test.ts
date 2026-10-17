import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBundleDir } from '../src/cli/bundle.js';
import { KeychainError, systemKeychain } from '../src/cli/keychain.js';
import { resolveHome } from '../src/cli/paths.js';
import type { CommandResult } from '../src/cli/process.js';
import { parseRegistryOrigin, RegistryClient } from '../src/cli/registry.js';
import { engineForFormat, resolveEndpoint } from '../src/cli/runtime.js';
import { ConsentError, ConsentSession } from '../src/index.js';

type Call = { command: string; args: string[]; input: string | undefined };
function runner(result: Partial<CommandResult> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command: string, args: string[], options?: { input?: string }): Promise<CommandResult> => {
      calls.push({ command, args, input: options?.input });
      return { code: 0, stdout: '', stderr: '', errorCode: null, ...result };
    },
  };
}

describe('keychain', () => {
  it('stores on macOS through `security -i` with the secret only on stdin', async () => {
    const fake = runner();
    await systemKeychain('darwin', fake.run).set('registry:https://r.example', 'tok_secret');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe('security');
    expect(fake.calls[0]!.args).toEqual(['-i']);
    expect(JSON.stringify(fake.calls[0]!.args)).not.toContain('tok_secret');
    expect(fake.calls[0]!.input).toContain(Buffer.from('tok_secret').toString('hex'));
    expect(fake.calls[0]!.input).not.toContain('tok_secret');
  });

  it('reads on macOS, treating "not found" as no token', async () => {
    expect(await systemKeychain('darwin', runner({ stdout: 'tok\n' }).run).get('a')).toBe('tok');
    expect(await systemKeychain('darwin', runner({ code: 44 }).run).get('a')).toBeNull();
    await expect(systemKeychain('darwin', runner({ code: 1 }).run).get('a')).rejects.toMatchObject({ code: 'keychain_failed' });
  });

  it('uses secret-tool on Linux with the secret on stdin and never in argv', async () => {
    const set = runner();
    await systemKeychain('linux', set.run).set('registry:https://r.example', 'tok_secret');
    expect(set.calls[0]).toMatchObject({ command: 'secret-tool', input: 'tok_secret' });
    expect(JSON.stringify(set.calls[0]!.args)).not.toContain('tok_secret');
    const get = runner({ stdout: 'tok_secret' });
    expect(await systemKeychain('linux', get.run).get('registry:https://r.example')).toBe('tok_secret');
    expect(get.calls[0]!.args).toEqual(['lookup', 'service', 'localfirstdotsh', 'account', 'registry:https://r.example']);
    expect(await systemKeychain('linux', runner({ code: 1 }).run).get('a')).toBeNull();
  });

  it('fails clearly when the tool is missing or the platform has no keychain, never falling back to a file', async () => {
    await expect(systemKeychain('linux', runner({ code: null, errorCode: 'ENOENT' }).run).get('a')).rejects.toMatchObject({ code: 'keychain_tool_missing' });
    await expect(systemKeychain('darwin', runner({ code: null, errorCode: 'ENOENT' }).run).set('a', 'b')).rejects.toMatchObject({ code: 'keychain_tool_missing' });
    const none = runner();
    const win = systemKeychain('win32', none.run);
    await expect(win.set('a', 'b')).rejects.toBeInstanceOf(KeychainError);
    await expect(win.get('a')).rejects.toMatchObject({ code: 'keychain_unsupported' });
    expect(none.calls).toEqual([]);
  });

  it('refuses a macOS token that the keychain tool would read back as hex', async () => {
    const fake = runner({});
    await expect(systemKeychain('darwin', fake.run).set('a', 'caf\u00e9')).rejects.toMatchObject({ code: 'keychain_failed' });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects account names that could inject keychain commands', async () => {
    const fake = runner();
    await expect(systemKeychain('darwin', fake.run).set('a" -w "x', 'b')).rejects.toBeInstanceOf(KeychainError);
    expect(fake.calls).toEqual([]);
  });
});

describe('paths', () => {
  it('puts everything under LOCALFIRST_HOME when set', () => {
    const home = resolveHome({ LOCALFIRST_HOME: '/tmp/x' }, '/home/u');
    expect(home.dataDir).toBe('/tmp/x/data');
    expect(home.reportsDir).toBe('/tmp/x/data/reports');
    expect(home.configDir).toBe('/tmp/x/config');
  });

  it('uses XDG locations otherwise', () => {
    expect(resolveHome({}, '/home/u').dataDir).toBe('/home/u/.local/share/localfirstdotsh');
    expect(resolveHome({ XDG_DATA_HOME: '/d', XDG_CONFIG_HOME: '/c' }, '/home/u')).toMatchObject({ dataDir: '/d/localfirstdotsh', configDir: '/c/localfirstdotsh' });
  });
});

describe('registry origin and client', () => {
  it('accepts https and loopback http origins only', () => {
    expect(parseRegistryOrigin('https://registry.example')).toBe('https://registry.example');
    expect(parseRegistryOrigin('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
    for (const bad of ['http://registry.example', 'ftp://x', 'https://u:p@x.example', 'https://x.example/api', 'https://x.example?q=1', 'nope']) {
      expect(() => parseRegistryOrigin(bad), bad).toThrow();
    }
  });

  it('never follows redirects and reports transport failures without a stack', async () => {
    let seenRedirect: RequestRedirect | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      throw new TypeError('redirect mode is set to error');
    }) as typeof fetch;
    const client = new RegistryClient('https://registry.example', fakeFetch, 'tok');
    await expect(client.getDraft('d')).rejects.toMatchObject({ code: 'REGISTRY_UNREACHABLE' });
    expect(seenRedirect).toBe('error');
  });

  it('sends the token only when given one', async () => {
    const seen: Array<string | null> = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ data: { current_version: { project_version_id: 'v' } } }), { status: 200 });
    }) as typeof fetch;
    await new RegistryClient('https://registry.example', fakeFetch).currentVersion('p');
    await new RegistryClient('https://registry.example', fakeFetch, 'tok').currentVersion('p');
    expect(seen).toEqual([null, 'Bearer tok']);
  });
});

describe('runtime helpers', () => {
  it('only accepts loopback runtime endpoints', () => {
    expect(resolveEndpoint('ollama', undefined)).toBe('http://127.0.0.1:11434');
    expect(resolveEndpoint('lmstudio', undefined)).toBe('http://127.0.0.1:1234');
    expect(() => resolveEndpoint('ollama', 'http://10.0.0.5:11434')).toThrow();
    expect(() => resolveEndpoint('ollama', 'https://api.example.com')).toThrow();
  });

  it('picks the engine for the model format and never exceeds the label limit', () => {
    const both = 'gguf=llama.cpp-mac-arm64-apple-metal-advsimd@2.51.0;mlx=mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0';
    expect(engineForFormat(both, 'mlx')).toBe('mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0');
    expect(engineForFormat(both, 'gguf')).toBe('llama.cpp-mac-arm64-apple-metal-advsimd@2.51.0');
    expect(engineForFormat(both, null)).toBeNull();
    expect(engineForFormat(null, 'mlx')).toBeNull();
    expect(engineForFormat(`mlx=${'x'.repeat(70)}`, 'mlx')).toBeNull();
  });
});

describe('bundle reading', () => {
  it('refuses symlinks inside the bundle and a missing PROJECT.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-bundle-'));
    await expect(readBundleDir(dir)).rejects.toThrow(/PROJECT.md/);
    await writeFile(join(dir, 'PROJECT.md'), '# x');
    await mkdir(join(dir, 'TESTS'));
    await writeFile(join(dir, 'outside.txt'), 'secret');
    await symlink(join(dir, 'outside.txt'), join(dir, 'TESTS', 'link.yaml'));
    await expect(readBundleDir(dir)).rejects.toThrow(/symlink/);
  });
});

describe('consent session additions used by the CLI', () => {
  const d = (char: string) => `sha256:${char.repeat(64)}`;

  it('accepts an approved plan as the discovery authorization for a run, and nothing else', () => {
    const session = new ConsentSession({ project_manifest_digest: d('1') });
    session.advance('local_discovery_authorized', { runtime: 'ollama', endpoint: 'http://127.0.0.1:11434', channel: 'approved_plan' });
    const bad = new ConsentSession({ project_manifest_digest: d('1') });
    expect(() =>
      bad.advance('local_discovery_authorized', { runtime: 'ollama', endpoint: 'x', channel: 'stored_approval' } as never),
    ).toThrow(ConsentError);
  });

  it('resumes after a saved report or a reviewed export, without replaying earlier stages', () => {
    const afterReport = ConsentSession.resume('local_report_saved', { project_manifest_digest: d('1'), report_digest: d('2') });
    expect(afterReport.state).toBe('local_report_saved');
    expect(afterReport.history.at(-1)?.detail).toMatchObject({ resumed: true });
    afterReport.advance('export_reviewed', { payload_digest: d('3') });
    afterReport.advance('upload_authorized', { payload_digest: d('3'), registry_origin: 'https://r.example', channel: 'interactive_tty' });

    const afterExport = ConsentSession.resume('export_reviewed', { project_manifest_digest: d('1'), payload_digest: d('3') });
    expect(() => afterExport.advance('upload_authorized', { payload_digest: d('4'), registry_origin: 'https://r.example', channel: 'interactive_tty' })).toThrow(
      expect.objectContaining({ code: 'digest_mismatch' }),
    );
    expect(() => afterExport.advance('private_submission', { payload_digest: d('3'), submission_id: 's' })).toThrow(
      expect.objectContaining({ code: 'stage_skipped' }),
    );
    expect(() => ConsentSession.resume('export_reviewed', { project_manifest_digest: d('1') })).toThrow(ConsentError);
  });
});
