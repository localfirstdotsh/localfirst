import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { makeSignature } from 'better-auth/crypto';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML } from '@localfirst/contracts';
import { auth } from '../auth/instance.js';
import { db } from '../db/client.js';
import { approverCredentials, publicationApprovals } from '../db/schema/registry.js';
import { createDirectProjectDraft, revalidateDraft } from '../services/drafts.js';
import { createAccount, mintToken } from './evidence-fixture.js';
import { isolatedDatabases, startServer } from './harness.js';

/**
 * BACKEND_PRD section 10.4 "local approval", end to end: the real runner CLI
 * (under a pseudo-terminal) against the real HTTP server, with the link code
 * approved by a person in real Chrome. Nothing is faked on the path except the
 * OS keychain and `open`, which are file-backed stubs placed first on PATH so
 * the drill never touches the user's keychain or opens their browser.
 *
 * Needs `python3` (its `pty` module provides the terminal).
 */

const here = dirname(fileURLToPath(import.meta.url));
const runnerBin = resolve(here, '../../../runner/src/cli/bin.ts');
const tsx = resolve(here, '../../node_modules/.bin/tsx');

const resources = await isolatedDatabases();
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let sandbox: string | undefined;
const steps: Array<{ step: string; passed: boolean; detail?: unknown }> = [];
const step = (name: string, passed: boolean, detail?: unknown) => {
  steps.push({ step: name, passed, ...(detail === undefined ? {} : { detail }) });
};

/** A runner process on a pseudo-terminal whose prompts the drill answers. */
const PTY_RELAY = `
import os, pty, select, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
stdin_open = True
while True:
    readers = [master] + ([0] if stdin_open else [])
    ready, _, _ = select.select(readers, [], [], 0.2)
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(master, data)
        else:
            stdin_open = False
    if child.poll() is not None and master not in ready:
        break
sys.exit(child.wait())
`;

