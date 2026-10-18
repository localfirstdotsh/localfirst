import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from the reviewed Drizzle schema, including the
 * generated Better Auth tables (BACKEND_PRD section 16.4). One release
 * migration job applies them; replicas never auto-migrate.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
});
