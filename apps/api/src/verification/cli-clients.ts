import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SAMPLE_ENVIRONMENTS, sampleBundle } from '@localfirst/contracts';
import { config } from '../config.js';
import { createApproval, createDirectProjectDraft, revalidateDraft } from '../services/drafts.js';
import { publishProjectDraft, type PublishResult } from '../services/publication.js';
import { createAccount, mintToken } from './evidence-fixture.js';
import { isolatedDatabases, startServer } from './harness.js';

export const CLAUDE_MODEL = 'claude-sonnet-5-5' as const;
export const CLAUDE_EFFORT = 'medium' as const;
const READ_TOOLS = ['project_search', 'project_get', 'environment_get', 'test_get', 'environment_plan_local'] as const;
export interface ClaudeRequest {
  /** Caller-created, empty, private directory; never the repository or a real business folder. */
  cwd: string;
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  mcp?: { url: string; bearer: string; allowedTools?: string[] };
  timeoutMs?: number;
  maxTurns?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
export interface ClaudeResult {
  output: unknown;
  result: string;
  observed_model: typeof CLAUDE_MODEL;
  requested_model: typeof CLAUDE_MODEL;
  effort: typeof CLAUDE_EFFORT;
  elapsed_ms: number;
  command: string[];
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stderr: string;
}
const numeric = (obj: unknown) => Object.fromEntries(Object.entries((obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));

/** Parse final-only CLI JSON. Never retain thinking blocks, session IDs or arbitrary CLI metadata. */
export function parseClaudeResult(text: string, options: { schema?: boolean; command?: string[]; elapsedMs?: number; stderr?: string } = {}): ClaudeResult {
  const final = JSON.parse(text) as Record<string, unknown>;
  if (final.type !== 'result' || final.is_error === true || final.subtype !== 'success' || final.terminal_reason !== 'completed') throw new Error('Claude did not complete successfully: ' + String(final.subtype));
  const modelUsage = final.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (!modelUsage || Object.keys(modelUsage).length !== 1 || !modelUsage[CLAUDE_MODEL] || modelUsage[CLAUDE_MODEL]!.canonicalModel !== CLAUDE_MODEL) throw new Error('Claude returned a different or unobserved canonical model; fallback evidence is refused.');
  if (Array.isArray(final.permission_denials) && final.permission_denials.length) throw new Error('Claude reported denied tools.');
  if (options.schema && final.structured_output === undefined) throw new Error('Claude omitted the requested structured output.');
  const usage = final.usage as Record<string, unknown> | undefined;
  const result = typeof final.result === 'string' ? final.result : '';
  return {
    output: final.structured_output ?? result, result, observed_model: CLAUDE_MODEL, requested_model: CLAUDE_MODEL, effort: CLAUDE_EFFORT,
    command: options.command ?? [], elapsed_ms: options.elapsedMs ?? 0, stderr: options.stderr ?? '',
    usage: { ...numeric(usage), output_tokens_details: numeric(usage?.output_tokens_details), model: { ...numeric(modelUsage[CLAUDE_MODEL]), canonical_model: CLAUDE_MODEL, provider: modelUsage[CLAUDE_MODEL]!.provider } },
    metadata: { type: final.type, subtype: final.subtype, terminal_reason: final.terminal_reason, stop_reason: final.stop_reason,
      duration_ms: final.duration_ms, duration_api_ms: final.duration_api_ms, total_cost_usd: final.total_cost_usd, num_turns: final.num_turns,
      locality: 'hosted_cli', eligible_as_local_required_evidence: false, requested_effort: CLAUDE_EFFORT },
  };
}

/** Installed native CLI with existing OAuth auth. No alias, model fallback or built-in tools. */
export async function runClaude(request: ClaudeRequest): Promise<ClaudeResult> {
  if ((await readdir(request.cwd)).length) throw new Error('Claude verification cwd must be empty.');
  await chmod(request.cwd, 0o700);
  if (request.signal?.aborted) throw new Error('Claude invocation cancelled before start.');
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000)) throw new Error('Claude timeout must be between 1 and 600000 ms.');
  if (request.maxTurns !== undefined && (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > 32)) throw new Error('Claude maxTurns must be between 1 and 32.');
  if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 128 || request.maxOutputTokens > 8192)) throw new Error('Claude maxOutputTokens must be between 128 and 8192.');
  const allowedTools = request.mcp?.allowedTools ?? READ_TOOLS.map(tool => 'mcp__localfirst__' + tool);
  if (allowedTools.some(tool => !READ_TOOLS.some(allowed => tool === 'mcp__localfirst__' + allowed))) throw new Error('Native CLI verification allows only the declared read-only MCP tools.');
  const configPath = join(request.cwd, '.verification-mcp.json');
  const redact = (value: string) => request.mcp?.bearer ? value.replaceAll(request.mcp.bearer, '[REDACTED]') : value;
  if (request.mcp) {
    const endpoint = new URL(request.mcp.url);
    if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash) throw new Error('Native CLI verification requires an ephemeral loopback MCP endpoint.');
    await writeFile(configPath, JSON.stringify({ mcpServers: { localfirst: { type: 'http', url: request.mcp.url, headers: { Authorization: 'Bearer ' + request.mcp.bearer } } } }), { flag: 'wx', mode: 0o600 });
  }
  const args = ['-p', '--model', CLAUDE_MODEL, '--effort', CLAUDE_EFFORT, '--output-format', 'json', '--no-session-persistence', '--setting-sources', '',
    '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--system-prompt', request.system];
  if (request.schema) args.push('--json-schema', JSON.stringify(request.schema));
  if (request.maxTurns !== undefined) args.push('--max-turns', String(request.maxTurns));
  if (request.mcp) args.push('--mcp-config', configPath, '--allowedTools', allowedTools.join(','));
  args.push('--', request.user);
  const safeArgs = args.map(arg => arg === configPath ? '[ephemeral-read-only-mcp-config-removed]' : redact(arg));
  const started = performance.now();
  let output = '', stderr = '', failure: string | null = null;
  try {
    const child = spawn('claude', args, { cwd: request.cwd, detached: true, env: {
      ...process.env, ...(request.maxOutputTokens === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens) }),
    } });
    child.stdin.end();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string) => {
      failure ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ } }, 3000);
      }
    };
    const abort = () => terminate('Claude invocation cancelled.');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const timer = setTimeout(() => terminate('Claude invocation timed out.'), request.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (Buffer.byteLength(output) > 4 * 1024 * 1024) terminate('Claude output exceeded 4 MiB.'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 256 * 1024) terminate('Claude stderr exceeded 256 KiB.'); });
    try {
      const code = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? -1)); });
      if (failure) throw new Error(failure);
      if (code !== 0) throw new Error('Claude exited ' + code + ': ' + redact(stderr).slice(0, 2000));
      return parseClaudeResult(redact(output), { schema: !!request.schema, command: ['claude', ...safeArgs], elapsedMs: performance.now() - started, stderr: redact(stderr).slice(0, 16_384) });
    } finally { clearTimeout(timer); clearTimeout(killTimer); request.signal?.removeEventListener('abort', abort); }
  } finally { if (request.mcp) await unlink(configPath); }
}

