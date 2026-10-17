/**
 * LIVE: real LM Studio, real CLI, real adapter. Not part of `pnpm check`.
 * This check never starts the LM Studio server or loads a model: it runs only
 * when you have started the server yourself, loaded a model, and opted in
 * (see `gate.ts`). Otherwise it skips with the reason.
 */

import { describe, expect, it } from 'vitest';
import { LmStudioAdapter, type AdapterInferRequest } from '../../src/index.js';
import { grant, settings } from '../support/conformance.js';
import { isTarget, lmStudioTarget } from './gate.js';
import { liveSmoke, liveUnsupportedCapability } from './smoke.js';

const target = await lmStudioTarget();
const run = isTarget(target);

describe('LIVE LM Studio', () => {
  it.skipIf(run)('is skipped unless the server is already running and you opted in', () => {
    console.log(`LIVE LM Studio skipped: ${(target as { skip: string }).skip}`);
  });

  it.skipIf(!run)('runs the section 5.2 smoke test and records the exact outcome', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const { report } = await liveSmoke('lmstudio', endpoint, model, { platform: process.platform });
    expect(report.plan.runtime.family).toBe('lmstudio');
    expect(['pass', 'fail']).toContain(report.outcome);
    expect(report.execution_state).toBe('local_report_saved');
    console.log(
      'LIVE LM Studio outcome ' +
        JSON.stringify({
          model,
          application: report.plan.runtime.application_version,
          cli: report.plan.runtime.cli_version,
          engine: report.plan.runtime.engine_version,
          outcome: report.outcome,
          output: report.case_details[0]!.output_text,
        }),
    );
  });

  it.skipIf(!run)('streams a real reply: first content arrives before the end and matches the non-streamed text', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const adapter = new LmStudioAdapter({ endpoint });
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
    expect(streamed.content.trim().toLowerCase()).toBe(plain.content.trim().toLowerCase());
    console.log(
      'LIVE LM Studio stream ' +
        JSON.stringify({ model, first_content_ms: events[0]!.at, end_ms: events[1]!.at, streamed: streamed.content, plain: plain.content, provider_stats: streamed.providerStats }),
    );
  });

  it.skipIf(!run)('refuses a required capability the model does not have, before any inference', async () => {
    const { endpoint, model } = target as { endpoint: string; model: string };
    const result = await liveUnsupportedCapability('lmstudio', endpoint, model, { platform: process.platform });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/capability_(unsupported|unknown)/);
  });
});
