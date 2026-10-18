import {
  boundedJson, digestOf, validateProjectBundle, verifyEnvironmentFiles, workflowDigests,
  type sampleBundle,
} from '@localfirst/contracts';
import { mapInputs, readPointer, validateOutput, WorkflowError } from '../workflows/state.js';
import { runOperation } from '../workflows/operations.js';

export interface CliWorkflowRequest {
  system: string; user: string; response_schema: unknown; role: string; case_key: string;
  /** Cancellation is a transport instruction; it is excluded from the persisted prompt. */
  signal?: AbortSignal;
}
export interface CliWorkflowOptions {
  cli?: string; model?: string; reasoningEffort?: string;
  stepTimeoutMs?: number; runTimeoutMs?: number; signal?: AbortSignal;
}
export interface CliWorkflowEvaluation {
  schema: 'localfirst/cli-workflow-evaluation/v0.1';
  execution_location: 'hosted_via_cli';
  locality_contract: 'out_of_profile_not_local_evidence';
  state: 'completed' | 'run_timeout' | 'cancelled';
  started_at: string; completed_at: string;
  configuration: {
    cli: string | null; requested_model: string | null; requested_reasoning_effort: string;
    effective_settings: 'not_verified_by_evaluator';
    declared_model_settings: unknown;
    declared_settings_enforcement: 'not_enforced_via_cli';
    step_timeout_ms: number; run_timeout_ms: number; retries: 0;
  };
  setup: unknown;
  summary: {
    state: 'completed' | 'run_timeout' | 'cancelled'; elapsed_ms: number;
    cases: number; passed: number; failed: number; errors: number; skipped: number;
    assertions_matched: number; assertions_mismatched: number; assertions_not_evaluated: number;
    inference_calls: number; limitations: string[];
  };
  cases: Array<{
    key: string; input: unknown; outcome: 'pass' | 'fail' | 'error' | 'skipped';
    started_at: string | null; elapsed_ms: number; output: unknown; error_code: string | null;
    assertions: Array<{ path: string; expected: unknown; actual: unknown; result: 'match' | 'mismatch' | 'unavailable' | 'not_evaluated' }>;
    steps: Array<{
      id: string; kind: 'agent' | 'operation'; outcome: 'completed' | 'error' | 'skipped';
      started_at: string | null; elapsed_ms: number | null; error_code: string | null;
      inputs: unknown; request: Omit<CliWorkflowRequest, 'signal'> | null;
      raw_output: unknown; output: unknown; metadata: unknown;
    }>;
  }>;
}
type Case = CliWorkflowEvaluation['cases'][number];
type Step = Case['steps'][number];
const safeMetadata = (value: unknown): unknown => {
  if (!boundedJson(value)) return { omitted: 'invalid_or_oversized_metadata' };
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|cookie|password|secret|credential|api[-_]?key|^(?:token|(?:access|refresh|auth|id)[-_]?token)$/i.test(key) ? '[redacted]' : safeMetadata(item)]));
  return value;
};

/**
 * Evaluate prompts and fixed trusted operations with a hosted CLI model.
 * This cannot produce a local runner report, a local plan, or registry evidence.
 */