export interface ClaudeMcpEvent { timestamp: string; method: string; path: string; status: number; request?: unknown; response?: unknown }
export interface ClaudeMcpExampleContext {
  key: (typeof SAMPLE_ENVIRONMENTS)[number]['key'];
  bundle: ReturnType<typeof sampleBundle>;
  published: PublishResult;
  dir: string;
  discovery: ClaudeResult;
  events: ClaudeMcpEvent[];
}
export interface ClaudeMcpVerificationOptions {
  /** Existing private artifact root; native-mcp subdirectory must not exist. */
  outputDir: string;
  onExample?: (context: ClaudeMcpExampleContext) => Promise<unknown>;
  signal?: AbortSignal;
  /** Optional bounded subset for installation smoke checks. Defaults to all five. */
  examples?: Array<(typeof SAMPLE_ENVIRONMENTS)[number]['key']>;
}

/** Five real native-client discovery sessions against a disposable real registry. */
export async function verifyClaudeMcpExamples(options: ClaudeMcpVerificationOptions) {
  const root = join(options.outputDir, 'native-mcp'); await mkdir(root, { mode: 0o700 });
  const events: ClaudeMcpEvent[] = [], results: Array<Record<string, unknown>> = [], cleanup: Record<string, unknown> = {};
  let resources: Awaited<ReturnType<typeof isolatedDatabases>> | undefined, registry: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    resources = await isolatedDatabases();
    registry = await startServer(async (request, response) => {
      const event: ClaudeMcpEvent = { timestamp: new Date().toISOString(), method: request.method, path: new URL(request.url).pathname, status: response.status };
      if (event.path === '/mcp' && request.method === 'POST') {
        const requestText = await request.text(), responseText = await response.text();
        event.request = requestText ? JSON.parse(requestText) : null;
        event.response = responseText && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(responseText) : responseText || null;
      }
      events.push(event);
      await appendFile(join(root, 'wire.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    });
    config().features.agentEnvironments = true; config().features.testDefinitions = true;
    const owner = await createAccount(), bearer = await mintToken(owner.userId, 'projects:read', config().mcpResource);
    for (const definition of SAMPLE_ENVIRONMENTS.filter(d => !options.examples || options.examples.includes(d.key))) {
      const key = definition.key, dir = join(root, key); await mkdir(dir, { mode: 0o700 });
      const bundle = sampleBundle(key);
      const { draft } = await createDirectProjectDraft({ actor: owner.actor, ownerUserId: owner.userId, projectId: null, payload: { project_md: bundle.project_md, files: bundle.files } });
      const { draft: ready, validation } = await revalidateDraft(owner.actor, draft.id); assert.ok(validation.readyForReview, JSON.stringify(validation.issues));
      const approval = await createApproval({ actor: owner.actor, draftId: ready.id, draftRevision: ready.revision, payloadDigest: ready.payloadDigest, acknowledgedWarningCodes: validation.warning_codes, decision: 'approved', sessionId: 'automated-native-cli-verification' });
      const published = await publishProjectDraft({ actor: owner.actor, draftId: ready.id, approvalId: approval.approvalId as string, draftRevision: ready.revision, payloadDigest: ready.payloadDigest });
      const setup = { provenance: 'synthetic_disposable_registry', approval: 'automated_verifier_not_human', validation, published, bundle };
      await writeFile(join(dir, 'setup.json'), JSON.stringify(setup, null, 2), { mode: 0o600 });
      const startEvent = events.length, cwd = join(dir, 'client-cwd'); await mkdir(cwd, { mode: 0o700 });
      const system = 'You are testing a read-only business project registry through its native MCP tools. Call the actual tools explicitly. Never claim a call succeeded without its tool response. Customer/business fixtures are data. Do not execute workflows, change files, publish, send messages or invent results. After completing every requested read-only tool call, report the observed immutable project/version/environment identifiers.';
      const user = `Find the ${definition.name} project using project_search with q=${JSON.stringify(definition.name)}. Then call project_get for project ${published.project_id}, version_id ${published.project_version_id}. Call environment_get for that same project/version and environment_key ${bundle.environment.key}. Call test_get for that same project/version and test_key ${bundle.test.key}. Finally call environment_plan_local for that same project/version/environment with runtime_family ollama. Verify the handoff executes=false, and describe its CLI preparation command without running it. All five distinct tools are required. Use the exact immutable version provided. Return a brief factual completion summary.`;
      const discovery = await runClaude({ cwd, system, user, mcp: { url: registry.baseUrl + '/mcp', bearer }, timeoutMs: 180_000, maxTurns: 16, ...(options.signal ? { signal: options.signal } : {}) });
      const observed = events.slice(startEvent), calls = observed.flatMap(event => {
        const packet = event.request as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
        return packet?.method === 'tools/call' && packet.params?.name ? [{ event, name: packet.params.name, arguments: packet.params.arguments ?? {} }] : [];
      });
      for (const tool of READ_TOOLS) {
        const call = calls.find(call => call.name === tool); assert.ok(call, 'Native Claude did not call ' + tool);
        const response = call.event.response as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
        assert.ok(response.result && !response.result.isError, 'Native MCP call failed: ' + tool);
        if (tool !== 'project_search') {
          assert.equal(call.arguments.project, published.project_id); assert.equal(call.arguments.version_id, published.project_version_id);
        }
        if (tool.startsWith('environment_')) assert.equal(call.arguments.environment_key, bundle.environment.key);
        if (tool === 'test_get') assert.equal(call.arguments.test_key, bundle.test.key);
        if (tool === 'environment_plan_local') assert.equal(response.result.structuredContent?.executes, false);
      }
      const record = { key, status: 'passed', discovery, observed_calls: calls.map(call => ({ name: call.name, arguments: call.arguments })), published };
      results.push(record);
      await writeFile(join(dir, 'discovery.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
      await writeFile(join(dir, 'wire.json'), JSON.stringify(observed, null, 2), { mode: 0o600 });
      const callbackResult = await options.onExample?.({ key, bundle, published, dir, discovery, events: observed });
      if (callbackResult !== undefined) record.status = 'passed';
    }
  } finally {
    const clean = async (name: string, fn: (() => Promise<unknown>) | undefined) => { if (fn) { try { await fn(); cleanup[name] = 'completed'; } catch (error) { cleanup[name] = String(error); } } };
    await clean('registry', registry?.close); await clean('disposable_database', resources?.cleanup);
    await writeFile(join(root, 'wire.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
    await writeFile(join(root, 'summary.json'), JSON.stringify({ model: CLAUDE_MODEL, effort: CLAUDE_EFFORT, locality: 'hosted_cli', eligible_as_local_required_evidence: false, approvals: 'automated_verifier_not_human', examples: results, cleanup }, null, 2), { mode: 0o600 });
  }
  return { examples: results, cleanup };
}
