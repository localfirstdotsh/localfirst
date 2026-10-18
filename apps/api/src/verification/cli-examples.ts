import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { sampleBundle } from '@localfirst/contracts';
import { runClaude, verifyClaudeMcpExamples } from './cli-clients.js';

type InferenceRequest = { system: string; user: string; response_schema: unknown; role: string; case_key: string; signal?: AbortSignal };
type Evaluation = { state: string; cases: Array<{ key: string; outcome: string; steps: unknown[] }>; [key: string]: unknown };
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const pretty = (value: unknown) => '<pre>' + escape(JSON.stringify(value, null, 2) ?? 'null') + '</pre>';
const head = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui;max-width:1120px;margin:36px auto;padding:0 20px;color:#172b38;background:#f6f8fa}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #ccd6de;border-radius:8px;padding:16px;font:13px/1.5 ui-monospace,monospace}td,th{text-align:left;padding:12px;border-bottom:1px solid #ccd6de}table{width:100%;border-collapse:collapse}summary{padding:10px;background:#e5edf2;cursor:pointer}details{margin:12px 0}.notice{background:#fff4de;padding:14px;border-left:5px solid #c17b16}a{color:#17629e}</style></head><body>`;

/** Hosted CLI evaluation is a separate test protocol, never local runner evidence. */
export async function runCliExampleVerification(options: { live: true; outputDir?: string }) {
  if (options.live !== true) throw new Error('Explicit live CLI opt-in required.');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const evaluator = await import(pathToFileURL(join(repo, 'packages/runner/dist/verification/cli-workflow.js')).href) as {
    evaluateCliWorkflow(bundle: ReturnType<typeof sampleBundle>, infer: (request: InferenceRequest) => Promise<{ output: unknown; metadata: unknown }>, options: Record<string, unknown>): Promise<Evaluation>;
  };
  const outputDir = options.outputDir ? resolve(options.outputDir) : await mkdtemp(join(tmpdir(), 'localfirst-cli-examples-'));
  if (options.outputDir) await mkdir(outputDir, { mode: 0o700 });
  const cliVersion = (await promisify(execFile)('claude', ['--version'], { timeout: 10000 })).stdout.trim();
  const summary: Record<string, unknown> = {
    schema: 'localfirst/cli-example-verification/v0.1', started_at: new Date().toISOString(), completed_at: null,
    cli: 'claude', cli_version: cliVersion, requested_model: 'claude-sonnet-5-5', reasoning_effort: 'medium',
    execution_location: 'hosted_via_cli', locality_contract: 'out_of_profile_not_local_evidence',
    notice: 'Synthetic fixture evaluation through an installed hosted-model CLI. These are not local-required runner reports and cannot be submitted as local inference evidence. Publication approvals use test automation. Role evaluations use fresh sessions without expected answers. Call counts are CLI invocations, not captured provider HTTP requests.',
    status: 'running', examples: [],
  };
  const examples: Array<Record<string, unknown>> = [];
  const saveSummary = async () => writeFile(join(outputDir, 'summary.json'), JSON.stringify({ ...summary, examples }, null, 2) + '\n', { mode: 0o600 });
  await saveSummary();
  try {
    const discovery = await verifyClaudeMcpExamples({ outputDir, onExample: async ({ key, bundle, dir, discovery: nativeDiscovery }) => {
      const entry: Record<string, unknown> = { key, native_mcp: 'completed', status: 'running', observed_model: nativeDiscovery.observed_model, effort: nativeDiscovery.effort };
      examples.push(entry); await saveSummary();
      let calls = 0;
      const evaluation = await evaluator.evaluateCliWorkflow(bundle, async request => {
        const { signal, ...input } = request;
        const number = ++calls, cwd = join(dir, 'role-work', String(number));
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const started = new Date().toISOString();
        await appendFile(join(dir, 'role-calls.jsonl'), JSON.stringify({ phase: 'request', number, started_at: started, input }) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ example: key, case: request.case_key, role: request.role, call: number, state: 'started' }));
        try {
          const result = await runClaude({ cwd, system: request.system, user: request.user, schema: request.response_schema as Record<string, unknown>, timeoutMs: 90000, ...(signal ? { signal } : {}) });
          await appendFile(join(dir, 'role-calls.jsonl'), JSON.stringify({ phase: 'response', number, completed_at: new Date().toISOString(), result }) + '\n', { mode: 0o600 });
          return { output: result.output, metadata: result };
        } catch (error) {
          await appendFile(join(dir, 'role-calls.jsonl'), JSON.stringify({ phase: 'error', number, completed_at: new Date().toISOString(), error: String(error) }) + '\n', { mode: 0o600 });
          throw error;
        }
      }, { cli: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium', stepTimeoutMs: 90000, runTimeoutMs: 900000 });
      await writeFile(join(dir, 'evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n', { mode: 0o600 });
      const counts = Object.fromEntries(['pass', 'fail', 'error', 'skipped'].map(outcome => [outcome, evaluation.cases.filter(c => c.outcome === outcome).length]));
      Object.assign(entry, { status: evaluation.state, defined: bundle.test.cases.length, counts, model_calls: calls, html: 'native-mcp/' + key + '/trail.html' });
      await writeFile(join(dir, 'trail.html'), head(key + ' — Claude CLI trial') + `<h1>${escape(key)} — Sonnet 5.5 CLI trial</h1><p class="notice">${escape(String(summary.notice))}</p><p>Requested model: claude-sonnet-5-5 · effort: medium · hosted inference</p><h2>Summary</h2>${pretty(entry)}<details><summary>Actual native CLI MCP discovery</summary>${pretty(nativeDiscovery)}</details><p><a href="evaluation.json">Complete evaluation JSON</a> · <a href="role-calls.jsonl">Exact role requests, outputs and CLI metadata</a> · <a href="wire.json">Captured MCP requests and responses</a> · <a href="setup.json">Creator project and environment setup</a></p><h2>Cases, prompts and results</h2>${evaluation.cases.map(c => `<details><summary>${escape(c.key)} — ${escape(c.outcome)}</summary>${pretty(c)}</details>`).join('')}</body></html>\n`, { mode: 0o600 });
      await saveSummary();
      console.log(JSON.stringify({ example: key, state: evaluation.state, counts, model_calls: calls }));
    } });
    summary.discovery = discovery;
    summary.status = examples.length === 5 && examples.every(e => e.status === 'completed') && Object.values(discovery.cleanup).every(v => v === 'completed') ? 'completed' : 'incomplete';
  } catch (error) { summary.status = 'infrastructure_error'; summary.error = String(error); }
  finally {
    summary.completed_at = new Date().toISOString();
    await saveSummary();
    const rows = examples.map(e => `<tr><td><a href="${escape(String(e.html ?? 'native-mcp/' + e.key + '/trail.html'))}">${escape(String(e.key))}</a></td><td>${escape(String(e.status))}</td><td>${escape(String((e.counts as Record<string, unknown> | undefined)?.pass ?? '—'))}/${escape(String(e.defined ?? '—'))}</td><td>${escape(String((e.counts as Record<string, unknown> | undefined)?.error ?? '—'))}</td><td>${escape(String(e.model_calls ?? '—'))}</td></tr>`).join('');
    await writeFile(join(outputDir, 'index.html'), head('Business examples through Claude Code') + `<h1>Five business examples through Claude Code</h1><p>Exact requested model: <strong>claude-sonnet-5-5</strong> · effort: <strong>medium</strong></p><p class="notice">${escape(String(summary.notice))}</p><p>Status: ${escape(String(summary.status))}. A completed run can contain failed fixture cases.</p><table><tr><th>Example and full trail</th><th>Execution</th><th>Passed</th><th>Errors</th><th>CLI role calls</th></tr>${rows}</table><p><a href="summary.json">Complete summary and discovery results</a> · <a href="native-mcp/wire.json">All native MCP packets</a> · <a href="native-mcp/summary.json">MCP discovery and cleanup</a></p><p>Each trial uses real native CLI MCP discovery, then fresh isolated CLI sessions for each role. Trusted operations compute prices and daily capacity; assertions are evaluated outside the model. Model changes and failures remain visible. No real customer messages, orders, calendar writes or public evidence submissions occur.</p></body></html>\n`, { mode: 0o600 });
  }
  return { outputDir, summary: Object.assign(summary, { examples }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.LOCALFIRST_LIVE_CLI !== '1') throw new Error('Set LOCALFIRST_LIVE_CLI=1 to authorize hosted CLI model calls.');
  const result = await runCliExampleVerification({ live: true, ...(process.env.LOCALFIRST_CLI_OUTPUT ? { outputDir: process.env.LOCALFIRST_CLI_OUTPUT } : {}) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.summary.status === 'completed' ? 0 : 1;
}
