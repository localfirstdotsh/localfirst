/**
 * Node entry point (BACKEND_PRD sections 19.4, 22.1).
 *
 * The API, the metadata worker, and the migration job deploy separately from
 * this one codebase. Shutdown is graceful: in-flight requests finish and the
 * database pool closes.
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config, configSummary } from './config.js';
import { checkDatabaseReady, closeDatabase } from './db/client.js';
import { createLogger } from './observability/logger.js';
import { startUsageFlush, stopUsageFlush } from './services/usage.js';

const log = createLogger('server');

export function startServer(): { close: () => Promise<void> } {
  const cfg = config();
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    log.info({ ...configSummary(cfg), address: `http://${cfg.host}:${info.port}` }, 'api listening');
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await stopUsageFlush();
    await closeDatabase();
  };
  startUsageFlush();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'shutting down');
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  return { close };
}

// Local checkouts often advance ahead of their database. Explain the repair
// before opening a listener; migration credentials remain a separate job.
if (config().env === 'development') {
  const database = await checkDatabaseReady();
  if (!database.ok) {
    log.error(
      { database: database.detail },
      database.detail.reason === 'migrations_pending'
        ? 'Database migrations are pending. Run pnpm db:migrate from the repository root, then restart pnpm dev.'
        : 'Database is unreachable. Check PostgreSQL and DATABASE_URL, then restart pnpm dev.',
    );
    await closeDatabase();
    process.exitCode = 1;
  } else {
    startServer();
  }
} else {
  startServer();
}
