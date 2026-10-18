import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getPool } from '../db/client.js';
import { exactEnvironment, seedEvidenceFixture } from './evidence-fixture.js';
import { seedLoadFixture } from './fixture.js';
import { isolatedDatabases, jsonRequest, startServer, useDatabase } from './harness.js';

const exec = promisify(execFile);
const resources = await isolatedDatabases(2);
const directory = await mkdtemp(join(tmpdir(), 'localfirst-restore-'));
let server: Awaited<ReturnType<typeof startServer>> | undefined;
const P1_TABLES = ['test_definitions', 'build_configurations', 'run_reports', 'evidence_reviews', 'compatibility_summaries'];

async function fingerprints() {
  const tables = await getPool().query<{ table_schema: string; table_name: string }>(
    "select table_schema, table_name from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE' order by table_schema, table_name");
  const results = [];
  for (const table of tables.rows) {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const result = await getPool().query(`select count(*)::int as count, md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' order by row_to_json(t)::text), '')) as digest from ${quote(table.table_schema)}.${quote(table.table_name)} t`);
    results.push({ table: `${table.table_schema}.${table.table_name}`, ...result.rows[0] });
  }
  return results;
}

/** Every constraint and index definition, so a restore that drops or weakens one is caught. */
async function schemaObjects() {
  const constraints = await getPool().query<{ table: string; name: string; definition: string }>(
    `select conrelid::regclass::text as table, conname as name, pg_get_constraintdef(oid) as definition
       from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`);
  const indexes = await getPool().query<{ table: string; name: string; definition: string }>(
    "select tablename as table, indexname as name, indexdef as definition from pg_indexes where schemaname = 'public' order by 1, 2");
  return { constraints: constraints.rows, indexes: indexes.rows };
}

