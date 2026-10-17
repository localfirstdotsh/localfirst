/**
 * Latency of a deployed API over the network (BACKEND_PRD section 19.1).
 *
 * `verify:load` measures the backend at catalog scale on loopback. This
 * measures what a client of a deployment sees: TLS, the edge, the host, and
 * the pooled database connection, from wherever it runs. Requests are
 * sequential and paced under the public rate limits (section 19.2), so it is
 * safe against a shared environment. It sends only public, anonymous reads and
 * compatibility checks, and writes nothing except the API's own rate-limit
 * accounting.
 *
 *   API_URL=https://staging.example pnpm --filter @localfirst/backend verify:remote-latency
 *
 * `/health/live` does no work, so its median is the network round trip. Each
 * route's p95 minus that median estimates the time spent inside the backend
 * boundary, which is what the section 19.1 targets bound.
 */

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { exactEnvironment } from './evidence-fixture.js';

const base = (process.env.API_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) throw new Error('Set API_URL to the deployment origin, for example https://staging.example');
const samples = Number(process.env.LATENCY_SAMPLES ?? 40);

type Call = { path: string; init?: RequestInit; ok: (status: number, body: any) => boolean };
type Route = { target_ms: number | null; perMinute: number; call: (i: number) => Call };

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function timed(call: Call) {
  const started = performance.now();
  const response = await fetch(`${base}${call.path}`, { ...call.init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { ms: performance.now() - started, ok: call.ok(response.status, body), status: response.status };
}

/** Sequential samples, spaced to stay under `perMinute`. */
async function measure(route: Route) {
  const spacing = 60_000 / route.perMinute;
  const times: number[] = [];
  const failures: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const result = await timed(route.call(i));
    if (result.ok) times.push(result.ms); else failures.push(result.status);
    await sleep(Math.max(0, spacing - (performance.now() - started)));
  }
  times.sort((a, b) => a - b);
  return { times, failures };
}

const listing = await (await fetch(`${base}/api/v1/projects?limit=20`)).json() as { data: { items: Array<{ project_id: string; slug: string }> } };
const projects = listing.data.items;
if (projects.length === 0) throw new Error('The deployment has no published project to read.');
const project = (i: number) => projects[i % projects.length]!;

// Catalog routes share one 120/minute bucket and compatibility checks a
// 30/minute one; each route is paced well under its bucket on its own.
const routes: Record<string, Route> = {
  health_live: { target_ms: null, perMinute: 240, call: () => ({ path: '/health/live', ok: (s) => s === 200 }) },
  health_ready: { target_ms: null, perMinute: 120, call: () => ({ path: '/health/ready', ok: (s, b) => s === 200 && b?.status === 'ready' }) },
  list: { target_ms: 500, perMinute: 90, call: () => ({ path: '/api/v1/projects?limit=20', ok: (s, b) => s === 200 && b?.data?.items?.length > 0 }) },
  search: { target_ms: 500, perMinute: 90, call: (i) => ({ path: `/api/v1/projects?q=${encodeURIComponent(project(i).slug.split('-')[0]!)}&limit=20`, ok: (s, b) => s === 200 && Array.isArray(b?.data?.items) }) },
  detail: { target_ms: 500, perMinute: 90, call: (i) => ({ path: `/api/v1/projects/${project(i).project_id}`, ok: (s, b) => s === 200 && !!b?.data?.project_id }) },
  by_slug: { target_ms: 500, perMinute: 90, call: (i) => ({ path: `/api/v1/projects/by-slug/${encodeURIComponent(project(i).slug)}`, ok: (s, b) => s === 200 && !!b?.data?.project_id }) },
  compatibility_check: { target_ms: 1000, perMinute: 25, call: (i) => ({
    path: `/api/v1/projects/${project(i).project_id}/compatibility-checks`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactEnvironment()) },
    ok: (s, b) => s === 200 && !!b?.data,
  }) },
};

const first = await timed(routes.health_ready!.call(0));
const results: Record<string, unknown> = {};
let network = 0;
let passed = true;
for (const [name, route] of Object.entries(routes)) {
  const { times, failures } = await measure(route);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  if (name === 'health_live') network = p50;
  const backend = Math.max(0, p95 - network);
  const routePassed = failures.length === 0 && (route.target_ms === null || backend <= route.target_ms);
  passed &&= routePassed;
  results[name] = {
    samples: times.length, failures, p50_ms: Math.round(p50), p95_ms: Math.round(p95), max_ms: Math.round(times.at(-1)!),
    ...(route.target_ms === null ? {} : { p95_minus_network_ms: Math.round(backend), target_ms: route.target_ms }),
    passed: routePassed,
  };
}

console.log(JSON.stringify({
  verification: 'remote-latency',
  api: base,
  measured_at: new Date().toISOString(),
  projects_in_catalog: projects.length,
  first_request_ms: Math.round(first.ms),
  network_round_trip_p50_ms: Math.round(network),
  routes: results,
  passed,
  limitation: 'Sequential, paced requests from one client: this measures deployed per-request latency, not capacity. Catalog-scale query cost is covered by verify:load.',
}, null, 2));
if (!passed) process.exitCode = 1;
