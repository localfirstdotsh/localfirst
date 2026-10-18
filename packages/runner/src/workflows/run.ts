import {
  boundedJson, digestOf, environmentSchema, verifyEnvironmentFiles, workflowTestSchema,
  type AgentEnvironment, type WorkflowTest,
} from '@localfirst/contracts';
import { AdapterError, type InferenceAdapter, type ProviderStats } from '../adapters/types.js';
import { mapInputs, readPointer, validateOutput, WorkflowError } from './state.js';
import { runOperation } from './operations.js';
import type { WorkflowScheduler } from '../frameworks/docker.js';

export interface WorkflowStep {
  id: string; kind: 'agent' | 'operation'; outcome: 'completed' | 'error' | 'skipped';
  latency_ms: number | null; output: unknown; error_code: string | null; provider_stats: ProviderStats;
}
export interface WorkflowCase {
  key: string; outcome: 'pass' | 'fail' | 'error' | 'skipped'; steps: WorkflowStep[];
  output: unknown; error_code: string | null; elapsed_ms: number;
}
export interface WorkflowRun {
  state: 'completed' | 'cancelled' | 'run_timeout'; cases: WorkflowCase[]; elapsed_ms: number;
}
export interface WorkflowOptions {
  environment: AgentEnvironment; test: WorkflowTest; files: Map<string, string>;
  adapter: InferenceAdapter; signal?: AbortSignal; nowMs?: () => number;
  scheduler?: WorkflowScheduler;
  observeOnly?: boolean;
}
async function boundedAttempt<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new WorkflowError('request_cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}

/** Interprets a fixed, validated graph; inference output never supplies a command or next step. */
export async function runWorkflow(options: WorkflowOptions): Promise<WorkflowRun> {
  const env = environmentSchema.parse(structuredClone(options.environment));
  const test = workflowTestSchema.parse(structuredClone(options.test));
  const files = new Map(options.files);
  verifyEnvironmentFiles(env, files);
  if ((env.framework !== undefined) !== (options.scheduler !== undefined) || test.profile !== (env.framework?.profile ?? 'declarative')) throw new WorkflowError('workflow_profile_mismatch');
  if (test.environment_key !== env.key || test.environment_digest !== digestOf(env)) throw new WorkflowError('environment_digest_mismatch');
  const now = options.nowMs ?? (() => performance.now());
  const start = now(), deadline = start + env.limits.run_timeout_ms;
  let runState: WorkflowRun['state'] = 'completed';
  const cases: WorkflowCase[] = [];
  const schedule = async <T>(promise: Promise<T>): Promise<T> => {
    const remaining = deadline - now(), runLimited = remaining <= env.limits.step_timeout_ms;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(env.limits.step_timeout_ms, remaining))));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try { return await boundedAttempt(promise, signal); } catch (cause) {
      if (options.signal?.aborted) { runState = 'cancelled'; throw new WorkflowError('cancelled'); }
      if (timeout.aborted) {
        if (runLimited || now() >= deadline) runState = 'run_timeout';
        throw new WorkflowError(runState === 'run_timeout' ? 'run_timeout' : 'step_timeout');
      }
      throw cause;
    }
  };
  const shouldStop = () => {
    if (options.signal?.aborted) runState = 'cancelled';
    else if (now() >= deadline) runState = 'run_timeout';
    return runState !== 'completed';
  };
  for (const fixture of test.cases) {
    const began = now();
    const record: WorkflowCase = { key: fixture.key, outcome: 'skipped', steps: [], output: null, error_code: null, elapsed_ms: 0 };
    cases.push(record);
    if (shouldStop()) continue;
    const state = new Map<string, unknown>([['input', structuredClone(fixture.input)]]);
    for (const data of env.data) state.set('data:' + data.key, JSON.parse(files.get(data.path)!));
    let requests = 0, tokens = 0, failed = false;
    if (options.scheduler) {
      try { await schedule(options.scheduler.startCase(env)); }
      catch (cause) { failed = true; record.error_code = cause instanceof WorkflowError ? cause.code : 'framework_error'; }
    }
    for (const node of env.nodes) {
      const step: WorkflowStep = { id: node.id, kind: node.kind, outcome: 'skipped', latency_ms: null, output: null, error_code: null, provider_stats: {} };
      record.steps.push(step);
      if (failed || shouldStop()) { failed = true; continue; }
      const nodeStart = now();
      try {
        if (options.scheduler) await schedule(options.scheduler.beforeStep(node.id));
        const inputs = mapInputs(node.inputs, state);
        let output: unknown;
        if (node.kind === 'operation') output = runOperation(node.operation, inputs);
        else {
          const role = env.model_roles.find(r => r.key === node.role)!;
          const prompt = env.prompts.find(p => p.key === node.prompt)!;
          requests++; tokens += role.settings.max_output_tokens;
          if (requests > env.limits.max_inference_requests || tokens > env.limits.max_output_tokens) throw new WorkflowError('inference_budget');
          const remaining = deadline - now();
          const runLimited = remaining <= env.limits.step_timeout_ms;
          const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(env.limits.step_timeout_ms, remaining))));
          const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
          try {
            const response = await boundedAttempt(options.adapter.infer({
              messages: [{ role: 'system', content: files.get(prompt.path)! }, { role: 'user', content: JSON.stringify(inputs) }],
              responseSchema: node.response_schema, settings: role.settings,
            }, { signal }), signal);
            if (Buffer.byteLength(response.content) > env.limits.max_state_bytes) throw new WorkflowError('output_limit');
            try { output = JSON.parse(response.content); } catch { throw new WorkflowError('invalid_agent_json'); }
            if (!validateOutput(output, node.response_schema)) throw new WorkflowError('agent_schema_mismatch');
            for (const constraint of node.constraints ?? []) {
              if (digestOf(readPointer(output, constraint.path)) !== digestOf(readPointer(state.get(constraint.equals_from.source), constraint.equals_from.path))) throw new WorkflowError('agent_claim_mismatch');
            }
            step.provider_stats = response.providerStats;
          } catch (cause) {
            if (options.signal?.aborted) throw new WorkflowError('cancelled');
            if (timeout.aborted) throw new WorkflowError(runLimited || now() >= deadline ? 'run_timeout' : 'step_timeout');
            throw cause;
          }
        }
        if (!boundedJson(output)) throw new WorkflowError('state_limit');
        if (Buffer.byteLength(JSON.stringify([...state.values(), output])) > env.limits.max_state_bytes) throw new WorkflowError('state_limit');
        state.set('node:' + node.id, structuredClone(output));
        step.output = output; step.outcome = 'completed';
        if (options.scheduler) await schedule(options.scheduler.afterStep(node.id, output));
      } catch (cause) {
        const code = cause instanceof WorkflowError || cause instanceof AdapterError ? cause.code : 'workflow_error';
        step.outcome = 'error'; step.error_code = code; record.error_code = code; failed = true;
        if (code === 'cancelled') runState = 'cancelled';
        if (code === 'run_timeout') runState = 'run_timeout';
      }
      step.latency_ms = now() - nodeStart;
    }
    if (options.scheduler) {
      try { if (!failed) await schedule(options.scheduler.finishCase()); }
      catch (cause) { failed = true; record.error_code = cause instanceof WorkflowError ? cause.code : 'framework_error'; }
      finally {
        try { await options.scheduler.closeCase(); }
        catch { failed = true; record.error_code = 'framework_cleanup_failed'; runState = 'cancelled'; }
      }
    }
    if (failed) record.outcome = 'error';
    else {
      try {
        record.output = mapInputs(env.output, state);
        record.outcome = options.observeOnly || test.cases.find(c => c.key === fixture.key)!.assertions.every(a => {
          try { return readPointer(record.output, a.path) === a.equals; } catch { return false; }
        }) ? 'pass' : 'fail';
      } catch (cause) { record.outcome = 'error'; record.error_code = cause instanceof WorkflowError ? cause.code : 'workflow_error'; }
    }
    record.elapsed_ms = now() - began;
  }
  return { state: runState, cases, elapsed_ms: now() - start };
}
