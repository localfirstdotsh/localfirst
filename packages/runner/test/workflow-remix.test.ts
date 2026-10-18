import { describe, expect, it } from 'vitest';
import { bakeryBundle, bakeryHolidayBundle } from '@localfirst/contracts';
import { runWorkflow } from '../src/workflows/run.js';

// Independent scripted extraction isolates graph/data behavior from model accuracy.
const orders = [
  { units: 60, date: '2026-11-06', decoration: 'blue' },
  { units: 90, date: '2026-11-06', decoration: 'blue' },
  { units: 110, date: '2026-11-06', decoration: 'blue' },
  { units: 60, date: '', decoration: 'blue' },
  { units: 60, date: '2026-11-06', decoration: 'gold sculpture' },
  { units: 60, date: '2026-11-06', decoration: 'blue' },
];
async function runRemix(tamperChecklist = false) {
  const bundle = bakeryHolidayBundle();
  const inputs = new Map(bundle.test.cases.map((c, i) => [(c.input as { message: string }).message, orders[i]!]));
  let calls = 0;
  const run = await runWorkflow({ environment: bundle.environment, test: bundle.test, files: new Map(bundle.files.map(f => [f.path, f.content])), adapter: {
    async infer(request) {
      calls++;
      const input = JSON.parse(request.messages[1]!.content);
      let output: unknown;
      if (input.message) {
        const order = inputs.get(input.message)!;
        output = { units: order.units, pickup_date: order.date, pickup_time: '10:00', decoration: order.decoration, items: [{ sku: 'chocolate', quantity: order.units / 2 }, { sku: 'vanilla', quantity: order.units / 2 }] };
      } else if (input.price) output = { text: 'Owner review required.', display_total: input.price.display_total, decision_status: input.decision.status };
      else if (input.decision) output = { decision_status: tamperChecklist ? 'accepted' : input.decision.status, tasks: ['Ask owner to confirm packaging.', 'Ask owner to confirm pickup contact and details.'] };
      else output = { summary: 'Scripted capacity review; no model-quality claim.' };
      return { content: JSON.stringify(output), providerStats: {} };
    },
  } });
  return { run, calls };
}
describe('remixed workflow execution with scripted inference', () => {
  it('uses seasonal data and a fourth role, preserving independent expected prices and capacity outcomes', async () => {
    const { run, calls } = await runRemix();
    expect(run.state).toBe('completed');
    expect(run.cases.map(c => c.outcome)).toEqual(Array(6).fill('pass'));
    expect(calls).toBe(24);
    expect(run.cases.map(c => (c.output as any).price.total_minor)).toEqual([21000, 31500, 38500, 21000, null, 21000]);
    expect(run.cases.map(c => (c.output as any).decision.status)).toEqual(['needs_owner_review', 'needs_owner_review', 'capacity_unavailable', 'needs_information', 'needs_information', 'needs_owner_review']);
    expect(run.cases.every(c => c.steps.length === 7 && c.steps.at(-1)?.id === 'pickup-checklist')).toBe(true);
  });
  it('rejects the new agent changing the authoritative decision to accepted', async () => {
    const { run } = await runRemix(true);
    expect(run.cases.every(c => c.outcome === 'error' && c.steps.at(-1)?.outcome === 'error')).toBe(true);
  });
  it('refuses a parent fixture reused against the changed environment', async () => {
    const remix = bakeryHolidayBundle();
    await expect(runWorkflow({ environment: remix.environment, test: bakeryBundle().test, files: new Map(remix.files.map(f => [f.path, f.content])), adapter: { async infer() { throw new Error('Must not call inference.'); } } })).rejects.toThrow('environment_digest_mismatch');
  });
});
