import { describe, expect, it } from 'vitest';
import { SAMPLE_ENVIRONMENTS, sampleBundle, sampleScriptedIntake } from '@localfirst/contracts';
import { runWorkflow } from '../src/workflows/run.js';

describe('five business workflow fixtures with explicitly scripted inference', () => {
  for (const metadata of SAMPLE_ENVIRONMENTS) {
    it(metadata.key + ': evaluates the complete independent fixture without external effects', async () => {
      const sample = sampleBundle(metadata.key);
      const fixtures = new Map(sample.test.cases.map(c => [(c.input as { message: string }).message, c.key]));
      let calls = 0;
      const run = await runWorkflow({
        environment: sample.environment, test: sample.test,
        files: new Map(sample.files.map(f => [f.path, f.content])),
        adapter: { async infer(request) {
          calls++;
          const input = JSON.parse(request.messages[1]!.content);
          const output = typeof input.message === 'string'
            ? sampleScriptedIntake(metadata.key, fixtures.get(input.message)!)
            : input.decision
              ? { text: 'Staff review required.', display_total: input.price.display_total, decision_status: input.decision.status }
              : { summary: 'Scripted review; no model-quality claim.' };
          return { content: JSON.stringify(output), providerStats: {} };
        } },
      });
      expect(run.state).toBe('completed');
      expect(run.cases.map(c => ({ key: c.key, outcome: c.outcome, error_code: c.error_code }))).toEqual(sample.test.cases.map(c => ({ key: c.key, outcome: 'pass', error_code: null })));
      expect(calls).toBe(24);
      expect(run.cases.every(c => c.steps.map(s => s.id).join(',') === sample.environment.nodes.map(n => n.id).join(','))).toBe(true);
    });
  }
});
