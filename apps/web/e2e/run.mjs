#!/usr/bin/env node
/**
 * End-to-end test runner. Prepares real services, then runs Playwright against them:
 *
 *   1. a fresh PostgreSQL database (dropped again afterwards),
 *   2. migrations and the curated seed,
 *   3. a second version of one project (so "historical" pages exist),
 *   4. an owner and a stranger account, and request counts for the owner's project,
 *   5. a production build of contracts, backend, and web.
 *
 * Playwright's webServer then starts the backend and two website instances. Server
 * state is prepared here, not in Playwright's globalSetup, because Playwright starts
 * its web servers before global setup runs.
 *
 * It never touches any database except the one named below. Override the admin
 * connection with E2E_ADMIN_DATABASE_URL; it only needs CREATE/DROP DATABASE rights.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const repoRoot = path.resolve(webDir, '..', '..');
const c = JSON.parse(readFileSync(path.join(here, 'constants.json'), 'utf8'));

const adminUrl = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://localhost:5432/postgres';
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${c.database}`;
const databaseUrl = dbUrl.toString();

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: process.env, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
};

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabase() {
  await withClient(adminUrl, async (client) => {
    await client.query(`drop database if exists "${c.database}" with (force)`);
    await client.query(`create database "${c.database}"`);
  });
}

async function dropDatabase() {
  await withClient(adminUrl, (client) => client.query(`drop database if exists "${c.database}" with (force)`)).catch(
    () => undefined,
  );
}

async function prepareData() {
  await withClient(databaseUrl, async (db) => {
    for (const [id, handle] of [
      [c.ownerId, 'e2e-owner'],
      [c.strangerId, 'e2e-stranger'],
    ]) {
      await db.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, $3, false, now(), now())`,
        [id, handle, `${handle}@e2e.localfirst.invalid`],
      );
      await db.query(
        `insert into user_profiles (user_id, handle, display_name, external_identities) values ($1, $2, $2, '[]'::jsonb)`,
        [id, handle],
      );
    }
    const { rows } = await db.query(`select id, current_version_id from projects where slug = $1`, [c.ownerProjectSlug]);
    const project = rows[0];
    if (!project) throw new Error(`seed has no project ${c.ownerProjectSlug}`);
    await db.query(`update projects set manager_user_id = $1 where id = $2`, [c.ownerId, project.id]);

    // A second, newer version, so the first becomes a historical one.
    await db.query(`create temp table v2 as select * from project_versions where id = $1`, [project.current_version_id]);
    await db.query(
      `update v2 set id = gen_random_uuid(), version_number = 2, spec_version = '0.2.0',
         content_digest = 'sha256:' || repeat('b', 64), published_at = now()`,
    );
    await db.query(`insert into project_versions select * from v2`);
    await db.query(`update projects set current_version_id = (select id from v2) where id = $1`, [project.id]);

    // Request counts for the owner's project: a busy stretch, quiet days, and a gap.
    for (let offset = 0; offset < 30; offset += 1) {
      if (offset % 9 === 4) continue;
      const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
      const exports = 2 + ((offset * 5) % 7);
      const retrievals = 3 + ((offset * 3) % 9);
      for (const [channel, count] of [
        ['rest_export', exports],
        ['mcp_retrieval', retrievals],
      ]) {
        await db.query(
          `insert into project_usage_daily (project_id, version_id, day_utc, channel, count)
           values ($1, (select id from v2), $2, $3, $4)`,
          [project.id, day, channel, count],
        );
      }
    }
  });
}

const childEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  API_BASE_URL: `http://127.0.0.1:${c.apiPort}`,
  WEBSITE_URL: `http://127.0.0.1:${c.webPort}`,
  AUTH_SECRET: 'e2e-secret-not-for-deploy-0123456789abcdef',
  LOG_LEVEL: 'warn',
};
delete childEnv.NODE_ENV;
Object.assign(process.env, childEnv);

let exitCode = 1;
try {
  console.log('e2e: creating database', c.database);
  await recreateDatabase();
  if (process.env.E2E_SKIP_BUILD === '1') {
    console.log('e2e: E2E_SKIP_BUILD=1, reusing the existing builds (they must be current)');
  } else {
    console.log('e2e: building contracts, backend, and web');
    run('pnpm', ['build:contracts']);
    run('pnpm', ['--filter', '@localfirst/api', 'build']);
    run('pnpm', ['--filter', '@localfirst/web', 'build'], { env: { ...process.env, LOCALFIRST_API_URL: childEnv.API_BASE_URL } });
  }
  console.log('e2e: migrating and seeding');
  run('pnpm', ['--filter', '@localfirst/api', 'db:migrate']);
  run('pnpm', ['--filter', '@localfirst/api', 'db:seed']);
  await prepareData();
  // Next persists its data cache in .next/cache across server restarts. A cached response from
  // a previous run holds that run's project IDs, which do not exist in this fresh database.
  rmSync(path.join(webDir, '.next', 'cache', 'fetch-cache'), { recursive: true, force: true });
  console.log('e2e: running Playwright');
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], {
    cwd: webDir,
    stdio: 'inherit',
    env: process.env,
  });
  exitCode = result.status ?? 1;
} catch (error) {
  console.error('e2e: setup failed:', error instanceof Error ? error.message : error);
} finally {
  await dropDatabase();
}
process.exit(exitCode);
