import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_ENVIRONMENTS, sampleBundle, sampleScriptedIntake } from '@localfirst/contracts';
import { evaluateCliWorkflow, type CliWorkflowRequest } from '../src/verification/cli-workflow.js';

function scripted(key: Parameters<typeof sampleBundle>[0], requests: CliWorkflowRequest[] = []) {
  return async (request: CliWorkflowRequest) => {
    requests.push(request);
    const input = JSON.parse(request.user);
    const output = request.role === 'intake' ? sampleScriptedIntake(key, request.case_key)
      : Object.hasOwn((request.response_schema as any).properties, 'summary') ? { summary: 'Capacity checked for owner review.' }
        : { text: 'Owner review required.', display_total: input.price.display_total, decision_status: input.decision.status };
    return { output, metadata: { model: 'scripted_only', api_key: 'should-not-appear' } };
  };
}
describe('hosted CLI workflow evaluation', () => {
  it.each(SAMPLE_ENVIRONMENTS)('evaluates $key independently while explicitly refusing local evidence status', async ({ key }) => {
    const bundle = sampleBundle(key), result = await evaluateCliWorkflow(bundle, scripted(key), { cli: 'scripted', model: 'fixture-only', reasoningEffort: 'medium' });
    expect(result.schema).toBe('localfirst/cli-workflow-evaluation/v0.1');
    expect(result.execution_location).toBe('hosted_via_cli');
    expect(result.locality_contract).toBe('out_of_profile_not_local_evidence');
    expect(result.summary).toMatchObject({ passed: 8, failed: 0, errors: 0, skipped: 0, inference_calls: 24 });
    expect(result.cases.every(c => c.assertions.every(a => a.result === 'match'))).toBe(true);
    expect(result.configuration).toMatchObject({ declared_settings_enforcement: 'not_enforced_via_cli', effective_settings: 'not_verified_by_evaluator', requested_reasoning_effort: 'medium', retries: 0 });
    expect(JSON.stringify(result)).not.toContain('should-not-appear');
  });
  it('only sends declared prompts/inputs/schema, without assertions or golden intake answers', async () => {
    const requests: CliWorkflowRequest[] = [], bundle = sampleBundle('bakery');
    const result = await evaluateCliWorkflow(bundle, scripted('bakery', requests));
    expect(requests).toHaveLength(24);
    expect(Object.keys(requests[0]!).sort()).toEqual(['case_key', 'response_schema', 'role', 'signal', 'system', 'user']);
    expect(JSON.parse(requests[0]!.user)).toEqual({ message: bundle.test.cases[0]!.input && (bundle.test.cases[0]!.input as any).message, menu: JSON.parse(bundle.files.find(f => f.path === 'DATA/menu.json')!.content) });
    expect(Object.keys(JSON.parse(requests[1]!.user))).toEqual(['order', 'capacity']);
    expect(Object.keys(JSON.parse(requests[2]!.user))).toEqual(['order', 'capacity', 'price', 'decision']);
    expect(requests[0]!.system).toBe(bundle.files.find(f => f.path === 'PROMPTS/intake.txt')!.content);
    expect(JSON.stringify(result.cases[0]!.steps[0]!.request)).not.toContain('"signal"');
    expect(JSON.stringify(requests.map(({ signal: _, ...request }) => request))).not.toContain('"assertions"');
  });
  it('retains an actual rejected claim and continues other fixtures without retrying', async () => {
    const normal = scripted('bakery');
    const result = await evaluateCliWorkflow(sampleBundle('bakery'), async request => {
      const response = await normal(request);
      if (request.role === 'quote' && request.case_key === 'complete-order') return { output: { text: 'Free booking', display_total: 'USD 0.00', decision_status: 'needs_owner_review' } };
      return response;
    });
    expect(result.cases[0]).toMatchObject({ outcome: 'error', error_code: 'agent_claim_mismatch' });
    expect(result.cases[0]!.steps.at(-1)).toMatchObject({ outcome: 'error', raw_output: { display_total: 'USD 0.00' }, output: { display_total: 'USD 0.00' } });
    expect(result.cases[0]!.assertions.every(a => a.result === 'not_evaluated')).toBe(true);
    expect(result.cases[1]!.outcome).toBe('pass');
    expect(result.summary.inference_calls).toBe(24);
  });
  it.each([{ output: '{invalid', code: 'invalid_agent_json' }, { output: { message: 'Wrong shape' }, code: 'agent_schema_mismatch' }])('retains malformed response $code without downstream requests', async ({ output, code }) => {
    let calls = 0;
    const result = await evaluateCliWorkflow(sampleBundle('bakery'), async () => { calls++; return { output }; });
    expect(calls).toBe(8);
    expect(result.cases.every(c => c.error_code === code)).toBe(true);
    expect(result.cases[0]!.steps[0]!.raw_output).toEqual(output);
    expect(result.cases[0]!.steps.slice(1).every(s => s.outcome === 'skipped')).toBe(true);
  });
  it('enforces per-step timeout even when the caller ignores cancellation', async () => {
    const result = await evaluateCliWorkflow(sampleBundle('bakery'), async () => new Promise(() => {}), { stepTimeoutMs: 2, runTimeoutMs: 500 });
    expect(result.summary).toMatchObject({ inference_calls: 8, errors: 8, state: 'completed' });
    expect(result.cases.every(c => c.error_code === 'step_timeout')).toBe(true);
  });
  it('cancels a request and records remaining fixtures as skipped', async () => {
    const controller = new AbortController();
    const result = await evaluateCliWorkflow(sampleBundle('bakery'), async () => { controller.abort(); return new Promise(() => {}); }, { signal: controller.signal });
    expect(result.summary).toMatchObject({ state: 'cancelled', inference_calls: 1, errors: 1, skipped: 7 });
  });
  it('stops the entire evaluation at its run deadline and retains the unfinished case', async () => {
    const result = await evaluateCliWorkflow(sampleBundle('bakery'), async () => new Promise(() => {}), { stepTimeoutMs: 90000, runTimeoutMs: 5 });
    expect(result.state).toBe('run_timeout');
    expect(result.summary).toMatchObject({ state: 'run_timeout', inference_calls: 1, errors: 1, skipped: 7 });
    expect(result.cases[0]!.steps[0]).toMatchObject({ outcome: 'error', error_code: 'run_timeout' });
    expect(result.cases.slice(1).every(c => c.error_code === 'run_timeout')).toBe(true);
  });
  it('classifies a run-limited timer even before the high-resolution clock reaches its deadline', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const result = await evaluateCliWorkflow(sampleBundle('bakery'), async () => new Promise(() => {}), { stepTimeoutMs: 90000, runTimeoutMs: 5 });
      expect(result.summary).toMatchObject({ state: 'run_timeout', inference_calls: 1, errors: 1, skipped: 7 });
      expect(result.cases[0]!.steps[0]).toMatchObject({ outcome: 'error', error_code: 'run_timeout' });
    } finally {
      clock.mockRestore();
    }
  });
  it('bounds output data and validates deadline limits before invoking a CLI', async () => {
    const bundle = sampleBundle('bakery');
    const result = await evaluateCliWorkflow(bundle, async () => ({ output: 'x'.repeat(65537) }));
    expect(result.cases.every(c => c.error_code === 'output_limit')).toBe(true);
    expect(result.cases[0]!.steps[0]!.raw_output).toBeNull();
    await expect(evaluateCliWorkflow(bundle, scripted('bakery'), { stepTimeoutMs: 90001 })).rejects.toThrow('deadlines');
  });
});
