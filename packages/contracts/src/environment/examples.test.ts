import { describe, expect, it } from 'vitest';
import { digestOf } from '../canonical.js';
import { validateProjectBundle } from '../project/validate.js';
import { bakeryBundle } from './bakery.js';
import { SAMPLE_ENVIRONMENTS, sampleBundle, sampleScriptedIntake } from './examples.js';

describe('small business creator examples', () => {
  it('provides five distinct, complete and digest-bound creator bundles without claiming a tested model', () => {
    expect(SAMPLE_ENVIRONMENTS.map(s => s.key)).toEqual(['bakery', 'florist', 'print-shop', 'bike-repair', 'pet-grooming']);
    const environmentDigests = new Set<string>();
    for (const metadata of SAMPLE_ENVIRONMENTS) {
      const sample = sampleBundle(metadata.key), checked = validateProjectBundle(sample);
      expect(checked.issues.filter(i => i.severity === 'error'), metadata.key).toEqual([]);
      expect(sample.environment.key).toBe(metadata.environment_key);
      expect(sample.test.key).toBe(metadata.test_key);
      expect(sample.test.environment_digest).toBe(digestOf(sample.environment));
      expect(sample.environment.model_roles).toHaveLength(3);
      expect(Object.values(sample.environment.tested_configuration).every(value => value === null)).toBe(true);
      expect(sample.environment.execution).toEqual({ locality: 'local_required', project_code: false, downloads: false, network: 'loopback_only' });
      expect(sample.test.cases).toHaveLength(8);
      environmentDigests.add(sample.test.environment_digest);
      const changed = structuredClone(sample);
      changed.files.find(f => f.path === 'DATA/capacity.json')!.content += ' ';
      expect(validateProjectBundle(changed).ok).toBe(false);
    }
    expect(environmentDigests.size).toBe(5);
    expect(sampleBundle('bakery')).toEqual(bakeryBundle());
  });

  it('includes independent golden prices, corrections, missing fields, capacity, unsupported products and injected instructions', () => {
    const completePrices = { florist: 8000, 'print-shop': 5000, 'bike-repair': 10000, 'pet-grooming': 10000 };
    for (const metadata of SAMPLE_ENVIRONMENTS.filter(s => s.key !== 'bakery')) {
      const sample = sampleBundle(metadata.key);
      expect(sample.test.cases.map(c => c.key)).toEqual(['complete-request', 'missing-date', 'capacity-conflict', 'unknown-product', 'corrected-request', 'missing-quantity', 'unlisted-date', 'customer-instruction']);
      const assertions = (key: string) => Object.fromEntries(sample.test.cases.find(c => c.key === key)!.assertions.map(a => [a.path, a.equals]));
      expect(assertions('complete-request')['/price/total_minor']).toBe(completePrices[metadata.key]);
      expect(assertions('complete-request')['/decision/status']).toBe('needs_owner_review');
      expect(assertions('missing-date')['/order/pickup_date']).toBe('');
      expect(assertions('missing-date')['/decision/status']).toBe('needs_information');
      expect(assertions('capacity-conflict')['/decision/status']).toBe('capacity_unavailable');
      expect(assertions('unknown-product')['/price/total_minor']).toBe(null);
      expect(assertions('corrected-request')).toEqual(assertions('capacity-conflict'));
      expect(assertions('missing-quantity')['/order/units']).toBe(0);
      expect(assertions('customer-instruction')).toEqual(assertions('complete-request'));
      expect(sample.test.cases.find(c => c.key === 'customer-instruction')!.input).toMatchObject({ message: expect.stringContaining('Ignore') });
      expect(sample.project_md.toLowerCase()).not.toContain('bakery');
      expect(sample.environment.model_roles.map(r => r.key)[1]).not.toBe('production');
    }
  });

  it('keeps scripted intake bounded to exact known cases and independent between callers', () => {
    for (const metadata of SAMPLE_ENVIRONMENTS) {
      const sample = sampleBundle(metadata.key);
      for (const fixture of sample.test.cases) {
        const intake = sampleScriptedIntake(metadata.key, fixture.key);
        expect(intake.units).toBe(intake.items.reduce((total, item) => total + item.quantity, 0));
        expect(intake.pickup_time).toBe('10:00');
        const before = structuredClone(intake);
        intake.items.push({ sku: 'tampered', quantity: 999 });
        expect(sampleScriptedIntake(metadata.key, fixture.key)).toEqual(before);
      }
      expect(() => sampleScriptedIntake(metadata.key, 'invented-case')).toThrow('unknown');
    }
  });
});
