import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { EXIT } from '../src/cli/errors.js';
import { DEFAULT_REGISTRY } from '../src/cli/commands/mcp.js';
import { makeHarness, startFakeRegistry, type FakeRegistry } from './support/cli-harness.js';

let registry: FakeRegistry;
beforeAll(async () => { registry = await startFakeRegistry(); });
afterAll(async () => registry.close());

const ok = { code: 0, errorCode: null };

describe('mcp add', () => {
  it('prints the exact Claude Code command from the registry metadata, changing nothing', async () => {
    const h = await makeHarness({ tty: false });
    const code = await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin, '--print'], h.env);
    expect(code).toBe(EXIT.ok);
    expect(h.io.text()).toBe(`claude mcp add --transport http --scope user localfirst ${registry.origin}/mcp\n`);
    expect(h.spawned).toEqual([]);
    expect(h.fetched).toEqual([`${registry.origin}/.well-known/oauth-protected-resource/mcp`]);
  });

  it('registers Gemini over HTTP with explicit scope and client-owned OAuth', async () => {
    const h = await makeHarness({ answers: ['yes'], runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', 'gemini-cli', '--registry', registry.origin], h.env)).toBe(EXIT.ok);
    expect(h.spawned).toEqual([['gemini', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'localfirst', `${registry.origin}/mcp`]]);
    expect(h.io.text()).toContain('/mcp auth localfirst');
    expect(h.spawned.flat()).not.toContain('--trust');
  });

  it('prints Gemini project registration without writing settings or launching a client', async () => {
    const h = await makeHarness({ tty: false });
    expect(await runCli(['mcp', 'add', '--client', 'gemini-cli', '--scope', 'project', '--registry', registry.origin, '--name', 'localfirst-dev', '--print'], h.env)).toBe(EXIT.ok);
    expect(h.io.text()).toBe(`gemini mcp add --transport http --scope project localfirst-dev ${registry.origin}/mcp\n`);
    expect(h.spawned).toEqual([]);
    expect(await runCli(['mcp', 'add', '--client', 'gemini-cli', '--scope', 'local', '--registry', registry.origin, '--print'], h.env)).toBe(EXIT.usage);
  });

  it('requires confirmation and an installed Gemini executable', async () => {
    const declined = await makeHarness({ answers: ['no'], runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', 'gemini-cli', '--registry', registry.origin], declined.env)).toBe(EXIT.refused);
    expect(declined.spawned).toEqual([]);
    const missing = await makeHarness({ answers: ['yes'] });
    expect(await runCli(['mcp', 'add', '--client', 'gemini-cli', '--registry', registry.origin], missing.env)).toBe(EXIT.failed);
    expect(missing.io.stderr.join('')).toContain('`gemini` was not found');
  });

  it('runs the native command only after an interactive yes, without a shell', async () => {
    const h = await makeHarness({ answers: ['yes'], runInteractive: () => ok });
    const code = await runCli(['mcp', 'add', '--client', 'codex', '--registry', registry.origin, '--name', 'localfirst-staging'], h.env);
    expect(code).toBe(EXIT.ok);
    expect(h.spawned).toEqual([['codex', 'mcp', 'add', 'localfirst-staging', '--url', `${registry.origin}/mcp`]]);
    expect(h.io.text()).toContain(`codex mcp add localfirst-staging --url ${registry.origin}/mcp`);
    expect(h.io.text()).toContain('starts its own browser sign-in in this terminal');
    expect(h.io.text()).toContain('codex mcp login localfirst-staging');
  });

  it('changes nothing on any answer but yes, and refuses without a terminal', async () => {
    const declined = await makeHarness({ answers: ['no'], runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin], declined.env)).toBe(EXIT.refused);
    expect(declined.spawned).toEqual([]);
    const headless = await makeHarness({ tty: false, runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin], headless.env)).toBe(EXIT.refused);
    expect(headless.spawned).toEqual([]);
    expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin, '--yes'], headless.env)).toBe(EXIT.usage);
  });

  it.each([
    ['cursor', '~/.cursor/mcp.json', (url: string) => ({ mcpServers: { localfirst: { url } } })],
    ['vscode', '.vscode/mcp.json', (url: string) => ({ servers: { localfirst: { type: 'http', url } } })],
    ['opencode', 'opencode.json', (url: string) => ({ mcp: { localfirst: { type: 'remote', url, enabled: true } } })],
    ['windsurf', 'mcp_config.json', (url: string) => ({ mcpServers: { localfirst: { serverUrl: url } } })],
    ['cline', 'cline_mcp_settings.json', (url: string) => ({ mcpServers: { localfirst: { type: 'streamableHttp', url, disabled: false, autoApprove: [] } } })],
  ])('prints the %s configuration entry and never spawns anything or writes a file', async (client, file, expected) => {
    const h = await makeHarness({ tty: false, runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin], h.env)).toBe(EXIT.ok);
    const out = h.io.text();
    expect(out).toContain(file);
    expect(JSON.parse(/(\{\n[\s\S]*\n\})\n/.exec(out)![1]!)).toEqual(expected(`${registry.origin}/mcp`));
    expect(h.spawned).toEqual([]);
    expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin, '--scope', 'user'], h.env)).toBe(EXIT.usage);
    expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin, '--name', 'Bad Name'], h.env)).toBe(EXIT.usage);
  });

  it.each([
    ['claude-desktop', 'Customize > Connectors', 'Register automatically'],
    ['chatgpt', 'Add custom MCP server', 'must include /mcp'],
  ])('prints the verified URL and the %s steps without running or writing anything', async (client, step, hint) => {
    const h = await makeHarness({ tty: false, runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin], h.env)).toBe(EXIT.ok);
    const out = h.io.text();
    expect(out).toContain(`MCP server URL: ${registry.origin}/mcp`);
    expect(out).toContain(step);
    expect(out).toContain(hint);
    expect(h.spawned).toEqual([]);
    expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin, '--scope', 'user'], h.env)).toBe(EXIT.usage);
  });

  it('offers a one-click install link for Cursor and VS Code that carries only the URL', async () => {
    const url = `${registry.origin}/mcp`;
    for (const [client, check] of [
      ['cursor', (link: URL) => JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString())],
      ['vscode', (link: URL) => JSON.parse(link.searchParams.get('config')!)],
    ] as const) {
      const h = await makeHarness({ tty: false });
      expect(await runCli(['mcp', 'add', '--client', client, '--registry', registry.origin], h.env)).toBe(EXIT.ok);
      const link = new URL(/^ {2}((?:cursor|https):\S+)$/m.exec(h.io.text())![1]!);
      expect(link.searchParams.get('name')).toBe('localfirst');
      expect(check(link)).toEqual(client === 'cursor' ? { url } : { type: 'http', url });
      expect(h.io.text()).toContain('asks you to confirm');
    }
    // A custom name cannot be put in the link, so none is offered.
    const custom = await makeHarness({ tty: false });
    await runCli(['mcp', 'add', '--client', 'cursor', '--registry', registry.origin, '--name', 'other'], custom.env);
    expect(custom.io.text()).not.toContain('cursor-deeplink');
  });

  it('registers GitHub Copilot CLI over HTTP after approval, with no scope option', async () => {
    const h = await makeHarness({ answers: ['yes'], runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--client', 'github-copilot', '--registry', registry.origin], h.env)).toBe(EXIT.ok);
    expect(h.spawned).toEqual([['copilot', 'mcp', 'add', '--transport', 'http', 'localfirst', `${registry.origin}/mcp`]]);
    expect(await runCli(['mcp', 'add', '--client', 'github-copilot', '--registry', registry.origin, '--scope', 'user', '--print'], h.env)).toBe(EXIT.usage);
  });

  it('refuses an MCP server advertised on another origin', async () => {
    registry.mcpResource = 'https://elsewhere.example/mcp';
    try {
      const h = await makeHarness({ answers: ['yes'], runInteractive: () => ok });
      expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin], h.env)).toBe(EXIT.refused);
      expect(h.spawned).toEqual([]);
      expect(h.io.stderr.join('')).toContain('different origin');
    } finally {
      registry.mcpResource = null;
    }
  });

  it('offers only tested clients and validates the name and scope', async () => {
    const h = await makeHarness({ tty: false });
    const usage = async (...extra: string[]) => runCli(['mcp', 'add', '--registry', registry.origin, ...extra], h.env);
    expect(await usage()).toBe(EXIT.usage);
    expect(await usage('--client', 'zed')).toBe(EXIT.usage);
    expect(h.io.stderr.join('')).toContain('not a tested client');
    expect(await usage('--client', 'claude-code', '--name', 'Bad Name', '--print')).toBe(EXIT.usage);
    expect(await usage('--client', 'claude-code', '--scope', 'global', '--print')).toBe(EXIT.usage);
    expect(await usage('--client', 'codex', '--scope', 'user', '--print')).toBe(EXIT.usage);
    expect(h.spawned).toEqual([]);
  });

  it('asks which application to set up when --client is omitted, marking clients found on PATH', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'lf-path-'));
    await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
    await chmod(join(bin, 'codex'), 0o755);
    const h = await makeHarness({ answers: ['2', 'yes'], runInteractive: () => ok, vars: { PATH: bin } });
    expect(await runCli(['mcp', 'add', '--registry', registry.origin], h.env)).toBe(EXIT.ok);
    const out = h.io.text();
    expect(out).toContain('Which application should connect to Localfirst?');
    expect(out).toContain(' 2. Codex CLI (`codex` found)');
    expect(out).toContain(' 1. Claude Code\n');
    expect(out).toContain('11. ChatGPT');
    expect(h.io.questions[0]).toBe('Enter 1-11: ');
    expect(h.spawned).toEqual([['codex', 'mcp', 'add', 'localfirst', '--url', `${registry.origin}/mcp`]]);
  });

  it('accepts a client key at the menu and changes nothing for any other answer', async () => {
    const named = await makeHarness({ answers: ['Cursor'], runInteractive: () => ok });
    expect(await runCli(['mcp', 'add', '--registry', registry.origin], named.env)).toBe(EXIT.ok);
    expect(named.io.text()).toContain('~/.cursor/mcp.json');
    for (const answer of ['', '0', '12', 'zed']) {
      const h = await makeHarness({ answers: [answer], runInteractive: () => ok });
      expect(await runCli(['mcp', 'add', '--registry', registry.origin], h.env)).toBe(EXIT.refused);
      expect(h.io.text()).toContain('No application chosen. Nothing was changed.');
      expect(h.fetched).toEqual([]);
      expect(h.spawned).toEqual([]);
    }
  });

  it('never shows the menu to a script or with --print', async () => {
    const printing = await makeHarness({ answers: ['1'] });
    expect(await runCli(['mcp', 'add', '--registry', registry.origin, '--print'], printing.env)).toBe(EXIT.usage);
    expect(printing.io.questions).toEqual([]);
    expect(printing.io.stderr.join('')).toContain('Pass --client');
  });

  it('defaults to the public registry, and LOCALFIRST_REGISTRY overrides it', async () => {
    const stub = (h: Awaited<ReturnType<typeof makeHarness>>) => {
      h.env.fetch = async (input) => {
        h.fetched.push(String(input));
        const origin = new URL(String(input)).origin;
        return new Response(JSON.stringify({ resource: `${origin}/mcp` }), { headers: { 'content-type': 'application/json' } });
      };
    };
    const byDefault = await makeHarness({ tty: false });
    stub(byDefault);
    expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--print'], byDefault.env)).toBe(EXIT.ok);
    expect(byDefault.fetched).toEqual([`${DEFAULT_REGISTRY}/.well-known/oauth-protected-resource/mcp`]);
    expect(byDefault.io.text()).toBe(`claude mcp add --transport http --scope user localfirst ${DEFAULT_REGISTRY}/mcp\n`);

    const fromEnv = await makeHarness({ tty: false, vars: { LOCALFIRST_REGISTRY: 'https://registry.example' } });
    stub(fromEnv);
    expect(await runCli(['mcp', 'add', '--client', 'codex', '--print'], fromEnv.env)).toBe(EXIT.ok);
    expect(fromEnv.fetched).toEqual(['https://registry.example/.well-known/oauth-protected-resource/mcp']);
  });

  it('reports a missing client binary and a refused change honestly', async () => {
    const missing = await makeHarness({ answers: ['yes'] });
    expect(await runCli(['mcp', 'add', '--client', 'codex', '--registry', registry.origin], missing.env)).toBe(EXIT.failed);
    expect(missing.io.stderr.join('')).toContain('`codex` was not found');
    const refused = await makeHarness({ answers: ['yes'], runInteractive: () => ({ code: 1, errorCode: null }) });
    expect(await runCli(['mcp', 'add', '--client', 'claude-code', '--registry', registry.origin], refused.env)).toBe(EXIT.failed);
    expect(refused.io.stderr.join('')).toContain('did not complete the change (exit 1)');
  });
});

