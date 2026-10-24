/**
 * Registry tables for Phase 1 / P0 (BACKEND_PRD sections 16.1 and 16.2).
 *
 * Filtering, ownership, IDs, and states are relational. Bounded evolving
 * specifications, checks, and projections are schema-validated JSONB. Private
 * authorization is enforced in queries and serializers, never inferred from an
 * ID being known.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
import { oauthConsentTable, userTable } from './auth.js';

/** PostgreSQL full-text search vector (section 18.1). */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

const now = sql`now()`;

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(now);
const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(now);

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/** Safe public contributor identity, separate from the auth-owned user row. */
export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    /** `github:<login>` style public identity hints; never a provider token. */
    externalIdentities: jsonb('external_identities').notNull().default(sql`'[]'::jsonb`),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    suspendedReason: text('suspended_reason'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('user_profiles_handle_uidx').on(sql`lower(${table.handle})`)],
);

/** Administratively assigned privileges; never derived from email or login. */
export const operatorRoles = pgTable(
  'operator_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    grantedByUserId: text('granted_by_user_id').references(() => userTable.id, {
      onDelete: 'set null',
    }),
    grantedReason: text('granted_reason'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('operator_roles_active_uidx')
      .on(table.userId, table.role)
      .where(sql`${table.revokedAt} is null`),
    check('operator_roles_role_check', sql`${table.role} in ('moderator', 'admin')`),
  ],
);

// --------------------------------------------------------------------------
// Projects and immutable versions
// --------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    /** Author-chosen key from the specification; unique per manager, not global. */
    projectKey: text('project_key').notNull(),
    managerUserId: text('manager_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    visibility: text('visibility').notNull().default('published'),
    listingOrigin: text('listing_origin').notNull(),
    /** Pointer only; version content is immutable. */
    currentVersionId: uuid('current_version_id'),
    quarantinedAt: timestamp('quarantined_at', { withTimezone: true, mode: 'date' }),
    quarantineReason: text('quarantine_reason'),
    unpublishedAt: timestamp('unpublished_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('projects_slug_uidx').on(table.slug),
    uniqueIndex('projects_manager_key_uidx').on(table.managerUserId, table.projectKey),
    index('projects_visibility_updated_idx').on(table.visibility, table.updatedAt),
    check(
      'projects_visibility_check',
      sql`${table.visibility} in ('published', 'unpublished', 'quarantined')`,
    ),
    check(
      'projects_listing_origin_check',
      sql`${table.listingOrigin} in ('creator_submitted', 'curated_from_upstream')`,
    ),
  ],
);

export const projectVersions = pgTable(
  'project_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Monotonic registry version number, independent of the author's label. */
    versionNumber: integer('version_number').notNull(),
    /** The author's `project.version` label, e.g. `0.1.0`. */
    specVersion: text('spec_version').notNull(),
    schemaId: text('schema_id').notNull(),
    manifest: jsonb('manifest').notNull(),
    markdown: text('markdown').notNull(),
    /** Digest over manifest + markdown + bundled file digests. */
    contentDigest: text('content_digest').notNull(),
    /** Digest of the exact approved draft payload. */
    payloadDigest: text('payload_digest').notNull(),
    /** Search/filter projection derived at publication. */
    derived: jsonb('derived').notNull(),
    warningCodes: jsonb('warning_codes').notNull().default(sql`'[]'::jsonb`),
    publishedByUserId: text('published_by_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'restrict' }),
    publishedFromDraftId: uuid('published_from_draft_id'),
    approvalId: uuid('approval_id'),
    /** A person's exact approval (`human`) or the owner's delegation to a connection (section 10.4). */
    publicationAuthorization: text('publication_authorization').notNull().default('human'),
    /** For a delegated publication, the connection's self-reported client name at the time. */
    publishedViaClientName: text('published_via_client_name'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(now),
  },
  (table) => [
    check('project_versions_publication_authorization_check', sql`${table.publicationAuthorization} in ('human', 'delegated')`),
    unique('project_versions_project_number_uq').on(table.projectId, table.versionNumber),
    unique('project_versions_project_digest_uq').on(table.projectId, table.contentDigest),
    // Lets `projects.current_version_id` carry a composite FK that proves the
    // version belongs to this project rather than merely existing.
    unique('project_versions_id_project_uq').on(table.id, table.projectId),
    index('project_versions_project_published_idx').on(table.projectId, table.publishedAt),
  ],
);

/** Bundled public test/fixture text stored with its version (section 16.1). */
export const projectVersionFiles = pgTable(
  'project_version_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    contentDigest: text('content_digest').notNull(),
  },
  (table) => [
    unique('project_version_files_path_uq').on(table.projectVersionId, table.path),
    check(
      'project_version_files_kind_check',
      sql`${table.kind} in ('test_manifest', 'fixture', 'other', 'environment_manifest', 'prompt')`,
    ),
  ],
);