function runCli(args: string[], env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn('python3', ['-c', PTY_RELAY, tsx, runnerBin, ...args], { env: { ...process.env, ...env } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const exited = new Promise<number>((resolveExit) => child.on('close', (code) => resolveExit(code ?? -1)));
  return {
    output: () => output.replaceAll('\r', ''),
    send: (text: string) => child.stdin.write(text),
    waitFor: async (needle: string | RegExp, timeoutMs = 60_000) => {
      for (let waited = 0; waited < timeoutMs; waited += 100) {
        const text = output.replaceAll('\r', '');
        const match = typeof needle === 'string' ? (text.includes(needle) ? [needle] : null) : needle.exec(text);
        if (match) return match;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for ${needle}. Output so far:\n${output}`);
    },
    exited,
  };
}

try {
  sandbox = await mkdtemp(join(tmpdir(), 'lf-local-approval-'));
  const bin = join(sandbox, 'bin');
  await mkdir(bin);
  const keychainFile = join(sandbox, 'keychain.json');
  const openedFile = join(sandbox, 'opened.txt');
  await writeFile(keychainFile, '{}');
  // Stub `security`: the two command shapes the runner uses, backed by a JSON file.
  await writeFile(join(bin, 'security'), `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.STUB_KEYCHAIN;
const items = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'find-generic-password') {
  const account = args[args.indexOf('-a') + 1];
  if (!(account in items)) process.exit(44);
  process.stdout.write(items[account] + '\\n');
} else if (args[0] === '-i') {
  const input = fs.readFileSync(0, 'utf8');
  const match = /add-generic-password -a "([^"]+)" -s \\S+ -U -X ([0-9a-f]+)/.exec(input);
  if (!match) process.exit(1);
  items[match[1]] = Buffer.from(match[2], 'hex').toString('utf8');
  fs.writeFileSync(file, JSON.stringify(items));
} else process.exit(2);
`);
  await writeFile(join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${openedFile}"\n`);
  await chmod(join(bin, 'security'), 0o755);
  await chmod(join(bin, 'open'), 0o755);

  server = await startServer();
  const base = server.baseUrl;
  const person = await createAccount();
  const agentToken = await mintToken(person.userId, 'projects:read projects:draft projects:publish');
  const cliEnv = {
    PATH: `${bin}:${process.env.PATH}`, HOME: sandbox, STUB_KEYCHAIN: keychainFile,
    LOCALFIRST_REGISTRY: base, NO_COLOR: '1',
  };

  // The agent has a draft ready; nothing is approved yet.
  const { draft } = await createDirectProjectDraft({
    actor: person.actor, ownerUserId: person.userId, projectId: null,
    payload: { project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] },
  });
  const { draft: ready, validation } = await revalidateDraft(person.actor, draft.id);

  // 1. The terminal refuses to approve before the machine is linked.
  const unlinked = runCli(['contribution', 'approve', ready.id], cliEnv);
  const unlinkedCode = await unlinked.exited;
  step('approving before linking is refused and points to approver-login', unlinkedCode !== 0 && unlinked.output().includes('approver-login'), unlinked.output().trim().slice(0, 200));

  // 2. Link the machine: the code is approved by a person in real Chrome.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const ctx = await (auth() as unknown as { $context: Promise<any> }).$context;
  const session = await ctx.internalAdapter.createSession(person.userId, false);
  await context.addCookies([{
    name: ctx.authCookies.sessionToken.name, value: `${session.token}.${await makeSignature(session.token, ctx.secret)}`,
    url: base, httpOnly: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') problems.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const w = globalThis as any;
    w.document.addEventListener('securitypolicyviolation', (event: any) => {
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const login = runCli(['auth', 'approver-login', '--label', 'drill-laptop'], cliEnv);
  const [, code] = await login.waitFor(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/);
  const [, verificationUrl] = await login.waitFor(/open:\n\s+(\S+)/);
  // `open` runs just after the URL is printed.
  let opened = '';
  for (let waited = 0; !opened && waited < 5_000; waited += 100) {
    opened = (await readFile(openedFile, 'utf8').catch(() => '')).trim();
    if (!opened) await new Promise((r) => setTimeout(r, 100));
  }
  step('the CLI prints the code and opens only the registry\'s own page', opened === verificationUrl && new URL(verificationUrl!).origin === base, { code, opened });

  const response = await page.goto(verificationUrl!);
  assert.equal(response?.status(), 200);
  const linkText = (await page.textContent('#link-request')) ?? '';
  step('the browser page shows the machine and the same code', linkText.includes('drill-laptop') && linkText.includes(code!), linkText.replace(/\s+/g, ' ').slice(0, 160));
  await page.click('#link-approve');
  await page.waitForFunction(() => (globalThis as any).document.getElementById('link-status')?.textContent?.includes('Approved'), undefined, { timeout: 10_000 });
  const linkExit = await login.exited;
  step('the terminal finishes by itself once the person approves', linkExit === 0 && login.output().includes('Linked.'), login.output().trim().split('\n').slice(-3));
  assert.ok(!login.output().includes('lfh_'), 'the credential must never be printed');
  const stored = JSON.parse(await readFile(keychainFile, 'utf8')) as Record<string, string>;
  step('the credential is in the keychain under the approver account, not the agent token\'s', Object.keys(stored).join() === `approver:${base}` && stored[`approver:${base}`]!.startsWith('lfh_'), Object.keys(stored));
  const credential = stored[`approver:${base}`]!;

  // 3. What the credential cannot do, over real HTTP.
  const bearer = { authorization: `Bearer ${credential}` };
  const refusals = await Promise.all([
    fetch(`${base}/api/v1/me`, { headers: bearer }),
    fetch(`${base}/api/v1/drafts/${ready.id}`, { headers: bearer }),
    fetch(`${base}/api/v1/drafts/${ready.id}/publish`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json', 'idempotency-key': 'x' }, body: '{}' }),
    fetch(`${base}/mcp`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }),
  ]);
  step('the credential is refused on /me, draft reads, publishing, and MCP', refusals.every((r) => r.status === 401 || r.status === 403), refusals.map((r) => r.status));

  // 4. Approve in the terminal, then the agent publishes once.
  const approve = runCli(['contribution', 'approve', ready.id], cliEnv);
  await approve.waitFor('--- end ---');
  const shown = approve.output();
  step('the terminal shows the exact documentation and bundled test, and recomputes the digest',
    shown.includes('name: Local Request Labeler') && shown.includes(`Bundled file: ${EXAMPLE_TEST_PATH}`) && shown.includes('recomputed here'),
    shown.split('\n').slice(0, 3));
  for (let i = 0; i < validation.warning_codes.length; i += 1) {
    await approve.waitFor(/Acknowledge this limitation\? Type "yes": /);
    approve.send('yes\n');
    await approve.waitFor(new RegExp(`(Acknowledge this limitation\\? Type "yes": [\\s\\S]*){${i + 1}}`));
  }
  await approve.waitFor(/Approve exactly this artifact[\s\S]*Type "yes": /);
  const tooEarly = await publishWith(base, agentToken, ready, undefined);
  step('the agent cannot publish while the person is still deciding', tooEarly.status === 409 || tooEarly.status === 400, tooEarly.status);
  approve.send('yes\n');
  const approveExit = await approve.exited;
  step('the CLI records the approval', approveExit === 0 && approve.output().includes('Approval recorded'), approve.output().trim().split('\n').slice(-2));
  const [row] = await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, ready.id));
  const [cred] = await db().select().from(approverCredentials).where(eq(approverCredentials.userId, person.userId));
  step('the approval names the device and no browser session', row?.approverCredentialId === cred?.id && row?.sessionId === null && row?.decision === 'approved',
    { approver_credential: !!row?.approverCredentialId, session: row?.sessionId });
  const published = await publishWith(base, agentToken, ready, row!.id);
  const replay = await publishWith(base, agentToken, ready, row!.id, 'second');
  step('the agent then publishes the approved revision once', published.status === 201 && replay.status >= 400, { first: published.status, second: replay.status });

  // 5. Revoke in the browser; the machine stops working at once.
  const second = await createDirectProjectDraft({
    actor: person.actor, ownerUserId: person.userId, projectId: null,
    payload: { project_md: `${EXAMPLE_PROJECT_MD.trimEnd()}\n\nA second draft.\n`, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] },
  });
  const secondReady = (await revalidateDraft(person.actor, second.draft.id)).draft;
  await page.goto(`${base}/account/devices`);
  const listText = (await page.textContent('body')) ?? '';
  step('the account page lists the device by label', listText.includes('drill-laptop'), null);
  await page.click('.device summary');
  await page.click('[data-revoke-device]');
  await page.waitForFunction(() => (globalThis as any).document.getElementById('devices-status')?.textContent?.includes('revoked'), undefined, { timeout: 10_000 });
  const afterRevoke = runCli(['contribution', 'approve', secondReady.id], cliEnv);
  const revokedExit = await afterRevoke.exited;
  step('after revocation the CLI cannot review or approve', revokedExit !== 0 && !afterRevoke.output().includes('Approval recorded'), afterRevoke.output().trim().split('\n').slice(-2));
  const csp = await page.evaluate(() => ((globalThis as any).__csp ?? []) as string[]);
  step('the devices page works under the CSP with no page errors', problems.length === 0 && csp.length === 0, { problems, csp });
} catch (error) {
  step('unexpected failure', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await resources.cleanup();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
}

async function publishWith(base: string, token: string, draft: { id: string; revision: number; payloadDigest: string }, approvalId: string | undefined, key = 'first') {
  return fetch(`${base}/api/v1/drafts/${draft.id}/publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `local-approval-${key}-${randomUUID()}` },
    body: JSON.stringify({ approval_id: approvalId ?? randomUUID(), draft_revision: draft.revision, payload_digest: draft.payloadDigest }),
  });
}

const passed = steps.every((entry) => entry.passed);
console.log(JSON.stringify({ local_approval: { steps, passed } }, null, 2));
process.exit(passed ? 0 : 1);
