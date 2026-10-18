/**
 * Minimal in-process metrics for `/metrics` (BACKEND_PRD sections 12.3, 19.3).
 *
 * Operational counters only. Nothing here observes local test activity, which
 * the backend cannot and must not see.
 */

interface Histogram {
  count: number;
  totalMs: number;
  maxMs: number;
}

const requestCounts = new Map<string, number>();
const requestLatency = new Map<string, Histogram>();
const counters = new Map<string, number>();

export function recordRequest(route: string, status: number, latencyMs: number): void {
  const key = `${route}|${status}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  const histogram = requestLatency.get(route) ?? { count: 0, totalMs: 0, maxMs: 0 };
  histogram.count += 1;
  histogram.totalMs += latencyMs;
  histogram.maxMs = Math.max(histogram.maxMs, latencyMs);
  requestLatency.set(route, histogram);
}

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function renderMetrics(extra: Record<string, number> = {}): string {
  const lines: string[] = [];
  lines.push('# TYPE localfirst_http_requests_total counter');
  for (const [key, value] of requestCounts) {
    const [route, status] = key.split('|');
    lines.push(`localfirst_http_requests_total{route="${route}",status="${status}"} ${value}`);
  }
  lines.push('# TYPE localfirst_http_request_duration_ms_sum counter');
  for (const [route, histogram] of requestLatency) {
    lines.push(`localfirst_http_request_duration_ms_sum{route="${route}"} ${histogram.totalMs}`);
    lines.push(`localfirst_http_request_duration_ms_count{route="${route}"} ${histogram.count}`);
    lines.push(`localfirst_http_request_duration_ms_max{route="${route}"} ${histogram.maxMs}`);
  }
  lines.push('# TYPE localfirst_events_total counter');
  for (const [name, value] of counters) {
    lines.push(`localfirst_events_total{event="${name}"} ${value}`);
  }
  for (const [name, value] of Object.entries(extra)) {
    lines.push(`localfirst_${name} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics(): void {
  requestCounts.clear();
  requestLatency.clear();
  counters.clear();
}
