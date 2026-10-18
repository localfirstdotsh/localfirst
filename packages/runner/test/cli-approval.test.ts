import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@localfirst/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { approverAccount, registryAccount } from '../src/cli/keychain.js';
import { makeHarness, MemoryKeychain, startFakeRegistry, type FakeRegistry, type HarnessOptions } from './support/cli-harness.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const newRoot = () => mkdtemp(join(tmpdir(), 'lf-approval-'));

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

const ok = (data: unknown, status = 200) => ({ status, json: { data, meta: { request_id: 'r' } } });
const fail = (status: number, code: string, message: string) => ({ status, json: { error: { code, message, retryable: false }, meta: { request_id: 'r' } } });

describe('auth approver-login', () => {
  it('prints the code, polls until approved, and stores the credential apart from the agent token', async () => {
    const reg = await registry();
    let polls = 0;
    reg.custom = (method, path) => {
      if (method === 'POST' && path === '/api/v1/approver-links') {
        return ok({ link_id: 'link-1', user_code: 'ABCD-2345', poll_secret: 'poll-secret-xxxxxxxxxxxx', verification_url: `${reg.origin}/account/devices?code=ABCD-2345`, expires_in: 600, interval: 3 }, 201);
      }
      if (method === 'POST' && path === '/api/v1/approver-links/link-1/token') {
        polls += 1;
        return polls < 3
          ? ok({ status: 'authorization_pending', interval: 3 }, 202)
          : ok({ status: 'issued', credential: 'lfh_secretvalue', credential_id: 'c1', label: 'my-mac', expires_at: '2026-11-13T00:00:00.000Z' });
      }
      return undefined;
    };
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'agent-token');
    const result = await cli(await newRoot(), ['auth', 'approver-login', '--registry', reg.origin, '--label', 'my-mac'], { keychain });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('ABCD-2345');
    expect(result.out).not.toContain('lfh_secretvalue');
    expect(polls).toBe(3);
    expect(keychain.items.get(approverAccount(reg.origin))).toBe('lfh_secretvalue');
    expect(keychain.items.get(registryAccount(reg.origin))).toBe('agent-token');
    expect(result.h.opened).toEqual([`${reg.origin}/account/devices?code=ABCD-2345`]);
    expect(reg.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
  });

  it('fails clearly when the request is denied, and stores nothing', async () => {
    const reg = await registry();
    reg.custom = (method, path) => {
      if (path === '/api/v1/approver-links') return ok({ link_id: 'link-1', user_code: 'ABCD-2345', poll_secret: 'poll-secret-xxxxxxxxxxxx', verification_url: `${reg.origin}/x`, expires_in: 600, interval: 3 }, 201);
      if (path.endsWith('/token')) return fail(410, 'INVALID_LIFECYCLE', 'The request was denied in the browser.');
      return undefined;
    };
    const keychain = new MemoryKeychain();
    const result = await cli(await newRoot(), ['auth', 'approver-login', '--registry', reg.origin], { keychain });
    expect(result.code).toBe(1);
    expect(result.err).toContain('denied in the browser');
    expect(keychain.items.size).toBe(0);
  });
});

