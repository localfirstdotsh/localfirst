import { describe, expect, it } from 'vitest';
import { AdapterError, RefusedTestError, plannedInferenceRequests, runTest } from '../src/index.js';
import { exampleManifest, hang, manifestWith, scriptedAdapter } from './helpers.js';

const twoCases = (extra: (raw: Record<string, any>) => void = () => undefined) =>
  manifestWith((raw) => {
    raw.cases = ['one-001', 'two-002', 'three-003'].map((key) => ({
      key,
      messages: [{ role: 'user', content: `prompt ${key}` }],
      evaluation: { kind: 'json_assert_v1', assertions: [{ path: '/label', equals: 'billing' }] },
    }));
    raw.limits.max_cases = 3;
    extra(raw);
  });

const good = '{"label":"billing"}';

describe('runTest', () => {
  it('passes the PRD example against a conforming reply', async () => {
    const adapter = scriptedAdapter(() => good);
    const run = await runTest({ manifest: exampleManifest(), adapter });
    expect(run.state).toBe('completed');
    expect(run.cases).toHaveLength(1);
    expect(run.cases[0]).toMatchObject({ key: 'billing-001', repetition: 1, outcome: 'pass', output_text: good });
    expect(run.cases[0]?.provider_stats).toEqual({ eval_count: 7, eval_duration: 39_123_000 });
    expect(adapter.calls[0]?.settings).toMatchObject({ temperature: 0, max_output_tokens: 32, stream: false });
    expect(adapter.calls[0]?.responseSchema).toMatchObject({ type: 'object' });
  });

  it('runs warmups first, then each repetition over every case in order', async () => {
    const manifest = twoCases((raw) => {
      raw.measurement.repetitions = 2;
      raw.measurement.warmup_runs = 1;
    });
    const adapter = scriptedAdapter(() => good);
    const run = await runTest({ manifest, adapter });
    expect(adapter.calls.map((call) => call.messages[0]?.content)).toEqual([
      'prompt one-001', // warmup, not evaluated
      'prompt one-001',
      'prompt two-002',
      'prompt three-003',
      'prompt one-001',
      'prompt two-002',
      'prompt three-003',
    ]);
    expect(adapter.calls).toHaveLength(plannedInferenceRequests(manifest));
    expect(run.warmups_executed).toBe(1);
    expect(run.cases.map((entry) => `${entry.key}#${entry.repetition}`)).toEqual([
      'one-001#1', 'two-002#1', 'three-003#1', 'one-001#2', 'two-002#2', 'three-003#2',
    ]);
  });

  it('gives every case a pass, fail, or error result and keeps errors in the record', async () => {
    const adapter = scriptedAdapter((_, call) => {
      if (call === 1) return good;
      if (call === 2) return '{"label":"support"}';
      throw new AdapterError('model_not_found', 'no such model');
    });
    const run = await runTest({ manifest: twoCases(), adapter });
    expect(run.cases.map((entry) => entry.outcome)).toEqual(['pass', 'fail', 'error']);
    expect(run.cases[1]?.error_code).toBe('value_mismatch');
    expect(run.cases[2]).toMatchObject({ error_code: 'model_not_found', output_text: null });
    expect(run.state).toBe('completed');
  });

  it('makes one attempt per request and never retries a failure', async () => {
    const adapter = scriptedAdapter(() => {
      throw new Error('boom');
    });
    const run = await runTest({ manifest: twoCases(), adapter });
    expect(adapter.calls).toHaveLength(3);
    expect(run.cases.every((entry) => entry.error_code === 'adapter_error')).toBe(true);
  });

  it('turns an oversized reply into an error without recording it', async () => {
    const adapter = scriptedAdapter(() => 'x'.repeat(70_000));
    const run = await runTest({ manifest: exampleManifest(), adapter });
    expect(run.cases[0]).toMatchObject({ outcome: 'error', error_code: 'output_too_large', output_text: null });
  });

  it('times out a hung request and continues with the next case', async () => {
    const manifest = twoCases((raw) => {
      raw.limits.request_timeout_ms = 30;
      raw.limits.run_timeout_ms = 5000;
    });
    const adapter = scriptedAdapter((_, call, signal) => (call === 2 ? hang(signal) : good));
    const run = await runTest({ manifest, adapter });
    expect(run.cases.map((entry) => [entry.outcome, entry.error_code])).toEqual([
      ['pass', null],
      ['error', 'request_timeout'],
      ['pass', null],
    ]);
    expect(run.state).toBe('completed');
  });

  it('stops at the run timeout and counts the remaining cases as skipped', async () => {
    const manifest = twoCases((raw) => {
      raw.limits.request_timeout_ms = 100;
      raw.limits.run_timeout_ms = 120;
    });
    const adapter = scriptedAdapter((_, __, signal) => hang(signal));
    const run = await runTest({ manifest, adapter });
    expect(run.state).toBe('run_timeout');
    expect(run.cases.map((entry) => entry.outcome)).toEqual(['error', 'error', 'skipped']);
    expect(run.cases[0]?.error_code).toBe('request_timeout');
    expect(run.cases[1]?.error_code).toBe('run_timeout');
    expect(run.diagnostic_codes).toContain('run_timeout');
    expect(adapter.calls).toHaveLength(2);
  });

  it('cancels in flight, keeps a partial record, skips the rest, and never retries', async () => {
    const controller = new AbortController();
    const adapter = scriptedAdapter((_, call, signal) => {
      if (call === 2) {
        controller.abort();
        return hang(signal);
      }
      return good;
    });
    const run = await runTest({ manifest: twoCases(), adapter, signal: controller.signal });
    expect(run.state).toBe('cancelled');
    expect(run.cases.map((entry) => entry.outcome)).toEqual(['pass', 'error', 'skipped']);
    expect(run.cases[1]?.error_code).toBe('cancelled_in_flight');
    expect(adapter.calls).toHaveLength(2);
    expect(run.diagnostic_codes).toContain('run_cancelled');
  });

  it('does not start anything when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = scriptedAdapter(() => good);
    const run = await runTest({ manifest: twoCases(), adapter, signal: controller.signal });
    expect(adapter.calls).toHaveLength(0);
    expect(run.state).toBe('cancelled');
    expect(run.cases.every((entry) => entry.outcome === 'skipped')).toBe(true);
  });

  it('records a failed warmup as a diagnostic without evaluating it', async () => {
    const manifest = twoCases((raw) => (raw.measurement.warmup_runs = 1));
    const adapter = scriptedAdapter((_, call) => {
      if (call === 1) throw new Error('cold start failed');
      return good;
    });
    const run = await runTest({ manifest, adapter });
    expect(run.diagnostic_codes).toContain('warmup_failed');
    expect(run.cases).toHaveLength(3);
    expect(run.cases.every((entry) => entry.outcome === 'pass')).toBe(true);
  });

  it('refuses a non-executable manifest before calling the adapter', async () => {
    const manifest = structuredClone(exampleManifest()) as any;
    manifest.execution.allow_tools = true;
    const adapter = scriptedAdapter(() => good);
    await expect(runTest({ manifest, adapter })).rejects.toBeInstanceOf(RefusedTestError);
    expect(adapter.calls).toHaveLength(0);
  });

  it('uses the injected monotonic clock for start offsets and latency', async () => {
    let tick = 0;
    const adapter = scriptedAdapter(() => good);
    const run = await runTest({ manifest: exampleManifest(), adapter, nowMs: () => (tick += 10) });
    expect(run.cases[0]?.latency_ms).toBeGreaterThan(0);
    expect(run.cases[0]?.started_at_monotonic_ms).toBeGreaterThanOrEqual(0);
  });
});
