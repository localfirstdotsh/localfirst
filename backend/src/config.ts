/**
 * Configuration boundaries (BACKEND_PRD section 22.2).
 *
 * Inconsistent issuer/origin/audience configuration fails at startup. Secrets
 * are never logged, and the resolved configuration object carries no secret in
 * its public summary.
 */

import { z } from 'zod';
import type { BlockList } from 'node:net';
import { parseTrustedProxies } from './http/client-ip.js';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.int().min(min).max(max));

const url = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}, 'must be an absolute http(s) URL without query, fragment, or credentials');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(8787, 1, 65535),

  DATABASE_URL: z.string().min(1),
  /** Migration credentials are isolated from the API role (section 19.4). */
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: int(10, 1, 100),

  /** Public origin of this backend, e.g. https://api.localfirst.sh */
  API_BASE_URL: url,
  AUTH_BASE_PATH: z.string().default('/api/auth'),
  AUTH_SECRET: z.string().min(1),
  /** Human website origin that hands off to the CLI/agent, e.g. https://localfirst.sh */
  WEBSITE_URL: url,
  /** Extra browser origins allowed to use credentialed requests. No wildcards. */
  TRUSTED_ORIGINS: z.string().optional(),
  /** Proxies whose X-Forwarded-For entries are believed: CIDRs, addresses, `cloudflare`, `private`. */
  TRUSTED_PROXIES: z.string().optional(),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  /** Optional separate credential for bounded public-source ingestion. */
  GITHUB_INGESTION_TOKEN: z.string().optional(),

  ACCESS_TOKEN_TTL_SECONDS: int(900, 60, 3600),
  REFRESH_TOKEN_TTL_SECONDS: int(30 * 24 * 3600, 3600, 90 * 24 * 3600),
  AUTHORIZATION_CODE_TTL_SECONDS: int(300, 30, 600),
  SESSION_TTL_SECONDS: int(7 * 24 * 3600, 3600, 30 * 24 * 3600),
  /** Exact-artifact approval lifetime (section 10.4). */
  APPROVAL_TTL_SECONDS: int(1800, 60, 3600),
  /** Maximum age of a cached revocation/account check on private access. */
  AUTH_CHECK_CACHE_SECONDS: int(60, 0, 60),

  WORKER_CONCURRENCY: int(2, 1, 32),
  WORKER_POLL_INTERVAL_MS: int(1000, 100, 60_000),
  JOB_MAX_ATTEMPTS: int(5, 1, 10),

  RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE: int(120, 1, 100_000),
  RATE_LIMIT_PUBLIC_COMPATIBILITY_PER_MINUTE: int(30, 1, 100_000),
  RATE_LIMIT_AUTHENTICATED_READS_PER_MINUTE: int(300, 1, 100_000),
  RATE_LIMIT_DRAFTS_PER_HOUR: int(10, 1, 100_000),
  RATE_LIMIT_CONCURRENT_IMPORTS: int(2, 1, 100),
  RATE_LIMIT_PUBLICATIONS_PER_DAY: int(20, 1, 100_000),
  RATE_LIMIT_SUBMISSIONS_PER_DAY: int(100, 1, 100_000),

  /** Phase gates. Disabling removes tool discovery and rejects direct calls. */
  FEATURE_GITHUB_IMPORT: bool(true),
  FEATURE_TEST_DEFINITIONS: bool(true),
  FEATURE_RESULT_SUBMISSION: bool(true),
  FEATURE_EVIDENCE_CLASSIFICATION: bool(true),
  FEATURE_COMMUNITY_NETWORK: bool(true),
  FEATURE_INDEPENDENT_VERIFICATION: bool(true),
  FEATURE_AGENT_ENVIRONMENTS: bool(false),
  FEATURE_FRAMEWORK_ENVIRONMENTS: bool(false),
  FEATURE_WORKFLOW_RESULTS: bool(false),
  FEATURE_EXECUTABLE_PLANS: bool(false),
  FEATURE_LEGACY_MCP_SESSIONS: bool(false),
  FEATURE_DYNAMIC_CLIENT_REGISTRATION: bool(false),
  /** Dev/test-only header identity. Refused in production. */
  DEV_AUTH_ENABLED: bool(false),
  METRICS_TOKEN: z.string().optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: RawEnv['LOG_LEVEL'];
  host: string;
  port: number;
  database: { url: string; migrationUrl: string; poolMax: number };
  /** `https://api.localfirst.sh` */
  apiBaseUrl: string;
  /** `https://api.localfirst.sh/api/auth` — the OAuth/OIDC issuer. */
  authIssuer: string;
  authBasePath: string;
  authSecret: string;
  websiteUrl: string;
  trustedOrigins: string[];
  /** Null: the socket peer is the client and forwarding headers are ignored. */
  trustedProxies: { list: BlockList; entries: string[] } | null;
  /** `https://api.localfirst.sh/mcp` — MCP token audience. */
  mcpResource: string;
  /** `https://api.localfirst.sh/api/v1` — REST token audience. */
  restResource: string;
  github: { clientId: string | null; clientSecret: string | null; ingestionToken: string | null };
  ttl: {
    accessTokenSeconds: number;
    refreshTokenSeconds: number;
    authorizationCodeSeconds: number;
    sessionSeconds: number;
    approvalSeconds: number;
    authCheckCacheSeconds: number;
  };
  worker: { concurrency: number; pollIntervalMs: number; maxAttempts: number };
  limits: {
    publicCatalogPerMinute: number;
    publicCompatibilityPerMinute: number;
    authenticatedReadsPerMinute: number;
    draftsPerHour: number;
    concurrentImports: number;
    publicationsPerDay: number;
    submissionsPerDay: number;
  };
  features: {
    githubImport: boolean;
    testDefinitions: boolean;
    resultSubmission: boolean;
    evidenceClassification: boolean;
    communityNetwork: boolean;
    independentVerification: boolean;
    agentEnvironments: boolean;
    frameworkEnvironments: boolean;
    workflowResults: boolean;
    executablePlans: boolean;
    legacyMcpSessions: boolean;
    dynamicClientRegistration: boolean;
    devAuth: boolean;
  };
  metricsToken: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${detail}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const apiBaseUrl = env.API_BASE_URL.replace(/\/+$/, '');
  const basePath = env.AUTH_BASE_PATH.startsWith('/')
    ? env.AUTH_BASE_PATH.replace(/\/+$/, '')
    : `/${env.AUTH_BASE_PATH}`;

  let trustedProxies: AppConfig['trustedProxies'];
  try {
    trustedProxies = parseTrustedProxies(env.TRUSTED_PROXIES);
  } catch (error) {
    throw new ConfigError(`Invalid configuration: ${(error as Error).message}`);
  }

  const trustedOrigins = [
    ...new Set(
      [env.WEBSITE_URL, apiBaseUrl, ...(env.TRUSTED_ORIGINS ?? '').split(',')]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => new URL(value).origin),
    ),
  ];

  const config: AppConfig = {
    env: env.NODE_ENV,
    isProduction,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
      migrationUrl: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    },
    apiBaseUrl,
    authIssuer: `${apiBaseUrl}${basePath}`,
    authBasePath: basePath,
    authSecret: env.AUTH_SECRET,
    websiteUrl: env.WEBSITE_URL.replace(/\/+$/, ''),
    trustedOrigins,
    trustedProxies,
    mcpResource: `${apiBaseUrl}/mcp`,
    restResource: `${apiBaseUrl}/api/v1`,
    github: {
      clientId: env.GITHUB_CLIENT_ID ?? null,
      clientSecret: env.GITHUB_CLIENT_SECRET ?? null,
      ingestionToken: env.GITHUB_INGESTION_TOKEN ?? null,
    },
    ttl: {
      accessTokenSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
      authorizationCodeSeconds: env.AUTHORIZATION_CODE_TTL_SECONDS,
      sessionSeconds: env.SESSION_TTL_SECONDS,
      approvalSeconds: env.APPROVAL_TTL_SECONDS,
      authCheckCacheSeconds: env.AUTH_CHECK_CACHE_SECONDS,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
    },
    limits: {
      publicCatalogPerMinute: env.RATE_LIMIT_PUBLIC_CATALOG_PER_MINUTE,
      publicCompatibilityPerMinute: env.RATE_LIMIT_PUBLIC_COMPATIBILITY_PER_MINUTE,
      authenticatedReadsPerMinute: env.RATE_LIMIT_AUTHENTICATED_READS_PER_MINUTE,
      draftsPerHour: env.RATE_LIMIT_DRAFTS_PER_HOUR,
      concurrentImports: env.RATE_LIMIT_CONCURRENT_IMPORTS,
      publicationsPerDay: env.RATE_LIMIT_PUBLICATIONS_PER_DAY,
      submissionsPerDay: env.RATE_LIMIT_SUBMISSIONS_PER_DAY,
    },
    features: {
      githubImport: env.FEATURE_GITHUB_IMPORT,
      testDefinitions: env.FEATURE_TEST_DEFINITIONS,
      resultSubmission: env.FEATURE_RESULT_SUBMISSION,
      evidenceClassification: env.FEATURE_EVIDENCE_CLASSIFICATION,
      communityNetwork: env.FEATURE_COMMUNITY_NETWORK,
      independentVerification: env.FEATURE_INDEPENDENT_VERIFICATION,
      agentEnvironments: env.FEATURE_AGENT_ENVIRONMENTS,
      frameworkEnvironments: env.FEATURE_FRAMEWORK_ENVIRONMENTS,
      workflowResults: env.FEATURE_WORKFLOW_RESULTS,
      executablePlans: env.FEATURE_EXECUTABLE_PLANS,
      legacyMcpSessions: env.FEATURE_LEGACY_MCP_SESSIONS,
      dynamicClientRegistration: env.FEATURE_DYNAMIC_CLIENT_REGISTRATION,
      devAuth: env.DEV_AUTH_ENABLED,
    },
    metricsToken: env.METRICS_TOKEN ?? null,
  };

  assertConsistent(config);
  return config;
}

