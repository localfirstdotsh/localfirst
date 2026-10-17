import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localReportSchema, testResultSchema } from '@localfirst/contracts';
import {
  ExportRefusedError,
  buildLocalReport,
  exportSanitized,
  readLocalReport,
  runTest,
  saveLocalReport,
} from '../src/index.js';
import { exampleManifest, hang, manifestWith, planFor, scriptedAdapter } from './helpers.js';

const good = '{"label":"billing"}';
const secretOutput = '{"label":"billing","note":"private customer text 4242"}';

async function reportFor(
  reply: (call: number, signal: AbortSignal) => string | Promise<string> = () => secretOutput,
  options: { manifest?: ReturnType<typeof exampleManifest>; signal?: AbortSignal; data?: 'public_fixture' | 'private_local' } = {},
) {
  const manifest = options.manifest ?? exampleManifest();
  const adapter = scriptedAdapter((_, call, signal) => reply(call, signal));
  const run = await runTest({ manifest, adapter, signal: options.signal });
  const plan = planFor(undefined, (body) => {
    if (options.data) body.data_class = options.data;
  });
  return buildLocalReport({
    plan,
    manifest,
    run,
    clientRunId: 'run_local_0001',
   
    completedAt: '2026-10-11T20:00:00Z',
  });
}

describe('buildLocalReport', () => {
  it('builds a valid local report that keeps output and raw provider statistics', async () => {
    const report = await reportFor();
    expect(localReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      outcome: 'pass',
      counts: { defined: 1, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 },
      checks: { locality: 'pass', offline: 'not_run' },
      execution_state: 'local_report_saved',
      data_class: 'public_fixture',
      build_id: 'local',
    });
    expect(report.case_details[0]?.output_text).toBe(secretOutput);
    expect(report.case_details[0]?.provider_stats.eval_duration).toBe(39_123_000);
  });

  it('measures client latency and leaves everything without a method null with a reason', async () => {
    const report = await reportFor();
    expect(report.measurements.latency_ms).toMatchObject({ method: 'client_monotonic_end_to_end_v1', samples: 1 });
    expect(report.measurements.time_to_first_token_ms).toEqual({ value: null, reason: 'nonstreaming_run' });
    // The scripted adapter reports no provider tag, so there is no method-tagged token rate.
    expect(report.measurements.tokens_per_second).toEqual({ value: null, reason: 'provider_statistics_missing' });
    expect(report.measurements.peak_memory_bytes).toEqual({ value: null, reason: 'runtime_sensor_unavailable' });
    expect(report.measurements.hardware_utilization).toEqual({ value: null, reason: 'sensor_unavailable' });
    expect(report.checks.offline).toBe('not_run');
    expect(report.hardware).toBeNull();
    expect(report.plan.plan_digest).toBe(report.plan_digest);
  });

  it('carries a streamed run\'s first-token time into the report and the sanitized upload', async () => {
    const manifest = manifestWith((raw) => (raw.inference.stream = true));
    let now = 0;
    const adapter = {
      async infer(_request: unknown, options: { onFirstContent?: () => void }) {
        now += 12;
        options.onFirstContent?.();
        now += 20;
        return { content: good, providerStats: {} };
      },
    };
    const run = await runTest({ manifest, adapter: adapter as never, nowMs: () => now });
    const report = await buildLocalReport({
      plan: planFor(undefined, () => undefined),
      manifest,
      run,
      clientRunId: 'run_local_0002',
      completedAt: '2026-10-11T20:00:00Z',
    });
    expect(localReportSchema.safeParse(report).success).toBe(true);
    expect(report.measurements.time_to_first_token_ms).toEqual({ value: 12, method: 'client_monotonic_first_content_chunk_v1', samples: 1 });
    const exported = exportSanitized(report, { build_id: 'build_abc123', test_definition_id: 'test_abc123' });
    expect(testResultSchema.safeParse(exported.payload).success).toBe(true);
    expect((exported.payload as { measurements: Record<string, unknown> }).measurements.time_to_first_token_ms).toMatchObject({ value: 12 });
  });

  it('reports fail, error, and counted skips honestly', async () => {
    const manifest = manifestWith((raw) => {
      raw.cases = ['a-001', 'b-002', 'c-003'].map((key) => ({
        key,
        messages: [{ role: 'user', content: key }],
        evaluation: { kind: 'json_assert_v1', assertions: [{ path: '/label', equals: 'billing' }] },
      }));
      raw.limits.max_cases = 3;
    });
    const failing = await reportFor((call) => (call === 2 ? '{"label":"other"}' : good), { manifest });
    expect(failing.outcome).toBe('fail');
    expect(failing.counts).toMatchObject({ passed: 2, failed: 1 });

    const erroring = await reportFor((call) => { if (call === 2) throw new Error('x'); return good; }, { manifest });
    expect(erroring.outcome).toBe('error');
    expect(erroring.counts).toMatchObject({ passed: 2, errors: 1 });

    const controller = new AbortController();
    const cancelled = await reportFor(
      (call, signal) => { if (call === 2) { controller.abort(); return hang(signal); } return good; },
      { manifest, signal: controller.signal },
    );
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.execution_state).toBe('cancelled_partial');
    expect(cancelled.counts).toMatchObject({ defined: 3, evaluated: 2, passed: 1, errors: 1, skipped: 1 });
    expect(cancelled.diagnostic_codes).toContain('run_cancelled');
  });

  it('treats an unknown locality method as an unknown locality check', async () => {
    const manifest = exampleManifest();
    const run = await runTest({ manifest, adapter: scriptedAdapter(() => good) });
    const plan = planFor(undefined, (body) => (body.model.locality_method = 'user_declared'));
    const report = buildLocalReport({ plan, manifest, run, clientRunId: 'run_local_0002', completedAt: '2026-10-11T20:00:00Z' });
    expect(report.checks.locality).toBe('unknown');
  });
});

