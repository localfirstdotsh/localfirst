import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SAMPLE_ENVIRONMENTS, sampleBundle, validateProjectBundle, workflowLocalReportSchema } from '@localfirst/contracts';
import { config } from '../config.js';
import { createApproval, createDirectProjectDraft, revalidateDraft } from '../services/drafts.js';
import { publishProjectDraft } from '../services/publication.js';
import { createAccount, mintToken } from './evidence-fixture.js';
import { isolatedDatabases, startServer } from './harness.js';

/**
 * Private, opt-in verification against one already-installed local Ollama model.
 * Uses the real registry, official MCP client and actual runner CLI. Publication
 * and PTY confirmations are AUTOMATED VERIFICATION, never a human approval claim.
 * No model downloads, real customer data, external delivery or evidence uploads.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const tsx = resolve(repo, 'backend/node_modules/.bin/tsx');
const runnerBin = resolve(repo, 'runner/src/cli/bin.ts');
const ALLOWED = new Set(['GET /api/version', 'GET /api/tags', 'GET /api/ps', 'POST /api/show', 'POST /api/chat']);
type ExampleKey = (typeof SAMPLE_ENVIRONMENTS)[number]['key'];
type LifecycleEvent = { kind: 'setup' | 'mcp' | 'approval' | 'command' | 'cleanup'; timestamp: string; summary: string; details?: unknown };
export interface EnvironmentVerificationOptions {
  /** Must name a new directory. Everything inside is a private local artifact. */
  outputDir?: string;
  endpoint: string;
  model: string;
  examples?: ExampleKey[];
  /** Explicit acknowledgement: this invokes an installed real model. */
  live: true;
}

export function validateLocalOllamaEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Verification only accepts a plain HTTP loopback Ollama origin without credentials.');
  }
  return url.origin;
}
async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const PTY_RELAY = `
import os, pty, select, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
stdin_open = True
while True:
    readers = [master] + ([0] if stdin_open else [])
    ready, _, _ = select.select(readers, [], [], 0.1)
    if master in ready:
        try: data = os.read(master, 65536)
        except OSError: data = b''
        if not data: break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stdin_open = False
sys.exit(child.wait())
`;

/** Real terminal behavior; yes is injected only at an observed exact yes prompt. */
async function runCli(args: string[], localHome: string, cwd: string, approve: (question: string) => Promise<void>) {
  const child = spawn('python3', ['-c', PTY_RELAY, tsx, runnerBin, ...args], {
    cwd, detached: true, env: { ...process.env, LOCALFIRST_HOME: localHome, HOME: homedir(), NO_COLOR: '1' },
  });
  let output = '', answered = 0, approvals = Promise.resolve();
  const terminate = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } } };
  const timer = setTimeout(terminate, 300_000);
  const consume = (chunk: Buffer) => {
    output += chunk.toString().replaceAll('\r', '');
    const prompts = [...output.matchAll(/([^\n]*Type "yes"[^\n]*?: )/g)];
    while (answered < prompts.length) {
      const question = prompts[answered++]![1]!;
      approvals = approvals.then(async () => { await approve(question); child.stdin.write('yes\n'); });
    }
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) terminate();
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  try {
    const exitCode = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? -1)); });
    await approvals;
    return { args, exit_code: exitCode, transcript: output, automated_confirmation_count: answered };
  } finally { clearTimeout(timer); }
}

/** Observe the unchanged model protocol through a loopback-only recording proxy. */
async function runtimeRecorder(endpoint: string, observed: (event: unknown) => Promise<void>) {
  let example: string | null = null;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const task = (async () => {
      const started = new Date().toISOString(), path = req.url ?? '/', method = req.method ?? 'GET';
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Runtime request exceeds limit.'); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString('utf8');
      if (!ALLOWED.has(method + ' ' + path)) { res.writeHead(403); res.end(); return; }
      const upstream = await fetch(endpoint + path, {
        method, ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}), signal: AbortSignal.timeout(40_000),
      });
      const text = await upstream.text();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Runtime response exceeds limit.');
      await observed({ example, timestamp: started, completed_at: new Date().toISOString(), method, path, status: upstream.status,
        request: body ? JSON.parse(body) : null, response: JSON.parse(text), inference: method === 'POST' && path === '/api/chat', provenance: 'real_local_ollama' });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }); res.end(text);
    })().catch(async error => {
      await observed({ example, timestamp: new Date().toISOString(), error: String(error), provenance: 'real_local_ollama' });
      if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({ error: 'Verification recorder failed.' }));
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, select: (key: string | null) => { example = key; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await Promise.all(pending); } };
}

