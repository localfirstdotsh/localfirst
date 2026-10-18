import { defineConfig, devices } from '@playwright/test';
import c from './e2e/constants.json' with { type: 'json' };

/**
 * Browser tests against real servers (see e2e/run.mjs, which prepares the database
 * and builds first). Three servers start here: the API, the website with a released
 * CLI configured, and a second website instance with no CLI released, so both
 * setup-command states are exercised.
 *
 * The public rate limits are raised for the test run only: every page the website
 * renders calls the API from one address, so the production defaults would make a
 * test suite flaky for reasons unrelated to what is under test.
 */
const api = `http://127.0.0.1:${c.apiPort}`;
const web = `http://127.0.0.1:${c.webPort}`;
const webUnreleased = `http://127.0.0.1:${c.webUnreleasedPort}`;
const apiLimited = `http://127.0.0.1:${c.apiLimitedPort}`;
const webForwarding = `http://127.0.0.1:${c.webForwardingPort}`;

const webEnv = (extra: Record<string, string>) => ({
  LOCALFIRST_API_URL: api,
  LOCALFIRST_SITE_URL: web,
  ...extra,
});

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Catalog fixtures are shared; private mutations create isolated records. Keep single-process servers deterministic.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: web,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @localfirst/api start',
      url: `${api}/api/v1/catalog/facets`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(c.apiPort),
        HOST: '127.0.0.1',
        DEV_AUTH_ENABLED: 'true',
        API_BASE_URL: web,
        WEBSITE_URL: web,
        GITHUB_CLIENT_ID: 'e2e-fixture-client',
        GITHUB_CLIENT_SECRET: 'e2e-fixture-secret',
        RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE: '100000',
        RATE_LIMIT_PUBLIC_COMPATIBILITY_PER_MINUTE: '100000',
        RATE_LIMIT_AUTHENTICATED_READS_PER_MINUTE: '100000',
      },
    },
    {
      command: `pnpm exec next start --port ${c.webPort}`,
      url: `${web}/robots.txt`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: webEnv({
        LOCALFIRST_DESIGN_SYSTEM: 'true',
        LOCALFIRST_CLI_RELEASED: 'true',
        LOCALFIRST_CLI_VERSION: '0.1.0',
        LOCALFIRST_CLI_SETUP_COMMAND: c.setupCommand,
        LOCALFIRST_TESTED_CLIENTS: JSON.stringify([
          { id: 'claude-code', label: 'Claude Code', command: c.clientCommand },
          { id: 'codex', label: 'Codex CLI', command: 'npx localfirstdotsh mcp add --client codex --registry http://127.0.0.1:3015' },
        ]),
      }),
    },
    {
      command: `pnpm exec next start --port ${c.webUnreleasedPort}`,
      url: `${webUnreleased}/robots.txt`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: webEnv({ LOCALFIRST_SITE_URL: webUnreleased }),
    },
    // A second API with a LOW public limit that trusts the website's hop, and a website that
    // forwards each visitor's address and gives browsers a different public API address.
    // Used only by rate-limit.spec.ts, with visitor addresses no other test uses.
    {
      command: 'pnpm --filter @localfirst/api start',
      url: `${apiLimited}/api/v1/catalog/facets`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(c.apiLimitedPort),
        HOST: '127.0.0.1',
        API_BASE_URL: apiLimited,
        TRUSTED_PROXIES: 'private',
        RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE: String(c.limitedCatalogPerMinute),
      },
    },
    {
      command: `pnpm exec next start --port ${c.webForwardingPort}`,
      url: `${webForwarding}/robots.txt`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        LOCALFIRST_API_URL: apiLimited,
        LOCALFIRST_PUBLIC_API_URL: c.publicApiOrigin,
        LOCALFIRST_SITE_URL: webForwarding,
        LOCALFIRST_CLIENT_IP_HEADER: 'x-e2e-visitor-ip',
      },
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // A phone-sized viewport on Chromium (touch, no hover), so the narrow layout is exercised.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
