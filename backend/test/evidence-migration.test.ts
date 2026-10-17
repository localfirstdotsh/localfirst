/**
 * Migration checks (BACKEND_PRD sections 16.4, 20.4): a fresh database applies
 * every migration and matches the Drizzle schema, and a database that already
 * holds P0 data upgrades to 0002 without losing it. Both run in uniquely named
 * throwaway databases on the test server, always dropped afterwards. Neither
 * touches the shared test database or any other database.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PROJECT_MD,
  EXAMPLE_TEST_PATH,
  EXAMPLE_TEST_YAML,
  digestOf,
  validateProjectBundle,
} from '@localfirst/contracts';
import * as schema from '../src/db/schema/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { ensureTestDefinitions } from '../src/services/test-definitions.js';
import type { DbOrTx } from '../src/db/client.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const BASE = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/localfirst_test');

function urlFor(database: string): string {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Create a uniquely named database, run `work`, and always drop it. */
async function withThrowawayDatabase<T>(work: (url: string, pool: Pool) => Promise<T>): Promise<T> {
  const name = `localfirst_migration_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
  await admin.query(`create database "${name}"`);
  const pool = new Pool({ connectionString: urlFor(name), max: 2 });
  try {
    return await work(urlFor(name), pool);
  } finally {
    await pool.end().catch(() => undefined);
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}

const EVIDENCE_TABLES = [
  'test_definitions',
  'build_configurations',
  'run_reports',
  'evidence_reviews',
  'compatibility_summaries',
];

describe('fresh database', () => {
  it('applies every migration and matches the Drizzle schema column for column', async () => {
    await withThrowawayDatabase(async (url, pool) => {
      await runMigrations(url);

      const applied = await pool.query('select count(*)::int as count from drizzle.__drizzle_migrations');
      const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
      expect(applied.rows[0].count).toBe(journal.entries.length);

      const tables = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));
      expect(tables.length).toBeGreaterThan(30);
      for (const table of tables) {
        const config = getTableConfig(table);
        const rows = await pool.query<{ column_name: string; is_nullable: string }>(
          `select column_name, is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = $1`,
          [config.name],
        );
        expect(rows.rows.length, `table ${config.name} is missing from the database`).toBeGreaterThan(0);
        const actual = new Map(rows.rows.map((row) => [row.column_name, row.is_nullable === 'NO']));
        for (const column of config.columns) {
          expect(actual.has(column.name), `${config.name}.${column.name} missing`).toBe(true);
          expect(actual.get(column.name), `${config.name}.${column.name} nullability`).toBe(
            column.notNull || column.primary,
          );
        }
        expect([...actual.keys()].sort(), `${config.name} has columns the schema does not`).toEqual(
          config.columns.map((column) => column.name).sort(),
        );
      }
      for (const name of EVIDENCE_TABLES) {
        expect(tables.some((table) => getTableConfig(table).name === name), name).toBe(true);
      }
    });
  });

  it('installs the evidence-policy constraints and composite ownership keys', async () => {
    await withThrowawayDatabase(async (url, pool) => {
      await runMigrations(url);
      const constraints = await pool.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid::regclass::text in
         ('run_reports','build_configurations','test_definitions','compatibility_summaries','evidence_reviews')`,
      );
      const names = new Set(constraints.rows.map((row) => row.conname));
      for (const expected of [
        'run_reports_build_owned_fk',
        'run_reports_test_definition_belongs_fk',
        'run_reports_version_belongs_fk',
        'run_reports_submitter_run_uq',
        'run_reports_manual_cap_check',
        'run_reports_evidence_requires_acceptance_check',
        'run_reports_definition_discriminator_check',
        'build_configurations_id_owner_version_uq',
        'test_definitions_id_version_uq',
        'compatibility_summaries_definition_belongs_fk',
      ]) {
        expect(names.has(expected), expected).toBe(true);
      }
    });
  });
});

