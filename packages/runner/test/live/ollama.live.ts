/**
 * LIVE: real Ollama, real CLI, real adapter. Not part of `pnpm check`.
 * See `gate.ts` for the opt-in variables. The cloud-model failure is NOT
 * checked here: no cloud model is installed, so that case is covered only by
 * the labelled synthetic fixtures in the deterministic suite.
 */

import { describe, expect, it } from 'vitest';
import { OllamaAdapter, type AdapterInferRequest } from '../../src/index.js';
import { grant, settings } from '../support/conformance.js';
import { isTarget, ollamaTarget } from './gate.js';
import { liveSmoke, liveUnsupportedCapability } from './smoke.js';

const target = ollamaTarget();
const run = isTarget(target);

describe('LIVE Ollama', () => {
  it.skipIf(run)('is skipped unless opted in', () => {
    console.log(`LIVE Ollama skipped: ${(target as { skip: string }).skip}`);
  });

  it.skipIf(!run)('runs the section 5.2 smoke test and records the exact outcome', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const { planned, report } = await liveSmoke('ollama', endpoint, model);

    // What the real runtime told the adapter.
    expect(planned.out).toMatch(/application \d+\.\d+\.\d+/);
    expect(report.plan.runtime.family).toBe('ollama');
    expect(report.plan.runtime.application_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.plan.model.artifact_identity).toMatchObject({ scheme: 'ollama_manifest_sha256' });
    expect(report.plan.model.artifact_identity?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.checks).toEqual({ locality: 'pass', offline: 'not_run' });

    // An honest report: a small model may legitimately fail the label check.
    expect(['pass', 'fail']).toContain(report.outcome);
    expect(report.execution_state).toBe('local_report_saved');
    expect(report.counts.skipped).toBe(0);
    const detail = report.case_details[0]!;
    expect(detail.provider_stats.provider).toBe('ollama_native_v1');
    expect(typeof detail.provider_stats.eval_duration).toBe('number'); // raw nanoseconds, native unit

    const latency = report.measurements.latency_ms;
    expect(latency.value).not.toBeNull();
    expect(report.measurements.peak_memory_bytes).toMatchObject({ value: null });
    expect(report.measurements.time_to_first_token_ms).toMatchObject({ value: null, reason: 'nonstreaming_run' });

    console.log(
      'LIVE Ollama outcome ' +
        JSON.stringify({
          model,
          ollama_version: report.plan.runtime.application_version,
          outcome: report.outcome,
          case: { key: detail.key, outcome: detail.outcome, error_code: detail.error_code },
          output: detail.output_text,
          latency_ms: latency.value,
          tokens_per_second: report.measurements.tokens_per_second,
          eval_count: detail.provider_stats.eval_count,
          eval_duration_ns: detail.provider_stats.eval_duration,
          load_state: report.measurement_context.load_state,
        }),
    );
  });

  it.skipIf(!run)('streams a real reply: first content arrives before the end and matches the non-streamed text', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const adapter = new OllamaAdapter({ endpoint });
    const ask = (stream: boolean): AdapterInferRequest => ({
      model, grant, responseSchema: null,
      messages: [{ role: 'user', content: 'Reply with exactly the single word: ok' }],
      settings: { ...settings, stream, max_output_tokens: 16 },
    });
    const preflight = await adapter.preflight({
      model,
      requirements: { capabilities: ['chat'], locality: 'local_required', settings: { ...settings, stream: true }, structured_output: false },
    });
    expect(preflight.blockers.map((blocker) => blocker.code)).not.toContain('stream_unsupported');

    const events: Array<{ at: number; what: string }> = [];
    const began = performance.now();
    const streamed = await adapter.infer(ask(true), {
      signal: AbortSignal.timeout(120_000),
      onFirstContent: () => events.push({ at: performance.now() - began, what: 'first' }),
    });
    events.push({ at: performance.now() - began, what: 'end' });
    const plain = await adapter.infer(ask(false), { signal: AbortSignal.timeout(120_000) });

    expect(events.map((event) => event.what)).toEqual(['first', 'end']);
    expect(streamed.content.length).toBeGreaterThan(0);
    expect(streamed.providerStats.provider).toBe('ollama_native_v1');
    expect(typeof streamed.providerStats.eval_duration).toBe('number');
    expect(streamed.content.trim().toLowerCase()).toBe(plain.content.trim().toLowerCase());
    console.log(
      'LIVE Ollama stream ' +
        JSON.stringify({ model, first_content_ms: events[0]!.at, end_ms: events[1]!.at, streamed: streamed.content, plain: plain.content, eval_count: streamed.providerStats.eval_count }),
    );
  });

  it.skipIf(!run)('refuses a required capability the installed model does not have, before any inference', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const result = await liveUnsupportedCapability('ollama', endpoint, model);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/capability_(unsupported|unknown)/);
    expect(result.out).not.toContain('Plan written');
    console.log(`LIVE Ollama unsupported-capability refusal: ${result.err.trim().split('\n').slice(0, 2).join(' | ')}`);
  });

  it.skip('SYNTHETIC ONLY: a cloud model failing local-only preflight (no cloud model is installed to test live)', () => {});
});