describe('contribution approve', () => {
  const projectMd = '# Example\n\nBody text.\n';
  const files = [{ path: 'tests/a.yaml', content: 'key: a\n' }];
  const digest = digestOf({ project_md: projectMd, files });
  const review = (overrides: Record<string, unknown> = {}) => ({
    draft: { draft_id: 'draft-1', kind: 'project', state: 'ready_for_review', revision: 4, payload_digest: digest },
    stale: false,
    content: projectMd,
    content_label: 'Inspect exact documentation',
    content_digest: 'sha256:' + 'c'.repeat(64),
    slug: 'example',
    files,
    issues: [{ code: 'OFFLINE_UNVERIFIED', message: 'Offline operation is unverified.', severity: 'warning' }],
    warning_codes: ['OFFLINE_UNVERIFIED'],
    approval_window_seconds: 1800,
    ...overrides,
  });

  async function setup(reviewData: unknown = review()) {
    const reg = await registry();
    const decisions: any[] = [];
    reg.custom = (method, path, body) => {
      if (method === 'GET' && path === '/api/v1/drafts/draft-1/review') return ok(reviewData);
      if (method === 'POST' && path === '/api/v1/drafts/draft-1/approval') {
        decisions.push(body);
        return ok({ approval_id: body.decision === 'approved' ? 'approval-1' : null, decision: body.decision, draft: {} }, body.decision === 'approved' ? 201 : 200);
      }
      return undefined;
    };
    const keychain = new MemoryKeychain();
    keychain.items.set(approverAccount(reg.origin), 'lfh_secretvalue');
    keychain.items.set(registryAccount(reg.origin), 'agent-token');
    return { reg, decisions, keychain };
  }

  it('shows the exact content, asks for each limitation and the artifact, and sends the approval credential', async () => {
    const { reg, decisions, keychain } = await setup();
    const result = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', reg.origin], { keychain, tty: true, answers: ['yes', 'yes'] });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('Body text.');
    expect(result.out).toContain('Bundled file: tests/a.yaml');
    expect(result.out).toContain('recomputed here');
    expect(result.h.io.questions).toHaveLength(2);
    expect(result.h.io.questions[1]).toContain(digest);
    expect(decisions).toEqual([{ draft_revision: 4, payload_digest: digest, acknowledged_warning_codes: ['OFFLINE_UNVERIFIED'], decision: 'approved' }]);
    expect(reg.requests.every((request) => request.headers.authorization === 'Bearer lfh_secretvalue')).toBe(true);
    expect(result.out).toContain('approval-1');
  });

  it('records nothing unless every answer is yes', async () => {
    for (const answers of [[], ['no'], ['yes', 'no']]) {
      const { reg, decisions, keychain } = await setup();
      const result = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', reg.origin], { keychain, tty: true, answers });
      expect(result.code).toBe(3);
      expect(decisions).toEqual([]);
    }
  });

  it('needs an interactive terminal and never contacts the registry without one', async () => {
    const { reg, keychain } = await setup();
    const result = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', reg.origin], { keychain, tty: false, answers: ['yes', 'yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('interactive terminal');
    expect(reg.requests).toEqual([]);
  });

  it('refuses when the registry returns content that does not match its digest', async () => {
    const { reg, decisions, keychain } = await setup(review({ content: '# Example\n\nDifferent text.\n' }));
    const result = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', reg.origin], { keychain, tty: true, answers: ['yes', 'yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('does not match its own digest');
    expect(decisions).toEqual([]);
    expect(result.h.io.questions).toEqual([]);
  });

  it('refuses blocking issues and a stale record, but still lets a person deny without acknowledging', async () => {
    const blocked = review({ issues: [{ code: 'BAD', message: 'Fix this first.', severity: 'error' }] });
    const first = await setup(blocked);
    const refused = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', first.reg.origin], { keychain: first.keychain, tty: true, answers: ['yes', 'yes'] });
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('Fix this first.');
    expect(first.decisions).toEqual([]);

    const stale = await setup(review({ stale: true }));
    const staleResult = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', stale.reg.origin], { keychain: stale.keychain, tty: true, answers: ['yes', 'yes'] });
    expect(staleResult.code).toBe(3);
    expect(stale.decisions).toEqual([]);

    const denial = await setup();
    const denied = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--deny', '--registry', denial.reg.origin], { keychain: denial.keychain, tty: true, answers: ['yes'] });
    expect(denied.code, denied.err).toBe(0);
    expect(denial.decisions).toEqual([{ draft_revision: 4, payload_digest: digest, acknowledged_warning_codes: [], decision: 'denied' }]);
  });

  it('points to approver-login when the machine is not linked, using the agent token for nothing', async () => {
    const reg = await registry();
    const keychain = new MemoryKeychain();
    keychain.items.set(registryAccount(reg.origin), 'agent-token');
    const result = await cli(await newRoot(), ['contribution', 'approve', 'draft-1', '--registry', reg.origin], { keychain, tty: true, answers: ['yes'] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('approver-login');
    expect(reg.requests).toEqual([]);
  });
});