/**
 * Declared test metadata. Phase 1 stores declarations only: `runnerAvailable`
 * is false and no run has happened (section 21).
 */
export const projectVersionTests = pgTable(
  'project_version_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    schemaId: text('schema_id').notNull(),
    path: text('path').notNull(),
    harness: text('harness').notNull(),
    scope: text('scope').notNull(),
    configurationKey: text('configuration_key').notNull(),
    modelRole: text('model_role'),
    environmentKey: text('environment_key'),
    environmentDigest: text('environment_digest'),
    requiredCapabilities: jsonb('required_capabilities').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    fixtureDigest: text('fixture_digest').notNull(),
    runnerAvailable: boolean('runner_available').notNull().default(false),
  },
  (table) => [unique('project_version_tests_key_uq').on(table.projectVersionId, table.key),
    check('project_version_tests_role_profile_check', sql`(${table.harness} = 'declarative_workflow_v1' and ${table.modelRole} is null and ${table.environmentKey} is not null and ${table.environmentDigest} is not null and ${table.environmentDigest} ~ '^sha256:[0-9a-f]{64}$') or (${table.harness} <> 'declarative_workflow_v1' and ${table.modelRole} is not null and ${table.environmentKey} is null and ${table.environmentDigest} is null)`)],
);

export const sourceReferences = pgTable(
  'source_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    url: text('url'),
    revision: text('revision'),
    contentDigest: text('content_digest'),
    path: text('path'),
    /** Stable provider repository identity survives a rename (section 3.3). */
    providerName: text('provider_name'),
    providerRepoId: text('provider_repo_id'),
    providerOwner: text('provider_owner'),
    providerRepo: text('provider_repo'),
    licenseState: text('license_state'),
    licenseId: text('license_id'),
    licenseReference: text('license_reference'),
    note: text('note'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt,
  },
  (table) => [
    unique('source_references_version_key_uq').on(table.projectVersionId, table.key),
    index('source_references_provider_idx').on(
      table.providerName,
      table.providerRepoId,
      table.path,
    ),
    index('source_references_url_idx').on(table.url),
  ],
);

/** Mutable drift observations about an immutable source reference (section 15.4). */
export const sourceDriftChecks = pgTable(
  'source_drift_checks',
  {
    sourceReferenceId: uuid('source_reference_id')
      .primaryKey()
      .references(() => sourceReferences.id, { onDelete: 'cascade' }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    observedUpstreamRevision: text('observed_upstream_revision'),
    pinnedRevisionAvailable: boolean('pinned_revision_available'),
    sourceVisibility: text('source_visibility'),
    errorClass: text('error_class'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true, mode: 'date' }),
    updatedAt,
  },
  (table) => [index('source_drift_checks_next_idx').on(table.nextCheckAt)],
);

/** Original authors stay distinct from the submitter or curator (section 15.2). */
export const attributions = pgTable(
  'attributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    relationship: text('relationship').notNull(),
    userId: text('user_id').references(() => userTable.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    index('attributions_version_idx').on(table.projectVersionId),
    check('attributions_role_check', sql`${table.role} in ('author', 'submitter', 'curator')`),
  ],
);

// --------------------------------------------------------------------------
// Normalized reference pillars (joins and dedupe keys only)
// --------------------------------------------------------------------------