export async function evaluateCliWorkflow(
  bundle: ReturnType<typeof sampleBundle>,
  infer: (request: CliWorkflowRequest) => Promise<{ output: unknown; metadata?: unknown }>,
  options: CliWorkflowOptions = {},
): Promise<CliWorkflowEvaluation> {
  const stepTimeoutMs = options.stepTimeoutMs ?? 90000, runTimeoutMs = options.runTimeoutMs ?? 900000;
  if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 1 || stepTimeoutMs > 90000 || !Number.isInteger(runTimeoutMs) || runTimeoutMs < 1 || runTimeoutMs > 900000) throw new Error('CLI evaluation deadlines are outside the supported bounds.');
  const validated = validateProjectBundle(bundle), env = structuredClone(bundle.environment), test = structuredClone(bundle.test);
  if (!validated.ok || !validated.content_digest || env.framework ||
    digestOf(env) !== digestOf(validated.environments?.find(e => e.manifest.key === env.key)?.manifest) ||
    digestOf(test) !== digestOf(validated.workflow_tests?.find(t => t.manifest.key === test.key)?.manifest)) throw new Error('CLI evaluation requires a matching validated declarative sample bundle.');
  const files = new Map(bundle.files.map(f => [f.path, f.content]));
  verifyEnvironmentFiles(env, files);
  const startedAt = new Date().toISOString(), began = performance.now(), deadline = began + runTimeoutMs;
  let state: CliWorkflowEvaluation['summary']['state'] = 'completed', inferenceCalls = 0;
  const cases: Case[] = [];
  const checkStop = () => {
    if (options.signal?.aborted) state = 'cancelled';
    else if (performance.now() >= deadline) state = 'run_timeout';
    return state !== 'completed';
  };
  const inferBounded = async (request: Omit<CliWorkflowRequest, 'signal'>) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new WorkflowError('run_timeout');
    // Classify the timer by the budget that limited it. Timer delivery and
    // performance.now() can disagree slightly at the deadline on Node 22.
    const runLimited = remaining <= stepTimeoutMs;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(stepTimeoutMs, remaining))));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return new Promise<{ output: unknown; metadata?: unknown }>((resolve, reject) => {
      const abort = () => reject(new WorkflowError(options.signal?.aborted ? 'cancelled' : runLimited || performance.now() >= deadline ? 'run_timeout' : 'step_timeout'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      // No retry: a failed request belongs to this case and is retained below.
      Promise.resolve().then(() => infer({ ...request, signal })).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
    });
  };
  for (const fixture of test.cases) {
    const record: Case = {
      key: fixture.key, input: structuredClone(fixture.input), outcome: 'skipped', started_at: null, elapsed_ms: 0, output: null, error_code: null,
      assertions: fixture.assertions.map(a => ({ path: a.path, expected: a.equals, actual: null, result: 'not_evaluated' })),
      steps: env.nodes.map(n => ({ id: n.id, kind: n.kind, outcome: 'skipped', started_at: null, elapsed_ms: null, error_code: null, inputs: null, request: null, raw_output: null, output: null, metadata: null })),
    };
    cases.push(record);
    if (checkStop()) { record.error_code = state; continue; }
    record.started_at = new Date().toISOString();
    const caseStart = performance.now();
    const namespace = new Map<string, unknown>([['input', structuredClone(fixture.input)]]);
    for (const data of env.data) namespace.set('data:' + data.key, JSON.parse(files.get(data.path)!));
    let failed = false;
    for (const [index, node] of env.nodes.entries()) {
      const step: Step = record.steps[index]!;
      if (failed) continue;
      if (checkStop()) { failed = true; record.error_code = state; continue; }
      step.started_at = new Date().toISOString();
      const stepStart = performance.now();
      try {
        const inputs = mapInputs(node.inputs, namespace);
        step.inputs = inputs;
        let output: unknown;
        if (node.kind === 'operation') {
          output = runOperation(node.operation, inputs);
          step.raw_output = output; step.output = output;
        } else {
          const prompt = env.prompts.find(p => p.key === node.prompt)!;
          const request: Omit<CliWorkflowRequest, 'signal'> = { system: files.get(prompt.path)!, user: JSON.stringify(inputs), response_schema: node.response_schema, role: node.role, case_key: fixture.key };
          step.request = request;
          inferenceCalls++;
          const response = await inferBounded(request);
          if (!boundedJson(response.output)) { step.metadata = safeMetadata(response.metadata ?? null); throw new WorkflowError('output_limit'); }
          step.raw_output = structuredClone(response.output);
          step.metadata = safeMetadata(response.metadata ?? null);
          if (typeof response.output === 'string') {
            try { output = JSON.parse(response.output); } catch { throw new WorkflowError('invalid_agent_json'); }
          } else output = response.output;
          if (!boundedJson(output)) throw new WorkflowError('state_limit');
          step.output = output;
          if (!validateOutput(output, node.response_schema)) throw new WorkflowError('agent_schema_mismatch');
          for (const constraint of node.constraints ?? []) {
            if (digestOf(readPointer(output, constraint.path)) !== digestOf(readPointer(namespace.get(constraint.equals_from.source), constraint.equals_from.path))) throw new WorkflowError('agent_claim_mismatch');
          }
        }
        if (!boundedJson(output) || Buffer.byteLength(JSON.stringify([...namespace.values(), output])) > env.limits.max_state_bytes) throw new WorkflowError('state_limit');
        namespace.set('node:' + node.id, structuredClone(output));
        step.outcome = 'completed';
      } catch (cause) {
        const code = cause instanceof WorkflowError ? cause.code : 'cli_inference_error';
        step.outcome = 'error'; step.error_code = code; record.error_code = code; failed = true;
        if (code === 'run_timeout' || code === 'cancelled') state = code;
      }
      step.elapsed_ms = performance.now() - stepStart;
    }
    if (failed) record.outcome = 'error';
    else {
      try {
        record.output = mapInputs(env.output, namespace);
        for (const assertion of record.assertions) {
          try { assertion.actual = readPointer(record.output, assertion.path); assertion.result = assertion.actual === assertion.expected ? 'match' : 'mismatch'; }
          catch { assertion.result = 'unavailable'; }
        }
        record.outcome = record.assertions.every(a => a.result === 'match') ? 'pass' : 'fail';
      } catch (cause) { record.outcome = 'error'; record.error_code = cause instanceof WorkflowError ? cause.code : 'workflow_output_error'; }
    }
    record.elapsed_ms = performance.now() - caseStart;
  }
  const assertions = cases.flatMap(c => c.assertions);
  return {
    schema: 'localfirst/cli-workflow-evaluation/v0.1', execution_location: 'hosted_via_cli', locality_contract: 'out_of_profile_not_local_evidence', state,
    started_at: startedAt, completed_at: new Date().toISOString(),
    configuration: { cli: options.cli ?? null, requested_model: options.model ?? null, requested_reasoning_effort: options.reasoningEffort ?? 'medium', effective_settings: 'not_verified_by_evaluator', declared_model_settings: env.model_roles, declared_settings_enforcement: 'not_enforced_via_cli', step_timeout_ms: stepTimeoutMs, run_timeout_ms: runTimeoutMs, retries: 0 },
    setup: {
      project_document: bundle.project_md, bundle_digest: validated.content_digest,
      environment_key: env.key, environment_digest: digestOf(env), coordinator: env.coordinator,
      coordinator_execution: 'fixed_declarative_evaluation_no_framework_execution',
      declared_locality_requirement: env.execution.locality, local_contract_satisfied: false,
      graph: env.nodes, graph_output: env.output,
      prompts: env.prompts.map(p => ({ ...p, content: files.get(p.path)! })),
      datasets: env.data.map(d => ({ ...d, content: JSON.parse(files.get(d.path)!) })),
      test: { key: test.key, ...workflowDigests(test), fixture_kind: test.fixture_kind },
    },
    summary: {
      state, elapsed_ms: performance.now() - began, cases: cases.length,
      passed: cases.filter(c => c.outcome === 'pass').length, failed: cases.filter(c => c.outcome === 'fail').length,
      errors: cases.filter(c => c.outcome === 'error').length, skipped: cases.filter(c => c.outcome === 'skipped').length,
      assertions_matched: assertions.filter(a => a.result === 'match').length,
      assertions_mismatched: assertions.filter(a => a.result === 'mismatch' || a.result === 'unavailable').length,
      assertions_not_evaluated: assertions.filter(a => a.result === 'not_evaluated').length,
      inference_calls: inferenceCalls,
      limitations: ['Hosted CLI prompt evaluation is outside the environment local_required contract and is ineligible for local evidence.', 'Declared temperature, token budgets, context size, seed and concurrency settings are not enforced by the CLI evaluator.', 'Requested model and reasoning effort require separate CLI observations to establish actual provider configuration.', 'CLI tools, hosted network access and provider behavior are controlled by the invoking CLI configuration, not by the declarative local runner.', 'Only the fixed coordinator operations and declared model inputs run here; golden fixture answers are never sent to inference.'],
    },
    cases,
  };
}