/** Fail fast on contradictory issuer/origin/audience/secret configuration. */
export function assertConsistent(config: AppConfig): void {
  const problems: string[] = [];
  const apiUrl = new URL(config.apiBaseUrl);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(apiUrl.hostname);

  if (apiUrl.protocol !== 'https:' && !isLoopback) {
    problems.push('API_BASE_URL must use https outside loopback development');
  }
  if (config.isProduction) {
    if (apiUrl.protocol !== 'https:') problems.push('production requires an https API_BASE_URL');
    if (config.authSecret.length < 32) {
      problems.push('AUTH_SECRET must be at least 32 characters in production');
    }
    if (!config.github.clientId || !config.github.clientSecret) {
      problems.push('GitHub sign-in credentials are required in production');
    }
    if (config.features.devAuth) {
      problems.push('DEV_AUTH_ENABLED must be off in production');
    }
    if (new URL(config.websiteUrl).protocol !== 'https:') {
      problems.push('production requires an https WEBSITE_URL');
    }
  }
  if (!config.authIssuer.startsWith(config.apiBaseUrl)) {
    problems.push('the auth issuer must live under API_BASE_URL');
  }
  if (!sameOrigin(config.mcpResource, config.apiBaseUrl)) {
    problems.push('the MCP resource must share the API origin');
  }
  if (!sameOrigin(config.restResource, config.apiBaseUrl)) {
    problems.push('the REST resource must share the API origin');
  }
  if (config.mcpResource === config.restResource) {
    problems.push('MCP and REST resources must be distinct token audiences');
  }
  for (const origin of config.trustedOrigins) {
    if (origin.includes('*')) problems.push(`trusted origin \`${origin}\` must not use a wildcard`);
  }
  if (config.features.resultSubmission && !config.features.testDefinitions) {
    problems.push('FEATURE_RESULT_SUBMISSION requires FEATURE_TEST_DEFINITIONS');
  }
  if (config.features.evidenceClassification && !config.features.resultSubmission) {
    problems.push('FEATURE_EVIDENCE_CLASSIFICATION requires FEATURE_RESULT_SUBMISSION');
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
}

/** Secret-free summary safe to log at startup. */
export function configSummary(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    api_base_url: config.apiBaseUrl,
    auth_issuer: config.authIssuer,
    mcp_resource: config.mcpResource,
    rest_resource: config.restResource,
    website_url: config.websiteUrl,
    trusted_origins: config.trustedOrigins,
    trusted_proxies: config.trustedProxies?.entries.length ?? 0,
    github_sign_in: Boolean(config.github.clientId),
    features: config.features,
    worker: config.worker,
  };
}

let cached: AppConfig | null = null;

/**
 * Independent verification is effective only alongside the community network
 * and evidence classification it builds on. Every gate reads this, never the
 * raw flag alone.
 */
export function independentVerificationEnabled(features: AppConfig['features'] = config().features): boolean {
  return features.independentVerification && features.communityNetwork && features.evidenceClassification;
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: replace the process-wide configuration. */
export function setConfig(next: AppConfig | null): void {
  cached = next;
}
