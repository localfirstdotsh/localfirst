import { measurementsSchema, peakMemoryMetricSchema } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import {
  cacheStateOf,
  firstTokenMetric,
  latencyMetric,
  loadStateOf,
  measurementsFor,
  median,
  sensorMetric,
  tokenRateMetric,
  unsupportedObservation,
  unsupportedSensor,
  type CaseRecord,
  type RunRecord,
} from '../src/index.js';
import { exampleManifest, manifestWith } from './helpers.js';

function entry(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    key: 'billing-001',
    repetition: 1,
    outcome: 'pass',
    output_text: '{}',
    error_code: null,
    started_at_monotonic_ms: 0,
    latency_ms: 100,
    provider_stats: {},
    ...overrides,
  };
}

const runOf = (cases: CaseRecord[], overrides: Partial<RunRecord> = {}): RunRecord => ({
  state: 'completed',
  cases,
  warmups_executed: 0,
  diagnostic_codes: [],
  elapsed_ms: 1,
  ...overrides,
});

const ollamaStats = (rate: number | null, extra: Record<string, number | string | null> = {}) => ({
  provider: 'ollama_native_v1',
  derived_tokens_per_second: rate,
  load_duration: 0,
  prompt_eval_cached_count: 0,
  ...extra,
});

describe('median', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('latencyMetric', () => {
  it('is the median over evaluated, non-error executions with the client monotonic method', () => {
    const run = runOf([
      entry({ latency_ms: 300 }),
      entry({ latency_ms: 100, outcome: 'fail' }),
      entry({ latency_ms: 200 }),
      entry({ latency_ms: 9999, outcome: 'error', error_code: 'request_timeout' }),
      entry({ latency_ms: null, outcome: 'skipped' }),
    ]);
    expect(latencyMetric(run)).toEqual({ value: 200, method: 'client_monotonic_end_to_end_v1', samples: 3 });
  });

  it('is null with a reason when nothing was evaluated, and ignores invalid timings', () => {
    expect(latencyMetric(runOf([entry({ outcome: 'error', error_code: 'adapter_error' })]))).toEqual({ value: null, reason: 'no_evaluated_requests' });
    expect(latencyMetric(runOf([]))).toEqual({ value: null, reason: 'no_evaluated_requests' });
    const bad = runOf([entry({ latency_ms: Number.NaN }), entry({ latency_ms: -5 }), entry({ latency_ms: Number.POSITIVE_INFINITY }), entry({ latency_ms: 50 })]);
    expect(latencyMetric(bad)).toEqual({ value: 50, method: 'client_monotonic_end_to_end_v1', samples: 1 });
  });

  it('never takes provider durations into the client latency', () => {
    const run = runOf([entry({ latency_ms: 42, provider_stats: { provider: 'ollama_native_v1', derived_total_ms: 1 } })]);
    expect(latencyMetric(run)).toMatchObject({ value: 42 });
  });
});

describe('firstTokenMetric', () => {
  const streaming = () => manifestWith((raw) => (raw.inference.stream = true));
  const evaluated = (first_token_ms: number | null, outcome: 'pass' | 'fail' | 'error' = 'pass') => entry({ outcome, first_token_ms });

  it('is unavailable for a non-streaming run: there is no first-content event', () => {
    expect(firstTokenMetric(runOf([evaluated(null)]), exampleManifest())).toEqual({ value: null, reason: 'nonstreaming_run' });
  });

  it('takes the median client time to the first content fragment over evaluated executions', () => {
    const run = runOf([evaluated(40), evaluated(10), evaluated(25), evaluated(900, 'error')]);
    expect(firstTokenMetric(run, streaming())).toEqual({ value: 25, method: 'client_monotonic_first_content_chunk_v1', samples: 3 });
  });

  it('is unavailable, with a reason, when a streamed reply carried no content or an execution lacks the event', () => {
    expect(firstTokenMetric(runOf([evaluated(null)]), streaming())).toEqual({ value: null, reason: 'no_content_event' });
    expect(firstTokenMetric(runOf([evaluated(12), evaluated(null)]), streaming())).toEqual({ value: null, reason: 'first_content_event_missing' });
    expect(firstTokenMetric(runOf([]), streaming())).toEqual({ value: null, reason: 'no_content_event' });
  });

  it('never accepts a negative or non-finite time', () => {
    expect(firstTokenMetric(runOf([evaluated(-1)]), streaming())).toEqual({ value: null, reason: 'no_content_event' });
  });
});

describe('tokenRateMetric', () => {
  it('uses the Ollama generation rate, tagged and aggregated by median', () => {
    const run = runOf([entry({ provider_stats: ollamaStats(100) }), entry({ provider_stats: ollamaStats(300) }), entry({ provider_stats: ollamaStats(200) })]);
    expect(tokenRateMetric(run)).toEqual({ value: 200, method: 'provider_ollama_eval_duration_v1', samples: 3 });
  });

  it('uses the LM Studio native rate with its own method', () => {
    const run = runOf([entry({ provider_stats: { provider: 'lmstudio_native_v1', 'provider_native.tokens_per_second': 263.6 } })]);
    expect(tokenRateMetric(run)).toEqual({ value: 263.6, method: 'provider_lmstudio_native_stats_v1', samples: 1 });
  });

  it('reports the OpenAI-compatible profile as unexported rather than deriving a rate', () => {
    const run = runOf([entry({ provider_stats: { provider: 'lmstudio_openai_compat_v1', usage_total_tokens: 20 } })]);
    expect(tokenRateMetric(run)).toEqual({ value: null, reason: 'generation_interval_not_exported' });
  });

  it('is null for a zero generation duration, missing stats, NaN, and non-positive rates', () => {
    expect(tokenRateMetric(runOf([entry({ provider_stats: ollamaStats(null) })]))).toEqual({ value: null, reason: 'zero_generation_duration' });
    expect(tokenRateMetric(runOf([entry({ provider_stats: ollamaStats(0) })]))).toEqual({ value: null, reason: 'zero_generation_duration' });
    expect(tokenRateMetric(runOf([entry({ provider_stats: ollamaStats(-3) })]))).toEqual({ value: null, reason: 'zero_generation_duration' });
    expect(tokenRateMetric(runOf([entry({ provider_stats: ollamaStats(Number.NaN) })]))).toEqual({ value: null, reason: 'zero_generation_duration' });
    expect(tokenRateMetric(runOf([entry({ provider_stats: {} })]))).toEqual({ value: null, reason: 'provider_statistics_missing' });
    expect(tokenRateMetric(runOf([entry({ outcome: 'skipped', provider_stats: {} })]))).toEqual({ value: null, reason: 'provider_statistics_missing' });
    expect(tokenRateMetric(runOf([entry({ provider_stats: { provider: 'lmstudio_native_v1' } })]))).toEqual({ value: null, reason: 'provider_statistics_missing' });
  });

  it('refuses to average across provider methods', () => {
    const run = runOf([
      entry({ provider_stats: ollamaStats(100) }),
      entry({ provider_stats: { provider: 'lmstudio_native_v1', 'provider_native.tokens_per_second': 200 } }),
    ]);
    expect(tokenRateMetric(run)).toEqual({ value: null, reason: 'mixed_provider_methods' });
  });

  it('keeps a valid rate when some executions have no usable statistics', () => {
    const run = runOf([entry({ provider_stats: ollamaStats(120) }), entry({ provider_stats: {} })]);
    expect(tokenRateMetric(run)).toMatchObject({ value: 120, samples: 1 });
  });
});

describe('sensors', () => {
  it('reports peak memory and utilization as unavailable with their reasons', async () => {
    expect(await unsupportedSensor('peak_memory_bytes').observe()).toMatchObject({ value: null, reason: 'runtime_sensor_unavailable', method: null });
    expect(sensorMetric(unsupportedObservation('hardware_utilization'))).toEqual({ value: null, reason: 'sensor_unavailable' });
    expect(sensorMetric(unsupportedObservation('peak_memory_bytes', 'platform_unsupported'))).toEqual({ value: null, reason: 'platform_unsupported' });
  });

  it('accepts a real device sensor method and rejects runner RSS as inference memory', () => {
    const observed = { ...unsupportedObservation('peak_memory_bytes'), method: 'device_memory_sensor_v1', scope: 'device' as const, source: 'driver', samples: 4, value: 1_000_000, reason: null };
    expect(sensorMetric(observed)).toEqual({ value: 1_000_000, method: 'device_memory_sensor_v1', samples: 4 });
    for (const method of ['runner_process_rss', 'process.memoryUsage().rss', 'runner_rss_v1', null]) {
      expect(() => sensorMetric({ ...observed, method })).toThrow();
    }
    expect(peakMemoryMetricSchema.safeParse({ value: 1, method: 'runner_process_rss', samples: 1 }).success).toBe(false);
  });
});

describe('measurementsFor', () => {
  it('produces a contract-valid set and never claims a sensor it does not have', () => {
    const manifest = exampleManifest();
    const measurements = measurementsFor(runOf([entry({ provider_stats: ollamaStats(50) })]), manifest);
    expect(measurementsSchema.safeParse(measurements).success).toBe(true);
    expect(measurements.peak_memory_bytes.value).toBeNull();
    expect(measurements.hardware_utilization.value).toBeNull();
  });
});

describe('measurement context', () => {
  const manifest = exampleManifest();
  const cold = runOf([entry({ provider_stats: ollamaStats(50, { load_duration: 1_300_000_000 }) })]);

  it('derives load state only from observed evidence', () => {
    expect(loadStateOf(cold, manifest, {})).toBe('unknown');
    expect(loadStateOf(cold, manifest, { modelStateBefore: 'loaded' })).toBe('loaded');
    expect(loadStateOf(cold, manifest, { modelStateBefore: 'available' })).toBe('cold');
    expect(loadStateOf(runOf([entry({ provider_stats: ollamaStats(50, { load_duration: 0 }) })]), manifest, { modelStateBefore: 'available' })).toBe('unknown');
    expect(loadStateOf(runOf([entry()]), manifest, { modelStateBefore: 'available' })).toBe('unknown');
    const warmed = manifestWith((raw) => (raw.measurement.warmup_runs = 1));
    expect(loadStateOf(cold, warmed, { modelStateBefore: 'available' })).toBe('unknown');
  });

  it('derives cache state only from Ollama cached prompt counts', () => {
    const run = (...counts: number[]) => runOf(counts.map((count) => entry({ provider_stats: ollamaStats(50, { prompt_eval_cached_count: count }) })));
    expect(cacheStateOf(run(0, 0))).toBe('cold');
    expect(cacheStateOf(run(24, 24))).toBe('warm');
    expect(cacheStateOf(run(0, 24))).toBe('unknown');
    expect(cacheStateOf(runOf([entry()]))).toBe('unknown');
    expect(cacheStateOf(runOf([]))).toBe('unknown');
    expect(cacheStateOf(runOf([entry({ provider_stats: { provider: 'lmstudio_native_v1' } })]))).toBe('unknown');
  });
});

describe('implausible provider numbers', () => {
  it('turns an out-of-range token rate or latency into an unavailable metric instead of failing the report', () => {
    const ollama = (rate: number) => ({
      state: 'completed' as const,
      warmups_executed: 0,
      diagnostic_codes: [],
      elapsed_ms: 1,
      cases: [
        {
          key: 'a-001',
          repetition: 1,
          outcome: 'pass' as const,
          output_text: null,
          error_code: null,
          started_at_monotonic_ms: 0,
          latency_ms: 10,
          provider_stats: { provider: 'ollama_native_v1', derived_tokens_per_second: rate },
        },
      ],
    });
    expect(tokenRateMetric(ollama(5e9))).toEqual({ value: null, reason: 'value_out_of_range' });
    expect(tokenRateMetric(ollama(40))).toMatchObject({ value: 40, method: 'provider_ollama_eval_duration_v1' });

    const slow = ollama(40);
    slow.cases[0]!.latency_ms = 90_000_000;
    expect(latencyMetric(slow)).toEqual({ value: null, reason: 'value_out_of_range' });
  });
});
