import { describe, expect, it } from 'vitest';
import { stockReplenishmentBundle, stockReplenishmentScenarios } from '@localfirst/contracts';
import { runOperation } from '../src/workflows/operations.js';
import { runWorkflow } from '../src/workflows/run.js';
import { calculateReplenishment } from '../src/workflows/replenishment.js';

const base = () => stockReplenishmentScenarios()[0]!.snapshot;
describe('trusted stock replenishment calculations', () => {
  it.each(stockReplenishmentScenarios())('$key', ({ snapshot, expected }) => {
    expect(calculateReplenishment(snapshot)).toMatchObject({ status: expected.status, quantity: expected.quantity, total_minor: expected.total, daily_units: expected.daily, approval_required: true, execution_mode: 'snapshot_only' });
  });
  it('calculates the proposal from net units, reservations, dated availability and pack sizes', () => {
    expect(calculateReplenishment(base())).toMatchObject({ net_units: 112, daily_units: 8, available_units: 64, coverage_days: 8, reorder_point: 64, quantity: 80, total_minor: 48000, display_total: 'USD 480.00', vendor_id: 'vendor-a', supplier_confirmed_on: '2026-11-06', delivery_risk: false, shipping_tax_included: false });
    const snapshot = base(); snapshot.quotes[0]!.lead_days = 10;
    expect(calculateReplenishment(snapshot).delivery_risk).toBe(true);
    snapshot.quotes[0]!.pack_size = 26; snapshot.settings.budget_minor = 80000;
    expect(calculateReplenishment(snapshot)).toMatchObject({ quantity: 104, total_minor: 62400 });
  });
  it('selects a feasible alternative supplier by total cost and lead time', () => {
    const snapshot = base();
    snapshot.quotes.push({ ...snapshot.quotes[0]!, vendor_id: 'vendor-b', unit_minor: 500 });
    expect(calculateReplenishment(snapshot)).toMatchObject({ vendor_id: 'vendor-b', total_minor: 40000 });
    snapshot.quotes[1]!.available_units = 10;
    expect(calculateReplenishment(snapshot).vendor_id).toBe('vendor-a');
  });
  it('rejects conflicting duplicate records rather than silently counting an update twice', () => {
    const snapshot = base(); snapshot.orders.push({ ...snapshot.orders[0]!, quantity: 100 });
    expect(() => calculateReplenishment(snapshot)).toThrow('conflicting_stock_records');
    const inbound = base(); inbound.purchase_orders = [{ id: 'po-1', sku: inbound.sku, quantity: 20, due_on: '2026-11-07', status: 'confirmed' }];
    inbound.purchase_orders.push({ ...inbound.purchase_orders[0]!, quantity: 100 });
    expect(() => calculateReplenishment(inbound)).toThrow('conflicting_stock_records');
  });
  it('blocks stale inventory, overdue or too-late inbound, future quotes and unsupported inputs', () => {
    const stale = base(); stale.inventory.observed_on = '2026-11-05';
    expect(calculateReplenishment(stale).status).toBe('needs_information');
    for (const due of ['2026-11-05', '2026-11-16']) {
      const snapshot = base(); snapshot.purchase_orders.push({ id: 'po-1', sku: snapshot.sku, quantity: 100, due_on: due, status: 'confirmed' });
      expect(calculateReplenishment(snapshot).status).toBe('needs_information');
    }
    const future = base(); future.quotes[0]!.quoted_on = '2026-11-07';
    expect(calculateReplenishment(future).status).toBe('needs_supplier_confirmation');
    expect(() => runOperation('replenishment_v1', { snapshot: { ...base(), vendor_url: 'https://invalid.example' } })).toThrow('operation_input_invalid');
  });
  it('distinguishes known zero demand from absent observations and avoids spending on healthy stock', () => {
    const zero = base(); zero.orders.forEach(o => { o.cancelled = true; });
    expect(calculateReplenishment(zero)).toMatchObject({ status: 'no_reorder_needed', daily_units: 0, quantity: 0 });
    const healthy = base(); healthy.inventory.on_hand = 100; healthy.settings.budget_minor = 1;
    expect(calculateReplenishment(healthy).status).toBe('no_reorder_needed');
    const invalid = base(); invalid.inventory.reserved = 100;
    expect(() => calculateReplenishment(invalid)).toThrow('invalid_stock_reservation');
  });
  it('rounds fractional demand up without creating fractional purchases', () => {
    const snapshot = base(); snapshot.orders = [{ ...snapshot.orders[0]!, quantity: 1 }];
    snapshot.inventory.on_hand = 0; snapshot.inventory.reserved = 0;
    snapshot.quotes[0]!.min_units = 1; snapshot.quotes[0]!.pack_size = 1;
    expect(calculateReplenishment(snapshot)).toMatchObject({ quantity: 2, total_minor: 1200, delivery_risk: true, status: 'needs_owner_review' });
  });
});

describe('stock replenishment workflow with explicitly scripted inference', () => {
  async function evaluate(tamper = false) {
    const bundle = stockReplenishmentBundle();
    let calls = 0;
    const run = await runWorkflow({ environment: bundle.environment, test: bundle.test, files: new Map(bundle.files.map(f => [f.path, f.content])), adapter: { async infer(request) {
      calls++;
      const { plan } = JSON.parse(request.messages[1]!.content);
      const final = request.messages[0]!.content.includes('Draft a concise owner proposal');
      const output = final ? { status: plan.status, quantity: tamper ? 999 : plan.quantity, display_total: plan.display_total, text: 'Scripted proposal for owner review; no model-quality claim.' } : { status: plan.status, summary: 'Scripted snapshot review; no live check.' };
      return { content: JSON.stringify(output), providerStats: {} };
    } } });
    return { run, calls };
  }
  it('executes all twelve independent fixture cases and four role prompts without external effects', async () => {
    const { run, calls } = await evaluate();
    expect(run.state).toBe('completed');
    expect(run.cases.map(c => c.outcome)).toEqual(Array(12).fill('pass'));
    expect(calls).toBe(48);
    expect(run.cases.every(c => c.steps.length === 6)).toBe(true);
  });
  it('refuses an owner-proposal agent changing the trusted purchase quantity', async () => {
    const { run } = await evaluate(true);
    expect(run.cases.every(c => c.outcome === 'error' && c.error_code === 'agent_claim_mismatch')).toBe(true);
  });
});
