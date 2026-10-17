import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real PostgreSQL database: ownership,
 * constraint, and transaction-race behaviour cannot be proven against a mock
 * (BACKEND_PRD section 20.4).
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // One shared database, so files run sequentially.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/localfirst_test',
      API_BASE_URL: 'http://127.0.0.1:8788',
      WEBSITE_URL: 'http://127.0.0.1:3000',
      AUTH_SECRET: 'test-secret-value-that-is-long-enough-000000',
      DEV_AUTH_ENABLED: 'true',
      FEATURE_GITHUB_IMPORT: 'true',
      WORKER_POLL_INTERVAL_MS: '100',
      PORT: '8788',
      GITHUB_CLIENT_ID: 'test-github-client-id',
      GITHUB_CLIENT_SECRET: 'test-github-client-secret',
      HOST: '127.0.0.1',
    },
  },
});
