import { performance } from 'node:perf_hooks';
import { isolatedDatabases, startServer } from './harness.js';
import { seedLoadFixture } from './fixture.js';
import { drainWorker, exactEnvironment, seedEvidenceFixture, type Submission } from './evidence-fixture.js';
import { getPool } from '../db/client.js';

const projects = Number(process.env.LOAD_PROJECTS ?? 10_000);
const evidenceProjects = Number(process.env.LOAD_EVIDENCE_PROJECTS ?? 1_000);
const reportsPerProject = Number(process.env.LOAD_REPORTS_PER_PROJECT ?? 10);
const concurrency = 20;
const perRoute = 400;

interface Call { path: string; init?: RequestInit; check: (status: number, body: any) => boolean }
interface Route { target_ms: number; call: (i: number) => Call }

async function measure(baseUrl: string, name: string, route: Route) {
  const samples: number[] = [];
  const failures: string[] = [];
  const run = async (i: number, measured: boolean) => {
    const call = route.call(i);
    const start = performance.now();
    try {
      const response = await fetch(`${baseUrl}${call.path}`, { ...call.init, signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      if (!call.check(response.status, body)) failures.push(`${name}: HTTP ${response.status} or unexpected body ${JSON.stringify(body)?.slice(0, 160)}`);
    } catch { failures.push(`${name}: request failed or timed out`); }
    finally { if (measured) samples.push(performance.now() - start); }
  };
  // Warm-up uses indices beyond the measured range so single-use requests are not consumed twice.
  await Promise.all(Array.from({ length: concurrency }, (_, i) => run(perRoute + i, false)));
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < perRoute) await run(next++, true); }));
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
  const ok = failures.length === 0 && p95 < route.target_ms;
  return { requests: samples.length, errors: failures.length, p50_ms: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)), p95_ms: Number(p95.toFixed(2)), max_ms: Number(samples.at(-1)!.toFixed(2)), target_ms: route.target_ms, passed: ok, ...(failures.length ? { first_failure: failures[0] } : {}) };
}

const resources = await isolatedDatabases();
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  await seedLoadFixture(projects);
  const { rows } = await getPool().query<{ id: string }>('select id from projects order by slug');
  if (rows.length !== projects) throw new Error('Wrong fixture project count');
  server = await startServer();
  const baseUrl = server.baseUrl;

  const p0: Record<string, Route> = {
    list: { target_ms: 500, call: () => ({ path: '/api/v1/projects?limit=20', check: (s, b) => s === 200 && b?.data?.items?.length > 0 }) },
    search: { target_ms: 500, call: () => ({ path: '/api/v1/projects?q=local&limit=20', check: (s, b) => s === 200 && b?.data?.items?.length > 0 }) },
    filtered_search: { target_ms: 500, call: () => ({ path: '/api/v1/projects?runtime=ollama&limit=20', check: (s, b) => s === 200 && b?.data?.items?.length > 0 }) },
    detail: { target_ms: 500, call: (i) => ({ path: `/api/v1/projects/${rows[(i * 137) % rows.length]!.id}`, check: (s, b) => s === 200 && !!b?.data?.project_id }) },
  };
  const results: Record<string, Record<string, unknown>> = { p0: {}, p1: {} };
  let passed = true;
  for (const [name, route] of Object.entries(p0)) {
    const result = await measure(baseUrl, name, route);
    passed &&= result.passed;
    results.p0![name] = result;
  }

  const evidence = await seedEvidenceFixture({ baseUrl, projects: evidenceProjects, reportsPerProject, submissions: perRoute + concurrency });
  const target = (i: number) => evidence.targets[(i * 7) % evidence.targets.length]!;
  const submit = (list: Submission[]) => (i: number): Call => {
    const s = list[i]!;
    return { path: '/api/v1/test-results', init: { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', 'idempotency-key': s.key }, body: JSON.stringify(s.body) }, check: (status, b) => status === 202 && !!b?.data?.report_id };
  };
  const p1: Record<string, Route> = {
    // Compatibility target is "bounded candidate set p95 < 1 s"; evidence matching must really find the accepted reports.
    compatibility_check_with_evidence: { target_ms: 1000, call: (i) => ({
      path: `/api/v1/projects/${target(i).projectId}/compatibility-checks`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactEnvironment()) },
      check: (s, b) => s === 200 && b?.data?.evidence_ids?.length > 0,
    }) },
    compatibility_reports: { target_ms: 500, call: (i) => ({ path: `/api/v1/projects/${target(i).projectId}/compatibility-reports`, check: (s, b) => s === 200 && !!b?.data }) },
    accepted_results: { target_ms: 500, call: (i) => ({ path: `/api/v1/projects/${target(i).projectId}/test-results?limit=20`, check: (s, b) => s === 200 && b?.data?.items?.length > 0 }) },
    test_definition: { target_ms: 500, call: (i) => ({ path: `/api/v1/test-definitions/${target(i).definitionId}`, check: (s, b) => s === 200 && !!b?.data }) },
    test_plan: { target_ms: 500, call: (i) => ({ path: `/api/v1/test-definitions/${target(i).definitionId}/plan`, check: (s, b) => s === 200 && !!b?.data }) },
    result_submission: { target_ms: 500, call: submit(evidence.submitters) },
  };
  for (const [name, route] of Object.entries(p1)) {
    const result = await measure(baseUrl, name, route);
    passed &&= result.passed;
    results.p1![name] = result;
  }
  // Replays use the exact bodies and keys already accepted above; they must answer from the idempotency record.
  const replay = await measure(baseUrl, 'result_submission_replay', { target_ms: 500, call: (i) => {
    const call = submit(evidence.submitters)(i);
    return { ...call, check: (status, b) => call.check(status, b) && b?.meta?.replayed === true };
  } });
  passed &&= replay.passed;
  results.p1!['result_submission_replay'] = replay;

  const backlog = (await getPool().query<{ state: string; n: number }>("select state, count(*)::int as n from jobs group by 1")).rows;
  const drain = await drainWorker();
  const after = (await getPool().query<{ kind: string; state: string; attempts: number; n: number; due_in_s: number }>(
    "select kind, state, max(attempts)::int as attempts, count(*)::int as n, round(extract(epoch from max(run_at) - now()))::int as due_in_s from jobs where state <> 'succeeded' group by 1, 2")).rows;
  const submitted = (await getPool().query<{ validation_state: string; n: number }>(
    "select validation_state, count(*)::int as n from run_reports where review_state = 'pending' group by 1")).rows;
  console.log(JSON.stringify({
    verification: 'p0-p1-load', projects, concurrency, requests_per_route: perRoute,
    fixture: 'synthetic copies of validated seed shapes and version relations; P1 evidence per `evidence_fixture.shape`',
    boundary: 'loopback HTTP, response parsing, real PostgreSQL and rate-limit accounting; elevated quotas; submissions use REST bearer tokens',
    evidence_fixture: { shape: evidence.shape, setup_ms: evidence.timings },
    results, queue: { jobs_before_drain: backlog, drain_after_submissions: drain, unfinished_jobs_after_drain: after, submitted_report_validation: submitted }, passed,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (server) await server.close();
  await resources.cleanup();
}
