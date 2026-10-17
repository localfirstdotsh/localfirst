import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { comparisonQuerySchema } from '@localfirst/contracts';
import { db, type DbOrTx } from '../db/client.js';
import { buildConfigurations, runReports, testDefinitions } from '../db/schema/evidence.js';
import { projects } from '../db/schema/registry.js';
import { ApiError } from '../http/errors.js';
import { cursorBound, encodeCursor, parsePageRequest } from '../http/envelope.js';
import { comparisonFacts, comparePublicRuns, type PublicRun } from '../domain/public-comparison.js';
import { assertCommunityEnabled } from './community.js';

/** Only approved projections enter community comparisons or verification claims. */
function publicRunQuery(conn: DbOrTx, reports: SQL) {
  return conn.select({ report: runReports, build: buildConfigurations, definition: testDefinitions })
    .from(runReports).innerJoin(buildConfigurations, eq(buildConfigurations.id, runReports.buildId))
    .innerJoin(testDefinitions, eq(testDefinitions.id, runReports.testDefinitionId))
    .innerJoin(projects, eq(projects.id, runReports.projectId))
    .where(and(reports, eq(runReports.visibility, 'public'), eq(runReports.reviewState, 'accepted'), eq(runReports.evidenceLevel, 'reproducible_test'), eq(buildConfigurations.visibility, 'public'), eq(projects.visibility, 'published')));
}
type PublicRunRow = Awaited<ReturnType<typeof publicRunQuery>>[number];
function toPublicRun(row: PublicRunRow | undefined): PublicRun | null {
  if (!row || !row.report.publicProjection || !row.build.publicProjection) return null;
  return { reportId: row.report.id, submitterId: row.report.submitterUserId, report: row.report.publicProjection as PublicRun['report'], build: row.build.publicProjection as PublicRun['build'], definition: row.definition as PublicRun['definition'] };
}
export async function loadPublicRun(id: string, conn: DbOrTx = db(), lock = false): Promise<PublicRun | null> {
  const q = publicRunQuery(conn, eq(runReports.id, id));
  const [row] = lock ? await q.for('share') : await q;
  return toPublicRun(row);
}
/** The qualifying public runs among `ids`, in one query. Missing or hidden runs are absent. */
export async function loadPublicRuns(ids: string[], conn: DbOrTx = db()): Promise<Map<string, PublicRun>> {
  const runs = new Map<string, PublicRun>();
  if (!ids.length) return runs;
  for (const row of await publicRunQuery(conn, inArray(runReports.id, ids))) {
    const run = toPublicRun(row);
    if (run) runs.set(run.reportId, run);
  }
  return runs;
}
export async function publicComparisons(raw: unknown) {
  assertCommunityEnabled();
  const parsed = comparisonQuerySchema.safeParse(raw);
  if (!parsed.success) throw ApiError.badRequest('Invalid comparison query.', { issues: parsed.error.issues });
  const query = parsed.data;
  const [version] = await db().execute<{ project_id: string }>(/* scoped lookup does not reveal hidden versions */
    sql`select v.project_id from project_versions v join projects p on p.id = v.project_id where v.id = ${query.project_version_id} and p.visibility = 'published'`
  ).then(r => r.rows);
  if (!version) throw ApiError.notFound();
  const bound = cursorBound({ ...query, limit: undefined, cursor: undefined });
  const page = parsePageRequest({ limit: String(query.limit), ...(query.cursor ? { cursor: query.cursor } : {}) }, bound);
  const after = page.cursor?.values[0];
  if (page.cursor && (page.cursor.values.length !== 1 || typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) throw ApiError.badRequest('Invalid comparison cursor.');
  const conditions = [eq(runReports.projectVersionId, query.project_version_id), eq(runReports.visibility, 'public'), eq(runReports.reviewState, 'accepted')];
  if (after) conditions.push(gt(runReports.id, String(after)));
  const rows = await db().select({ id: runReports.id }).from(runReports).where(and(...conditions)).orderBy(asc(runReports.id)).limit(page.limit + 1);
  const groups = new Map<string, { baseline: PublicRun; protocol: unknown; runs: any[]; contributors: Set<string> }>();
  const exclusions: Array<{ report_id: string; reasons: string[] }> = [];
  const window = rows.slice(0, page.limit);
  const runs = await loadPublicRuns(window.map((row) => row.id));
  for (const { id } of window) {
    const run = runs.get(id);
    if (!run) { exclusions.push({ report_id: id, reasons: ['qualifying_public_build_or_evidence_unavailable'] }); continue; }
    const facts = comparisonFacts(run, query);
    if (facts.reasons.length) { exclusions.push({ report_id: id, reasons: facts.reasons }); continue; }
    let group = groups.get(facts.key);
    if (!group) { group = { baseline: run, protocol: facts.protocol, runs: [], contributors: new Set() }; groups.set(facts.key, group); }
    group.contributors.add(run.submitterId);
    const pair = comparePublicRuns(group.baseline, run, query);
    group.runs.push({ report_id: id, build_id: run.build.build_id, outcome: run.report.outcome, counts: run.report.counts, measurement: query.metric === 'case_outcomes' ? null : run.report.measurements[query.metric], ...pair });
  }
  const hasMore = rows.length > page.limit;
  return {
    project_version_id: query.project_version_id,
    items: [...groups].map(([id, g]) => ({ comparison_group_id: id, intentionally_varies: query.varies, protocol: g.protocol, reports: g.runs, distinct_contributors: g.contributors.size, comparison_ready: g.runs.length >= 2, universal_score: null })),
    exclusions, has_more: hasMore, next_cursor: hasMore ? encodeCursor(bound, [rows[page.limit - 1]!.id]) : null,
    window: 'Groups and contributor counts cover this bounded page of accepted reports. Follow next_cursor for the next window; groups may span windows.',
  };
}
