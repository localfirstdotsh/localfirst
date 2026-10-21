import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { migrationsFolder, migrationStatus } from '../src/db/migration-status.js';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/localfirst_test');

async function withOlderDatabase(work: (url: string, pool: Pool) => Promise<void>): Promise<void> {
  const name = `localfirst_server_${randomBytes(6).toString('hex')}`;
  const url = new URL(BASE);
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const folder = await mkdtemp(join(tmpdir(), 'localfirst-server-schema-'));
  let pool: Pool | undefined;
  try {
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString(), max: 1 });
    await cp(migrationsFolder(), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
    // Reproduce a checkout with only the original registry/auth migrations.
    // All four tables used by the old readiness check exist in this schema.
    journal.entries = journal.entries.slice(0, 2);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    await work(url.toString(), pool);
  } finally {
    try {
      await pool?.end();
      // Pool.end() can resolve while PostgreSQL is still closing its backends.
      // Wait for the fixture's connections instead of force-killing them, which
      // can emit an unhandled 57P01 on an already-ending pg client.
      const deadline = Date.now() + 10_000;
      while (true) {
        const active = await admin.query<{ count: string }>(
          'select count(*)::text as count from pg_stat_activity where datname = $1',
          [name],
        );
        if (active.rows[0]?.count === '0') break;
        if (Date.now() >= deadline) throw new Error(`Connections to test database ${name} did not close`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await admin.query(`drop database if exists "${name}"`);
    } finally {
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  }
}

async function server(url: string, mode: 'development' | 'test') {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const lines: string[] = [];
  const child = spawn(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], {
    cwd: BACKEND,
    env: {
      ...process.env, NODE_ENV: mode, LOG_LEVEL: 'info', DATABASE_URL: url,
      API_BASE_URL: baseUrl, HOST: '127.0.0.1', PORT: String(port),
    },
  });
  child.stdout.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return {
    baseUrl, lines, exited,
    async ready() {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (lines.join('').includes('api listening')) return;
        if (child.exitCode !== null) throw new Error(`server exited: ${lines.join('')}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`server did not listen: ${lines.join('')}`);
    },
    async close() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

describe('API schema readiness', () => {
  it('refuses development startup with a migration command, then serves the catalog after migration', async () => {
    await withOlderDatabase(async (url, pool) => {
      const stale = await server(url, 'development');
      try {
        expect(await stale.exited).toBe(1);
        const logs = stale.lines.join('');
        expect(logs).toContain('pnpm db:migrate');
        expect(logs).not.toContain('api listening');
        expect(logs).not.toContain(url);
        expect(await migrationStatus(pool)).toMatchObject({ applied: 2, current: false });
      } finally {
        await stale.close();
      }

      await runMigrations(url);
      const current = await server(url, 'development');
      try {
        await current.ready();
        const ready = await fetch(`${current.baseUrl}/health/ready`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toMatchObject({ status: 'ready', database: { migrations: { current: true } } });
        for (const path of ['/api/v1/projects', '/api/v1/catalog/facets']) {
          const response = await fetch(`${current.baseUrl}${path}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toHaveProperty('data');
        }
      } finally {
        await current.close();
      }
    });
  });

  it('keeps liveness available but returns 503 readiness for an older deployed schema', async () => {
    await withOlderDatabase(async (url) => {
      const stale = await server(url, 'test');
      try {
        await stale.ready();
        expect((await fetch(`${stale.baseUrl}/health/live`)).status).toBe(200);
        const ready = await fetch(`${stale.baseUrl}/health/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({
          status: 'not_ready',
          database: { present_tables: 4, reason: 'migrations_pending', migrations: { applied: 2, current: false } },
        });
      } finally {
        await stale.close();
      }
    });
  });
});
