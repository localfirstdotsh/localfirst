import { describe, it, expect } from 'vitest';
import { bakeryBundle, bakeryFrameworkBundle, digestOf, digestOfBytes, environmentSchema, LANGGRAPH_LOCK_DIGEST } from '@localfirst/contracts';
import { runWorkflow } from '../src/workflows/run.js';
import { runOperation } from '../src/workflows/operations.js';
import { readPointer } from '../src/workflows/state.js';
import type { InferenceAdapter, InferRequest } from '../src/adapters/types.js';

const order = (units = 60, date = '2026-11-06', decoration = 'blue') => ({ units, pickup_date: date, pickup_time: '10:00', decoration, items: units ? [{ sku: 'chocolate', quantity: units / 2 }, { sku: 'vanilla', quantity: units / 2 }] : [] });
const goldenOrders = [
  order(), order(60, ''), order(90), order(60, '2026-11-06', 'gold sculpture'), order(90), order(0), order(60, '2026-11-08'), order(),
];
const response = (content: unknown) => ({ content: JSON.stringify(content), providerStats: {} });
function sampleRun(adapter?: InferenceAdapter) {
  const sample = bakeryBundle();
  let step = 0;
  const recorded: InferRequest[] = [];
  const scripted = {
    async infer(request: InferRequest) {
      recorded.push(request);
      const index = step++, kind = index % 3;
      return response(kind === 0 ? goldenOrders[Math.floor(index / 3)] : kind === 1 ? { summary: 'Capacity summarized.' } : { text: 'Draft for owner review.', display_total: JSON.parse(request.messages[1]!.content).price.display_total, decision_status: JSON.parse(request.messages[1]!.content).decision.status });
    },
  };
  return { sample, recorded, options: { environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: adapter ?? scripted } };
}
describe('bounded local coordinator', () => {
  it('runs all public cases and computes authoritative results independently of prose', async () => {
    const fixture = sampleRun(), result = await runWorkflow(fixture.options);
    expect(result.state).toBe('completed');
    expect(result.cases.map(c => c.outcome)).toEqual(Array(8).fill('pass'));
    expect(fixture.recorded).toHaveLength(24);
    expect(result.cases[0]!.steps.map(s => s.id)).toEqual(['intake', 'capacity', 'production', 'price', 'decision', 'quote']);
    expect(readPointer(result.cases[0]!.output, '/price/total_minor')).toBe(16500);
    expect(readPointer(result.cases[4]!.output, '/order/units')).toBe(90);
    expect(readPointer(result.cases[4]!.output, '/price/total_minor')).toBe(24750);
  });
  it('passes only declared upstream fields into each agent', async () => {
    const fixture = sampleRun(); await runWorkflow(fixture.options);
    expect(Object.keys(JSON.parse(fixture.recorded[1]!.messages[1]!.content))).toEqual(['order', 'capacity']);
    expect(Object.keys(JSON.parse(fixture.recorded[2]!.messages[1]!.content))).toEqual(['order', 'capacity', 'price', 'decision']);
  });
  it('rejects malformed agent output without retries or downstream work', async () => {
    let calls = 0;
    const fixture = sampleRun({ async infer() { calls++; return { content: '{invalid', providerStats: {} }; } });
    const result = await runWorkflow(fixture.options);
    expect(calls).toBe(8);
    expect(result.cases.every(c => c.error_code === 'invalid_agent_json')).toBe(true);
    expect(result.cases[0]!.steps.slice(1).every(s => s.outcome === 'skipped')).toBe(true);
  });
  it('refuses an attempt by the quote agent to inject computed state', async () => {
    let calls = 0;
    const fixture = sampleRun({ async infer() { const i = calls++ % 3; return response(i === 0 ? order() : i === 1 ? { summary: 'ok' } : { text: 'free', total_minor: 0, capacity: true }); } });
    const result = await runWorkflow(fixture.options);
    expect(result.cases[0]!.error_code).toBe('agent_schema_mismatch');
    expect(result.cases[0]!.steps.find(s => s.id === 'price')!.output).toEqual({ currency: 'USD', total_minor: 16500, display_total: 'USD 165.00', reason: 'price_calculated' });
  });
  it('enforces timeouts even when an adapter ignores abort', async () => {
    const fixture = sampleRun({ infer: async () => new Promise(() => {}) });
    fixture.options.environment.limits.step_timeout_ms = 5;
    fixture.options.test.environment_digest = digestOf(fixture.options.environment);
    fixture.options.test.cases = fixture.options.test.cases.slice(0, 1);
    const result = await runWorkflow(fixture.options);
    expect(result.cases[0]!.error_code).toBe('step_timeout');
    expect(result.cases[0]!.outcome).toBe('error');
  });
  it('stops after a run-limited timer even before the supplied clock reaches the deadline', async () => {
    let calls = 0;
    const fixture = sampleRun({ infer: async () => { calls++; return new Promise(() => {}); } });
    fixture.options.environment.limits.run_timeout_ms = 5;
    fixture.options.test.environment_digest = digestOf(fixture.options.environment);
    const result = await runWorkflow({ ...fixture.options, nowMs: () => 0 });
    expect(result.state).toBe('run_timeout');
    expect(calls).toBe(1);
    expect(result.cases[0]).toMatchObject({ outcome: 'error', error_code: 'run_timeout' });
    expect(result.cases[0]!.steps[0]!.error_code).toBe('run_timeout');
    expect(result.cases.slice(1).every(c => c.outcome === 'skipped')).toBe(true);
  });
  it('classifies a run-limited framework timer and cleans up its unfinished case', async () => {
    const source = 'export default {};';
    const sample = bakeryFrameworkBundle({ profile: 'langgraph-docker/v0.1', sdk_version: '1.5.0', entry_digest: digestOfBytes(source), lock_digest: LANGGRAPH_LOCK_DIGEST }, source);
    sample.environment.limits.run_timeout_ms = 5;
    sample.test.environment_digest = digestOf(sample.environment);
    let calls = 0, cleaned = 0;
    const result = await runWorkflow({
      environment: sample.environment, test: sample.test,
      files: new Map(sample.files.map(f => [f.path, f.content])),
      adapter: { infer: async () => { calls++; return response(order()); } },
      nowMs: () => 0,
      scheduler: {
        startCase: async () => new Promise(() => {}),
        beforeStep: async () => {}, afterStep: async () => {}, finishCase: async () => {},
        closeCase: async () => { cleaned++; },
      },
    });
    expect(result.state).toBe('run_timeout');
    expect(result.cases[0]).toMatchObject({ outcome: 'error', error_code: 'run_timeout' });
    expect(result.cases.slice(1).every(c => c.outcome === 'skipped')).toBe(true);
    expect(calls).toBe(0);
    expect(cleaned).toBe(1);
  });
  it('cancels in-flight inference and preserves partial results', async () => {
    const controller = new AbortController();
    const fixture = sampleRun({ async infer() { controller.abort(); return new Promise(() => {}); } });
    const result = await runWorkflow({ ...fixture.options, signal: controller.signal });
    expect(result.state).toBe('cancelled');
    expect(result.cases[0]!.outcome).toBe('error');
    expect(result.cases.slice(1).every(c => c.outcome === 'skipped')).toBe(true);
  });
  it('refuses changed prompts before inference', async () => {
    let called = false;
    const fixture = sampleRun({ async infer() { called = true; return response(order()); } });
    fixture.options.files.set('PROMPTS/intake.txt', 'changed');
    await expect(runWorkflow(fixture.options)).rejects.toThrow('digest mismatch');
    expect(called).toBe(false);
  });
  it('rejects a graph that could select untrusted code or read future state', () => {
    const fixture = sampleRun();
    expect(environmentSchema.safeParse({ ...fixture.sample.environment, nodes: [{ kind: 'operation', id: 'shell', operation: 'shell', inputs: {} }] }).success).toBe(false);
    expect(() => readPointer(JSON.parse('{"__proto__":1}'), '/__proto__')).toThrow('invalid_pointer');
  });
});
describe('trusted arithmetic and capacity boundaries', () => {
  const catalog = { currency: 'USD', minor_unit_digits: 2, items: [{ sku: 'chocolate', unit_minor: 250 }, { sku: 'vanilla', unit_minor: 200 }], decorations: [{ key: 'blue', unit_minor: 50 }] };
  it('prices exact integer quantities without trusting agent totals', () => {
    expect(runOperation('price_v1', { order: order(), catalog })).toEqual({ currency: 'USD', total_minor: 16500, display_total: 'USD 165.00', reason: 'price_calculated' });
    expect(runOperation('price_v1', { order: { ...order(), units: 90 }, catalog })).toMatchObject({ total_minor: null });
    expect(() => runOperation('price_v1', { order: { ...order(), total_minor: 0 }, catalog })).toThrow('operation_input_invalid');
  });
  it('fails ambiguous calendars instead of picking a convenient result', () => {
    expect(() => runOperation('capacity_v1', { order: order(), calendar: { slots: [{ date: '2026-11-06', available_units: 80 }, { date: '2026-11-06', available_units: 0 }] } })).toThrow('ambiguous_capacity');
  });
  it('requires actual calendar availability and known price before owner review', () => {
    expect(runOperation('order_decision_v1', { order: order(), capacity: { available: null, reason: 'unknown' }, price: { currency: 'USD', total_minor: 16500, reason: 'known' } })).toEqual({ status: 'needs_information' });
  });
});
