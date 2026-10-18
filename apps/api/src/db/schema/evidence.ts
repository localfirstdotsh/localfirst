/**
 * Phase 1 evidence tables (BACKEND_PRD sections 6, 8, 9, 16.1, 16.2).
 *
 * Builds, test definitions, and reports are immutable observations or
 * identities; visibility, review, and withdrawal are the only mutable parts.
 * Ownership is relational: a report names a build owned by the same submitter
 * and a test definition that belongs to the same project version, which composite
 * foreign keys prove rather than merely checking that the IDs exist.
 *
 * Constraints encode the evidence policy where they can: a manual build report
 * can never exceed `community_reported`, `independently_verified` is
 * unreachable through this table, and a report that was never accepted carries
 * no evidence level.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { userTable } from './auth.js';
import { operations, projectVersions } from './registry.js';

const now = sql`now()`;
const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(now);
const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(now);

/**
 * Immutable executable-test identities derived from the tests bundled in a
 * published project version (section 5.3). Manifest, fixture, and evaluator
 * are hashed independently; `bundle_digest` is the version content digest.
 */
export const testDefinitions = pgTable(
  'test_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    projectVersionId: uuid('project_version_id').notNull(),
    key: text('key').notNull(),
    configurationKey: text('configuration_key').notNull(),
    scope: text('scope').notNull(),
    harness: text('harness').notNull(),
    modelRole: text('model_role'),
    environmentKey: text('environment_key'),
    environmentDigest: text('environment_digest'),
    requiredCapabilities: jsonb('required_capabilities').notNull(),
    /** The parsed `localfirst/test/v0.1` manifest, public fixtures included. */
    manifest: jsonb('manifest').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    fixtureDigest: text('fixture_digest').notNull(),
    evaluatorDigest: text('evaluator_digest').notNull(),
    bundleDigest: text('bundle_digest').notNull(),
    /** True only when the first-party runner can execute this definition. */
    executable: boolean('executable').notNull(),
    refusalCodes: jsonb('refusal_codes').notNull().default(sql`'[]'::jsonb`),
    createdAt,
  },
  (table) => [
    foreignKey({
      name: 'test_definitions_version_belongs_fk',
      columns: [table.projectVersionId, table.projectId],
      foreignColumns: [projectVersions.id, projectVersions.projectId],
    }).onDelete('cascade'),
    unique('test_definitions_version_key_uq').on(table.projectVersionId, table.key),
    // Lets a report prove its definition belongs to the report's own version.
    unique('test_definitions_id_version_uq').on(table.id, table.projectVersionId),
    index('test_definitions_project_idx').on(table.projectId),
    check(
      'test_definitions_digest_format_check',
      sql`${table.manifestDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.fixtureDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.evaluatorDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.bundleDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('test_definitions_role_profile_check', sql`(${table.harness} = 'declarative_workflow_v1' and ${table.modelRole} is null and ${table.environmentKey} is not null and ${table.environmentDigest} is not null and ${table.environmentDigest} ~ '^sha256:[0-9a-f]{64}$') or (${table.harness} <> 'declarative_workflow_v1' and ${table.modelRole} is not null and ${table.environmentKey} is null and ${table.environmentDigest} is null)`),
    check('test_definitions_executable_refusal_check', sql`${table.executable} or jsonb_array_length(${table.refusalCodes}) > 0`),
  ],
);

/** Actual, sanitized, immutable build configurations (section 6). */
export const buildConfigurations = pgTable(
  'build_configurations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    projectVersionId: uuid('project_version_id').notNull(),
    configurationKey: text('configuration_key').notNull(),
    /** Validated `localfirst/build/v0.1` content without the manual report. */
    payload: jsonb('payload').notNull(),
    /** Canonical digest of `payload`; identical content is stored once per owner. */
    contentDigest: text('content_digest').notNull(),
    /** Identity-scheme, runtime, settings, and coarse platform; never a machine serial. */
    fingerprint: text('fingerprint').notNull(),
    reproducibility: text('reproducibility').notNull(),
    visibility: text('visibility').notNull().default('private'),
    /** The exact approved public projection; null while private. */
    publicProjection: jsonb('public_projection'),
    publicProjectionDigest: text('public_projection_digest'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    parentBuildId: uuid('parent_build_id'),
    createdAt,
  },
  (table) => [
    foreignKey({
      name: 'build_configurations_version_belongs_fk',
      columns: [table.projectVersionId, table.projectId],
      foreignColumns: [projectVersions.id, projectVersions.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'build_configurations_parent_fk',
      columns: [table.parentBuildId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    unique('build_configurations_owner_digest_uq').on(table.ownerUserId, table.contentDigest),
    // Lets a report prove the build is the submitter's and belongs to its version.
    unique('build_configurations_id_owner_version_uq').on(
      table.id,
      table.ownerUserId,
      table.projectVersionId,
    ),
    index('build_configurations_owner_idx').on(table.ownerUserId, table.createdAt),
    index('build_configurations_project_visibility_idx').on(table.projectId, table.visibility, table.publishedAt),
    index('build_configurations_fingerprint_idx').on(table.fingerprint),
    check(
      'build_configurations_visibility_check',
      sql`${table.visibility} in ('private', 'public', 'withdrawn')`,
    ),
    check(
      'build_configurations_reproducibility_check',
      sql`${table.reproducibility} in ('incomplete', 'partial', 'complete')`,
    ),
    check(
      'build_configurations_public_has_projection_check',
      sql`${table.visibility} <> 'public' or (${table.publicProjection} is not null and ${table.publishedAt} is not null)`,
    ),
    check(
      'build_configurations_withdrawn_check',
      sql`(${table.visibility} = 'withdrawn') = (${table.withdrawnAt} is not null)`,
    ),
    check(
      'build_configurations_digest_format_check',
      sql`${table.contentDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.fingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Discriminated observation: a manual build report (no test definition, a
 * human claim) or a test run (a sanitized runner result). Review state,
 * evidence level, outcome, and visibility are separate fields (section 9.1).
 */
export const runReports = pgTable(
  'run_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    submitterUserId: text('submitter_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    clientRunId: text('client_run_id').notNull(),
    /** Digest of the request as submitted; separates a replay from a conflict. */
    requestDigest: text('request_digest').notNull(),
    /** Digest of the payload without the client run ID; blocks content duplicates. */
    contentDigest: text('content_digest').notNull(),
    projectId: uuid('project_id').notNull(),
    projectVersionId: uuid('project_version_id').notNull(),
    buildId: uuid('build_id').notNull(),
    testDefinitionId: uuid('test_definition_id'),
    /** Sanitized `test-result/v0.1` or `build-report/v0.1` content. */
    payload: jsonb('payload').notNull(),
    outcome: text('outcome').notNull(),
    validationState: text('validation_state').notNull().default('pending'),
    /** Server checks: stable codes and pass/fail/unknown, never submitted content. */
    validation: jsonb('validation').notNull().default(sql`'{}'::jsonb`),
    reviewState: text('review_state').notNull().default('pending'),
    /** Server-derived; null until accepted. Never a submitted field. */
    evidenceLevel: text('evidence_level'),
    visibility: text('visibility').notNull().default('private'),
    publicProjection: jsonb('public_projection'),
    publicProjectionDigest: text('public_projection_digest'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    operationId: uuid('operation_id').references(() => operations.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    foreignKey({
      name: 'run_reports_version_belongs_fk',
      columns: [table.projectVersionId, table.projectId],
      foreignColumns: [projectVersions.id, projectVersions.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_reports_build_owned_fk',
      columns: [table.buildId, table.submitterUserId, table.projectVersionId],
      foreignColumns: [
        buildConfigurations.id,
        buildConfigurations.ownerUserId,
        buildConfigurations.projectVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_reports_test_definition_belongs_fk',
      columns: [table.testDefinitionId, table.projectVersionId],
      foreignColumns: [testDefinitions.id, testDefinitions.projectVersionId],
    }).onDelete('restrict'),
    unique('run_reports_submitter_run_uq').on(table.submitterUserId, table.clientRunId),
    unique('run_reports_submitter_content_uq').on(table.submitterUserId, table.contentDigest),
    index('run_reports_submitter_idx').on(table.submitterUserId, table.createdAt),
    index('run_reports_project_state_idx').on(table.projectId, table.reviewState, table.visibility),
    index('run_reports_build_idx').on(table.buildId),
    index('run_reports_validation_idx').on(table.validationState, table.createdAt),
    check('run_reports_kind_check', sql`${table.kind} in ('manual_build', 'test_run')`),
    check(
      'run_reports_review_state_check',
      sql`${table.reviewState} in ('pending', 'accepted', 'rejected', 'withdrawn')`,
    ),
    check(
      'run_reports_visibility_check',
      sql`${table.visibility} in ('private', 'public', 'withdrawn')`,
    ),
    check(
      'run_reports_validation_state_check',
      sql`${table.validationState} in ('pending', 'valid', 'invalid')`,
    ),
    // Only a test run names a test definition; a manual report never fabricates one.
    check(
      'run_reports_definition_discriminator_check',
      sql`(${table.kind} = 'test_run') = (${table.testDefinitionId} is not null)`,
    ),
    // Evidence is server-derived, only after acceptance, and bounded by policy.
    check(
      'run_reports_evidence_level_check',
      sql`${table.evidenceLevel} is null or ${table.evidenceLevel} in ('community_reported', 'reproducible_test')`,
    ),
    check(
      'run_reports_evidence_requires_acceptance_check',
      sql`${table.evidenceLevel} is null or ${table.reviewState} = 'accepted'`,
    ),
    check(
      'run_reports_manual_cap_check',
      sql`${table.kind} <> 'manual_build' or ${table.evidenceLevel} is null or ${table.evidenceLevel} = 'community_reported'`,
    ),
    check(
      'run_reports_public_has_projection_check',
      sql`${table.visibility} <> 'public' or (${table.publicProjection} is not null and ${table.publishedAt} is not null)`,
    ),
    check(
      'run_reports_withdrawn_check',
      sql`(${table.visibility} = 'withdrawn') = (${table.withdrawnAt} is not null)`,
    ),
    check(
      'run_reports_digest_format_check',
      sql`${table.requestDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.contentDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

/** Append-only operator decisions; the report row mirrors the latest one. */
export const evidenceReviews = pgTable(
  'evidence_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runReportId: uuid('run_report_id')
      .notNull()
      .references(() => runReports.id, { onDelete: 'cascade' }),
    reviewerUserId: text('reviewer_user_id').references(() => userTable.id, {
      onDelete: 'set null',
    }),
    decision: text('decision').notNull(),
    reasonCode: text('reason_code').notNull(),
    note: text('note'),
    /** Level assigned by the server when this decision accepted the report. */
    evidenceLevel: text('evidence_level'),
    /** Snapshot of the server checks the decision relied on. */
    serverChecks: jsonb('server_checks').notNull().default(sql`'{}'::jsonb`),
    policyVersion: text('policy_version').notNull(),
    createdAt,
  },
  (table) => [
    index('evidence_reviews_report_idx').on(table.runReportId, table.createdAt),
    check('evidence_reviews_decision_check', sql`${table.decision} in ('accepted', 'rejected')`),
    check(
      'evidence_reviews_level_check',
      sql`${table.evidenceLevel} is null or ${table.evidenceLevel} in ('community_reported', 'reproducible_test')`,
    ),
  ],
);

/**
 * Derived, recomputable accepted-evidence view (section 9). One row per project
 * version, configuration, build fingerprint, and test (or none for manual
 * reports). Rebuilt wholesale per project; nothing here is authoritative.
 */
export const compatibilitySummaries = pgTable(
  'compatibility_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    projectVersionId: uuid('project_version_id').notNull(),
    configurationKey: text('configuration_key').notNull(),
    subjectFingerprint: text('subject_fingerprint').notNull(),
    /** Exact identities this evidence names, kept for matching; never a machine serial. */
    subject: jsonb('subject').notNull(),
    testDefinitionId: uuid('test_definition_id'),
    scope: text('scope').notNull(),
    evidenceLevel: text('evidence_level').notNull(),
    /** Report counts by outcome; failures are included, never averaged away. */
    counts: jsonb('counts').notNull(),
    distinctContributors: integer('distinct_contributors').notNull(),
    conflict: boolean('conflict').notNull(),
    evidenceIds: jsonb('evidence_ids').notNull(),
    latestReportAt: timestamp('latest_report_at', { withTimezone: true, mode: 'date' }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull().default(now),
  },
  (table) => [
    foreignKey({
      name: 'compatibility_summaries_version_belongs_fk',
      columns: [table.projectVersionId, table.projectId],
      foreignColumns: [projectVersions.id, projectVersions.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'compatibility_summaries_definition_belongs_fk',
      columns: [table.testDefinitionId, table.projectVersionId],
      foreignColumns: [testDefinitions.id, testDefinitions.projectVersionId],
    }).onDelete('cascade'),
    uniqueIndex('compatibility_summaries_test_uidx')
      .on(table.projectVersionId, table.configurationKey, table.subjectFingerprint, table.testDefinitionId)
      .where(sql`${table.testDefinitionId} is not null`),
    uniqueIndex('compatibility_summaries_manual_uidx')
      .on(table.projectVersionId, table.configurationKey, table.subjectFingerprint)
      .where(sql`${table.testDefinitionId} is null`),
    index('compatibility_summaries_project_idx').on(table.projectId),
    // Version reads (compatibility checks, search reindex) cannot use the partial unique indexes.
    index('compatibility_summaries_version_idx').on(table.projectVersionId),
    check('compatibility_summaries_scope_check', sql`${table.scope} in ('component', 'workflow', 'manual')`),
    check(
      'compatibility_summaries_level_check',
      sql`${table.evidenceLevel} in ('community_reported', 'reproducible_test', 'independently_verified')`,
    ),
    check(
      'compatibility_summaries_contributors_check',
      sql`${table.distinctContributors} >= 1`,
    ),
  ],
);
