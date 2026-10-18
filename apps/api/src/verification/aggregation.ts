import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { config } from '../config.js';
import { closeDatabase, getPool } from '../db/client.js';
import { createWorkerCycle } from '../jobs/worker.js';
import { renderMetrics, resetMetrics } from '../observability/metrics.js';
import { reaggregateProject } from '../services/evidence.js';
import { reviewReport } from '../services/reports.js';
import { ensureTestDefinitions } from '../services/test-definitions.js';
import { exactEnvironment, seedEvidenceFixture } from './evidence-fixture.js';
import { seedLoadFixture } from './fixture.js';
import { isolatedDatabases, startServer } from './harness.js';

const projects = Number(process.env.LOAD_PROJECTS ?? 10_000);
const coldVersions = Number(process.env.AGG_COLD_VERSIONS ?? 200);
const hotReports = Number(process.env.AGG_HOT_REPORTS ?? 2_000);
const workers = Number(process.env.AGG_WORKERS ?? 2);
const concurrency = 20;
const MIN_SCANNED_TABLE_BYTES = 2 * 1024 * 1024;

const p95 = (samples: number[]) => { const s = [...samples].sort((a, b) => a - b); return Number((s[Math.ceil(s.length * 0.95) - 1] ?? 0).toFixed(2)); };
async function pooled<T>(items: T[], width: number, run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; await run(items[i]!, i); } }));
}

