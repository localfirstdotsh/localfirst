import { describe, expect, it } from 'vitest';
import {
  bakeryBundle, digestOf, sealWorkflowPlan, validateProjectBundle, workflowDigests,
  workflowLocalReportSchema, type WorkflowLocalReport,
} from '@localfirst/contracts';
import { runWorkflow } from '../src/workflows/run.js';
import { applyPrivateData } from '../src/workflows/private-data.js';
import { workflowTrail, renderWorkflowTrailHtml } from '../src/reports/workflow-trail.js';

async function fixture(privateInput?: unknown) {
  const bundle = bakeryBundle(), env = bundle.environment;
  const context = privateInput === undefined ? null : { input: privateInput, data: null };
  const plan = sealWorkflowPlan({
    schema: 'localfirst/local-plan/v0.2', created_at: '2026-10-14T12:00:00.000Z',
    runner: { version: '0.2.0', contract: 'localfirst/runner/v0.2' },
    project: { project_id: '00000000-0000-4000-8000-000000000001', project_version_id: '00000000-0000-4000-8000-000000000002', configuration_key: 'local-bakery' },
    environment_key: env.key, environment_digest: digestOf(env), bundle_digest: validateProjectBundle(bundle).content_digest!,
    test: { key: bundle.test.key, definition_id: null, ...workflowDigests(bundle.test) },
    runtime: { family: 'ollama', endpoint: 'http://127.0.0.1:11434', application_version: '0.35.1', cli_version: null, engine_version: null, adapter_profile: 'ollama' },
    bindings: env.model_roles.map(r => ({ role: r.key, runtime_model_id: 'sample-local', artifact_identity: null, execution_location: 'local', locality_method: 'adapter_preflight', settings: r.settings, quantization: null })),
    data_class: context ? 'private_local' : 'public_fixture', private_input_digest: context ? digestOf(context) : null,
    private_environment_digest: context ? digestOf(env) : null,
    effects: { network: 'loopback_only', downloads: false, project_code: false, operations: env.nodes.flatMap(n => n.kind === 'operation' ? [n.operation] : []), inference_requests: 3 * (context ? 1 : 8), output_token_budget: 1536 * (context ? 1 : 8), run_timeout_ms: env.limits.run_timeout_ms, writes_local_report: true },
  });
  const requests: { messages: Array<{ role: string; content: string }> }[] = [];
  const test = context ? { ...bundle.test, cases: [{ ...bundle.test.cases[0]!, key: 'private-input', input: privateInput }] } : bundle.test;
  const run = await runWorkflow({ environment: env, test, files: new Map(bundle.files.map(f => [f.path, f.content])), observeOnly: !!context,
    adapter: { async infer(request) {
      requests.push(request);
      const input = JSON.parse(request.messages[1]!.content);
      const content = 'message' in input ? { units: 60, pickup_date: '2026-11-06', pickup_time: '10:00', decoration: 'blue', items: [{ sku: 'chocolate', quantity: 30 }, { sku: 'vanilla', quantity: 30 }] }
        : 'price' in input ? { text: '<img src=x onerror=alert(1)>', display_total: input.price.display_total, decision_status: input.decision.status }
          : { summary: 'Production reviewed.' };
      return { content: JSON.stringify(content), providerStats: { confidential: 'provider-only-value' } };
    } },
  });
  const report = workflowLocalReportSchema.parse({ schema: 'localfirst/local-report/v0.2', client_run_id: 'trail-example', completed_at: '2026-10-14T12:01:00.000Z', plan, environment: env, run, locality: 'pass', offline: 'not_run', private_context: context });
  return { bundle, report, requests };
}

