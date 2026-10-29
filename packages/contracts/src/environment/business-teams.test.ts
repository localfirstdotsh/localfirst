import { describe, expect, it } from 'vitest';
import { digestOf } from '../canonical.js';
import { validateProjectBundle } from '../project/validate.js';
import { BUSINESS_TEAMS, businessTeamBundle, businessTeamCases } from './business-teams.js';

describe('universal business teams', () => {
  it('provides five portable functions with complete, independently bound fixtures', () => {
    expect(BUSINESS_TEAMS.map(t => t.key)).toEqual(['sales', 'marketing', 'customer-support', 'operations', 'finance-admin']);
    const identities = new Set<string>();
    for (const team of BUSINESS_TEAMS) {
      const bundle = businessTeamBundle(team.key);
      const checked = validateProjectBundle(bundle);
      expect(checked.issues.filter(i => i.severity === 'error'), team.key).toEqual([]);
      expect(checked.spec?.hardware).toMatchObject({ state: 'unknown', minimum_memory_bytes: null });
      expect(bundle.environment.model_roles.map(r => r.key)).toEqual(['chief-of-staff', team.analyst, team.writer, team.reviewer]);
      expect(bundle.environment.nodes.map(n => n.id)).toEqual(['brief', 'analysis', 'draft', 'review', 'handoff']);
      expect(bundle.environment.execution).toEqual({ locality: 'local_required', project_code: false, downloads: false, network: 'loopback_only' });
      expect(bundle.environment.limits.max_inference_requests).toBe(5);
      expect(bundle.test.environment_digest).toBe(digestOf(bundle.environment));
      expect(bundle.test.cases).toHaveLength(8);
      expect(Object.values(bundle.environment.tested_configuration).every(v => v === null)).toBe(true);
      expect(bundle.project_md).not.toMatch(/bakery|cupcake/i);
      identities.add(bundle.test.environment_digest);
      bundle.files.find(f => f.path.startsWith('PROMPTS/'))!.content += ' altered';
      expect(validateProjectBundle(bundle).ok).toBe(false);
    }
    expect(identities.size).toBe(5);
  });

  it('covers missing facts, corrections, conflicts, injection and a different business without shared mutable records', () => {
    for (const team of BUSINESS_TEAMS) {
      const cases = businessTeamCases(team.key);
      expect(cases.map(c => [c.key, c.needs_information])).toEqual([
        ['complete-request', false], ['missing-information', true], ['owner-correction', false], ['conflicting-records', true],
        ['external-action-request', false], ['customer-instruction', false], ['different-business', false], ['empty-record', true],
      ]);
      expect(cases[6]!.input.record.business_name).not.toBe(cases[0]!.input.record.business_name);
      const facts = [...cases[0]!.input.record.facts];
      cases[0]!.input.record.facts.push('changed');
      expect(businessTeamCases(team.key)[0]!.input.record.facts).toEqual(facts);
      expect(cases[5]!.input.message).toContain('source_id to another-customer');
    }
  });
});