const resources = await isolatedDatabases();
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let stopWorkers = () => {};
try {
  await seedLoadFixture(projects);
  server = await startServer();
  const baseUrl = server.baseUrl;
  const evidence = await seedEvidenceFixture({ baseUrl, projects: 1_000, reportsPerProject: 10, submissions: 0 });
  // Count only what the scenarios below do.
  await getPool().query('select pg_stat_reset()');
  const report: Record<string, unknown> = {};
  let passed = true;

  // A. Lazy test-definition creation: many readers race on versions that have none yet.
  const cold = (await getPool().query<{ project_id: string; version_id: string }>(
    `select p.id as project_id, v.id as version_id from projects p join project_versions v on v.id = p.current_version_id
      where exists (select 1 from project_version_tests t where t.project_version_id = v.id)
        and not exists (select 1 from test_definitions d where d.project_version_id = v.id)
      order by p.id limit $1`, [coldVersions + 100])).rows;
  assert.ok(cold.length >= coldVersions + 100, `only ${cold.length} versions lack definitions`);
  const httpCold = cold.slice(0, coldVersions);
  const serviceCold = cold.slice(coldVersions);
  const latencies: number[] = [];
  const failures: string[] = [];
  // Ten identical first reads per version, two versions at a time: every request races its siblings.
  await pooled(Array.from({ length: httpCold.length / 2 }, (_, i) => httpCold.slice(i * 2, i * 2 + 2)), 1, async (pair) => {
    await Promise.all(pair.flatMap((v) => Array.from({ length: 10 }, async () => {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/api/v1/projects/${v.project_id}/tests`);
      latencies.push(performance.now() - start);
      const body = await response.json() as { data?: { items?: Array<{ runner_available?: boolean }> } };
      if (response.status !== 200 || !body.data?.items?.length || body.data.items.some((t) => t.runner_available !== true)) {
        failures.push(`HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
      }
    })));
  });
  // Twenty concurrent bulk calls over the same hundred versions, in process.
  const serviceErrors = (await Promise.allSettled(Array.from({ length: concurrency }, () => ensureTestDefinitions(serviceCold.map((v) => v.version_id)))))
    .filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason).slice(0, 200));
  const integrity = (await getPool().query<{ incomplete: number; unflagged: number }>(
    `select count(*) filter (where d.n is distinct from t.n)::int as incomplete,
            count(*) filter (where t.unflagged > 0)::int as unflagged
       from (select project_version_id, count(*) as n, count(*) filter (where not runner_available) as unflagged
               from project_version_tests where project_version_id = any($1::uuid[]) group by 1) t
       left join (select project_version_id, count(*) as n from test_definitions group by 1) d using (project_version_id)`,
    [cold.map((v) => v.version_id)])).rows[0]!;
  const lazyOk = failures.length === 0 && serviceErrors.length === 0 && integrity.incomplete === 0 && integrity.unflagged === 0;
  passed &&= lazyOk;
  report.lazy_definitions = {
    versions: cold.length, http_requests: latencies.length, http_errors: failures.length, cold_read_p95_ms: p95(latencies),
    service_concurrent_calls: concurrency, service_errors: serviceErrors.length,
    versions_with_missing_or_extra_definitions: integrity.incomplete, versions_with_runner_flag_unset: integrity.unflagged,
    passed: lazyOk, ...(failures[0] || serviceErrors[0] ? { first_failure: failures[0] ?? serviceErrors[0] } : {}),
  };

  // B. A review burst on one project while independent workers drain the
  // queue, plus one review on a bystander project queued behind the burst.
  // Progress is observed only through the public route and the workers
  // themselves, so the sequential-scan audit below counts product queries.
  const hot = evidence.targets[0]!;
  const bystander = evidence.targets[1]!;
  const pending = await evidence.clone(Array.from({ length: hotReports }, () => ({ project: hot.projectId, version: hot.versionId, definition: hot.definitionId })), 'pending');
  const [bystanderReport] = await evidence.clone([{ project: bystander.projectId, version: bystander.versionId, definition: bystander.definitionId }], 'pending');
  await getPool().query('analyze run_reports, build_configurations');
  resetMetrics();
  const counter = (name: string) => Number(new RegExp(`event="${name.replaceAll('.', '\\.')}"} (\\d+)`).exec(renderMetrics())?.[1] ?? 0);
  const publicReports = async (projectId: string) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/${projectId}/compatibility-reports`);
    const body = await response.json() as { data: { summaries: Array<{ counts: { reports: number } }> } };
    return body.data.summaries.reduce((n, s) => n + s.counts.reports, 0);
  };
  let running = true;
  const idle = Array.from({ length: workers }, () => false);
  const workerLoops = Array.from({ length: workers }, async (_, i) => {
    const cycle = createWorkerCycle(`verify-worker-${i}`);
    while (running) {
      idle[i] = (await cycle()) === 0;
      if (idle[i]) await sleep(config().worker.pollIntervalMs);
    }
  });
  stopWorkers = () => { running = false; };
  const reviewLatency: number[] = [];
  const reviewErrors: string[] = [];
  const review = async (reportId: string, accept: boolean) => {
    const start = performance.now();
    try {
      await reviewReport({ actor: evidence.operator.actor, reportId, decision: accept ? 'accepted' : 'rejected', reasonCode: accept ? 'accepted_as_reported' : 'rejected_unverifiable', note: null });
    } catch (error) { reviewErrors.push(String(error).slice(0, 200)); }
    reviewLatency.push(performance.now() - start);
  };
  const burstStart = performance.now();
  await pooled(pending, concurrency, (reportId, i) => review(reportId, i % 10 !== 0));
  const reviewsDone = performance.now();
  await review(bystanderReport!, true);
  const bystanderReviewed = performance.now();
  const expectedReports = 10 + pending.filter((_, i) => i % 10 !== 0).length;
  const deadline = reviewsDone + 10 * 60_000;
  let hotProjected = 0;
  let bystanderProjected = 0;
  for (;;) {
    if (!hotProjected && (await publicReports(hot.projectId)) === expectedReports) hotProjected = performance.now();
    if (!bystanderProjected && (await publicReports(bystander.projectId)) === 11) bystanderProjected = performance.now();
    if (hotProjected && bystanderProjected && idle.every(Boolean)) break;
    if (performance.now() > deadline) break;
    await sleep(100);
  }
  const drained = performance.now();
  running = false;
  await Promise.all(workerLoops);

  const snapshot = async () => (await getPool().query(
    `select project_version_id, configuration_key, subject_fingerprint, test_definition_id, scope, evidence_level, counts,
            distinct_contributors, conflict, evidence_ids, latest_report_at
       from compatibility_summaries where project_id = $1 order by 1, 2, 3, 4`, [hot.projectId])).rows;
  const fromQueue = await snapshot();
  const rebuildStart = performance.now();
  const rebuilt = await reaggregateProject(hot.projectId);
  const rebuildMs = performance.now() - rebuildStart;
  const fromScratch = await snapshot();
  let summariesMatch = true;
  try { assert.deepEqual(fromQueue, fromScratch); } catch { summariesMatch = false; }
  const jobs = {
    rebuilt: counter('evidence.reaggregated'), skipped_as_covered: counter('evidence.reaggregate_skipped'),
    succeeded: counter('job.evidence_reaggregate.succeeded'), retrying: counter('job.evidence_reaggregate.retrying'), failed: counter('job.evidence_reaggregate.failed'),
  };
  const lagMs = hotProjected ? hotProjected - reviewsDone : null;
  const bystanderLagMs = bystanderProjected ? bystanderProjected - bystanderReviewed : null;
  const aggregationOk = reviewErrors.length === 0 && jobs.failed === 0 && jobs.retrying === 0 && summariesMatch && rebuilt.reports === expectedReports
    && jobs.succeeded === pending.length + 1 && lagMs !== null && lagMs < 60_000 && bystanderLagMs !== null && bystanderLagMs < 60_000;
  passed &&= aggregationOk;
  report.aggregation_burst = {
    hot_project_reports_before: 10, reviews: pending.length, accepted: expectedReports - 10, workers, worker_concurrency: config().worker.concurrency,
    review_p95_ms: p95(reviewLatency), review_errors: reviewErrors.length, reviews_wall_ms: Math.round(reviewsDone - burstStart),
    hot_projection_lag_ms: lagMs === null ? null : Math.round(lagMs), bystander_projection_lag_ms: bystanderLagMs === null ? null : Math.round(bystanderLagMs),
    projection_target_ms: 60_000, queue_drained_after_reviews_ms: Math.round(drained - reviewsDone),
    reaggregate_jobs: jobs, summaries_from_queue_equal_full_rebuild: summariesMatch, summary_reports: rebuilt.reports, expected_reports: expectedReports,
    full_rebuild_ms_at_hot_size: Math.round(rebuildMs), passed: aggregationOk, ...(reviewErrors[0] ? { first_failure: reviewErrors[0] } : {}),
  };

  // C. Read the P1 routes against the hot and ordinary projects, then audit sequential scans.
  for (const target of [hot, ...evidence.targets.slice(1, 50)]) {
    await fetch(`${baseUrl}/api/v1/projects/${target.projectId}/compatibility-checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactEnvironment()) });
    await fetch(`${baseUrl}/api/v1/projects/${target.projectId}/compatibility-reports`);
    await fetch(`${baseUrl}/api/v1/projects/${target.projectId}/test-results?limit=20`);
    await fetch(`${baseUrl}/api/v1/test-definitions/${target.definitionId}/plan`);
  }
  const url = config().database.url;
  await server.close();
  server = undefined;
  await closeDatabase(); // backends flush their table statistics on exit
  await sleep(1_000);
  const stats = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await stats.query<{ table: string; seq_scan: number; seq_tup_read: number; idx_scan: number; rows: number; bytes: number }>(
      `select s.relname as table, s.seq_scan::int, s.seq_tup_read::float8 as seq_tup_read, coalesce(s.idx_scan, 0)::int as idx_scan,
              greatest(c.reltuples, 0)::int as rows, pg_relation_size(c.oid)::float8 as bytes
         from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.seq_scan > 0 order by s.seq_tup_read desc`);
    // A hot unindexed path: a sizeable table scanned repeatedly, reading many rows each time.
    // One-off scans (this script's own setup and integrity queries) are not hot paths. Size is in
    // bytes as well as rows: for a table of a few hundred kilobytes the planner legitimately prefers
    // one sequential pass to many index probes (a 100-version bulk lookup of the 520 kB
    // project_version_tests table does), and which plan it picks varies with statistics timing.
    const suspects = rows.filter((r) => r.seq_scan >= 10 && r.rows >= 1_000 && r.bytes >= MIN_SCANNED_TABLE_BYTES && r.seq_tup_read / r.seq_scan >= 1_000);
    passed &&= suspects.length === 0;
    report.sequential_scans = { rule: `seq_scan >= 10 on a table of >= 1,000 rows and >= ${MIN_SCANNED_TABLE_BYTES / 1024 / 1024} MiB reading >= 1,000 rows per scan`, suspects, all: rows };
  } finally { await stats.end(); }

  console.log(JSON.stringify({ verification: 'p1-aggregation-and-lazy-definitions', projects, evidence: evidence.shape, ...report, passed }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  stopWorkers();
  if (server) await server.close();
  await resources.cleanup();
}
