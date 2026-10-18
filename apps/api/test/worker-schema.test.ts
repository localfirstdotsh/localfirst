/**
 * The worker never runs ahead of the schema (BACKEND_PRD sections 16.4 and
 * 19.4). Hosts deploy the worker independently of the release's pre-deploy
 * migration step, so a new worker must wait until every bundled migration is
 * applied, and its failure logs must say why without carrying data.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { getPool } from '../src/db/client.js';
import { migrationStatus, migrationsFolder } from '../src/db/migration-status.js';
import { runMigrations } from '../src/db/migrate.js';
import { failureFields, waitForSchema } from '../src/jobs/worker.js';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/localfirst_test');
const urlFor = (database: string) => {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  return url.toString();
};

async function withThrowawayDatabase<T>(work: (url: string, pool: Pool) => Promise<T>): Promise<T> {
  const name = `localfirst_worker_${randomBytes(6).toString('hex')}`;
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

const bundledCount = async () =>
  (JSON.parse(await readFile(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;

describe('migration status', () => {
  it('reports the migrated test database as current', async () => {
    const status = await migrationStatus(getPool());
    expect(status).toEqual({ expected: await bundledCount(), applied: await bundledCount(), current: true });
  });

  it('reports a database with nothing applied, and then a fully migrated one', async () => {
    await withThrowawayDatabase(async (url, pool) => {
      expect(await migrationStatus(pool)).toMatchObject({ applied: 0, current: false });
      await runMigrations(url);
      expect(await migrationStatus(pool)).toMatchObject({ applied: await bundledCount(), current: true });
    });
  });

  it('reports an older release schema as not current', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'localfirst-older-'));
    try {
      await cp(migrationsFolder(), folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, -1);
      await writeFile(journalPath, JSON.stringify(journal));
      await withThrowawayDatabase(async (_url, pool) => {
        await migrate(drizzle(pool), { migrationsFolder: folder });
        const expected = await bundledCount();
        expect(await migrationStatus(pool)).toEqual({ expected, applied: expected - 1, current: false });
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe('waitForSchema', () => {
  const pending = { expected: 4, applied: 3, current: false };
  const done = { expected: 4, applied: 4, current: true };

  it('waits until the schema is current, retrying through errors', async () => {
    const answers: Array<() => Promise<typeof done>> = [
      async () => pending,
      async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); },
      async () => done,
    ];
    let calls = 0;
    const ready = await waitForSchema(() => answers[calls++]!(), { isRunning: () => true, intervalMs: 1 });
    expect(ready).toBe(true);
    expect(calls).toBe(3);
  });

  it('stops waiting when the worker is stopped', async () => {
    let running = true;
    let calls = 0;
    const ready = await waitForSchema(async () => { calls += 1; if (calls === 2) running = false; return pending; }, {
      isRunning: () => running,
      intervalMs: 1,
    });
    expect(ready).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('failureFields', () => {
  it('logs the SQLSTATE, table and constraint, never the message', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "x": Key (email)=(a@b.c)'), {
      code: '23505', table: 'user', constraint: 'user_email_unique',
    });
    expect(failureFields(pgError)).toEqual({ error_class: 'Error', error_code: '23505', table: 'user', constraint: 'user_email_unique' });
    const wrapped = Object.assign(new Error('Failed query: select ...'), { name: 'DrizzleQueryError', cause: Object.assign(new Error('relation "jobs" does not exist'), { code: '42P01' }) });
    expect(failureFields(wrapped)).toEqual({ error_class: 'DrizzleQueryError', error_code: '42P01' });
    expect(failureFields(new TypeError('boom'))).toEqual({ error_class: 'TypeError' });
    expect(JSON.stringify(failureFields(pgError))).not.toContain('a@b.c');
  });
});

describe('a real worker process', () => {
  it('waits for migrations before processing jobs, then starts and stops cleanly', async () => {
    await withThrowawayDatabase(async (url) => {
      const lines: string[] = [];
      const child = spawn(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['src/jobs/worker.ts'], {
        cwd: BACKEND,
        env: {
          ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', DATABASE_URL: url,
          API_BASE_URL: 'http://127.0.0.1:8799', WEBSITE_URL: 'http://127.0.0.1:3000',
          AUTH_SECRET: 'test-secret-value-that-is-long-enough-000000', WORKER_POLL_INTERVAL_MS: '100',
        },
      });
      child.stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      const seen = async (text: string, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (lines.some((line) => line.includes(text))) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`worker never logged "${text}"; got:\n${lines.join('\n')}`);
      };
      try {
        await seen('waiting for migrations before processing jobs');
        // It must not attempt a cycle against the empty database meanwhile.
        expect(lines.some((line) => line.includes('worker cycle failed'))).toBe(false);
        await runMigrations(url);
        await seen('schema current; starting');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(lines.some((line) => line.includes('worker cycle failed'))).toBe(false);
      } finally {
        child.kill('SIGTERM');
      }
      expect(await exited).toBe(0);
      expect(lines.some((line) => line.includes('worker stopped'))).toBe(true);
    });
  }, 60_000);
});
