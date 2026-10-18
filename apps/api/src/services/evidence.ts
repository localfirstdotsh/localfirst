/**
 * Accepted-evidence aggregation (BACKEND_PRD sections 9.5, 16.3, 16.4).
 *
 * `compatibility_summaries` is a derived projection, rebuilt wholesale for one
 * project under an advisory lock, so recomputation is idempotent and a
 * withdraw racing an aggregate converges: every state change that can affect
 * evidence emits `evidence.changed`, which schedules another recomputation.
 *
 * Rules enforced here:
 * - only reports that are accepted, public, and attached to a public build count;
 * - contributors are counted by distinct submitter, so a creator's ten reruns
 *   are one contributor;
 * - accepted failures are included, and a group with both successes and
 *   failures is flagged as a conflict instead of being averaged;
 * - evidence is bound to the exact project version, so a new version starts empty.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { runReports, buildConfigurations, compatibilitySummaries } from '../db/schema/evidence.js';
import { db, type DbOrTx } from '../db/client.js';
import {
  isFailedOutcome,
  isSuccessfulOutcome,
  type AssignableEvidenceLevel,
} from '../domain/evidence.js';
import { buildSubject, type EvidenceSubject } from '../domain/evidence-match.js';
import { activeVerifications } from './verification.js';
import { independentVerificationEnabled } from '../config.js';
import { digestOf } from '@localfirst/contracts';
import { asBuild, asReport } from './builds.js';
import { reindexProject } from './search.js';

const MAX_EVIDENCE_IDS = 50;

export interface SummaryCounts {
  reports: number;
  successes: number;
  failures: number;
  partial: number;
}

export interface SummaryRecord {
  id: string;
  projectId: string;
  projectVersionId: string;
  configurationKey: string;
  subjectFingerprint: string;
  subject: EvidenceSubject;
  testDefinitionId: string | null;
  scope: 'component' | 'workflow' | 'manual';
  evidenceLevel: AssignableEvidenceLevel | 'independently_verified';
  counts: SummaryCounts;
  distinctContributors: number;
  conflict: boolean;
  evidenceIds: string[];
  latestReportAt: Date;
  computedAt: Date;
}

type SummaryLevel = SummaryRecord['evidenceLevel'];
const LEVEL_ORDER: SummaryLevel[] = ['independently_verified', 'reproducible_test', 'community_reported'];
const strongest = (levels: SummaryLevel[]): SummaryLevel =>
  LEVEL_ORDER.find((level) => levels.includes(level)) ?? 'community_reported';

/**
 * Recompute every summary for a project. Safe to run any number of times and
 * from concurrent workers: the advisory lock serializes recomputation per
 * project, and the result depends only on the committed report rows.
 *
 * `unlessRebuiltSince` lets a queued recomputation stand down when another one
 * already covers it: `computed_at` is the rebuilding transaction's start time,
 * and that transaction read reports only after taking the lock, so a rebuild
 * that started at or after the given instant saw every change committed before
 * it. The instant is a database timestamp in text form, so no precision is
 * lost. A project with no summaries cannot prove coverage and is always rebuilt.
 */
