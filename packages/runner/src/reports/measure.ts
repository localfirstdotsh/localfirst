import type { Measurements, TestManifest } from '@localfirst/contracts';
import { firstTokenMetricSchema, latencyMetricSchema, tokenRateMetricSchema, unavailableMetric } from '@localfirst/contracts';
import { PROVIDER_TAG as OLLAMA_PROVIDER } from '../adapters/ollama/mapping.js';
import type { CaseRecord, RunRecord } from '../harnesses/run.js';
import { sensorMetric, unsupportedObservation, type SensorMetric, type SensorObservation } from '../sensors/types.js';

/**
 * Method-tagged measurements for a local report (BACKEND_PRD section 8.2).
 *
 * Aggregation rule for every per-case metric: the median over the contributing
 * case executions, with `samples` the number of contributors. Warmups never
 * contribute. A metric whose contributors used different methods is not
 * averaged across methods: it is reported unavailable with a reason.
 */

export const LATENCY_METHOD = 'client_monotonic_end_to_end_v1' as const;
export const FIRST_TOKEN_METHOD = 'client_monotonic_first_content_chunk_v1' as const;
export const OLLAMA_RATE_METHOD = 'provider_ollama_eval_duration_v1' as const;
export const LMSTUDIO_NATIVE_RATE_METHOD = 'provider_lmstudio_native_stats_v1' as const;

const LMSTUDIO_OPENAI = 'lmstudio_openai_compat_v1';
const LMSTUDIO_NATIVE = 'lmstudio_native_v1';
const LMSTUDIO_NATIVE_RATE_KEY = 'provider_native.tokens_per_second';

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty set');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * A computed metric must satisfy its contract bounds. An implausible provider
 * number (for example a one-nanosecond generation interval) becomes an
 * unavailable metric with a reason instead of aborting the whole report.
 */
function withinContract<M extends Measurements[keyof Measurements]>(
  schema: { safeParse(value: unknown): { success: boolean } },
  metric: M,
): M | { value: null; reason: string } {
  return schema.safeParse(metric).success ? metric : unavailableMetric('value_out_of_range');
}

const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Client-side end-to-end latency: monotonic request start to reply, per case
 * execution, median over executions that were evaluated and did not error.
 * Provider-reported durations never enter this metric.
 */
export function latencyMetric(run: RunRecord): Measurements['latency_ms'] {
  const samples = run.cases
    .filter((entry) => (entry.outcome === 'pass' || entry.outcome === 'fail') && usable(entry.latency_ms))
    .map((entry) => entry.latency_ms as number);
  if (samples.length === 0) return unavailableMetric('no_evaluated_requests');
  return withinContract(latencyMetricSchema, { value: median(samples), method: LATENCY_METHOD, samples: samples.length });
}

/**
 * Streaming time to first token: monotonic client time from request start to
 * the first non-empty content fragment, median over executions that were
 * evaluated and did not error. Headers, empty fragments, and reasoning events
 * never count as the first token. A non-streaming run has no such event.
 */
export function firstTokenMetric(run: RunRecord, manifest: TestManifest): Measurements['time_to_first_token_ms'] {
  if (!manifest.inference.stream) return unavailableMetric('nonstreaming_run');
  const evaluated = run.cases.filter((entry) => entry.outcome === 'pass' || entry.outcome === 'fail');
  const samples = evaluated
    .map((entry) => entry.first_token_ms)
    .filter((value): value is number => usable(value));
  if (samples.length === 0) return unavailableMetric('no_content_event');
  if (samples.length < evaluated.length) return unavailableMetric('first_content_event_missing');
  return withinContract(firstTokenMetricSchema, { value: median(samples), method: FIRST_TOKEN_METHOD, samples: samples.length });
}

type RateMethod = typeof OLLAMA_RATE_METHOD | typeof LMSTUDIO_NATIVE_RATE_METHOD;

interface RateSample {
  method: RateMethod;
  value: number;
}

