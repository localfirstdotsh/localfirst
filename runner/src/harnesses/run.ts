import type { TestManifest } from '@localfirst/contracts';
import {
  AdapterError,
  type InferenceAdapter,
  type InferRequest,
  type ProviderStats,
} from '../adapters/types.js';
import { evaluate } from './evaluate.js';
import { checkExecutable, type RefusalCode } from './executable.js';
import { harnessLimits } from './limits.js';

/** Largest model output kept in a local report. */
export const MAX_RECORDED_OUTPUT_BYTES = 64 * 1024;

export type CaseOutcome = 'pass' | 'fail' | 'error' | 'skipped';
export type RunState = 'completed' | 'cancelled' | 'run_timeout';

export interface CaseRecord {
  key: string;
  repetition: number;
  outcome: CaseOutcome;
  output_text: string | null;
  error_code: string | null;
  /** Monotonic client time at request start, relative to the run start. */
  started_at_monotonic_ms: number | null;
  latency_ms: number | null;
  /** Monotonic ms from request start to the first non-empty content fragment of a streamed reply; null when there was none. */
  first_token_ms?: number | null;
  provider_stats: ProviderStats;
}

export interface RunRecord {
  state: RunState;
  cases: CaseRecord[];
  warmups_executed: number;
  diagnostic_codes: string[];
  elapsed_ms: number;
}

export interface RunOptions {
  manifest: TestManifest;
  adapter: InferenceAdapter;
  /** Abort to cancel. A cancelled run keeps its partial results and is never retried. */
  signal?: AbortSignal;
  /** Monotonic millisecond clock. */
  nowMs?: () => number;
}

export class RefusedTestError extends Error {
  readonly reasons: RefusalCode[];
  constructor(reasons: RefusalCode[]) {
    super(`test is not executable: ${reasons.join(', ')}`);
    this.name = 'RefusedTestError';
    this.reasons = reasons;
  }
}

/** Inference requests a run will issue: warmups plus every case in every repetition. */
export function plannedInferenceRequests(manifest: TestManifest): number {
  return manifest.measurement.warmup_runs + manifest.cases.length * manifest.measurement.repetitions;
}

function abortReason(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function requestFor(manifest: TestManifest, messages: InferRequest['messages']): InferRequest {
  const { inference } = manifest;
  return {
    messages,
    responseSchema: manifest.response_schema,
    settings: {
      temperature: inference.temperature,
      max_output_tokens: inference.max_output_tokens,
      context_tokens: inference.context_tokens,
      concurrency: inference.concurrency,
      stream: inference.stream,
      seed: inference.seed,
      reasoning: inference.reasoning,
    },
  };
}

/**
 * Run the declared cases in order: warmups first, then each repetition over
 * every case. One attempt per request, never retried. Each case ends as pass,
 * fail, error, or skipped; skipped and errored cases stay in the record. The
 * run honours the per-request and whole-run timeouts and cancellation.
 */
export async function runTest(options: RunOptions): Promise<RunRecord> {
  const check = checkExecutable(options.manifest);
  if (!check.executable) throw new RefusedTestError(check.reasons);
  const { manifest, adapter } = options;
  const nowMs = options.nowMs ?? (() => performance.now());
  const { limits, measurement } = manifest;

  const start = nowMs();
  const runDeadline = start + limits.run_timeout_ms;
  const cases: CaseRecord[] = [];
  const diagnostics = new Set<string>();
  let state: RunState = 'completed';
  let warmups = 0;

  const stopReason = (): RunState | null => {
    if (options.signal?.aborted) return 'cancelled';
    if (nowMs() >= runDeadline) return 'run_timeout';
    return null;
  };

  /** One inference attempt bounded by the request timeout, run deadline, and cancel signal. */
  async function attempt(messages: InferRequest['messages']) {
    const remaining = runDeadline - nowMs();
    const bound = Math.min(limits.request_timeout_ms, remaining);
    const runBound = remaining < limits.request_timeout_ms;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(bound)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const began = nowMs();
    let firstContentAt: number | null = null;
    const onFirstContent = () => {
      firstContentAt ??= nowMs();
    };
    try {
      const response = await Promise.race([
        adapter.infer(requestFor(manifest, messages), { signal, onFirstContent }),
        abortReason(signal),
      ]);
      const firstToken = firstContentAt === null ? null : firstContentAt - began;
      return { ok: true as const, response, began, latency: nowMs() - began, firstToken };
    } catch (cause) {
      let code = 'adapter_error';
      if (options.signal?.aborted) code = 'cancelled_in_flight';
      else if (timeout.aborted) code = runBound ? 'run_timeout' : 'request_timeout';
      else if (cause instanceof AdapterError) code = cause.code;
      return { ok: false as const, code, began, latency: nowMs() - began };
    }
  }

  const firstCase = manifest.cases[0];
  for (let index = 0; index < measurement.warmup_runs && firstCase; index += 1) {
    const stop = stopReason();
    if (stop) {
      state = stop;
      break;
    }
    const result = await attempt(firstCase.messages);
    warmups += 1;
    if (!result.ok) diagnostics.add('warmup_failed');
  }

  const schedule: Array<{ testCase: TestManifest['cases'][number]; repetition: number }> = [];
  for (let repetition = 1; repetition <= measurement.repetitions; repetition += 1) {
    for (const testCase of manifest.cases) schedule.push({ testCase, repetition });
  }

  const skip = (entry: (typeof schedule)[number]): CaseRecord => ({
    key: entry.testCase.key,
    repetition: entry.repetition,
    outcome: 'skipped',
    output_text: null,
    error_code: null,
    started_at_monotonic_ms: null,
    latency_ms: null,
    provider_stats: {},
  });

  for (const entry of schedule) {
    if (state === 'completed') {
      const stop = stopReason();
      if (stop) state = stop;
    }
    if (state !== 'completed') {
      cases.push(skip(entry));
      continue;
    }

    const result = await attempt(entry.testCase.messages);
    const record: CaseRecord = {
      key: entry.testCase.key,
      repetition: entry.repetition,
      outcome: 'error',
      output_text: null,
      error_code: null,
      started_at_monotonic_ms: result.began - start,
      latency_ms: result.latency,
      first_token_ms: null,
      provider_stats: {},
    };
    if (!result.ok) {
      record.error_code = result.code;
      if (result.code === 'cancelled_in_flight') state = 'cancelled';
      else if (result.code === 'run_timeout') state = 'run_timeout';
    } else {
      record.provider_stats = result.response.providerStats;
      record.first_token_ms = result.firstToken;
      const evaluation = evaluate(
        entry.testCase.evaluation,
        result.response.content,
        harnessLimits({
          maxOutputBytes: limits.max_response_bytes,
          deadlineMs: runDeadline,
          nowMs,
        }),
      );
      record.outcome = evaluation.outcome;
      record.error_code = evaluation.code;
      if (Buffer.byteLength(result.response.content, 'utf8') <= MAX_RECORDED_OUTPUT_BYTES) {
        record.output_text = result.response.content;
      }
    }
    cases.push(record);
  }

  if (state === 'cancelled') diagnostics.add('run_cancelled');
  if (state === 'run_timeout') diagnostics.add('run_timeout');

  return {
    state,
    cases,
    warmups_executed: warmups,
    diagnostic_codes: [...diagnostics],
    elapsed_ms: nowMs() - start,
  };
}
