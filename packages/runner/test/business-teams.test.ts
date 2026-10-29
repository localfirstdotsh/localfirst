import { describe, expect, it } from 'vitest';
import { BUSINESS_TEAMS, businessTeamBundle, businessTeamCases } from '@localfirst/contracts';
import { runWorkflow } from '../src/workflows/run.js';

describe('business teams with explicitly scripted inference, not model-quality evidence', () => {
  for (const team of BUSINESS_TEAMS) {
    it(team.key + ': passes all fixtures with original-source access and ordered handoffs', async () => {
      const bundle = businessTeamBundle(team.key);
      const expected = new Map(businessTeamCases(team.key).map(c => [c.input.record.id, c.needs_information]));
      let calls = 0;
      const run = await runWorkflow({
        environment: bundle.environment, test: bundle.test, files: new Map(bundle.files.map(f => [f.path, f.content])),
        adapter: { async infer(request) {
          const input = JSON.parse(request.messages[1]!.content);
          const stage = calls++ % 5;
          const upstream = [[], ['brief'], ['brief', 'analysis'], ['brief', 'analysis', 'draft'], ['draft', 'review']][stage]!;
          expect(Object.keys(input).sort()).toEqual(['message', 'record', ...upstream].sort());
          for (const key of upstream) expect(input[key].source_id).toBe(input.record.id);
          expect(request.messages[0]!.content).toContain('Team requirements:');
          return { content: JSON.stringify({ source_id: input.record.id, business_name: input.record.business_name, needs_information: expected.get(input.record.id), text: 'Scripted draft; owner must assess content quality.', questions: expected.get(input.record.id) ? ['Resolve missing or conflicting facts.'] : [], review_required: true, delivery_state: 'draft_only' }), providerStats: {} };
        } },
      });
      expect(run.state).toBe('completed');
      expect(run.cases.map(c => c.outcome)).toEqual(Array(8).fill('pass'));
      expect(calls).toBe(40);
      expect(run.cases.every(c => c.steps.map(s => s.id).join(',') === 'brief,analysis,draft,review,handoff')).toBe(true);
    });
  }

  it.each([
    ['source_id', 'other-customer', 'agent_claim_mismatch'],
    ['business_name', 'Other Business', 'agent_claim_mismatch'],
    ['review_required', false, 'agent_schema_mismatch'],
    ['delivery_state', 'sent', 'agent_schema_mismatch'],
  ])('rejects an agent changing %s and skips downstream work', async (field, value, code) => {
    const bundle = businessTeamBundle('sales');
    let calls = 0;
    const run = await runWorkflow({ environment: bundle.environment, test: bundle.test, files: new Map(bundle.files.map(f => [f.path, f.content])), adapter: {
      async infer(request) {
        calls++;
        const { record } = JSON.parse(request.messages[1]!.content);
        return { content: JSON.stringify({ source_id: record.id, business_name: record.business_name, needs_information: false, text: 'Tampered draft', questions: [], review_required: true, delivery_state: 'draft_only', [field]: value }), providerStats: {} };
      },
    } });
    expect(calls).toBe(8);
    expect(run.cases.every(c => c.error_code === code && c.steps.slice(1).every(s => s.outcome === 'skipped'))).toBe(true);
  });

  it('prevents the final chief of staff from discarding the reviewer information-gap decision', async () => {
    const bundle = businessTeamBundle('operations');
    let calls = 0;
    const run = await runWorkflow({ environment: bundle.environment, test: bundle.test, files: new Map(bundle.files.map(f => [f.path, f.content])), adapter: {
      async infer(request) {
        const { record } = JSON.parse(request.messages[1]!.content);
        return { content: JSON.stringify({ source_id: record.id, business_name: record.business_name, needs_information: calls++ % 5 !== 4, text: 'Scripted handoff', questions: [], review_required: true, delivery_state: 'draft_only' }), providerStats: {} };
      },
    } });
    expect(run.cases.every(c => c.error_code === 'agent_claim_mismatch' && c.steps.at(-1)?.id === 'handoff')).toBe(true);
  });
});