function rateOf(entry: CaseRecord): RateSample | { reason: string } {
  const stats = entry.provider_stats;
  switch (stats.provider) {
    case OLLAMA_PROVIDER: {
      const rate = stats.derived_tokens_per_second;
      return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
        ? { method: OLLAMA_RATE_METHOD, value: rate }
        : { reason: 'zero_generation_duration' };
    }
    case LMSTUDIO_NATIVE: {
      const rate = stats[LMSTUDIO_NATIVE_RATE_KEY];
      return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
        ? { method: LMSTUDIO_NATIVE_RATE_METHOD, value: rate }
        : { reason: 'provider_statistics_missing' };
    }
    case LMSTUDIO_OPENAI:
      return { reason: 'generation_interval_not_exported' };
    default:
      return { reason: 'provider_statistics_missing' };
  }
}

/**
 * Generated tokens over the provider's own generation duration. Only the
 * provider's tagged statistics are used; prompt rates, cached rates, and total
 * request time are never substituted.
 */
export function tokenRateMetric(run: RunRecord): Measurements['tokens_per_second'] {
  const rates: RateSample[] = [];
  const reasons: string[] = [];
  for (const entry of run.cases) {
    if (entry.outcome === 'skipped') continue;
    const rate = rateOf(entry);
    if ('method' in rate) rates.push(rate);
    else if (Object.keys(entry.provider_stats).length > 0) reasons.push(rate.reason);
    else reasons.push('provider_statistics_missing');
  }
  if (rates.length === 0) return unavailableMetric(reasons[0] ?? 'provider_statistics_missing');
  const methods = new Set(rates.map((rate) => rate.method));
  if (methods.size > 1) return unavailableMetric('mixed_provider_methods');
  return withinContract(tokenRateMetricSchema, {
    value: median(rates.map((rate) => rate.value)),
    method: [...methods][0] as RateMethod,
    samples: rates.length,
  });
}

export type SensorObservations = Partial<Record<SensorMetric, SensorObservation>>;

export function measurementsFor(
  run: RunRecord,
  manifest: TestManifest,
  sensors: SensorObservations = {},
): Measurements {
  return {
    latency_ms: latencyMetric(run),
    time_to_first_token_ms: firstTokenMetric(run, manifest),
    tokens_per_second: tokenRateMetric(run),
    peak_memory_bytes: sensorMetric(sensors.peak_memory_bytes ?? unsupportedObservation('peak_memory_bytes')),
    hardware_utilization: sensorMetric(sensors.hardware_utilization ?? unsupportedObservation('hardware_utilization')),
  } as Measurements;
}

/** Facts observed outside the run, such as the model state seen during preflight. */
export interface ObservedFacts {
  /** `model_state` from the adapter preflight that preceded the run. */
  modelStateBefore?: 'loaded' | 'available' | null;
}

export type LoadState = 'unknown' | 'cold' | 'loaded';
export type CacheState = 'unknown' | 'cold' | 'warm' | 'ignored';

const firstMeasured = (run: RunRecord) => run.cases.find((entry) => entry.outcome !== 'skipped');

/**
 * Conservative, evidence-only. `loaded` needs a preflight that saw the model
 * loaded. `cold` needs a preflight that saw it merely available, no warmups,
 * and Ollama reporting a positive load duration on the first measured request.
 * Everything else is `unknown`.
 */
export function loadStateOf(run: RunRecord, manifest: TestManifest, observed: ObservedFacts): LoadState {
  if (observed.modelStateBefore === 'loaded') return 'loaded';
  if (observed.modelStateBefore === 'available' && manifest.measurement.warmup_runs === 0) {
    const stats = firstMeasured(run)?.provider_stats;
    if (stats?.provider === OLLAMA_PROVIDER && typeof stats.load_duration === 'number' && stats.load_duration > 0) {
      return 'cold';
    }
  }
  return 'unknown';
}

/**
 * Cache state only from Ollama's cached prompt token counts: every measured
 * request with none cached is `cold`, every one with cached tokens is `warm`,
 * a mix or missing evidence is `unknown`.
 */
export function cacheStateOf(run: RunRecord): CacheState {
  const counts: number[] = [];
  for (const entry of run.cases) {
    if (entry.outcome === 'skipped') continue;
    const stats = entry.provider_stats;
    if (stats.provider !== OLLAMA_PROVIDER || !usable(stats.prompt_eval_cached_count)) return 'unknown';
    counts.push(stats.prompt_eval_cached_count);
  }
  if (counts.length === 0) return 'unknown';
  if (counts.every((count) => count === 0)) return 'cold';
  if (counts.every((count) => count > 0)) return 'warm';
  return 'unknown';
}