export const modelReferences = pgTable(
  'model_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    displayName: text('display_name').notNull(),
    family: text('family'),
    sourceUrl: text('source_url'),
    licenseState: text('license_state').notNull().default('unknown'),
    licenseId: text('license_id'),
    /** e.g. `ollama_manifest_sha256`; null when no identity scheme is known. */
    identityScheme: text('identity_scheme'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => [uniqueIndex('model_references_key_uidx').on(table.key)],
);

export const runtimeReferences = pgTable(
  'runtime_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    family: text('family').notNull(),
    displayName: text('display_name').notNull(),
    apiProfile: text('api_profile'),
    /** Registry support status, independent of a project's declaration. */
    supportStatus: text('support_status').notNull().default('declared_only'),
    docsUrl: text('docs_url'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => [
    uniqueIndex('runtime_references_family_uidx').on(table.family),
    check(
      'runtime_references_support_check',
      sql`${table.supportStatus} in ('supported', 'declared_only', 'unsupported')`,
    ),
  ],
);

export const hardwareDescriptors = pgTable(
  'hardware_descriptors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    displayName: text('display_name').notNull(),
    platform: text('platform'),
    cpuArchitecture: text('cpu_architecture'),
    accelerator: text('accelerator'),
    /** Coarse public descriptor figures; never a private machine inventory. */
    memoryBytes: bigint('memory_bytes', { mode: 'number' }),
    vramBytes: bigint('vram_bytes', { mode: 'number' }),
    unifiedMemory: boolean('unified_memory'),
    docsUrl: text('docs_url'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => [uniqueIndex('hardware_descriptors_key_uidx').on(table.key)],
);

export const projectVersionModelRoles = pgTable(
  'project_version_model_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    roleKey: text('role_key').notNull(),
    requiredCapabilities: jsonb('required_capabilities').notNull(),
    minimumContextTokens: integer('minimum_context_tokens'),
    substitution: text('substitution').notNull(),
    /** A creator hint resolved to a reference row where one is recognizable. */
    modelReferenceId: uuid('model_reference_id').references(() => modelReferences.id, {
      onDelete: 'set null',
    }),
    preferredHint: text('preferred_hint'),
  },
  (table) => [
    unique('project_version_model_roles_uq').on(table.projectVersionId, table.roleKey),
    index('project_version_model_roles_model_idx').on(table.modelReferenceId),
  ],
);

export const projectVersionRuntimes = pgTable(
  'project_version_runtimes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    runtimeReferenceId: uuid('runtime_reference_id')
      .notNull()
      .references(() => runtimeReferences.id, { onDelete: 'restrict' }),
    versionConstraint: text('version_constraint'),
  },
  (table) => [
    unique('project_version_runtimes_uq').on(table.projectVersionId, table.runtimeReferenceId),
    index('project_version_runtimes_runtime_idx').on(table.runtimeReferenceId),
  ],
);

export const projectVersionHardware = pgTable(
  'project_version_hardware',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    hardwareDescriptorId: uuid('hardware_descriptor_id')
      .notNull()
      .references(() => hardwareDescriptors.id, { onDelete: 'restrict' }),
    relation: text('relation').notNull().default('declared_requirement'),
  },
  (table) => [
    unique('project_version_hardware_uq').on(table.projectVersionId, table.hardwareDescriptorId),
    index('project_version_hardware_descriptor_idx').on(table.hardwareDescriptorId),
  ],
);

// --------------------------------------------------------------------------
// Drafts, approvals, claims
// --------------------------------------------------------------------------

export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('editable'),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    /** Set when this draft updates an existing project the owner manages. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Incremented by every content edit; invalidates any approval. */
    revision: integer('revision').notNull().default(1),
    /** Incremented by each import attempt so a late result cannot overwrite edits. */
    sourceGeneration: integer('source_generation').notNull().default(0),
    payload: jsonb('payload').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    manifest: jsonb('manifest'),
    markdown: text('markdown'),
    derived: jsonb('derived'),
    contentDigest: text('content_digest'),
    issues: jsonb('issues').notNull().default(sql`'[]'::jsonb`),
    warningCodes: jsonb('warning_codes').notNull().default(sql`'[]'::jsonb`),
    importDescriptor: jsonb('import_descriptor'),
    importError: jsonb('import_error'),
    operationId: uuid('operation_id'),
    /** The OAuth client of the connection that created this draft, if one did (section 10.4). */
    createdByClientId: text('created_by_client_id'),
    publishedVersionId: uuid('published_version_id').references(() => projectVersions.id, {
      onDelete: 'set null',
    }),
    discardedAt: timestamp('discarded_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('drafts_owner_state_idx').on(table.ownerUserId, table.state, table.updatedAt),
    index('drafts_project_idx').on(table.projectId),
    check('drafts_kind_check', sql`${table.kind} in ('project', 'build', 'test_result', 'collection', 'troubleshooting')`),
    check(
      'drafts_state_check',
      sql`${table.state} in ('editable', 'ready_for_review', 'approved', 'published', 'ingesting', 'ingestion_failed', 'discarded')`,
    ),
  ],
);

