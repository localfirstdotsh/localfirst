/**
 * Database access (BACKEND_PRD sections 16, 19.4).
 *
 * Bounded pools, graceful shutdown, and a single Drizzle instance shared by the
 * REST adapter, the hosted MCP adapter, and the metadata worker.
 */

import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';
import { config } from '../config.js';
import { migrationStatus } from './migration-status.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run registry queries: the pool or an open transaction. */
export type DbOrTx = Database | Transaction;

let pool: Pool | null = null;
let database: Database | null = null;

export function getPool(): Pool {
  if (!pool) {
    const { database: dbConfig } = config();
    pool = new Pool({
      connectionString: dbConfig.url,
      max: dbConfig.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'localfirst-backend',
    });
    pool.on('error', () => {
      // Pool-level errors are surfaced by the next query; never crash on idle.
    });
  }
  return pool;
}

export function db(): Database {
  database ??= drizzle(getPool(), { schema, casing: 'snake_case' });
  return database;
}

export async function closeDatabase(): Promise<void> {
  const current = pool;
  pool = null;
  database = null;
  if (current) await current.end();
}

/** Readiness requires the bundled schema, not just the original P0 tables. */
export async function checkDatabaseReady(): Promise<{
  ok: boolean;
  detail: Record<string, unknown>;
}> {
  try {
    const result = await getPool().query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_name in ('projects', 'project_versions', 'drafts', 'jobs')`,
    );
    const present = Number(result.rows[0]?.count ?? '0');
    const migrations = await migrationStatus(getPool());
    const ok = present === 4 && migrations.current;
    return {
      ok,
      detail: {
        expected_tables: 4,
        present_tables: present,
        migrations,
        ...(!ok ? { reason: 'migrations_pending' } : {}),
      },
    };
  } catch {
    return { ok: false, detail: { reason: 'database_unreachable' } };
  }
}
