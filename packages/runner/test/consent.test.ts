import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  ConsentError,
  ConsentSession,
  approveInteractively,
  describePlan,
  type MachineState,
} from '../src/index.js';
import { planFor } from './helpers.js';

const d = (char: string) => `sha256:${char.repeat(64)}`;

function sessionAtPlanReviewed(plan = d('a')) {
  const session = new ConsentSession({ project_manifest_digest: d('1') });
  session.advance('local_discovery_authorized', { runtime: 'ollama', endpoint: 'http://127.0.0.1:11434', channel: 'interactive_tty' });
  session.advance('preflight', {});
  session.advance('plan_reviewed', { plan_digest: plan });
  return session;
}

function sessionRunning() {
  const session = sessionAtPlanReviewed();
  session.advance('execution_authorized', { plan_digest: d('a'), channel: 'interactive_tty' });
  session.advance('running', { plan_digest: d('a'), bundle_verified: true });
  return session;
}

describe('ConsentSession', () => {
  it('walks the full local and sharing path in order', () => {
    const session = sessionRunning();
    session.advance('local_report_saved', { report_digest: d('b') });
    session.advance('export_reviewed', { payload_digest: d('c') });
    session.advance('upload_authorized', { payload_digest: d('c'), registry_origin: 'https://registry.example', channel: 'interactive_tty' });
    session.advance('private_submission', { payload_digest: d('c'), submission_id: 'sub_1' });
    session.advance('public_contribution_approved', { payload_digest: d('c'), channel: 'browser_confirmation' });
    session.advance('published', {});
    expect(session.state).toBe('published');
    expect(session.history.map((entry) => entry.state)).toEqual([
      'spec_retrieved', 'local_discovery_authorized', 'preflight', 'plan_reviewed', 'execution_authorized',
      'running', 'local_report_saved', 'export_reviewed', 'upload_authorized', 'private_submission',
      'public_contribution_approved', 'published',
    ] satisfies MachineState[]);
  });

  it('cannot skip a stage, so discovery never implies execution', () => {
    const session = new ConsentSession({ project_manifest_digest: d('1') });
    expect(() => session.advance('execution_authorized' as never, { plan_digest: d('a'), channel: 'interactive_tty' } as never)).toThrow(
      expect.objectContaining({ code: 'stage_skipped' }),
    );
    session.advance('local_discovery_authorized', { runtime: 'lmstudio', endpoint: 'http://127.0.0.1:1234', channel: 'interactive_tty' });
    expect(() => session.advance('running', { plan_digest: d('a'), bundle_verified: true })).toThrow(
      expect.objectContaining({ code: 'stage_skipped' }),
    );
  });

  it('needs its own evidence for every authorizing stage', () => {
    const fresh = () => new ConsentSession({ project_manifest_digest: d('1') });
    expect(() => fresh().advance('local_discovery_authorized', { runtime: 'ollama', endpoint: 'http://127.0.0.1:11434', channel: 'stored_approval' } as never)).toThrow(ConsentError);
    expect(() => fresh().advance('local_discovery_authorized', { runtime: 'vllm', endpoint: 'x', channel: 'interactive_tty' } as never)).toThrow(ConsentError);

    const planned = sessionAtPlanReviewed();
    expect(() => planned.advance('execution_authorized', { plan_digest: d('a'), channel: 'browser_confirmation' } as never)).toThrow(ConsentError);

    const authorized = sessionAtPlanReviewed();
    authorized.advance('execution_authorized', { plan_digest: d('a'), channel: 'stored_approval' });
    expect(() => authorized.advance('running', { plan_digest: d('a'), bundle_verified: false } as never)).toThrow(ConsentError);
  });

  it('binds execution to the reviewed plan digest', () => {
    const session = sessionAtPlanReviewed(d('a'));
    expect(() => session.advance('execution_authorized', { plan_digest: d('b'), channel: 'interactive_tty' })).toThrow(
      expect.objectContaining({ code: 'digest_mismatch' }),
    );
    session.advance('execution_authorized', { plan_digest: d('a'), channel: 'interactive_tty' });
    expect(() => session.advance('running', { plan_digest: d('b'), bundle_verified: true })).toThrow(
      expect.objectContaining({ code: 'digest_mismatch' }),
    );
  });

  it('binds upload and public approval to the exact reviewed export', () => {
    const session = sessionRunning();
    session.advance('local_report_saved', { report_digest: d('b') });
    session.advance('export_reviewed', { payload_digest: d('c') });
    expect(() => session.advance('upload_authorized', { payload_digest: d('d'), registry_origin: 'https://registry.example', channel: 'interactive_tty' })).toThrow(
      expect.objectContaining({ code: 'digest_mismatch' }),
    );
    session.advance('upload_authorized', { payload_digest: d('c'), registry_origin: 'https://registry.example', channel: 'interactive_tty' });
    session.advance('private_submission', { payload_digest: d('c'), submission_id: 'sub_1' });
    expect(() => session.advance('public_contribution_approved', { payload_digest: d('c'), channel: 'interactive_tty' } as never)).toThrow(ConsentError);
    expect(() => session.advance('public_contribution_approved', { payload_digest: d('e'), channel: 'browser_confirmation' })).toThrow(
      expect.objectContaining({ code: 'digest_mismatch' }),
    );
  });

  it('cancelling a running session preserves a partial report and is terminal', () => {
    const session = sessionRunning();
    expect(session.cancel('user pressed ctrl-c')).toEqual({ partialReportRequired: true });
    expect(session.state).toBe('cancelled');
    expect(session.partialReportRequired).toBe(true);
    expect(() => session.advance('local_report_saved', { report_digest: d('b') })).toThrow(
      expect.objectContaining({ code: 'terminal_state' }),
    );
    expect(() => session.cancel('again')).toThrow(ConsentError);
    session.markPartialReportSaved(d('f'));
    expect(session.partialReportRequired).toBe(false);
  });

  it('owes no partial report when cancelled before execution', () => {
    const session = sessionAtPlanReviewed();
    expect(session.cancel('changed my mind')).toEqual({ partialReportRequired: false });
    expect(() => session.markPartialReportSaved(d('f'))).toThrow(ConsentError);
  });

  it('exposes no way back or retry after cancel or failure', () => {
    const session = sessionRunning();
    expect(session.fail('runtime crashed')).toEqual({ partialReportRequired: true });
    for (const name of ['retry', 'resume', 'restart', 'reset']) {
      expect((session as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    expect(() => session.advance('local_report_saved', { report_digest: d('b') })).toThrow(ConsentError);
  });

  it('requires a manifest digest to start', () => {
    expect(() => new ConsentSession({ project_manifest_digest: 'nope' })).toThrow(ConsentError);
  });
});

describe('plan approval', () => {
  it('shows the exact digest and effects', () => {
    const plan = planFor();
    const text = describePlan(plan);
    expect(text).toContain(plan.plan_digest);
    expect(text).toContain(plan.test.fixture_digest);
    expect(text).toContain('http://127.0.0.1:11434');
    expect(text).toContain('1 inference request(s)');
    expect(text).toContain('no downloads, no tools, no project code, no upload');
  });

  it('grants only on an explicit yes from the prompter', async () => {
    const plan = planFor();
    const seen: string[] = [];
    const yes = await approveInteractively(plan, { confirm: async (summary, digest) => (seen.push(summary, digest), true) });
    expect(yes).toEqual({ plan_digest: plan.plan_digest, channel: 'interactive_tty' });
    expect(seen).toEqual([describePlan(plan), plan.plan_digest]);
    expect(await approveInteractively(plan, { confirm: async () => false })).toBeNull();
    expect(await approveInteractively(plan, { confirm: async () => 'yes' as never })).toBeNull();
  });
});

describe('ApprovalStore', () => {
  const setup = async () => new ApprovalStore(join(await mkdtemp(join(tmpdir(), 'lf-approvals-')), 'approvals'), () => new Date('2026-10-11T20:00:00Z'));

  it('stores an interactive approval bound to one digest, privately', async () => {
    const store = await setup();
    const plan = planFor();
    expect(await store.find(plan.plan_digest)).toBeNull();
    const saved = await store.save({ plan_digest: plan.plan_digest, channel: 'interactive_tty' });
    expect(saved).toMatchObject({ plan_digest: plan.plan_digest, approved_at: '2026-10-11T20:00:00.000Z' });
    expect(await store.grantFor(plan.plan_digest)).toEqual({ plan_digest: plan.plan_digest, channel: 'stored_approval' });
    expect(await store.find(d('9'))).toBeNull();
    const other = planFor(undefined, (body) => (body.model.runtime_model_id = 'qwen3.6:27b'));
    expect(await store.grantFor(other.plan_digest)).toBeNull();
    const file = join((store as any).directory, `${plan.plan_digest.slice(7)}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('refuses to store anything but an interactive approval', async () => {
    const store = await setup();
    await expect(store.save({ plan_digest: d('a'), channel: 'stored_approval' })).rejects.toThrow(/interactive/);
  });

  it('ignores tampered, malformed, or relabelled approval files', async () => {
    const store = await setup();
    const plan = planFor();
    await store.save({ plan_digest: plan.plan_digest, channel: 'interactive_tty' });
    const file = join((store as any).directory, `${plan.plan_digest.slice(7)}.json`);
    const original = JSON.parse(await readFile(file, 'utf8'));

    for (const edit of [
      { ...original, plan_digest: d('0') },
      { ...original, channel: 'stored_approval' },
      { ...original, extra: true },
      { ...original, schema: 'other' },
    ]) {
      await writeFile(file, JSON.stringify(edit));
      expect(await store.find(plan.plan_digest)).toBeNull();
    }
    await writeFile(file, '{not json');
    expect(await store.find(plan.plan_digest)).toBeNull();
  });

  it('revokes an approval and never builds a path from a malformed digest', async () => {
    const store = await setup();
    const plan = planFor();
    await store.save({ plan_digest: plan.plan_digest, channel: 'interactive_tty' });
    await store.revoke(plan.plan_digest);
    expect(await store.find(plan.plan_digest)).toBeNull();
    expect(await store.find('../../etc/passwd')).toBeNull();
    await expect(store.revoke('../../etc/passwd')).rejects.toThrow(/malformed/);
    await expect(store.save({ plan_digest: '../x', channel: 'interactive_tty' })).rejects.toThrow(/malformed/);
  });
});
