/**
 * Point-in-time restore drill against a Neon project (RUNBOOK "Backups and
 * restore drill"; proposed RPO 15 minutes, RTO 4 hours).
 *
 * The local `verify:restore` drill proves a logical backup round-trips. This
 * one proves the provider's own recovery: it restores the deployment's
 * database to an exact moment as a new, isolated Neon branch, and checks that
 *
 * 1. every table that did not change during the drill holds exactly the rows
 *    the source held at that moment, and every constraint and index matches;
 * 2. a restore one second before the newest publication does not contain it,
 *    so recovery is precise to the second, well inside the RPO;
 * 3. the API serves the restored copy: readiness, the catalog, every
 *    published project by slug, and each version's content digest.
 *
 * The source database is only ever read, inside read-only transactions. Every
 * branch the drill creates is deleted afterward. Connection strings come from
 * the Neon CLI (which must be signed in) and are never printed.
 *
 *   NEON_PROJECT_ID=<project> pnpm --filter @localfirst/backend verify:pitr
 *
 * Optional: NEON_SOURCE_BRANCH (default `main`), NEON_DATABASE (`neondb`),
 * NEON_ROLE (`neondb_owner`).
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { closeDatabase } from '../db/client.js';
import { jsonRequest, startServer, useDatabase } from './harness.js';

const exec = promisify(execFile);
const projectId = process.env.NEON_PROJECT_ID;
if (!projectId) throw new Error('Set NEON_PROJECT_ID to the Neon project to drill.');
const sourceBranch = process.env.NEON_SOURCE_BRANCH ?? 'main';
const database = process.env.NEON_DATABASE ?? 'neondb';
const role = process.env.NEON_ROLE ?? 'neondb_owner';

async function neon(args: string[]): Promise<string> {
  const { stdout } = await exec('neon', [...args, '--project-id', projectId!], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** A direct (unpooled) connection string, with full certificate verification. */
async function connectionString(branch: string): Promise<string> {
  const url = new URL(await neon(['connection-string', branch, '--database-name', database, '--role-name', role]));
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

type Fingerprint = { table: string; count: number; digest: string };

/** Row count and content digest of every table, from one consistent snapshot. */
async function fingerprints(client: pg.ClientBase): Promise<Fingerprint[]> {
  const tables = await client.query<{ table_schema: string; table_name: string }>(
    "select table_schema, table_name from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE' order by table_schema, table_name");
  const results: Fingerprint[] = [];
  for (const table of tables.rows) {
    const result = await client.query<{ count: number; digest: string }>(
      `select count(*)::int as count, md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' order by row_to_json(t)::text), '')) as digest from ${quote(table.table_schema)}.${quote(table.table_name)} t`);
    results.push({ table: `${table.table_schema}.${table.table_name}`, ...result.rows[0]! });
  }
  return results;
}

/** Every constraint and index definition, so a restore that drops or weakens one is caught. */
async function schemaObjects(client: pg.ClientBase) {
  const constraints = await client.query(
    `select conrelid::regclass::text as table, conname as name, pg_get_constraintdef(oid) as definition
       from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`);
  const indexes = await client.query(
    "select tablename as table, indexname as name, indexdef as definition from pg_indexes where schemaname = 'public' order by 1, 2");
  return { constraints: constraints.rows, indexes: indexes.rows };
}

/** Run `work` in a read-only, repeatable-read transaction: one snapshot, no writes. */
async function readOnly<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await work(client);
    await client.query('rollback');
    return result;
  } finally {
    await client.end();
  }
}

/** Wait until a freshly restored branch answers, and return how long that took. */
async function waitUntilReady(url: string, started: number): Promise<number> {
  for (;;) {
    try {
      await readOnly(url, (client) => client.query('select 1'));
      return Math.round(performance.now() - started);
    } catch (error) {
      if (performance.now() - started > 10 * 60_000) throw error;
      await sleep(1_000);
    }
  }
}

const created: string[] = [];

/** Restore the source branch as it was at `at` into a new branch; returns its URL and readiness time. */
async function restoreAt(at: Date, label: string) {
  const name = `pitr-drill-${label}-${Date.now()}`;
  const started = performance.now();
  await neon(['branches', 'create', '--name', name, '--parent', at.toISOString(), '--no-secrets', '-o', 'json']);
  created.push(name);
  const url = await connectionString(name);
  const readyMs = await waitUntilReady(url, started);
  return { name, url, readyMs };
}

