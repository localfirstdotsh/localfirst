/**
 * Per-file isolation: every table is truncated so tests never depend on each
 * other's rows.
 */

import { afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { resetAuthCaches } from '../src/auth/actor.js';
import { resetMetrics } from '../src/observability/metrics.js';

const TABLES = [
  'independent_verifications', 'derivative_relationships', 'community_records',
  'compatibility_summaries',
  'evidence_reviews',
  'run_reports',
  'build_configurations',
  'test_definitions',
  'search_documents',
  'rate_limit_counters',
  'audit_events',
  'idempotency_records',
  'jobs',
  'outbox_events',
  'project_usage_daily',
  'site_counters',
  'operations',
  'claim_requests',
  'publication_approvals',
  'approver_credentials',
  'approver_links',
  'drafts',
  'source_drift_checks',
  'source_references',
  'attributions',
  'project_version_files',
  'project_version_tests',
  'project_version_model_roles',
  'project_version_runtimes',
  'project_version_hardware',
  'project_versions',
  'projects',
  'model_references',
  'runtime_references',
  'hardware_descriptors',
  'operator_roles',
  'user_profiles',
  'oauth_consent',
  'oauth_access_token',
  'oauth_refresh_token',
  'oauth_client_resource',
  'oauth_client',
  'session',
  'account',
  'verification',
  'user',
];

beforeEach(async () => {
  await db().execute(
    sql.raw(`truncate table ${TABLES.map((table) => `"${table}"`).join(', ')} cascade`),
  );
  resetAuthCaches();
  resetMetrics();
});

afterAll(async () => {
  await closeDatabase();
});