/** Exact-artifact approval (section 10.4): single use, short lived, content bound. */
export const publicationApprovals = pgTable(
  'publication_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    draftRevision: integer('draft_revision').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    acknowledgedWarningCodes: jsonb('acknowledged_warning_codes').notNull(),
    policyVersion: text('policy_version').notNull(),
    decision: text('decision').notNull().default('approved'),
    /** The browser session that recorded a person's decision. Null for a delegated approval, and for decisions recorded by the retired approval device. */
    sessionId: text('session_id'),
    /** `human` for a person's decision; `delegated` when a connection published under the owner's delegation. */
    authorizationKind: text('authorization_kind').notNull().default('human'),
    /** The connection's OAuth client, for a delegated approval. */
    clientId: text('client_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    consumedByOperationId: uuid('consumed_by_operation_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    index('publication_approvals_lookup_idx').on(
      table.draftId,
      table.draftRevision,
      table.payloadDigest,
      table.expiresAt,
    ),
    // At most one live approval per draft.
    uniqueIndex('publication_approvals_active_uidx')
      .on(table.draftId)
      .where(sql`${table.consumedAt} is null and ${table.revokedAt} is null`),
    check('publication_approvals_decision_check', sql`${table.decision} in ('approved', 'denied')`),
    check(
      'publication_approvals_authorization_check',
      sql`(${table.authorizationKind} = 'human' and ${table.clientId} is null) or (${table.authorizationKind} = 'delegated' and ${table.clientId} is not null)`,
    ),
  ],
);

/**
 * A person's standing permission for one connection to publish their own
 * drafts without a per-artifact approval (section 10.4). Only a browser
 * session creates or removes it; revoking the connection deletes its consent
 * row and with it this delegation.
 */
export const publicationDelegations = pgTable(
  'publication_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    consentId: text('consent_id')
      .notNull()
      .references(() => oauthConsentTable.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    enabledBySessionId: text('enabled_by_session_id').notNull(),
    createdAt,
  },
  (table) => [
    unique('publication_delegations_consent_uq').on(table.consentId),
    index('publication_delegations_user_client_idx').on(table.userId, table.clientId),
  ],
);

export const claimRequests = pgTable(
  'claim_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requesterUserId: text('requester_user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    evidence: text('evidence').notNull(),
    state: text('state').notNull().default('pending'),
    reviewedByUserId: text('reviewed_by_user_id').references(() => userTable.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewReason: text('review_reason'),
    createdAt,
  },
  (table) => [
    uniqueIndex('claim_requests_pending_uidx')
      .on(table.projectId, table.requesterUserId)
      .where(sql`${table.state} = 'pending'`),
    index('claim_requests_state_idx').on(table.state, table.createdAt),
    check('claim_requests_kind_check', sql`${table.kind} in ('manager', 'author')`),
    check(
      'claim_requests_state_check',
      sql`${table.state} in ('pending', 'accepted', 'rejected', 'withdrawn')`,
    ),
  ],
);

// --------------------------------------------------------------------------
// Durable work, replay safety, audit
// --------------------------------------------------------------------------