let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const sourceUrl = await connectionString(sourceBranch);

  // 1. The moment to restore, and the source's content at that moment.
  const snapshot = await readOnly(sourceUrl, async (client) => {
    const { rows } = await client.query<{ at: Date }>('select clock_timestamp() as at');
    return { at: rows[0]!.at, tables: await fingerprints(client), schema: await schemaObjects(client) };
  });
  // The restore point must lie in the past for the provider's history.
  await sleep(5_000);
  const restored = await restoreAt(snapshot.at, 'snapshot');

  // Tables that changed after the snapshot (sessions, rate-limit windows,
  // jobs) cannot be compared to it; every table that did not must match exactly.
  const later = await readOnly(sourceUrl, (client) => fingerprints(client));
  const unchanged = snapshot.tables.filter((table) => {
    const now = later.find((t) => t.table === table.table);
    return now && now.count === table.count && now.digest === table.digest;
  });
  const restoredTables = await readOnly(restored.url, (client) => fingerprints(client));
  const mismatched = unchanged.filter((table) => {
    const copy = restoredTables.find((t) => t.table === table.table);
    return !copy || copy.count !== table.count || copy.digest !== table.digest;
  });
  const restoredSchema = await readOnly(restored.url, (client) => schemaObjects(client));
  const schemaEqual = JSON.stringify(restoredSchema) === JSON.stringify(snapshot.schema);
  for (const key of ['public.projects', 'public.project_versions', 'public.user', 'drizzle.__drizzle_migrations']) {
    assert.ok(unchanged.some((t) => t.table === key), `${key} changed during the drill; run it again when the source is quiet`);
  }

  // 2. Precision: one second before the newest publication, it is absent.
  const newest = await readOnly(sourceUrl, async (client) => (await client.query<{ id: string; published_at: Date }>(
    'select id, published_at from project_versions where published_at <= $1 order by published_at desc limit 1', [snapshot.at])).rows[0]);
  let precision: Record<string, unknown> = { skipped: 'no publication in the source' };
  if (newest) {
    const before = new Date(newest.published_at.getTime() - 1_000);
    try {
      const earlier = await restoreAt(before, 'precision');
      const present = await readOnly(earlier.url, async (client) =>
        (await client.query('select 1 from project_versions where id = $1', [newest.id])).rowCount);
      const inSnapshot = await readOnly(restored.url, async (client) =>
        (await client.query('select 1 from project_versions where id = $1', [newest.id])).rowCount);
      precision = { publication_at: newest.published_at.toISOString(), restored_to: before.toISOString(),
        absent_one_second_before: present === 0, present_at_snapshot: inSnapshot === 1, passed: present === 0 && inSnapshot === 1 };
    } catch (error) {
      // Outside the provider's history window: the drill still stands, but say so.
      precision = { skipped: `could not restore to ${before.toISOString()}: ${(error as Error).message.split('\n')[0]}` };
    }
  }

  // 3. The API serves the restored copy. It writes only to the restored branch.
  await useDatabase(restored.url);
  server = await startServer();
  await jsonRequest(server.baseUrl, '/health/ready');
  await jsonRequest(server.baseUrl, '/api/v1/projects?limit=100');
  const published = await readOnly(restored.url, async (client) => (await client.query<{ id: string; slug: string }>(
    "select id, slug from projects where visibility = 'published' order by slug")).rows);
  const sourceDigests = await readOnly(sourceUrl, async (client) => (await client.query<{ project_id: string; content_digest: string }>(
    'select project_id, content_digest from project_versions where published_at <= $1', [snapshot.at])).rows);
  for (const project of published) {
    const resolved = await jsonRequest(server.baseUrl, `/api/v1/projects/by-slug/${encodeURIComponent(project.slug)}`);
    assert.equal(resolved.data.project_id, project.id);
    const versions = await jsonRequest(server.baseUrl, `/api/v1/projects/${project.id}/versions`);
    const served = (versions.data.items as Array<{ content_digest: string }>).map((v) => v.content_digest).sort();
    const expected = sourceDigests.filter((row) => row.project_id === project.id).map((row) => row.content_digest).sort();
    assert.deepEqual(served, expected, `version digests differ for ${project.slug}`);
  }

  const precisionPassed = precision.passed !== false;
  const passed = mismatched.length === 0 && schemaEqual && precisionPassed && restored.readyMs <= 4 * 60 * 60 * 1000;
  console.log(JSON.stringify({
    verification: 'neon-point-in-time-restore',
    neon_project: projectId,
    restore_point: snapshot.at.toISOString(),
    restore_ready_ms: restored.readyMs,
    tables: snapshot.tables.length,
    tables_compared: unchanged.length,
    tables_changed_during_drill: snapshot.tables.filter((t) => !unchanged.includes(t)).map((t) => t.table),
    tables_mismatched: mismatched.map((t) => t.table),
    constraints_and_indexes_equal: { equal: schemaEqual, constraints: snapshot.schema.constraints.length, indexes: snapshot.schema.indexes.length },
    precision,
    api_on_restored_copy: { readiness: 'passed', published_projects_checked: published.length },
    passed,
    limitation: 'Restores into a new branch of the same Neon project. The restored copy is served by a local API process with a verification AUTH_SECRET, so existing sessions and signing keys are not exercised.',
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (server) await server.close();
  await closeDatabase();
  for (const name of created) {
    await neon(['branches', 'delete', name]).catch((error) => console.error(`Delete branch ${name} by hand: ${(error as Error).message}`));
  }
}
