import { afterEach, describe, it, expect } from 'vitest';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SAMPLE_ENVIRONMENTS, BUSINESS_TEAMS, businessTeamCases, workflowLocalReportSchema, workflowPlanSchema, anyTestResultSubmissionSchema } from '@localfirst/contracts';
import { runCli } from '../src/cli/main.js';
import { makeHarness } from './support/cli-harness.js';
import { startFakeOllama, LOCAL, type FakeOllama } from './support/fake-ollama.js';

let runtime: FakeOllama | null = null;
afterEach(async () => { await runtime?.close(); runtime = null; });
const order = (units = 60, date = '2026-11-06', decoration = 'blue') => ({ units, pickup_date: date, pickup_time: '10:00', decoration, items: units ? [{ sku: 'chocolate', quantity: units / 2 }, { sku: 'vanilla', quantity: units / 2 }] : [] });
const golden = [order(), order(60, ''), order(90), order(60, '2026-11-06', 'gold sculpture'), order(90), order(0), order(60, '2026-11-08'), order()];
async function prepared() {
  const h = await makeHarness({ answers: ['yes'] });
  expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'bakery'], h.env), h.io.stderr.join('')).toBe(0);
  return h;
}
async function planned(root: string) {
  runtime = await startFakeOllama();
  let index = 0;
  runtime.chat = body => {
    const input = JSON.parse(body.messages[1].content), part = index++ % 3;
    const output = part === 0 ? golden[Math.floor((index - 1) / 3)] : part === 1 ? { summary: 'Capacity assessed.' } : { text: 'Owner review required.', display_total: input.price.display_total, decision_status: input.decision.status };
    return { json: { model: body.model, message: { role: 'assistant', content: JSON.stringify(output) }, done: true, eval_count: 10, eval_duration: 1000000 } };
  };
  const h = await makeHarness({ root, answers: ['yes'] });
  expect(await runCli(['environment', 'plan', 'bakery', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', runtime.url], h.env), h.io.stderr.join('')).toBe(0);
  const path = /Plan saved: (.+)\n/.exec(h.io.text())![1]!;
  const file = JSON.parse(await readFile(path, 'utf8'));
  return { h, path, plan: workflowPlanSchema.parse(file.plan) };
}
describe('local environment workflow', () => {
  it('prepares and runs all five universal teams through CLI plans and private reports with scripted inference', async () => {
    const h = await makeHarness({ answers: Array(5).fill('yes') });
    expect(await runCli(['environment', 'samples'], h.env)).toBe(0);
    runtime = await startFakeOllama();
    for (const team of BUSINESS_TEAMS) {
      expect(h.io.text()).toContain(team.key + ':');
      expect(await runCli(['environment', 'prepare', '--sample', team.key, '--out', team.key], h.env), h.io.stderr.join('')).toBe(0);
      const expected = new Map(businessTeamCases(team.key).map(c => [c.input.record.id, c.needs_information]));
      runtime.chat = body => {
        const { record } = JSON.parse(body.messages[1].content);
        return { json: { model: body.model, message: { role: 'assistant', content: JSON.stringify({ source_id: record.id, business_name: record.business_name, needs_information: expected.get(record.id), text: 'Scripted draft for owner review.', questions: [], review_required: true, delivery_state: 'draft_only' }) }, done: true } };
      };
      const planner = await makeHarness({ root: h.root, answers: ['yes'] });
      const before = runtime.requests.filter(r => r.path === '/api/chat').length;
      expect(await runCli(['environment', 'plan', team.key, '--runtime', 'ollama', '--model', LOCAL, '--endpoint', runtime.url], planner.env), planner.io.stderr.join('')).toBe(0);
      expect(runtime.requests.filter(r => r.path === '/api/chat')).toHaveLength(before);
      const path = /Plan saved: (.+)\n/.exec(planner.io.text())![1]!;
      const file = JSON.parse(await readFile(path, 'utf8'));
      expect(file.plan.effects.inference_requests).toBe(40);
      expect(file.plan.bindings).toHaveLength(4);
      const executor = await makeHarness({ root: h.root, answers: ['yes'] });
      expect(await runCli(['environment', 'run', path, '--offline'], executor.env), executor.io.stderr.join('')).toBe(0);
      const reportPath = /Private report: (.+)\n/.exec(executor.io.text())![1]!;
      const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
      expect(report.run.cases.map(c => c.outcome)).toEqual(Array(8).fill('pass'));
      expect(runtime.requests.filter(r => r.path === '/api/chat')).toHaveLength(before + 40);
      expect(h.fetched).toHaveLength(0);
    }
  });
  it('lists five samples without runtime access and prepares each as a distinct local bundle', async () => {
    const h = await makeHarness({ answers: Array(5).fill('yes') });
    expect(await runCli(['environment', 'samples'], h.env)).toBe(0);
    expect(SAMPLE_ENVIRONMENTS).toHaveLength(5);
    const ids = new Set<string>();
    for (const sample of SAMPLE_ENVIRONMENTS) {
      expect(h.io.text()).toContain(sample.key + ':');
      expect(await runCli(['environment', 'prepare', '--sample', sample.key, '--out', sample.key], h.env), h.io.stderr.join('')).toBe(0);
      const meta = JSON.parse(await readFile(join(h.dir(sample.key), '.localfirst-bundle.json'), 'utf8'));
      ids.add(meta.project_id);
    }
    expect(ids.size).toBe(5);
    expect(h.fetched).toHaveLength(0);
  });
  it('requires preparation consent and never overwrites a workspace', async () => {
    const denied = await makeHarness({ answers: ['no'] });
    expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'bakery'], denied.env)).not.toBe(0);
    await expect(stat(denied.dir('bakery'))).rejects.toThrow();
    const h = await prepared(), original = await readFile(join(h.dir('bakery'), 'PROJECT.md'), 'utf8');
    const repeated = await makeHarness({ root: h.root, answers: ['yes'] });
    expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'bakery'], repeated.env)).not.toBe(0);
    expect(await readFile(join(h.dir('bakery'), 'PROJECT.md'), 'utf8')).toBe(original);
    expect((await stat(h.dir('bakery'))).mode & 0o777).toBe(0o700);
  });
  it('lists and prepares the holiday remix separately without changing the bakery workspace', async () => {
    const h = await makeHarness({ answers: ['yes', 'yes'] });
    expect(await runCli(['environment', 'samples'], h.env)).toBe(0);
    expect(h.io.text()).toContain('bakery-holiday:');
    expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'parent'], h.env)).toBe(0);
    const parent = await readFile(join(h.dir('parent'), 'PROJECT.md'), 'utf8');
    expect(await runCli(['environment', 'prepare', '--sample', 'bakery-holiday', '--out', 'holiday'], h.env), h.io.stderr.join('')).toBe(0);
    const environment = JSON.parse(await readFile(join(h.dir('holiday'), 'ENVIRONMENT.yaml'), 'utf8'));
    expect(environment.model_roles).toHaveLength(4);
    expect(environment.nodes.at(-1).id).toBe('pickup-checklist');
    expect(await readFile(join(h.dir('parent'), 'PROJECT.md'), 'utf8')).toBe(parent);
    expect(h.fetched).toHaveLength(0);
  });
  it('plans without inference, runs only after approval, and exports only sanitized fields', async () => {
    const prep = await prepared(), p = await planned(prep.root);
    expect(runtime!.requests.filter(r => r.path === '/api/chat')).toHaveLength(0);
    expect(p.plan.bindings).toHaveLength(3);
    const denied = await makeHarness({ root: prep.root, answers: ['no'] });
    expect(await runCli(['environment', 'run', p.path, '--offline'], denied.env)).not.toBe(0);
    expect(runtime!.requests.filter(r => r.path === '/api/chat')).toHaveLength(0);
    const executed = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'run', p.path, '--offline'], executed.env), executed.io.stderr.join('')).toBe(0);
    const reportPath = /Private report: (.+)\n/.exec(executed.io.text())![1]!;
    const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    expect(report.run.cases.every(c => c.outcome === 'pass')).toBe(true);
    expect(runtime!.requests.filter(r => r.path === '/api/chat')).toHaveLength(24);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    const traced = await makeHarness({ root: prep.root });
    expect(await runCli(['report', 'trace', reportPath, '--workspace', 'bakery', '--out', 'trail.html'], traced.env), traced.io.stderr.join('')).toBe(0);
    const html = await readFile(traced.dir('trail.html'), 'utf8');
    expect(html).toContain('60 cupcakes');
    expect(html).toContain('Extract the CURRENT order');
    expect((await stat(traced.dir('trail.html'))).mode & 0o777).toBe(0o600);
    expect(await runCli(['report', 'trace', reportPath, '--workspace', 'bakery', '--out', 'trail.html'], traced.env)).not.toBe(0);
    expect(await readFile(traced.dir('trail.html'), 'utf8')).toBe(html);
    const exported = await makeHarness({ root: prep.root, answers: ['no', 'yes'] });
    expect(await runCli(['report', 'export', reportPath, '--review', '--test-definition-id', '00000000-0000-4000-8000-000000000009'], exported.env), exported.io.stderr.join('')).toBe(0);
    const exportPath = /Export written to (.+)\n/.exec(exported.io.text())![1]!;
    const payload = anyTestResultSubmissionSchema.parse(JSON.parse(await readFile(exportPath, 'utf8')).payload);
    expect(payload.result.schema).toBe('localfirst/test-result/v0.2');
    expect(JSON.stringify(payload)).not.toContain('60 cupcakes');
    expect(JSON.stringify(payload)).not.toContain(p.plan.runtime.endpoint);
    expect(JSON.stringify(payload)).not.toContain('PROMPTS/');
    expect(exported.fetched).toHaveLength(0);
  });
  it('prepares, plans and runs the stock snapshot example with scripted local inference', async () => {
    const prep = await makeHarness({ answers: ['yes'] });
    expect(await runCli(['environment', 'prepare', '--sample', 'stock-replenishment', '--out', 'stock'], prep.env), prep.io.stderr.join('')).toBe(0);
    runtime = await startFakeOllama();
    runtime.chat = body => {
      const input = JSON.parse(body.messages[1].content), plan = input.plan;
      const final = body.messages[0].content.includes('Draft a concise owner proposal');
      const output = final ? { status: plan.status, quantity: plan.quantity, display_total: plan.display_total, text: 'Owner review required.' } : { status: plan.status, summary: 'Scripted snapshot analysis; no live vendor check.' };
      return { json: { model: body.model, message: { role: 'assistant', content: JSON.stringify(output) }, done: true } };
    };
    const planner = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'plan', 'stock', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', runtime.url], planner.env), planner.io.stderr.join('')).toBe(0);
    const path = /Plan saved: (.+)\n/.exec(planner.io.text())![1]!;
    const plan = workflowPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')).plan);
    expect(plan.effects.operations).toEqual(['lookup_v1', 'replenishment_v1']);
    expect(plan.effects.inference_requests).toBe(48);
    expect(runtime.requests.filter(r => r.path === '/api/chat')).toHaveLength(0);
    const executor = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'run', path, '--offline'], executor.env), executor.io.stderr.join('')).toBe(0);
    const reportPath = /Private report: (.+)\n/.exec(executor.io.text())![1]!;
    const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    expect(report.run.cases.map(c => c.outcome)).toEqual(Array(12).fill('pass'));
    expect(runtime.requests.filter(r => r.path === '/api/chat')).toHaveLength(48);
  });
  it('invalidates an approved plan when prompts change before execution', async () => {
    const prep = await prepared(), p = await planned(prep.root);
    await writeFile(join(prep.dir('bakery'), 'PROMPTS/intake.txt'), 'changed');
    const executed = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'run', p.path, '--offline'], executed.env)).not.toBe(0);
    expect(runtime!.requests.filter(r => r.path === '/api/chat')).toHaveLength(0);
  });
  it('keeps private business overrides separate and refuses their export', async () => {
    const prep = await prepared();
    runtime = await startFakeOllama();
    runtime.chat = body => {
      const input = JSON.parse(body.messages[1].content);
      const output = input.message ? order() : input.price ? { text: 'Owner review required.', display_total: input.price.display_total, decision_status: input.decision.status } : { summary: 'Capacity assessed.' };
      return { json: { model: body.model, message: { role: 'assistant', content: JSON.stringify(output) }, done: true } };
    };
    const overlay = prep.dir('private-business.json'), customer = prep.dir('private-customer.json');
    await writeFile(overlay, JSON.stringify({ prices: { currency: 'USD', minor_unit_digits: 2, items: [{ sku: 'chocolate', unit_minor: 500 }, { sku: 'vanilla', unit_minor: 500 }], decorations: [{ key: 'blue', unit_minor: 0 }] } }));
    await writeFile(customer, JSON.stringify({ message: 'Private customer order for 60 cupcakes.' }));
    const plan = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'plan', 'bakery', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', runtime.url, '--data', overlay, '--input', customer], plan.env), plan.io.stderr.join('')).toBe(0);
    const path = /Plan saved: (.+)\n/.exec(plan.io.text())![1]!;
    const executed = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'run', path, '--offline'], executed.env), executed.io.stderr.join('')).toBe(0);
    const reportPath = /Private report: (.+)\n/.exec(executed.io.text())![1]!;
    const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    expect(report.plan.data_class).toBe('private_local');
    expect((report.run.cases[0]!.output as any).price.total_minor).toBe(30000);
    expect(report.run.cases).toHaveLength(1);
    const traced = await makeHarness({ root: prep.root, answers: ['no'] });
    expect(await runCli(['report', 'trace', reportPath, '--workspace', 'bakery', '--out', 'private-metadata.json', '--format', 'json'], traced.env), traced.io.stderr.join('')).toBe(0);
    expect(await readFile(traced.dir('private-metadata.json'), 'utf8')).not.toContain('Private customer order');
    expect(await runCli(['report', 'trace', reportPath, '--workspace', 'bakery', '--out', 'private-full.html', '--include-private'], traced.env)).not.toBe(0);
    await expect(stat(traced.dir('private-full.html'))).rejects.toThrow();
    const exported = await makeHarness({ root: prep.root, answers: ['no', 'yes'] });
    expect(await runCli(['report', 'export', reportPath, '--review', '--test-definition-id', '00000000-0000-4000-8000-000000000009'], exported.env)).not.toBe(0);
    expect(exported.fetched).toHaveLength(0);
  });
  it('refuses cleanup of changed user files and removes only an unchanged prepared workspace', async () => {
    const prep = await prepared(), workspace = prep.dir('bakery');
    await writeFile(join(workspace, 'private-notes.txt'), 'User work');
    const denied = await makeHarness({ root: prep.root, answers: ['yes'] });
    expect(await runCli(['environment', 'remove', workspace], denied.env)).not.toBe(0);
    expect(await readFile(join(workspace, 'private-notes.txt'), 'utf8')).toBe('User work');
    const clean = await prepared(), approved = await makeHarness({ root: clean.root, answers: ['yes'] });
    expect(await runCli(['environment', 'remove', clean.dir('bakery')], approved.env), approved.io.stderr.join('')).toBe(0);
    await expect(stat(clean.dir('bakery'))).rejects.toThrow();
  });
});
