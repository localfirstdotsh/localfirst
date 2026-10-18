import { and, eq, sql } from 'drizzle-orm';
import { derivativeDraftInputSchema, digestOf, parseProjectDocument, projectSpecSchema, serializeProjectDocument, type ProjectSpec, type ValidationIssue } from '@localfirst/contracts';
import { derivativeRelationships } from '../db/schema/community.js';
import { projects, projectVersions } from '../db/schema/registry.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { createDirectProjectDraft, serializeDraft } from './drafts.js';
import { cursorBound, encodeCursor, parsePageRequest } from '../http/envelope.js';
import { assertCommunityEnabled } from './community.js';
import { config } from '../config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function validateDerivative(spec: ProjectSpec, childProjectId: string | null, conn: DbOrTx): Promise<ValidationIssue[]> {
  const lineage = spec.derivative_of;
  if (!lineage) return [];
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, severity: 'error' | 'warning' = 'error') => issues.push({ code, message, severity, pointer: '/derivative_of' });
  // Without a pinned parent, derivative_of is a declared lineage note, as before
  // P2: valid, but it creates no first-class lineage link.
  if (!lineage.project_id && !lineage.project_version_id) return [];
  if (!lineage.project_id || !lineage.project_version_id) { add('DERIVATIVE_PARENT_PIN_REQUIRED', 'A first-class derivative must pin both the parent project and project version.'); return issues; }
  if (!config().features.communityNetwork) { add('DERIVATIVE_LINEAGE_UNAVAILABLE', 'Pinned derivative lineage is not enabled on this deployment.'); return issues; }
  const [parent] = await conn.select({ project: projects, version: projectVersions }).from(projectVersions)
    .innerJoin(projects, eq(projects.id, projectVersions.projectId))
    .where(and(eq(projectVersions.id, lineage.project_version_id), eq(projects.id, lineage.project_id), eq(projects.visibility, 'published'))).for('share', { of: projects });
  if (!parent) { add('DERIVATIVE_PARENT_UNAVAILABLE', 'The parent project/version is not public.'); return issues; }
  if (parent.project.projectKey !== lineage.project_key || parent.version.specVersion !== lineage.version) add('DERIVATIVE_PARENT_MISMATCH', 'The parent key and version must name the exact pinned parent.');
  const manifest = parent.version.manifest as ProjectSpec;
  if (!manifest.attribution.authors.every(a => spec.attribution.authors.some(b => digestOf(a) === digestOf(b)))) add('DERIVATIVE_ATTRIBUTION_REQUIRED', 'Preserve every original parent author and source URL in attribution.');
  for (const source of manifest.sources) {
    if (!spec.sources.some(s => s.url === source.url && s.revision === source.revision && s.content_digest === source.content_digest && digestOf(s.license) === digestOf(source.license))) add('DERIVATIVE_SOURCE_LICENSE_REQUIRED', 'Preserve the pinned parent sources and their license provenance.');
  }
  // Parent project license is retained in the immutable relationship view even if a derivative uses another license.
  add('DERIVATIVE_LICENSE_REVIEW_REQUIRED', 'Review the parent project and source licenses before publishing; lineage does not grant permission or transfer evidence.', 'warning');
  if (childProjectId) {
    if (lineage.project_id === childProjectId) add('DERIVATIVE_CYCLE', 'A project cannot derive from itself.');
    else {
      const cycle = await conn.execute(sql`with recursive ancestors(id) as (
        select ${lineage.project_id}::uuid union
        select r.parent_project_id from derivative_relationships r join ancestors a on r.child_project_id = a.id
      ) select id from ancestors where id = ${childProjectId}::uuid limit 1`);
      if (cycle.rows.length) add('DERIVATIVE_CYCLE', 'This parent would introduce a lineage cycle.');
    }
  }
  return issues;
}
export async function createDerivativeDraft(actor: Actor, parentId: string, raw: unknown) {
  assertCommunityEnabled();
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const parsed = derivativeDraftInputSchema.safeParse(raw);
  if (!parsed.success) throw ApiError.badRequest('Invalid derivative draft.', { issues: parsed.error.issues });
  const body = parsed.data;
  const [parent] = await db().select({ project: projects, version: projectVersions }).from(projectVersions).innerJoin(projects, eq(projects.id, projectVersions.projectId))
    .where(and(eq(projectVersions.id, body.parent_version_id), eq(projects.id, parentId), eq(projects.visibility, 'published')));
  if (!parent) throw ApiError.notFound();
  let doc: ReturnType<typeof parseProjectDocument>;
  try { doc = parseProjectDocument(body.project_md); } catch { throw ApiError.badRequest('Invalid PROJECT.md document.'); }
  const checked = projectSpecSchema.safeParse(doc.frontmatter);
  if (!checked.success) throw ApiError.badRequest('Invalid project specification.', { issues: checked.error.issues });
  const spec = checked.data;
  spec.attribution.relationship = 'third_party_submitted';
  spec.derivative_of = { project_key: parent.project.projectKey, project_id: parentId, project_version_id: body.parent_version_id, version: parent.version.specVersion, change_summary: body.change_summary };
  const { draft } = await createDirectProjectDraft({ actor, ownerUserId: actor.userId, projectId: null, payload: { project_md: serializeProjectDocument(spec, doc.markdown), files: body.files } });
  return serializeDraft(draft);
}
export async function publishDerivativeLink(conn: DbOrTx, spec: ProjectSpec, childProjectId: string, childVersionId: string) {
  const lineage = spec.derivative_of;
  if (!lineage?.project_id || !lineage.project_version_id) return;
  await conn.insert(derivativeRelationships).values({ childProjectId, childVersionId, parentProjectId: lineage.project_id, parentVersionId: lineage.project_version_id, changeSummary: lineage.change_summary });

}
export async function derivativeView(projectId: string, params: { limit?: string; cursor?: string } = {}) {
  if (!UUID.test(projectId)) throw ApiError.notFound();
  const bound = cursorBound({ projectId, kind: 'derivative-lineage' });
  const page = parsePageRequest(params, bound);
  const after = page.cursor?.values[0];
  if (page.cursor && (page.cursor.values.length !== 1 || typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) throw ApiError.badRequest('Invalid lineage cursor.');
  assertCommunityEnabled();
  const [project] = await db().select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.visibility, 'published')));
  if (!project) throw ApiError.notFound();
  const rows = await db().execute(sql`
    select r.*, p.slug as child_slug, v.manifest->'attribution' as parent_attribution,
      v.manifest->'project'->'license' as parent_license,
      v.manifest->'sources' as parent_sources
    from derivative_relationships r
    join projects p on p.id = r.child_project_id and p.visibility = 'published'
    join projects parent on parent.id = r.parent_project_id and parent.visibility = 'published'
    join project_versions v on v.id = r.parent_version_id
    where (r.parent_project_id = ${projectId} or r.child_project_id = ${projectId})
      ${after ? sql`and r.id > ${after}::uuid` : sql``}
    order by r.id limit ${page.limit + 1}
  `);
  return { project_id: projectId, items: rows.rows.slice(0,page.limit).map(r => ({ ...r, evidence_inherited: false })), has_more: rows.rows.length > page.limit, next_cursor: rows.rows.length > page.limit ? encodeCursor(bound, [String(rows.rows[page.limit - 1]!.id)]) : null, note: 'Lineage links immutable versions and attribution. Each child needs its own accepted evidence; parent management rights are not transferred.' };
}
