/**
 * Applies migrations to the test database once per run, proving the reviewed
 * migrations work on a fresh schema (BACKEND_PRD section 20.4).
 */

import { runMigrations } from '../src/db/migrate.js';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/localfirst_test';
  await runMigrations(url);
}
