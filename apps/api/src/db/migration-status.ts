/**
 * Whether the database schema matches the migrations bundled with this build.
 *
 * Drizzle records each applied migration in `drizzle.__drizzle_migrations`
 * with `created_at` set to its journal entry's `when`, so the schema is
 * current when the newest applied entry is at least as new as the newest
 * bundled one. Processes that do not run migrations themselves (the worker)
 * wait on this, because hosts deploy them independently of the release's
 * migration step.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export function migrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
}

let bundled: { expected: number; latestWhen: number } | null = null;

function bundledMigrations(): { expected: number; latestWhen: number } {
  if (!bundled) {
    const journal = JSON.parse(readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ when: number }>;
    };
    bundled = {
      expected: journal.entries.length,
      latestWhen: Math.max(0, ...journal.entries.map((entry) => entry.when)),
    };
  }
  return bundled;
}

export interface MigrationStatus {
  /** Migrations bundled with this build. */
  expected: number;
  /** Migrations recorded as applied in the database. */
  applied: number;
  /** True when every bundled migration has been applied. */
  current: boolean;
}

/** Undefined table (42P01) or schema (3F000): nothing has been migrated yet. */
const NOT_MIGRATED = new Set(['42P01', '3F000']);

export async function migrationStatus(pool: Pick<Pool, 'query'>): Promise<MigrationStatus> {
  const { expected, latestWhen } = bundledMigrations();
  try {
    const { rows } = await pool.query<{ applied: number; latest: string | null }>(
      'select count(*)::int as applied, max(created_at)::text as latest from drizzle.__drizzle_migrations',
    );
    const applied = rows[0]?.applied ?? 0;
    const latest = rows[0]?.latest === null || rows[0]?.latest === undefined ? 0 : Number(rows[0].latest);
    return { expected, applied, current: latest >= latestWhen };
  } catch (error) {
    if (NOT_MIGRATED.has((error as { code?: string }).code ?? '')) return { expected, applied: 0, current: false };
    throw error;
  }
}
