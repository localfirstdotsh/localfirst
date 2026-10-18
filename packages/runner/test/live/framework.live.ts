import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { bakeryFrameworkBundle, digestOfBytes, digestOf } from '@localfirst/contracts';
import { preparedFrameworkSchema, prepareFramework, localDockerEndpoint, DockerWorkflowScheduler } from '../../src/frameworks/docker.js';
import { runWorkflow } from '../../src/workflows/run.js';
import type { InferRequest } from '../../src/adapters/types.js';
import { bindModel } from '../../src/adapters/contract.js';
import { OllamaAdapter } from '../../src/adapters/ollama/adapter.js';
import { ollamaTarget, isTarget } from './gate.js';

const enabled = process.env.LOCALFIRST_LIVE_FRAMEWORKS === '1';
const artifactPath = process.env.LOCALFIRST_LIVE_FRAMEWORK_ARTIFACT;
async function artifact() {
  if (!artifactPath) throw new Error('LOCALFIRST_LIVE_FRAMEWORK_ARTIFACT must name the explicitly prepared local artifact.');
  return preparedFrameworkSchema.parse(JSON.parse(await readFile(artifactPath, 'utf8')));
}
async function oneCase(prepared: Awaited<ReturnType<typeof artifact>>, source?: string) {
  const sample = bakeryFrameworkBundle({ profile: prepared.profile, sdk_version: prepared.sdk_version, entry_digest: prepared.entry_digest, lock_digest: prepared.lock_digest }, source ?? await readFile(new URL('../../frameworks/langgraph/bakery.mjs', import.meta.url), 'utf8'));
  sample.test.cases = sample.test.cases.slice(0, 1);
  return sample;
}
function scriptedAdapter() {
  return { async infer(request: InferRequest) {
    const input = JSON.parse(request.messages[1]!.content);
    const result = input.message ? { units: 60, pickup_date: '2026-11-06', pickup_time: '10:00', decoration: 'blue', items: [{ sku: 'chocolate', quantity: 30 }, { sku: 'vanilla', quantity: 30 }] } :
      input.price ? { text: 'Owner review required.', display_total: input.price.display_total, decision_status: input.decision.status } : { summary: 'Available.' };
    return { content: JSON.stringify(result), providerStats: {} };
  } };
}
describe('live isolated LangGraph profile', () => {
  it.skipIf(!enabled)('transfers a maximum-size bounded output through the SDK broker', async () => {
    const prepared = await artifact(), sample = await oneCase(prepared);
    const scheduler = new DockerWorkflowScheduler(prepared);
    const output = { text: 'x'.repeat(65525) };
    expect(Buffer.byteLength(JSON.stringify(output))).toBe(65536);
    try {
      await scheduler.startCase(sample.environment);
      for (const node of sample.environment.nodes) {
        await scheduler.beforeStep(node.id);
        await scheduler.afterStep(node.id, output);
      }
      await scheduler.finishCase();
    } finally { await scheduler.closeCase(); }
  }, 120000);
  it.skipIf(!enabled)('runs the real SDK graph through the bounded parent broker and tears it down', async () => {
    const prepared = await artifact(), sample = await oneCase(prepared);
    const run = await runWorkflow({ environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: scriptedAdapter(), scheduler: new DockerWorkflowScheduler(prepared) });
    expect(run.state).toBe('completed');
    expect(run.cases[0]!.outcome).toBe('pass');
  }, 120000);
  it.skipIf(!enabled)('runs a real local model inside the same workflow boundary', async () => {
    const target = ollamaTarget();
    if (!isTarget(target)) throw new Error(target.skip);
    const prepared = await artifact(), sample = await oneCase(prepared);
    const runtime = new OllamaAdapter({ endpoint: target.endpoint });
    const preflight = await runtime.preflight({ model: target.model, requirements: { capabilities: ['chat', 'json_output'], locality: 'local_required', settings: sample.environment.model_roles[0]!.settings, structured_output: true } });
    expect(preflight.ok).toBe(true);
    const run = await runWorkflow({ environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: bindModel(runtime, target.model, { plan_digest: digestOf(sample.environment), channel: 'interactive_tty' }), scheduler: new DockerWorkflowScheduler(prepared) });
    expect(run.state).toBe('completed');
    expect(['pass', 'fail']).toContain(run.cases[0]!.outcome);
    console.log('LIVE LangGraph outcome ' + JSON.stringify({ model: target.model, outcome: run.cases[0]!.outcome, image: prepared.image_id, sdk: prepared.sdk_version }));
  }, 120000);
  it.skipIf(!enabled)('refuses host files, root writes, privilege escalation, network and credential access in creator code', async () => {
    const base = await readFile(new URL('../../frameworks/langgraph/bakery.mjs', import.meta.url), 'utf8');
    const probe = `
import fs from 'node:fs';
import net from 'node:net';
function mustFail(fn) { let blocked = false; try { fn(); } catch { blocked = true; } if (!blocked) throw new Error('isolation_failed'); }
mustFail(() => fs.readFileSync('/var/run/docker.sock'));
mustFail(() => fs.readFileSync('/root/.ssh/id_rsa'));
mustFail(() => fs.writeFileSync('/app/injected', 'bad'));
mustFail(() => process.setuid(0));
if (fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim() !== '32') throw new Error('process_limit_missing');
if (Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()) > 536870912) throw new Error('memory_limit_missing');
const [quota,period] = fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(' ').map(Number);
if (!Number.isFinite(quota) || quota/period > 1) throw new Error('cpu_limit_missing');
if (!/CapEff:\\s+0+/.test(fs.readFileSync('/proc/self/status','utf8'))) throw new Error('capability_drop_missing');
if (process.env.LOCALFIRST_HOST_SECRET) throw new Error('secret_leaked');
await new Promise((resolve,reject) => {
  const socket = net.connect({host:'1.1.1.1',port:443});
  socket.once('connect',()=>{socket.destroy();reject(new Error('network_escape'));});
  socket.once('error',()=>resolve());
  socket.setTimeout(1000,()=>{socket.destroy();resolve();});
});
`;
    process.env.LOCALFIRST_HOST_SECRET = 'local-test-secret-never-exported';
    let prepared;
    try { prepared = await prepareFramework(probe + base, await localDockerEndpoint()); }
    finally { delete process.env.LOCALFIRST_HOST_SECRET; }
    expect(prepared.entry_digest).toBe(digestOfBytes(probe + base));
    const sample = await oneCase(prepared, probe + base);
    const run = await runWorkflow({ environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: scriptedAdapter(), scheduler: new DockerWorkflowScheduler(prepared) });
    expect(run.cases[0]!.outcome).toBe('pass');
    const dir = await mkdtemp(join(tmpdir(), 'lf-framework-audit-'));
    await writeFile(join(dir, 'artifact.json'), JSON.stringify(prepared), { mode: 0o600 });
  }, 360000);
  it.skipIf(!enabled)('rejects undeclared broker steps from a custom graph', async () => {
    const source = 'export function createWorkflow({executeStep}) { return { invoke: async () => executeStep("undeclared-shell") }; }';
    const prepared = await prepareFramework(source, await localDockerEndpoint()), sample = await oneCase(prepared, source);
    let calls = 0;
    const run = await runWorkflow({ environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: { async infer(r) { calls++; return scriptedAdapter().infer(r); } }, scheduler: new DockerWorkflowScheduler(prepared) });
    expect(run.cases[0]!.error_code).toBe('framework_protocol_violation');
    expect(calls).toBe(0);
  }, 360000);
  it.skipIf(!enabled)('cancels a stalled custom graph and preserves the partial report', async () => {
    const source = 'export function createWorkflow() { return { invoke: async () => new Promise(() => { setInterval(() => {}, 1000); }) }; }';
    const prepared = await prepareFramework(source, await localDockerEndpoint()), sample = await oneCase(prepared, source), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const run = await runWorkflow({ environment: sample.environment, test: sample.test, files: new Map(sample.files.map(f => [f.path, f.content])), adapter: scriptedAdapter(), scheduler: new DockerWorkflowScheduler(prepared), signal: controller.signal });
      expect(run.state).toBe('cancelled');
      expect(run.cases[0]!.outcome).toBe('error');
    } finally { clearTimeout(timer); }
  }, 360000);
});
