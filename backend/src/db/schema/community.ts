import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, timestamp, index, unique, check, foreignKey } from 'drizzle-orm/pg-core';
import { userTable } from './auth.js';
import { projectVersions } from './registry.js';
import { runReports } from './evidence.js';

export const derivativeRelationships = pgTable('derivative_relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  childProjectId: uuid('child_project_id').notNull(),
  childVersionId: uuid('child_version_id').notNull(),
  parentProjectId: uuid('parent_project_id').notNull(),
  parentVersionId: uuid('parent_version_id').notNull(),
  changeSummary: text('change_summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, t => [
  unique('derivative_relationships_child_uq').on(t.childVersionId),
  foreignKey({ columns: [t.childVersionId, t.childProjectId], foreignColumns: [projectVersions.id, projectVersions.projectId] }).onDelete('cascade'),
  foreignKey({ columns: [t.parentVersionId, t.parentProjectId], foreignColumns: [projectVersions.id, projectVersions.projectId] }).onDelete('restrict'),
  index('derivative_relationships_parent_idx').on(t.parentProjectId),
  check('derivative_relationships_no_self_check', sql`${t.childProjectId} <> ${t.parentProjectId}`),
]);

/** Immutable community payloads use the same exact-artifact approval as reports. */
export const communityRecords = pgTable('community_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => userTable.id, { onDelete: 'restrict' }),
  payload: jsonb('payload').notNull(),
  contentDigest: text('content_digest').notNull(),
  visibility: text('visibility').notNull().default('private'),
  reviewState: text('review_state').notNull().default('pending'),
  reviewedByUserId: text('reviewed_by_user_id').references(() => userTable.id, { onDelete: 'restrict' }),
  reviewReason: text('review_reason'),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, t => [
  index('community_records_public_idx').on(t.kind, t.visibility, t.reviewState, t.id),
  index('community_records_owner_idx').on(t.ownerUserId),
  check('community_records_kind_check', sql`${t.kind} in ('collection', 'troubleshooting')`),
  check('community_records_visibility_check', sql`${t.visibility} in ('private', 'public', 'withdrawn', 'quarantined')`),
  check('community_records_review_check', sql`${t.reviewState} in ('pending', 'accepted', 'rejected')`),
  check('community_records_review_provenance_check', sql`${t.reviewState} = 'pending' or (${t.reviewedByUserId} is not null and ${t.reviewReason} is not null and ${t.reviewedByUserId} <> ${t.ownerUserId})`),
  check('community_records_public_check', sql`${t.visibility} <> 'public' or ${t.publishedAt} is not null`),
]);

/** A separate operator decision links two runs; report acceptance alone never verifies. */
export const independentVerifications = pgTable('independent_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalReportId: uuid('original_report_id').notNull().references(() => runReports.id, { onDelete: 'restrict' }),
  reproductionReportId: uuid('reproduction_report_id').notNull().references(() => runReports.id, { onDelete: 'restrict' }),
  reviewerUserId: text('reviewer_user_id').notNull().references(() => userTable.id, { onDelete: 'restrict' }),
  policyVersion: text('policy_version').notNull(),
  provenance: jsonb('provenance').notNull(),
  claimDigest: text('claim_digest').notNull(),
  state: text('state').notNull().default('active'),
  revokedReason: text('revoked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, t => [
  unique('independent_verifications_pair_uq').on(t.originalReportId, t.reproductionReportId),
  index('independent_verifications_reproduction_idx').on(t.reproductionReportId),
  check('independent_verifications_separate_check', sql`${t.originalReportId} <> ${t.reproductionReportId}`),
  check('independent_verifications_state_check', sql`${t.state} in ('active', 'revoked')`),
  check('independent_verifications_revocation_check', sql`(${t.state} = 'revoked') = (${t.revokedReason} is not null)`),
]);