/** P1 public answers that depend on the evidence tables, keyed by request. */
async function evidenceAnswers(baseUrl: string, targets: Array<{ projectId: string; definitionId: string }>) {
  // The restored server listens on another port; everything else must match exactly.
  const strip = (body: { data: unknown }) => JSON.parse(JSON.stringify(body.data).replaceAll(baseUrl, '{api}'));
  const answers: Record<string, unknown> = {};
  for (const target of targets) {
    answers[`reports:${target.projectId}`] = strip(await jsonRequest(baseUrl, `/api/v1/projects/${target.projectId}/compatibility-reports`));
    answers[`results:${target.projectId}`] = strip(await jsonRequest(baseUrl, `/api/v1/projects/${target.projectId}/test-results?limit=20`));
    answers[`definition:${target.definitionId}`] = strip(await jsonRequest(baseUrl, `/api/v1/test-definitions/${target.definitionId}`));
    const check = await fetch(`${baseUrl}/api/v1/projects/${target.projectId}/compatibility-checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactEnvironment()) });
    assert.equal(check.status, 200);
    answers[`check:${target.projectId}`] = strip(await check.json() as { data: unknown });
    // Equal answers only mean something if they carry the evidence.
    const reports = answers[`reports:${target.projectId}`] as { summaries: unknown[] };
    const results = answers[`results:${target.projectId}`] as { items: unknown[] };
    const matched = answers[`check:${target.projectId}`] as { evidence_ids: unknown[] };
    assert.ok(reports.summaries.length > 0 && results.items.length > 0 && matched.evidence_ids.length > 0, `no evidence in the answers for ${target.projectId}`);
  }
  return answers;
}

/**
 * Writes the evidence policy forbids. Each runs in a savepoint on the restored
 * database and must be refused by the named constraint, proving the
 * constraints are enforced, not merely present.
 */
async function constraintProbes(ids: { pending: string; accepted: string; otherUser: string; summary: string; definition: string }) {
  const probes: Array<{ name: string; constraint: string; sql: string; params: unknown[] }> = [
    { name: 'evidence level without acceptance', constraint: 'run_reports_evidence_requires_acceptance_check',
      sql: "update run_reports set evidence_level = 'reproducible_test' where id = $1", params: [ids.pending] },
    { name: 'evidence level outside policy', constraint: 'run_reports_evidence_level_check',
      sql: "update run_reports set evidence_level = 'independently_verified' where id = $1", params: [ids.accepted] },
    { name: 'manual report above community_reported', constraint: 'run_reports_manual_cap_check',
      sql: "update run_reports set kind = 'manual_build', test_definition_id = null where id = $1", params: [ids.accepted] },
    { name: 'test run without its definition', constraint: 'run_reports_definition_discriminator_check',
      sql: 'update run_reports set test_definition_id = null where id = $1', params: [ids.accepted] },
    { name: "report on another user's build", constraint: 'run_reports_build_owned_fk',
      sql: 'update run_reports set submitter_user_id = $2 where id = $1', params: [ids.accepted, ids.otherUser] },
    { name: 'duplicate accepted-evidence summary', constraint: 'compatibility_summaries_test_uidx',
      sql: `insert into compatibility_summaries (project_id, project_version_id, configuration_key, subject_fingerprint, subject, test_definition_id, scope, evidence_level, counts, distinct_contributors, conflict, evidence_ids, latest_report_at)
            select project_id, project_version_id, configuration_key, subject_fingerprint, subject, test_definition_id, scope, evidence_level, counts, distinct_contributors, conflict, evidence_ids, latest_report_at
              from compatibility_summaries where id = $1`, params: [ids.summary] },
    { name: 'non-executable definition without a refusal reason', constraint: 'test_definitions_executable_refusal_check',
      sql: "update test_definitions set executable = false, refusal_codes = '[]'::jsonb where id = $1", params: [ids.definition] },
  ];
  const client = await getPool().connect();
  const results = [];
  try {
    await client.query('begin');
    for (const probe of probes) {
      await client.query('savepoint probe');
      let refusedBy: string | null = null;
      try { await client.query(probe.sql, probe.params); } catch (error) { refusedBy = (error as { constraint?: string }).constraint ?? String(error); }
      await client.query('rollback to savepoint probe');
      results.push({ probe: probe.name, expected: probe.constraint, refused_by: refusedBy, passed: refusedBy === probe.constraint });
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
  return results;
}

try {
  const published = await seedLoadFixture(10_000);
  // P1 evidence: accepted reports with reviews and summaries, private builds,
  // and pending public reports, so every evidence table holds real shapes.
  server = await startServer();
  const evidence = await seedEvidenceFixture({ baseUrl: server.baseUrl, projects: 200, reportsPerProject: 10, submissions: 20 });
  const pending = await evidence.clone(evidence.targets.slice(0, 20).map((t) => ({ project: t.projectId, version: t.versionId, definition: t.definitionId })), 'pending');
  const probed = evidence.targets.slice(0, 20);
  const answersBefore = await evidenceAnswers(server.baseUrl, probed);
  await server.close();
  server = undefined;

  const before = await fingerprints();
  const schemaBefore = await schemaObjects();
  const p1Rows = Object.fromEntries(P1_TABLES.map((name) => [name, before.find((t) => t.table === `public.${name}`)?.count as number]));
  assert.ok(P1_TABLES.every((name) => p1Rows[name]! > 0), `an evidence table is empty before the backup: ${JSON.stringify(p1Rows)}`);

  const file = join(directory, 'registry.dump');
  // Credentials travel through the child environment, not process arguments or logs.
  const childEnv = (raw: string) => {
    const url = new URL(raw);
    return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username) || process.env.USER,
      PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) };
  };
  await exec('pg_dump', ['--format=custom', '--file', file], { env: childEnv(resources.urls[0]!) });
  const start = performance.now();
  await exec('pg_restore', ['--dbname', new URL(resources.urls[1]!).pathname.slice(1), '--no-owner', '--no-acl', '--exit-on-error', file], { env: childEnv(resources.urls[1]!) });
  await useDatabase(resources.urls[1]!);
  assert.deepEqual(await fingerprints(), before, 'Restored table content differs from the backup');
  const schemaAfter = await schemaObjects();
  assert.deepEqual(schemaAfter, schemaBefore, 'Restored constraints or indexes differ from the backup');

  const [accepted] = (await getPool().query<{ id: string }>(
    "select id from run_reports where review_state = 'accepted' and evidence_level = 'reproducible_test' and project_id = $1 limit 1", [probed[0]!.projectId])).rows;
  const [otherUser] = (await getPool().query<{ owner_user_id: string }>(
    'select owner_user_id from build_configurations where project_id = $1 and owner_user_id <> (select submitter_user_id from run_reports where id = $2) limit 1', [probed[0]!.projectId, accepted!.id])).rows;
  const [summary] = (await getPool().query<{ id: string }>('select id from compatibility_summaries where project_id = $1 and test_definition_id is not null limit 1', [probed[0]!.projectId])).rows;
  const probes = await constraintProbes({ pending: pending[0]!, accepted: accepted!.id, otherUser: otherUser!.owner_user_id, summary: summary!.id, definition: probed[0]!.definitionId });

  server = await startServer();
  await jsonRequest(server.baseUrl, '/health/ready');
  const listing = await jsonRequest(server.baseUrl, '/api/v1/projects?limit=100');
  assert.ok((listing.data.items as unknown[]).length > 0);
  for (const project of published) {
    const resolved = await jsonRequest(server.baseUrl, `/api/v1/projects/by-slug/${project.slug}`);
    assert.equal(resolved.data.project_id, project.project_id);
    const version = await jsonRequest(server.baseUrl, `/api/v1/projects/${project.project_id}/versions`);
    assert.ok((version.data.items as Array<{ content_digest: string }>).some((v) => v.content_digest));
  }
  const answersAfter = await evidenceAnswers(server.baseUrl, probed);
  const answersEqual = JSON.stringify(answersAfter) === JSON.stringify(answersBefore);
  const elapsed = performance.now() - start;
  const passed = elapsed <= 4 * 60 * 60 * 1000 && answersEqual && probes.every((p) => p.passed);
  console.log(JSON.stringify({ verification: 'p0-p1-restore', projects: 10_000, tables_verified: before.length,
    p1_table_rows: p1Rows,
    all_table_counts_and_content_fingerprints_equal: true,
    constraints_and_indexes_equal: { constraints: schemaAfter.constraints.length, indexes: schemaAfter.indexes.length },
    evidence_constraint_probes: probes,
    p1_answers_equal: { requests: Object.keys(answersBefore).length, equal: answersEqual },
    readiness_and_catalog: 'passed',
    restore_and_verification_ms: Math.round(elapsed), passed,
    limitation: 'Local logical backup drill; does not establish production PITR/RPO or deployed recovery time.' }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (server) await server.close();
  await resources.cleanup();
  await rm(directory, { recursive: true, force: true });
}