describe('upgrade from the previous release', () => {
  async function previousReleaseFolder(): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'localfirst-migrations-'));
    await cp(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    // The P0 release: everything from 0002 (the evidence tables) on is new.
    journal.entries = journal.entries.filter((entry) => entry.tag.startsWith('0000_') || entry.tag.startsWith('0001_'));
    await writeFile(journalPath, JSON.stringify(journal, null, 2));
    return folder;
  }

  it('keeps P0 data intact, adds empty evidence tables, and backfills definitions lazily', async () => {
    const folder = await previousReleaseFolder();
    try {
      await withThrowawayDatabase(async (url, pool) => {
        // --- Release N-1: 0000 and 0001 only --------------------------------
        const old = drizzle(pool, { schema, casing: 'snake_case' });
        await migrate(old, { migrationsFolder: folder });
        expect(
          (await pool.query("select to_regclass('public.test_definitions') as t")).rows[0].t,
        ).toBeNull();

        const validated = validateProjectBundle({
          project_md: EXAMPLE_PROJECT_MD,
          files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }],
        });
        expect(validated.ok).toBe(true);
        const now = new Date();
        await old.insert(schema.userTable).values({
          id: 'user-upgrade', name: 'upgrader', email: 'upgrade@test.invalid', emailVerified: false, createdAt: now, updatedAt: now,
        });
        await old.insert(schema.userProfiles).values({ userId: 'user-upgrade', handle: 'upgrader', displayName: 'upgrader' });
        const [project] = await old
          .insert(schema.projects)
          .values({
            slug: 'upgraded', projectKey: 'request-labeler', managerUserId: 'user-upgrade', type: 'experiment',
            visibility: 'unpublished', listingOrigin: 'creator_submitted',
          })
          .returning();
        const [version] = await old
          .insert(schema.projectVersions)
          .values({
            projectId: project!.id, versionNumber: 1, specVersion: '0.1.0', schemaId: 'localfirst/project/v0.2',
            manifest: validated.manifest, markdown: validated.markdown, contentDigest: validated.content_digest!,
            payloadDigest: validated.payload_digest, derived: validated.derived, publishedByUserId: 'user-upgrade',
          })
          .returning();
        await old.update(schema.projects).set({ currentVersionId: version!.id, visibility: 'published' }).where(sql`id = ${project!.id}`);
        // The version predates test definitions: only the P0 declaration rows exist.
        await old.insert(schema.projectVersionFiles).values({
          projectVersionId: version!.id, path: EXAMPLE_TEST_PATH, kind: 'test_manifest', content: EXAMPLE_TEST_YAML,
          contentDigest: digestOf(EXAMPLE_TEST_YAML),
        });
        // Use the historical column set: today's Drizzle schema includes fields
        // that deliberately do not exist before the upgrade under test.
        await pool.query(`insert into project_version_tests
          (project_version_id,key,schema_id,path,harness,scope,configuration_key,model_role,required_capabilities,manifest_digest,fixture_digest,runner_available)
          values ($1,'request-label-v1','localfirst/test/v0.1',$2,'declarative_task_v1','component','local-chat','classifier',$3,$4,$5,false)`,
          [version!.id, EXAMPLE_TEST_PATH, JSON.stringify(['chat','json_output']), digestOf('m'), digestOf('f')]);
        const [draft] = await old
          .insert(schema.drafts)
          .values({ kind: 'project', ownerUserId: 'user-upgrade', payload: {}, payloadDigest: digestOf('draft') })
          .returning();
        // Raw SQL: this table has gained columns since release N-1, so the current Drizzle insert would name them.
        await pool.query(
          `insert into publication_approvals (draft_id, kind, actor_user_id, draft_revision, payload_digest, acknowledged_warning_codes, policy_version, expires_at)
           values ($1, 'project', 'user-upgrade', 1, $2, '[]'::jsonb, 'p', $3)`,
          [draft!.id, digestOf('draft'), new Date(Date.now() + 60_000)],
        );
        await old.insert(schema.operations).values({ kind: 'project.publish', state: 'succeeded', actorUserId: 'user-upgrade' });
        const before = {
          projects: (await pool.query('select count(*)::int c from projects')).rows[0].c,
          versions: (await pool.query('select count(*)::int c from project_versions')).rows[0].c,
          drafts: (await pool.query('select count(*)::int c from drafts')).rows[0].c,
          approvals: (await pool.query('select count(*)::int c from publication_approvals')).rows[0].c,
          operations: (await pool.query('select count(*)::int c from operations')).rows[0].c,
          digest: (await pool.query('select content_digest d from project_versions')).rows[0].d,
        };

        // --- Release N: apply 0002 and later on top -------------------------
        await runMigrations(url);
        const after = {
          projects: (await pool.query('select count(*)::int c from projects')).rows[0].c,
          versions: (await pool.query('select count(*)::int c from project_versions')).rows[0].c,
          drafts: (await pool.query('select count(*)::int c from drafts')).rows[0].c,
          approvals: (await pool.query('select count(*)::int c from publication_approvals')).rows[0].c,
          operations: (await pool.query('select count(*)::int c from operations')).rows[0].c,
          digest: (await pool.query('select content_digest d from project_versions')).rows[0].d,
        };
        expect(after).toEqual(before);
        const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
        expect((await pool.query('select count(*)::int c from drizzle.__drizzle_migrations')).rows[0].c).toBe(journal.entries.length);
        for (const table of EVIDENCE_TABLES) {
          expect((await pool.query(`select count(*)::int c from ${table}`)).rows[0].c, table).toBe(0);
        }

        // --- Lazy backfill on the upgraded database ------------------------
        const upgraded = drizzle(pool, { schema, casing: 'snake_case' }) as unknown as DbOrTx;
        await ensureTestDefinitions([version!.id], upgraded);
        await ensureTestDefinitions([version!.id], upgraded);
        const definitions = await pool.query(
          'select key, executable, bundle_digest, manifest_digest from test_definitions',
        );
        expect(definitions.rows).toHaveLength(1);
        expect(definitions.rows[0]).toMatchObject({
          key: 'request-label-v1', executable: true, bundle_digest: before.digest,
        });
        expect(definitions.rows[0].manifest_digest).not.toBe(digestOf('m'));
        // The old declaration row now mirrors the definition's executability.
        expect((await pool.query('select runner_available r from project_version_tests')).rows[0].r).toBe(true);
        // Composite ownership keys accept the pre-existing rows.
        await pool.query(
          `insert into build_configurations (owner_user_id, project_id, project_version_id, configuration_key, payload,
             content_digest, fingerprint, reproducibility)
           values ('user-upgrade', $1, $2, 'local-chat', '{}', $3, $3, 'complete')`,
          [project!.id, version!.id, `sha256:${'a'.repeat(64)}`],
        );
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('leaves no throwaway database behind', async () => {
    const admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    try {
      const left = await admin.query("select datname from pg_database where datname like 'localfirst_migration_%'");
      expect(left.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('P1 to P2 projection upgrade', () => {
  it('preserves immutable versions and invalidates private-derived summaries through the outbox', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'localfirst-p1-upgrade-'));
    try {
      await cp(MIGRATIONS, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      // Stop before the P2 migration that this test upgrades across.
      journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0004');
      await writeFile(journalPath, JSON.stringify(journal));
      await withThrowawayDatabase(async (url, pool) => {
        const conn = drizzle(pool);
        await migrate(conn, { migrationsFolder: folder });
        const validated = validateProjectBundle({ project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] });
        const now = new Date();
        await conn.insert(schema.userTable).values({ id: 'p1-contributor', name: 'P1 Contributor', email: 'p1@test.invalid', emailVerified: false, createdAt: now, updatedAt: now });
        const [project] = await conn.insert(schema.projects).values({ slug: 'p1-project', projectKey: 'request-labeler', managerUserId: 'p1-contributor', type: 'experiment', visibility: 'unpublished', listingOrigin: 'creator_submitted' }).returning();
        const [version] = await conn.insert(schema.projectVersions).values({ projectId: project!.id, versionNumber: 1, specVersion: '0.1.0', schemaId: 'localfirst/project/v0.2', manifest: validated.manifest, markdown: validated.markdown, contentDigest: validated.content_digest!, payloadDigest: validated.payload_digest, derived: validated.derived, publishedByUserId: 'p1-contributor' }).returning();
        await conn.update(schema.projects).set({ currentVersionId: version!.id, visibility: 'published' }).where(sql`id = ${project!.id}`);
        await conn.insert(schema.compatibilitySummaries).values({ projectId: project!.id, projectVersionId: version!.id, configurationKey: 'local-chat', subjectFingerprint: digestOf('legacy-private-subject'), subject: { platform: { unapproved_hardware: 'private' } }, testDefinitionId: null, scope: 'manual', evidenceLevel: 'community_reported', counts: { reports: 1, successes: 1, failures: 0, partial: 0 }, distinctContributors: 1, conflict: false, evidenceIds: [], latestReportAt: now });
        await runMigrations(url);
        expect(await conn.select().from(schema.compatibilitySummaries)).toEqual([]);
        const [kept] = await conn.select().from(schema.projectVersions).where(sql`id = ${version!.id}`);
        expect(kept?.contentDigest).toBe(validated.content_digest);
        const events = await conn.select().from(schema.outboxEvents).where(sql`aggregate_id = ${project!.id}`);
        expect(events).toHaveLength(1); expect(events[0]?.eventType).toBe('evidence.changed');
        expect(await conn.select().from(schema.communityRecords)).toEqual([]);
      });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