describe('mcp add against a misbehaving registry', () => {
  async function withServer(listener: RequestListener, run: (origin: string) => Promise<void>) {
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function print(origin: string) {
    const h = await makeHarness({ tty: false, fetch: globalThis.fetch });
    const code = await runCli(['mcp', 'add', '--client', 'codex', '--registry', origin, '--print'], h.env);
    return { code, stderr: h.io.stderr.join(''), stdout: h.io.text(), spawned: h.spawned };
  }

  it('does not follow a redirect to another origin', async () => {
    let followed = false;
    await withServer((req, res) => {
      if (req.url === '/elsewhere') { followed = true; res.end('{}'); return; }
      res.writeHead(302, { location: '/elsewhere' }).end();
    }, async (origin) => {
      const result = await print(origin);
      expect(result.code).toBe(EXIT.failed);
      expect(result.stdout).toBe('');
      expect(followed).toBe(false);
    });
  });

  it.each([
    ['HTTP 404', (res: import('node:http').ServerResponse) => res.writeHead(404).end(), 'did not publish MCP metadata (HTTP 404)'],
    ['HTTP 500', (res: import('node:http').ServerResponse) => res.writeHead(500).end('boom'), 'did not publish MCP metadata (HTTP 500)'],
    ['malformed JSON', (res: import('node:http').ServerResponse) => res.writeHead(200).end('{not json'), 'without a resource URL'],
    ['an empty body', (res: import('node:http').ServerResponse) => res.writeHead(200).end(), 'without a resource URL'],
    ['a non-string resource', (res: import('node:http').ServerResponse) => res.writeHead(200).end('{"resource":42}'), 'without a resource URL'],
    ['an unparseable resource', (res: import('node:http').ServerResponse) => res.writeHead(200).end('{"resource":"::"}'), 'invalid MCP resource URL'],
    ['an oversized body', (res: import('node:http').ServerResponse) => res.writeHead(200).end(`{"resource":"${'a'.repeat(200_000)}"}`), 'without a resource URL'],
  ])('fails with a clear message on %s and changes nothing', async (_name, respond, message) => {
    await withServer((_req, res) => void respond(res), async (origin) => {
      const result = await print(origin);
      expect(result.code).toBe(EXIT.failed);
      expect(result.stderr).toContain(message);
      expect(result.spawned).toEqual([]);
    });
  });

  it('refuses an advertised MCP URL that embeds credentials or a query', async () => {
    for (const resource of ['{origin}/mcp?token=1', 'http://user:pw@{origin_host}/mcp']) {
      await withServer((_req, res) => {
        const address = res.req.socket.localPort;
        const filled = resource.replace('{origin_host}', `127.0.0.1:${address}`).replace('{origin}', `http://127.0.0.1:${address}`);
        res.writeHead(200).end(JSON.stringify({ resource: filled }));
      }, async (origin) => {
        const result = await print(origin);
        expect(result.code).toBe(EXIT.refused);
        expect(result.stdout).toBe('');
      });
    }
  });

  it('reports an unreachable registry without a stack trace', async () => {
    const result = await print('http://127.0.0.1:1');
    expect(result.code).toBe(EXIT.failed);
    expect(result.stderr).toContain('Could not reach http://127.0.0.1:1');
  });
});