export async function runEnvironmentVerification(options: EnvironmentVerificationOptions) {
  if (options.live !== true) throw new Error('Explicit live inference opt-in is required.');
  const endpoint = validateLocalOllamaEndpoint(options.endpoint);
  const definitions = options.examples ? options.examples.map(key => {
    const value = SAMPLE_ENVIRONMENTS.find(e => e.key === key); if (!value) throw new Error('Unknown example: ' + key); return value;
  }) : [...SAMPLE_ENVIRONMENTS];
  if (!definitions.length || new Set(definitions.map(e => e.key)).size !== definitions.length) throw new Error('Choose unique supported examples.');
  if (!options.model.trim()) throw new Error('An installed model ID is required.');
  // This also ensures a working prepared trace renderer before touching a DB.
  const traceModule = await import(pathToFileURL(resolve(repo, 'runner/dist/reports/workflow-trail.js')).href) as {
    workflowTrail(report: unknown, bundle: unknown, options: unknown): unknown;
    renderWorkflowTrailHtml(trail: unknown): string;
  };
  const output = options.outputDir ? resolve(options.outputDir) : await mkdtemp(join(tmpdir(), 'localfirst-five-examples-'));
  if (options.outputDir) await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);
  const runtimeEvents: unknown[] = [], registryRequests: unknown[] = [], globalEvents: LifecycleEvent[] = [];
  const lifecycle = async (events: LifecycleEvent[], kind: LifecycleEvent['kind'], summary: string, details?: unknown) => {
    const event: LifecycleEvent = { kind, timestamp: new Date().toISOString(), summary, ...(details === undefined ? {} : { details }) };
    events.push(event); await appendFile(join(output, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  };
  const summary: { schema: string; started_at: string; completed_at: string | null; status: string; inference: string; approvals: string; privacy: string; endpoint: string; model: string; examples: Array<Record<string, unknown>>; cleanup: Record<string, unknown> } = {
    schema: 'localfirst/example-verification/v0.1', started_at: new Date().toISOString(), completed_at: null, status: 'running',
    inference: 'real_local_ollama', approvals: 'Automated verification using a synthetic account and scripted PTY confirmations; no human approval is claimed.',
    privacy: 'Private local artifact. Contains synthetic customer prompts, expanded system prompts and local paths. No build/result/evidence is uploaded.',
    endpoint, model: options.model, examples: [], cleanup: {},
  };
  await privateJson(join(output, 'summary.json'), summary);
  let resources: Awaited<ReturnType<typeof isolatedDatabases>> | undefined;
  let registry: Awaited<ReturnType<typeof startServer>> | undefined;
  let recorder: Awaited<ReturnType<typeof runtimeRecorder>> | undefined;
  let client: Client | undefined;
  try {
    recorder = await runtimeRecorder(endpoint, async event => { runtimeEvents.push(event); await appendFile(join(output, 'runtime-http.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); });
    resources = await isolatedDatabases();
    await lifecycle(globalEvents, 'setup', 'Created and migrated a random disposable loopback verification database.', { database: new URL(resources.urls[0]!).pathname.slice(1), data_source: 'synthetic_only', existing_databases_modified: false });
    registry = await startServer(async (request, response) => {
      const event: Record<string, unknown> = { timestamp: new Date().toISOString(), method: request.method, path: new URL(request.url).pathname, status: response.status };
      // Capture protocol packets, including initialize/listTools/notifications.
      // Never retain headers: the bearer is deliberately absent from this trail.
      if (event.path === '/mcp' && request.method === 'POST') {
        const requestText = await request.text(), responseText = await response.text();
        event.request = requestText ? JSON.parse(requestText) : null;
        event.response = responseText && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(responseText) : responseText || null;
      }
      registryRequests.push(event);
      await appendFile(join(output, 'registry-http.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    });
    config().features.agentEnvironments = true;
    config().features.testDefinitions = true;
    await lifecycle(globalEvents, 'setup', 'Started the real local registry with agent environment and test-definition gates enabled.', { registry: registry.baseUrl, runtime_recorder: recorder.endpoint, real_runtime: endpoint });
    const owner = await createAccount();
    const token = await mintToken(owner.userId, 'projects:read', config().mcpResource);
    client = new Client({ name: 'localfirst-five-example-verifier', version: '0.3.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(registry.baseUrl + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    const advertised = await client.listTools();
    await lifecycle(globalEvents, 'mcp', 'Connected official MCP SDK transport and listed supported tools.', { method: 'tools/list', response: advertised });
    for (const definition of definitions) {
      const key = definition.key, dir = join(output, key), events: LifecycleEvent[] = [];
      await mkdir(dir, { mode: 0o700 });
      const entry: Record<string, unknown> = { key, name: definition.name, status: 'running', html: key + '/trail.html', events: key + '/lifecycle.json', raw_report: key + '/report.json' };
      summary.examples.push(entry); await privateJson(join(output, 'summary.json'), summary);
      recorder.select(key);
      try {
        const bundle = sampleBundle(key), validated = validateProjectBundle(bundle);
        assert.ok(validated.ok, JSON.stringify(validated.issues));
        await privateJson(join(dir, 'creator-bundle.json'), bundle);
        await lifecycle(events, 'setup', 'Authored and validated the complete synthetic creator project and environment bundle.', {
          example: key, environment: bundle.environment, fixtures: bundle.test, project_md: bundle.project_md,
          files: bundle.files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content) })), content_digest: validated.content_digest,
        });
        const { draft } = await createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null, payload: { project_md: bundle.project_md, files: bundle.files } });
        const { draft: ready, validation } = await revalidateDraft(owner.actor, draft.id);
        assert.ok(validation.readyForReview, JSON.stringify(validation.issues));
        await lifecycle(events, 'setup', 'Created a real project draft and ran server validation.', { draft_id: ready.id, revision: ready.revision, payload_digest: ready.payloadDigest, validation });
        const approval = await createApproval({ actor: owner.actor, draftId: ready.id, draftRevision: ready.revision, payloadDigest: ready.payloadDigest, acknowledgedWarningCodes: validation.warning_codes, decision: 'approved', sessionId: 'automated-environment-verification' });
        await lifecycle(events, 'approval', 'Automated verifier approved the exact synthetic project artifact; this was not a human review.', { approval_id: approval.approvalId, warning_codes: validation.warning_codes });
        const published = await publishProjectDraft({ actor: owner.actor, draftId: ready.id, approvalId: approval.approvalId as string, draftRevision: ready.revision, payloadDigest: ready.payloadDigest });
        Object.assign(entry, { project_id: published.project_id, project_version_id: published.project_version_id, bundle_digest: published.content_digest });
        await lifecycle(events, 'setup', 'Published the exact artifact into the disposable registry.', published);
        const mcpCall = async (name: string, args: Record<string, unknown>) => {
          const response = await client!.callTool({ name, arguments: args });
          await privateJson(join(dir, 'mcp-' + name + '.json'), { name, arguments: args, response });
          await lifecycle(events, 'mcp', 'Observed official MCP tool call: ' + name, { method: 'tools/call', name, arguments: args, response });
          assert.ok(!response.isError, JSON.stringify(response));
          return response.structuredContent as Record<string, unknown>;
        };
        const found = await mcpCall('project_search', { q: definition.name, test_support: ['declarative_workflow_v1'] });
        assert.ok((found.items as Array<{ project_id: string }>).some(item => item.project_id === published.project_id), 'Published example must appear in MCP search.');
        const reference = { project: published.project_id, version_id: published.project_version_id };
        await mcpCall('project_get', reference);
        const detail = await mcpCall('environment_get', { ...reference, environment_key: bundle.environment.key });
        await mcpCall('test_get', { ...reference, test_key: bundle.test.key });
        const handoff = await mcpCall('environment_plan_local', { ...reference, environment_key: bundle.environment.key, runtime_family: 'ollama' });
        assert.equal(handoff.executes, false);
        const resource = await client.readResource({ uri: detail.resource_uri as string });
        await privateJson(join(dir, 'mcp-resource.json'), { uri: detail.resource_uri, response: resource });
        await lifecycle(events, 'mcp', 'Read immutable environment resource through official MCP client.', { method: 'resources/read', uri: detail.resource_uri, response: resource });
        const workspace = join(dir, 'workspace'), localHome = join(dir, 'localfirst-home');
        const command = async (phase: string, args: string[]) => {
          const result = await runCli(args, localHome, dir, async question => lifecycle(events, 'approval', 'Automated verification answered an observed PTY confirmation; no human consent is claimed.', { phase, question, answer: 'yes' }));
          await privateJson(join(dir, 'cli-' + phase + '.json'), result);
          await lifecycle(events, 'command', 'Executed actual runner CLI: ' + phase, result);
          return result;
        };
        const prepArgs = [...(handoff.handoff as { args: string[] }).args];
        const outputIndex = prepArgs.indexOf('--out'); assert.ok(outputIndex >= 0); prepArgs[outputIndex + 1] = workspace;
        assert.equal((await command('prepare', prepArgs)).exit_code, 0);
        const plan = await command('plan', ['environment', 'plan', workspace, '--runtime', 'ollama', '--endpoint', recorder.endpoint, '--model', options.model]);
        assert.equal(plan.exit_code, 0, plan.transcript);
        const planPath = /Plan saved: (.+)\n/.exec(plan.transcript)?.[1]; assert.ok(planPath);
        const execution = await command('run', ['environment', 'run', planPath]);
        assert.ok([0, 1].includes(execution.exit_code), execution.transcript);
        const reportPath = /Private report: (.+)\n/.exec(execution.transcript)?.[1]; assert.ok(reportPath, execution.transcript);
        const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
        await privateJson(join(dir, 'report.json'), report);
        await privateJson(join(dir, 'plan.json'), JSON.parse(await readFile(planPath, 'utf8')));
        Object.assign(entry, { status: report.run.state === 'completed' ? 'completed' : 'incomplete', run_state: report.run.state,
          elapsed_ms: report.run.elapsed_ms, passed: report.run.cases.filter(c => c.outcome === 'pass').length, defined: bundle.test.cases.length,
          failed: report.run.cases.filter(c => c.outcome === 'fail').length, errors: report.run.cases.filter(c => c.outcome === 'error').length,
          cases: report.run.cases.map(c => ({ key: c.key, outcome: c.outcome, error_code: c.error_code })), runtime: report.plan.runtime, bindings: report.plan.bindings });
        const removed = await command('remove', ['environment', 'remove', workspace]);
        assert.equal(removed.exit_code, 0, removed.transcript);
        await lifecycle(events, 'cleanup', 'Removed only unchanged prepared workspace files through the real runner cleanup command. Private reports, plans and original creator bundle retained.');
        await privateJson(join(dir, 'lifecycle.json'), events);
        const trace = traceModule.workflowTrail(report, bundle, { includePrivate: true, lifecycle: events });
        await privateJson(join(dir, 'trail.json'), trace);
        await writeFile(join(dir, 'trail.html'), traceModule.renderWorkflowTrailHtml(trace), { mode: 0o600 });
      } catch (error) {
        Object.assign(entry, { status: 'infrastructure_error', error: String(error) });
        await lifecycle(events, 'cleanup', 'Example stopped with an infrastructure error; retained exact artifacts for inspection.', { error: String(error) });
        await privateJson(join(dir, 'lifecycle.json'), events);
      }
      await privateJson(join(output, 'summary.json'), summary);
    }
    summary.status = summary.examples.every(e => e.status === 'completed') ? 'completed' : 'incomplete';
  } catch (error) {
    summary.status = 'infrastructure_error'; summary.cleanup.error = String(error);
  } finally {
    recorder?.select(null);
    const cleanup = async (name: string, fn: (() => Promise<unknown>) | undefined) => {
      if (!fn) return;
      try { await fn(); summary.cleanup[name] = 'completed'; }
      catch (error) { summary.cleanup[name] = String(error); summary.status = 'incomplete'; }
    };
    await cleanup('mcp_client', client ? () => client!.close() : undefined);
    await cleanup('registry', registry?.close);
    await cleanup('runtime_recorder', recorder?.close);
    await cleanup('disposable_database', resources?.cleanup);
    await lifecycle(globalEvents, 'cleanup', 'Verification cleanup finished. The installed runtime and model were left running; disposable registry/database were removed.', summary.cleanup);
    summary.completed_at = new Date().toISOString();
    await privateJson(join(output, 'registry-http.json'), registryRequests);
    await privateJson(join(output, 'setup-lifecycle.json'), globalEvents);
    await privateJson(join(output, 'summary.json'), summary);
    const rows = summary.examples.map(e => `<tr><td><a href="${html(String(e.key))}/trail.html">${html(String(e.name))}</a></td><td>${html(String(e.status))}</td><td>${e.passed ?? '—'}/${e.defined ?? '—'}</td><td>${typeof e.elapsed_ms === 'number' ? (e.elapsed_ms / 1000).toFixed(1) + 's' : '—'}</td><td><a href="${html(String(e.key))}/lifecycle.json">MCP/setup/CLI</a> · <a href="${html(String(e.key))}/creator-bundle.json">project + prompts + fixtures</a> · <a href="${html(String(e.key))}/report.json">raw report</a></td></tr>`).join('');
    await writeFile(join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>Five small business environment trials</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#17212b}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ccd5dd}p{line-height:1.6}a{color:#17629e}</style><h1>Small business environment trials</h1><p>Status: ${html(summary.status)}. Real local model: ${html(options.model)}. ${html(summary.approvals)}</p><p>${html(summary.privacy)} Model mistakes remain recorded failures. Completion measures protocol execution separately from fixture accuracy.</p><table><tr><th>Example</th><th>Execution</th><th>Fixtures passed</th><th>Duration</th><th>Trail</th></tr>${rows}</table><p><a href="summary.json">Machine-readable summary</a> · <a href="setup-lifecycle.json">Global setup and cleanup</a> · <a href="runtime-http.jsonl">Exact model HTTP requests and responses</a> · <a href="registry-http.json">Observed registry HTTP and full MCP wire packets</a></p><p>Each successful trial follows creator bundle → validation → automated approval → publication → MCP discovery/read/handoff → workspace preparation → installed-model preflight → automated execution approval → fixture run → retained private report → safe workspace cleanup. No evidence was uploaded and no real booking/message/payment occurred.</p></html>`, { mode: 0o600 });
  }
  return { outputDir: output, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.LOCALFIRST_LIVE !== '1') throw new Error('Set LOCALFIRST_LIVE=1 to acknowledge real installed-model inference. No runtime was probed.');
  const result = await runEnvironmentVerification({ live: true,
    endpoint: process.env.LOCALFIRST_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434',
    model: process.env.LOCALFIRST_OLLAMA_MODEL ?? 'qwen2.5:1.5b',
    ...(process.env.LOCALFIRST_EXAMPLE_OUTPUT ? { outputDir: process.env.LOCALFIRST_EXAMPLE_OUTPUT } : {}),
  });
  console.log(JSON.stringify({ output_dir: result.outputDir, summary: result.summary }, null, 2));
  process.exitCode = result.summary.status === 'completed' ? 0 : 1;
}