export const operations = pgTable(
  'operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('queued'),
    actorUserId: text('actor_user_id').references(() => userTable.id, { onDelete: 'set null' }),
    actorClientId: text('actor_client_id'),
    requiredScope: text('required_scope'),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    /** Safe status detail only; never request bodies or private content. */
    result: jsonb('result'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('operations_actor_idx').on(table.actorUserId, table.createdAt),
    index('operations_state_idx').on(table.state, table.updatedAt),
    check(
      'operations_state_check',
      sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

/** Transactional outbox: domain events written with their state change. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    aggregateKind: text('aggregate_kind').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt,
  },
  (table) => [
    index('outbox_events_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} is null`),
  ],
);

/** PostgreSQL-backed job queue with leases. No inference job ever runs here. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().default(now),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    leaseOwner: text('lease_owner'),
    operationId: uuid('operation_id').references(() => operations.id, { onDelete: 'set null' }),
    /** Optional single-flight key, e.g. `source_import:<draft>:<generation>`. */
    dedupeKey: text('dedupe_key'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('jobs_claim_idx').on(table.state, table.runAt),
    uniqueIndex('jobs_dedupe_uidx')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null and ${table.state} in ('queued', 'running')`),
    check(
      'jobs_state_check',
      sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `user:<id>` or `client:<id>`; scoped so keys never cross actors. */
    actorKey: text('actor_key').notNull(),
    operation: text('operation').notNull(),
    targetKey: text('target_key').notNull().default(''),
    keyHash: text('key_hash').notNull(),
    /** Canonical digest of the request content, shared across REST and MCP. */
    requestDigest: text('request_digest').notNull(),
    state: text('state').notNull().default('in_flight'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    operationId: uuid('operation_id').references(() => operations.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('idempotency_records_scope_uq').on(
      table.actorKey,
      table.operation,
      table.targetKey,
      table.keyHash,
    ),
    index('idempotency_records_expiry_idx').on(table.expiresAt),
    check(
      'idempotency_records_state_check',
      sql`${table.state} in ('in_flight', 'completed', 'failed')`,
    ),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: text('actor_user_id').references(() => userTable.id, { onDelete: 'set null' }),
    actorClientId: text('actor_client_id'),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    policyVersion: text('policy_version'),
    /** Safe identifiers and digests only; no manifests, bodies, or tokens. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => [
    index('audit_events_target_idx').on(table.targetKind, table.targetId, table.createdAt),
    index('audit_events_actor_idx').on(table.actorUserId, table.createdAt),
    index('audit_events_action_idx').on(table.action, table.createdAt),
  ],
);

// --------------------------------------------------------------------------
// Projections and abuse controls
// --------------------------------------------------------------------------

/** Indexed projection; may lag, so detail reads stay authoritative. */
export const searchDocuments = pgTable(
  'search_documents',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    projectVersionId: uuid('project_version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    visibility: text('visibility').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    type: text('type').notNull(),
    categories: jsonb('categories').notNull(),
    runtimeFamilies: jsonb('runtime_families').notNull(),
    architectures: jsonb('architectures').notNull(),
    operatingSystems: jsonb('operating_systems').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    modelKeys: jsonb('model_keys').notNull(),
    hardwareKeys: jsonb('hardware_keys').notNull(),
    testSupport: text('test_support').notNull(),
    /** P0 derives claimed/documented only; no report evidence exists yet. */
    evidenceLevel: text('evidence_level').notNull(),
    offlineDeclared: text('offline_declared').notNull(),
    licenseState: text('license_state').notNull(),
    listingOrigin: text('listing_origin').notNull(),
    sourcesPinned: boolean('sources_pinned').notNull(),
    searchVector: tsvector('search_vector'),
    projectUpdatedAt: timestamp('project_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true, mode: 'date' }).notNull().default(now),
    stale: boolean('stale').notNull().default(false),
  },
  (table) => [
    index('search_documents_vector_idx').using('gin', table.searchVector),
    index('search_documents_visibility_idx').on(table.visibility, table.projectUpdatedAt),
    index('search_documents_type_idx').on(table.type),
    index('search_documents_test_support_idx').on(table.testSupport),
    index('search_documents_categories_idx').using('gin', table.categories),
    index('search_documents_runtimes_idx').using('gin', table.runtimeFamilies),
    index('search_documents_architectures_idx').using('gin', table.architectures),
    index('search_documents_os_idx').using('gin', table.operatingSystems),
    index('search_documents_models_idx').using('gin', table.modelKeys),
    index('search_documents_hardware_idx').using('gin', table.hardwareKeys),
  ],
);

/** Shared rate-limit storage so limits hold across replicas (section 19.2). */
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    bucketKey: text('bucket_key').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('rate_limit_counters_expiry_idx').on(table.expiresAt)],
);

/**
 * Aggregate request counters per published project version (BACKEND_PRD
 * section 19.3.1). Counts requests served, never people, installs, or runs:
 * no user ID, IP, user agent, or query is stored.
 */
export const projectUsageDaily = pgTable(
  'project_usage_daily',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => projectVersions.id, { onDelete: 'cascade' }),
    dayUtc: text('day_utc').notNull(),
    channel: text('channel').notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('project_usage_daily_pk').on(table.projectId, table.versionId, table.dayUtc, table.channel),
    check('project_usage_daily_channel_check', sql`${table.channel} in ('rest_export', 'mcp_retrieval')`),
    index('project_usage_daily_project_idx').on(table.projectId),
  ],
);

/** Site-wide counters that cannot be derived from live rows. */
export const siteCounters = pgTable('site_counters', {
  key: text('key').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull().default(0),
});