describe('local workflow inspection trail', () => {
  it('reconstructs the exact declared prompts and expanded upstream inputs, and compares actual assertions', async () => {
    const { report, bundle, requests } = await fixture();
    const trail = workflowTrail(report, bundle);
    expect(trail.lifecycle).toEqual([]);
    expect(trail.cases[0]!.steps[0]!.request).toMatchObject({ system: requests[0]!.messages[0]!.content, user: requests[0]!.messages[1]!.content });
    expect(trail.cases[0]!.steps[2]!.request!.user).toBe(requests[1]!.messages[1]!.content);
    expect(trail.cases[0]!.steps[5]!.request!.user).toBe(requests[2]!.messages[1]!.content);
    expect(trail.cases[0]!.assertions.every(a => a.result === 'match')).toBe(true);
    expect(trail.cases[1]!.assertions).toContainEqual({ path: '/order/pickup_date', expected: '', actual: '2026-11-06', result: 'mismatch' });
    expect(trail.summary.mismatched_assertions).toBeGreaterThan(0);
    expect(JSON.stringify(trail)).not.toContain('provider-only-value');
    expect(JSON.stringify(trail)).not.toContain('11434');
  });
  it('renders untrusted outputs as text with no script, external resources or fabricated MCP stages', async () => {
    const { report, bundle } = await fixture();
    const html = renderWorkflowTrailHtml(workflowTrail(report, bundle));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('No external setup, MCP, approval or cleanup events were supplied.');
  });
  it('rejects a different bundle rather than attaching unrelated prompts to the run', async () => {
    const { report, bundle } = await fixture();
    bundle.files.find(f => f.path === 'PROMPTS/intake.txt')!.content = 'unrelated';
    expect(() => workflowTrail(report, bundle)).toThrow('bundle does not match');
  });
  it('redacts private content by default and never claims private fixture accuracy even when included', async () => {
    const { report, bundle } = await fixture({ message: 'Private customer Acme Ltd order.' });
    const hidden = workflowTrail(report, bundle, { lifecycle: [{ kind: 'command', summary: 'Private customer Acme Ltd order.', details: { input: report.private_context!.input } }] });
    expect(JSON.stringify(hidden)).not.toContain('Acme');
    expect(hidden.cases[0]!.steps.every(s => s.request === null)).toBe(true);
    expect(hidden.summary.evaluated_assertions).toBe(0);
    expect(hidden.cases[0]!.assertions).toEqual([]);
    expect(hidden.cases[0]!.reported_outcome).toBe('structural_checks_completed');
    const included = workflowTrail(report, bundle, { includePrivate: true });
    expect(JSON.stringify(included)).toContain('Acme Ltd');
    expect(included.summary.assertion_accuracy).toBe('not_evaluated_private_input');
    expect(included.summary.reported_outcomes.pass).toBe(0);
  });
  it('reconstructs private dataset overlays from the sealed report context', async () => {
    const { report, bundle } = await fixture({ message: 'Private customer order.' });
    const data = { capacity: { slots: [{ date: '2026-11-06', available_units: 7 }] } };
    const effective = applyPrivateData(bundle.environment, new Map(bundle.files.map(f => [f.path, f.content])), data);
    const { plan_digest: _, ...body } = report.plan;
    const context = { input: report.private_context!.input, data };
    const overlayReport: WorkflowLocalReport = { ...report, environment: effective.environment, private_context: context, plan: sealWorkflowPlan({ ...body, private_environment_digest: digestOf(effective.environment), private_input_digest: digestOf(context) }) };
    const trail = workflowTrail(overlayReport, bundle, { includePrivate: true });
    expect((trail.cases[0]!.steps[1]!.inputs as any).calendar.slots[0].available_units).toBe(7);
  });
  it('only includes supplied lifecycle observations and removes credentials from bounded MCP details', async () => {
    const { report, bundle } = await fixture();
    const trail = workflowTrail(report, bundle, { lifecycle: [{ kind: 'mcp', timestamp: '2026-10-14T12:00:01.000Z', summary: 'environment_get', details: { params: { environment_key: bundle.environment.key }, headers: { Authorization: 'Bearer auth-value', Cookie: 'session=cookie-value' }, token: 'custom-token', access_token: 'access-value', api_key: 'custom-api-value', result: { available: true, settings: { max_output_tokens: 512, context_tokens: 4096 } } } }] });
    expect(trail.lifecycle).toHaveLength(1);
    expect(trail.lifecycle[0]).toMatchObject({ sequence: 1, kind: 'mcp', summary: 'environment_get', provenance: 'caller_supplied_observation' });
    const text = JSON.stringify(trail.lifecycle);
    for (const secret of ['auth-value', 'cookie-value', 'custom-token', 'access-value', 'custom-api-value']) expect(text).not.toContain(secret);
    expect(text).toContain(bundle.environment.key);
    expect(trail.lifecycle[0]!.details).toMatchObject({ result: { settings: { max_output_tokens: 512, context_tokens: 4096 } } });
    expect(renderWorkflowTrailHtml(trail)).toContain(`${trail.summary.reported_outcomes.pass} pass · ${trail.summary.reported_outcomes.fail} fail`);
  });
  it('marks skipped steps and assertions as unexecuted rather than reconstructing imaginary inference', async () => {
    const { report, bundle } = await fixture();
    report.run.cases[0] = { key: report.run.cases[0]!.key, outcome: 'skipped', steps: [], output: null, error_code: null, elapsed_ms: 0 };
    const trail = workflowTrail(report, bundle);
    expect(trail.cases[0]!.steps.every(s => s.request === null && s.outcome === 'not_recorded')).toBe(true);
    expect(trail.cases[0]!.assertions.every(a => a.result === 'not_evaluated')).toBe(true);
  });
});