export async function reaggregateProject(
  projectId: string,
  options: { unlessRebuiltSince?: string } = {},
): Promise<{ summaries: number; reports: number; skipped?: true }> {
  const result = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`evidence:${projectId}`}, 0))`);

    if (options.unlessRebuiltSince) {
      // Compared in SQL: a JavaScript Date would drop the microseconds.
      const [state] = await tx
        .select({
          covered: sql<boolean>`coalesce(max(${compatibilitySummaries.computedAt}) >= ${options.unlessRebuiltSince}::timestamptz, false)`,
          summaries: sql<number>`count(*)::int`,
        })
        .from(compatibilitySummaries)
        .where(eq(compatibilitySummaries.projectId, projectId));
      if (state?.covered) return { summaries: state.summaries, reports: 0, skipped: true as const };
    }

    const rows = await tx
      .select({ report: runReports, build: buildConfigurations })
      .from(runReports)
      .innerJoin(buildConfigurations, eq(buildConfigurations.id, runReports.buildId))
      .where(
        and(
          eq(runReports.projectId, projectId),
          eq(runReports.reviewState, 'accepted'),
          eq(runReports.visibility, 'public'),
          // Implied by the version foreign keys; lets the planner use the
          // project index instead of scanning every build on the platform.
          eq(buildConfigurations.projectId, projectId),
          eq(buildConfigurations.visibility, 'public'),
          isNotNull(runReports.evidenceLevel),
        ),
      )
      .orderBy(asc(runReports.publishedAt), asc(runReports.id));

    interface Group {
      projectVersionId: string;
      configurationKey: string;
      fingerprint: string;
      subject: EvidenceSubject;
      testDefinitionId: string | null;
      scope: 'component' | 'workflow' | 'manual';
      levels: SummaryLevel[];
      submitters: Set<string>;
      counts: SummaryCounts;
      ids: string[];
      latest: Date;
    }
    const verified = independentVerificationEnabled()
      ? new Set((await activeVerifications(rows.map(row => row.report.id), tx)).map(v => v.originalReportId)) : new Set<string>();
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const report = asReport(row.report);
      const build = asBuild(row.build);
      const subject = buildSubject(build.publicProjection as unknown as typeof build.payload);
      const fingerprint = digestOf(subject);
      const key = [report.projectVersionId, build.configurationKey, fingerprint, report.testDefinitionId ?? 'manual'].join('|');
      let group = groups.get(key);
      if (!group) {
        group = {
          projectVersionId: report.projectVersionId,
          configurationKey: build.configurationKey,
          fingerprint,
          subject,
          testDefinitionId: report.testDefinitionId,
          scope: report.kind === 'test_run' && report.payload.scope === 'workflow' ? 'workflow' : report.kind === 'test_run' ? 'component' : 'manual',
          levels: [],
          submitters: new Set(),
          counts: { reports: 0, successes: 0, failures: 0, partial: 0 },
          ids: [],
          latest: report.publishedAt ?? report.updatedAt,
        };
        groups.set(key, group);
      }
      group.levels.push(verified.has(report.id) ? 'independently_verified' : report.evidenceLevel as AssignableEvidenceLevel);
      group.submitters.add(report.submitterUserId);
      group.counts.reports += 1;
      if (isSuccessfulOutcome(report.kind, report.outcome)) group.counts.successes += 1;
      else if (isFailedOutcome(report.kind, report.outcome)) group.counts.failures += 1;
      else group.counts.partial += 1;
      if (verified.has(report.id)) group.ids.unshift(report.id);
      else if (group.ids.length < MAX_EVIDENCE_IDS) group.ids.push(report.id);
      const reportedAt = report.publishedAt ?? report.updatedAt;
      if (reportedAt > group.latest) group.latest = reportedAt;
    }

    await tx.delete(compatibilitySummaries).where(eq(compatibilitySummaries.projectId, projectId));
    for (const group of groups.values()) {
      await tx.insert(compatibilitySummaries).values({
        projectId,
        projectVersionId: group.projectVersionId,
        configurationKey: group.configurationKey,
        subjectFingerprint: group.fingerprint,
        subject: group.subject,
        testDefinitionId: group.testDefinitionId,
        scope: group.scope,
        evidenceLevel: strongest(group.levels),
        counts: group.counts,
        distinctContributors: group.submitters.size,
        // Both outcomes exist: surface the disagreement rather than averaging it.
        conflict: group.counts.successes > 0 && group.counts.failures > 0,
        evidenceIds: group.ids.slice(0, MAX_EVIDENCE_IDS),
        latestReportAt: group.latest,
      });
    }
    return { summaries: groups.size, reports: rows.length };
  });
  // The search projection mirrors the strongest accepted level; it may lag.
  // A skipped run leaves it to the rebuild that covered it.
  if (!('skipped' in result)) await reindexProject(projectId);
  return result;
}

function asSummary(row: Record<string, unknown>): SummaryRecord {
  return row as unknown as SummaryRecord;
}

export async function summariesForVersion(
  versionId: string,
  conn: DbOrTx = db(),
): Promise<SummaryRecord[]> {
  const rows = await conn
    .select()
    .from(compatibilitySummaries)
    .where(eq(compatibilitySummaries.projectVersionId, versionId));
  return refreshVerificationLevels(rows.map((row) => asSummary(row as unknown as Record<string, unknown>)), conn);
}

export async function summariesForProject(projectId: string, conn: DbOrTx = db()): Promise<SummaryRecord[]> {
  const rows = await conn
    .select()
    .from(compatibilitySummaries)
    .where(eq(compatibilitySummaries.projectId, projectId));
  return refreshVerificationLevels(rows.map((row) => asSummary(row as unknown as Record<string, unknown>)), conn);
}

async function refreshVerificationLevels(rows: SummaryRecord[], conn: DbOrTx): Promise<SummaryRecord[]> {
  const enabled = independentVerificationEnabled();
  const verified = enabled ? new Set((await activeVerifications(rows.filter(r => r.evidenceLevel === 'independently_verified').flatMap(r => r.evidenceIds), conn)).map(v => v.originalReportId)) : new Set<string>();
  return rows.map(r => r.evidenceLevel === 'independently_verified' && !r.evidenceIds.some(id => verified.has(id)) ? { ...r, evidenceLevel: 'reproducible_test' } : r);
}

interface ReportsViewInput {
  projectId: string;
  currentVersionId: string | null;
  versionId?: string | undefined;
}

/** Public accepted-evidence view for `GET /projects/:id/compatibility-reports`. */
export async function compatibilityReportsView(input: ReportsViewInput): Promise<Record<string, unknown>> {
  return (await compatibilityReportsViews([input]))[0]!;
}

/**
 * The same view for several projects in a fixed number of queries, so a list
 * of projects does not query each one separately.
 */
export async function compatibilityReportsViews(inputs: ReportsViewInput[]): Promise<Array<Record<string, unknown>>> {
  const projectIds = [...new Set(inputs.map((input) => input.projectId))];
  if (!projectIds.length) return [];
  const summaries = await refreshVerificationLevels(
    (await db().select().from(compatibilitySummaries).where(inArray(compatibilitySummaries.projectId, projectIds)))
      .map((row) => asSummary(row as unknown as Record<string, unknown>)),
    db(),
  );
  const pendingRows = await db()
    .select({ projectId: runReports.projectId, count: sql<string>`count(*)::text` })
    .from(runReports)
    .where(and(inArray(runReports.projectId, projectIds), eq(runReports.visibility, 'public'), eq(runReports.reviewState, 'pending')))
    .groupBy(runReports.projectId);
  const pending = new Map(pendingRows.map((row) => [row.projectId, Number(row.count)]));

  return inputs.map((input) => {
    const all = summaries.filter((row) => row.projectId === input.projectId);
    const rows = input.versionId ? all.filter((row) => row.projectVersionId === input.versionId) : all;
    const pendingCount = pending.get(input.projectId) ?? 0;
    return {
      project_id: input.projectId,
      current_version_id: input.currentVersionId,
      summaries: rows.map((row) => ({
        summary_id: row.id,
        project_version_id: row.projectVersionId,
        // Evidence for an earlier version stays historical and never verifies a newer one.
        current_version: row.projectVersionId === input.currentVersionId,
        configuration_key: row.configurationKey,
        test_definition_id: row.testDefinitionId,
        scope: row.scope,
        evidence_level: row.evidenceLevel,
        subject: row.subject,
        counts: row.counts,
        distinct_contributors: row.distinctContributors,
        conflict: row.conflict,
        evidence_ids: row.evidenceIds,
        latest_report_at: row.latestReportAt.toISOString(),
        computed_at: row.computedAt.toISOString(),
      })),
      accepted_only: true,
      pending_public_reports: pendingCount,
      notes: [
        'Only accepted, public reports on public builds are counted. Accepted failures are included.',
        'Contributors are counted by distinct submitter; repeated runs by one contributor are one contributor.',
        'Component evidence does not establish offline use, a complete project, or untested hardware.',
      ],
      freshness: { target_seconds: 60 },
    };
  });
}
