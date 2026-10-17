import { describe, expect, it } from 'vitest';
import { digestOf } from '../canonical.js';
import { validateProjectBundle } from '../project/validate.js';
import { stockReplenishmentBundle, stockReplenishmentScenarios, stockSnapshotSchema } from './replenishment.js';

describe('ecommerce replenishment creator example', () => {
  it('packages a complete digest-bound snapshot workflow and explicit missing live integrations', () => {
    const bundle = stockReplenishmentBundle(), checked = validateProjectBundle(bundle);
    expect(checked.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(checked.ok).toBe(true);
    expect(bundle.test.cases).toHaveLength(12);
    expect(bundle.environment.model_roles.map(r => r.key)).toEqual(['demand-review', 'vendor-review', 'purchasing-review', 'owner-proposal']);
    expect(bundle.test.environment_digest).toBe(digestOf(bundle.environment));
    expect(Object.values(bundle.environment.tested_configuration)).toEqual(Array(7).fill(null));
    const requirements = JSON.parse(bundle.files.find(f => f.path === 'DATA/integration-requirements.json')!.content);
    expect(requirements.live_mode).toBe('requires_development');
    expect(requirements.missing_capabilities).toHaveLength(4);
    expect(bundle.environment.execution).toEqual({ locality: 'local_required', project_code: false, downloads: false, network: 'loopback_only' });
    bundle.files.find(f => f.path === 'DATA/snapshots.json')!.content += ' ';
    expect(validateProjectBundle(bundle).ok).toBe(false);
  });
  it('provides bounded synthetic inputs, independent fixture expectations, and isolated copies', () => {
    const cases = stockReplenishmentScenarios();
    for (const item of cases) expect(stockSnapshotSchema.safeParse(item.snapshot).success).toBe(true);
    expect(cases[0]!.expected).toEqual({ status: 'needs_owner_review', quantity: 80, total: 48000, daily: 8 });
    cases[0]!.snapshot.orders[0]!.quantity = 999;
    expect(stockReplenishmentScenarios()[0]!.snapshot.orders[0]!.quantity).toBe(8);
  });
});