describe('local report files', () => {
  it('writes privately, round-trips, and never overwrites a run', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'lf-reports-')), 'reports');
    const report = await reportFor();
    const saved = await saveLocalReport(dir, report);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(await readLocalReport(saved.path)).toEqual(report);
    expect(saved.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(saveLocalReport(dir, report)).rejects.toThrow(/already exists/);
    expect(await readdir(dir)).toEqual(['run_local_0001.report.json']);
    expect(JSON.parse(await readFile(saved.path, 'utf8')).case_details[0].output_text).toBe(secretOutput);
  });

  it('rejects an invalid report instead of writing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-reports-'));
    const report = { ...(await reportFor()), counts: { defined: 9, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 } };
    await expect(saveLocalReport(dir, report)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('exportSanitized', () => {
  const ids = { build_id: 'build_abc123', test_definition_id: 'test_abc123' };

  it('exports only the allowlisted fields and a digest of the exact payload', async () => {
    const report = await reportFor();
    const exported = exportSanitized(report, ids);
    expect(testResultSchema.safeParse(exported.payload).success).toBe(true);
    const text = JSON.stringify(exported.payload);
    expect(text).not.toContain('4242');
    expect(text).not.toContain('private customer text');
    expect(text).not.toContain('eval_duration');
    expect(Object.keys(exported.payload)).not.toContain('case_details');
    expect(Object.keys(exported.payload)).not.toContain('plan');
    expect(Object.keys(exported.payload)).not.toContain('hardware');
    expect(text).not.toContain('qwen2.5');
    expect(exported.payload).toMatchObject({ ...ids, visibility_requested: 'private', checks: { offline: 'not_run' } });
    expect(exportSanitized(report, ids).payload_digest).toBe(exported.payload_digest);
    expect(exportSanitized(report, { ...ids, build_id: 'build_other1' }).payload_digest).not.toBe(exported.payload_digest);
  });

  it('refuses private local runs', async () => {
    const report = await reportFor(undefined, { data: 'private_local' });
    expect(() => exportSanitized(report, ids)).toThrow(expect.objectContaining({ reason: 'private_data_class' }));
    expect(() => exportSanitized(report, ids)).toThrow(ExportRefusedError);
  });

  it('refuses reports whose build or test definition is not registered yet', async () => {
    const report = await reportFor();
    expect(() => exportSanitized(report)).toThrow(expect.objectContaining({ reason: 'build_not_saved' }));
    expect(() => exportSanitized(report, { build_id: ids.build_id })).not.toThrow();
    const unresolved = { ...report, test_definition_id: 'local' };
    expect(() => exportSanitized(unresolved, { build_id: ids.build_id })).toThrow(
      expect.objectContaining({ reason: 'test_definition_unresolved' }),
    );
  });

  it('exports a partial cancelled report with its skipped cases visible', async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await reportFor(undefined, { signal: controller.signal });
    const exported = exportSanitized(report, ids);
    expect(exported.payload.outcome).toBe('cancelled');
    expect(exported.payload.counts).toMatchObject({ defined: 1, skipped: 1, evaluated: 0 });
  });
});
