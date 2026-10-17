/**
 * Metrics contract (BACKEND_PRD section 8.2).
 *
 * Values are canonical bytes or milliseconds, implied by the field name. A
 * measured value carries a method tag and a sample count. An unavailable value
 * is `null` with a reason, never zero, and runner process memory can never be
 * tagged as inference memory.
 */

import { z } from 'zod';
import { codeSchema } from './primitives.js';

export const LATENCY_METHODS = ['client_monotonic_end_to_end_v1'] as const;
export const FIRST_TOKEN_METHODS = ['client_monotonic_first_content_chunk_v1'] as const;
export const TOKEN_RATE_METHODS = [
  'provider_ollama_eval_duration_v1',
  'provider_lmstudio_native_stats_v1',
] as const;
/** Deliberately excludes any runner-process RSS method. */
export const PEAK_MEMORY_METHODS = [
  'runtime_process_rss_sampler_v1',
  'device_memory_sensor_v1',
] as const;
export const UTILIZATION_METHODS = ['device_utilization_sensor_v1'] as const;

function unavailable() {
  return z.object({ value: z.null(), reason: codeSchema }).strict();
}

function measured<const Methods extends readonly [string, ...string[]]>(
  methods: Methods,
  value: z.ZodType<number>,
) {
  return z
    .object({
      value,
      method: z.enum(methods),
      samples: z.int().positive().max(1000),
    })
    .strict();
}

function metric<const Methods extends readonly [string, ...string[]]>(
  methods: Methods,
  value: z.ZodType<number>,
) {
  return z.union([measured(methods, value), unavailable()]);
}

const milliseconds = z.number().nonnegative().max(86_400_000);

export const latencyMetricSchema = metric(LATENCY_METHODS, milliseconds);
export const firstTokenMetricSchema = metric(FIRST_TOKEN_METHODS, milliseconds);
/** Zero or negative rates are rejected: a zero generation duration yields null. */
export const tokenRateMetricSchema = metric(TOKEN_RATE_METHODS, z.number().positive().max(1e7));
export const peakMemoryMetricSchema = metric(PEAK_MEMORY_METHODS, z.int().positive().max(2 ** 53 - 1));
export const utilizationMetricSchema = metric(UTILIZATION_METHODS, z.number().min(0).max(1));

export const measurementsSchema = z
  .object({
    latency_ms: latencyMetricSchema,
    time_to_first_token_ms: firstTokenMetricSchema,
    tokens_per_second: tokenRateMetricSchema,
    peak_memory_bytes: peakMemoryMetricSchema,
    hardware_utilization: utilizationMetricSchema,
  })
  .strict();

export type Measurements = z.infer<typeof measurementsSchema>;

/** Build an unavailable metric. */
export function unavailableMetric(reason: string): { value: null; reason: string } {
  return { value: null, reason };
}

/** Provider nanoseconds to milliseconds, explicit and lossless to float precision. */
export function nanosecondsToMilliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) {
    throw new RangeError('duration must be a non-negative finite number of nanoseconds');
  }
  return nanoseconds / 1_000_000;
}

/**
 * Output tokens divided by generation seconds. Returns `null` for a zero or
 * invalid duration or count rather than infinity or zero (section 8.2).
 */
export function tokensPerSecond(outputTokens: number, generationNanoseconds: number): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
  if (!Number.isFinite(generationNanoseconds) || generationNanoseconds <= 0) return null;
  return outputTokens / (generationNanoseconds / 1e9);
}
