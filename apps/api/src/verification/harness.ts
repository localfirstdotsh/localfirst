import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { closeDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { config, loadConfig, setConfig } from '../config.js';
import { resetAuth } from '../auth/instance.js';
import { resetAuthCaches } from '../auth/actor.js';
import { createApp } from '../app.js';

/** Creates only random disposable loopback databases; never uses DATABASE_URL. */
export async function isolatedDatabases(count = 1) {
  const adminUrl = new URL(process.env.VERIFICATION_DATABASE_URL ?? 'postgres://localhost:5432/postgres');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) {
    throw new Error('Verification requires a loopback PostgreSQL instance.');
  }
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  const names: string[] = [];
  const urls: string[] = [];
  const cleanup = async () => {
    await closeDatabase();
    resetAuth();
    resetAuthCaches();
    try {
      for (const name of names) await admin.query(`drop database "${name}" with (force)`);
    } finally { await admin.end(); }
  };
  try {
    for (let i = 0; i < count; i++) {
      const name = `localfirst_verify_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`create database "${name}"`);
      names.push(name);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      urls.push(url.href);
    }
    await useDatabase(urls[0]!);
    await runMigrations(urls[0]!);
    return { urls, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function useDatabase(url: string) {
  await closeDatabase();
  resetAuth();
  resetAuthCaches();
  setConfig(loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: url,
    API_BASE_URL: 'http://127.0.0.1:8789', WEBSITE_URL: 'http://127.0.0.1:3000',
    AUTH_SECRET: 'isolated-verification-secret-at-least-32-characters',
    // Measure API work including rate-limit accounting, without reaching quotas.
    RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE: '100000',
    RATE_LIMIT_PUBLIC_COMPATIBILITY_PER_MINUTE: '100000',
    RATE_LIMIT_SUBMISSIONS_PER_DAY: '100000',
  }));
}

export async function startServer(observe?: (request: Request, response: Response) => Promise<void>) {
  const app = createApp();
  const server = serve({ fetch: async (request) => {
    const copy = observe ? request.clone() : null;
    const response = await app.fetch(request);
    if (copy && observe) await observe(copy, response.clone());
    return response;
  }, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  setConfig(loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: config().database.url,
    API_BASE_URL: baseUrl, WEBSITE_URL: 'http://127.0.0.1:3000',
    AUTH_SECRET: config().authSecret,
    RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE: '100000',
    RATE_LIMIT_PUBLIC_COMPATIBILITY_PER_MINUTE: '100000',
    RATE_LIMIT_SUBMISSIONS_PER_DAY: '100000',
  }));
  return { baseUrl, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  }) };
}

export async function jsonRequest(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { data: Record<string, unknown> };
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return body;
}
