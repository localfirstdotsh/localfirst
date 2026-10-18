import { peakMemoryMetricSchema, utilizationMetricSchema, unavailableMetric } from '@localfirst/contracts';

/**
 * Method-tagged sensor observations (BACKEND_PRD sections 7.3, 8.2).
 *
 * A sensor either observes a named quantity with a declared method, scope and
 * window, or reports why it cannot. There is deliberately no process-memory
 * sampler: the runner's own RSS is not inference memory and must never be
 * tagged as such, and the contract's peak-memory method list excludes it.
 */
export type SensorMetric = 'peak_memory_bytes' | 'hardware_utilization';

export interface SensorObservation {
  metric: SensorMetric;
  /** Versioned method tag, one of the contract's method names for the metric. */
  method: string | null;
  /** What was measured: the inference runtime process, a device, or the system. */
  scope: 'inference_process' | 'device' | 'system' | null;
  /** Where the number came from, e.g. a driver or OS interface. */
  source: string | null;
  window: { start_ms: number; end_ms: number } | null;
  samples: number;
  value: number | null;
  /** Stable reason code when `value` is null. */
  reason: string | null;
}

export interface Sensor {
  readonly metric: SensorMetric;
  observe(): Promise<SensorObservation>;
}

export const SENSOR_REASONS: Record<SensorMetric, string> = {
  peak_memory_bytes: 'runtime_sensor_unavailable',
  hardware_utilization: 'sensor_unavailable',
};

/** Observation for a sensor that does not exist on this platform or build. */
export function unsupportedObservation(metric: SensorMetric, reason?: string): SensorObservation {
  return {
    metric,
    method: null,
    scope: null,
    source: null,
    window: null,
    samples: 0,
    value: null,
    reason: reason ?? SENSOR_REASONS[metric],
  };
}

export function unsupportedSensor(metric: SensorMetric, reason?: string): Sensor {
  return { metric, observe: async () => unsupportedObservation(metric, reason) };
}

/**
 * Convert an observation into the contract metric, validated against the
 * contract's allowed methods. An observation with a value but a disallowed
 * method (for example a runner RSS tag) throws instead of being mislabelled.
 */
export function sensorMetric(observation: SensorObservation) {
  const schema = observation.metric === 'peak_memory_bytes' ? peakMemoryMetricSchema : utilizationMetricSchema;
  if (observation.value === null) {
    return schema.parse(unavailableMetric(observation.reason ?? SENSOR_REASONS[observation.metric]));
  }
  return schema.parse({
    value: observation.value,
    method: observation.method,
    samples: observation.samples,
  });
}
