/**
 * Release migration job (BACKEND_PRD section 16.4).
 *
 * One job applies migrations with the isolated migration credential; replicas
 * never auto-migrate.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { migrationsFolder } from './migration-status.js';
import { createLogger } from '../observability/logger.js';

export async function runMigrations(databaseUrl: string): Promise<void> {
  const log = createLogger('migrate');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'localfirst-migrate' });
  try {
    const folder = migrationsFolder();
    await migrate(drizzle(pool), { migrationsFolder: folder });
    log.info({ folder }, 'migrations applied');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const config = loadConfig();
  await runMigrations(config.database.migrationUrl);
}
