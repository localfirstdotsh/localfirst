import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { collectionInputSchema, troubleshootingInputSchema, digestOf, type ValidationIssue } from '@localfirst/contracts';
import { db, type DbOrTx } from '../db/client.js';
import { communityRecords } from '../db/schema/community.js';
import { projects, projectVersions, userProfiles } from '../db/schema/registry.js';
import { isOperator, type Actor } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { config } from '../config.js';
import { cursorBound, encodeCursor, parsePageRequest } from '../http/envelope.js';
import { lockActiveAccount } from './accounts.js';
import { writeAudit } from './audit.js';
import type { RecordValidation } from './contributions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommunityKind = 'collection' | 'troubleshooting';
export const isCommunityKind = (kind: string): kind is CommunityKind => kind === 'collection' || kind === 'troubleshooting';
export function assertCommunityEnabled() {
  if (!config().features.communityNetwork) throw ApiError.phaseUnavailable('Community compatibility network');
}
export function referencesOf(kind: CommunityKind, payload: any): Array<{ project_id: string; project_version_id: string }> {
  return kind === 'collection' ? payload.entries : [payload];
}
type Reference = { project_id: string; project_version_id: string };
/** `version id -> project id` for every referenced version whose project is published. */
async function publishedVersions(refs: Reference[], conn: DbOrTx, lock = false): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  // Lock in project order so publication/moderation cannot race a dangling public contribution.
  const query = conn.select({ versionId: projectVersions.id, projectId: projects.id, visibility: projects.visibility })
    .from(projectVersions).innerJoin(projects, eq(projects.id, projectVersions.projectId))
    .where(inArray(projectVersions.id, [...new Set(refs.map(r => r.project_version_id))])).orderBy(asc(projects.id));
  const rows = lock ? await query.for('share', { of: projects }) : await query;
  return new Map(rows.filter(row => row.visibility === 'published').map(row => [row.versionId, row.projectId]));
}
const allPublished = (refs: Reference[], published: Map<string, string>) =>
  refs.every(r => published.get(r.project_version_id) === r.project_id);
async function validateReferences(kind: CommunityKind, payload: any, conn: DbOrTx, lock = false) {
  const refs = referencesOf(kind, payload);
  return allPublished(refs, await publishedVersions(refs, conn, lock));
}
function serializeRecord(row: typeof communityRecords.$inferSelect, handle: string | null) {
  const payload = row.payload as any;
  return { record_id: row.id, kind: row.kind as CommunityKind, payload: row.payload, attribution: { handle, license: payload.license, sources: payload.sources }, visibility: row.visibility, review_state: row.reviewState, evidence_level: 'claimed', author_endorsement: false, content_digest: row.contentDigest };
}
export async function saveCommunityRecord(actor: Actor, kind: CommunityKind, body: unknown) {
  assertCommunityEnabled();
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const parsed = (kind === 'collection' ? collectionInputSchema : troubleshootingInputSchema).safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('Invalid community contribution.', { issues: parsed.error.issues });
  const payload = parsed.data;
  return db().transaction(async tx => {
    await lockActiveAccount(tx, actor.userId);
    if (!await validateReferences(kind, payload, tx)) throw ApiError.notFound();
    if (kind === 'troubleshooting' && 'supersedes_id' in payload && payload.supersedes_id) {
      const [parent] = await tx.select().from(communityRecords).where(eq(communityRecords.id, payload.supersedes_id));
      if (!parent || parent.ownerUserId !== actor.userId || parent.kind !== kind || (parent.payload as any).project_version_id !== payload.project_version_id) throw ApiError.notFound();
    }
    const [row] = await tx.insert(communityRecords).values({ kind, ownerUserId: actor.userId, payload, contentDigest: digestOf(payload) }).returning();
    if (!row) throw ApiError.internal();
    await writeAudit(tx, actor, { action: `${kind}.saved`, targetKind: kind, targetId: row.id, metadata: { content_digest: row.contentDigest } });
    return { record_id: row.id, kind, visibility: 'private', content_digest: row.contentDigest };
  });
}
export async function evaluateCommunityDraft(input: { kind: CommunityKind; ownerUserId: string; recordId: string; selection: unknown; conn: DbOrTx; lock?: boolean }): Promise<RecordValidation> {
  assertCommunityEnabled();
  const issues: ValidationIssue[] = [];
  if (Object.keys((input.selection ?? {}) as object).length) issues.push({ severity: 'error', code: 'selection_invalid', message: 'Community contributions publish their complete approved payload.', pointer: '/selection' });
  const q = input.conn.select().from(communityRecords).where(eq(communityRecords.id, input.recordId));
  const [row] = input.lock ? await q.for('update') : await q;
  if (!row || row.ownerUserId !== input.ownerUserId || row.kind !== input.kind) issues.push({ severity: 'error', code: 'record_not_found', message: 'The contribution does not exist.', pointer: '/record_id' });
  else {
    if (row.visibility !== 'private') issues.push({ severity: 'error', code: 'record_not_private', message: 'Only a private contribution can be published.', pointer: '/record_id' });
    if (!await validateReferences(input.kind, row.payload, input.conn, input.lock)) issues.push({ severity: 'error', code: 'reference_unavailable', message: 'A referenced project/version is not public.', pointer: '/record_id' });
  }
  const warnings = ['community_attribution_not_endorsement'];
  const projection = row ? { schema: 'localfirst/community/v0.1', record_id: row.id, kind: row.kind, curator_user_id: row.ownerUserId, payload: row.payload, evidence_level: 'claimed', author_endorsement: false } : null;
  const payloadDigest = digestOf({ kind: input.kind, record_id: input.recordId, projection });
  return { issues, warning_codes: warnings, readyForReview: issues.length === 0, projection, payloadDigest, recordDigest: row?.contentDigest ?? null, selection: {} };
}
export async function readableCommunityRecord(actor: Actor, id: string) {
  assertCommunityEnabled();
  if (!UUID.test(id)) throw ApiError.notFound();
  const [row] = await db().select().from(communityRecords).where(eq(communityRecords.id, id));
  if (!row) throw ApiError.notFound();
  const owner = actor.kind !== 'anonymous' && actor.userId === row.ownerUserId && actor.scopes.has('community:write');
  if (!owner && (row.visibility !== 'public' || row.reviewState !== 'accepted')) throw ApiError.notFound();
  const kind = row.kind as CommunityKind;
  if (!owner && !await validateReferences(kind, row.payload, db())) throw ApiError.notFound();
  const [profile] = await db().select({ handle: userProfiles.handle }).from(userProfiles).where(eq(userProfiles.userId, row.ownerUserId));
  return serializeRecord(row, profile?.handle ?? null);
}
export async function listCommunity(kind: CommunityKind, params: { limit?: string; cursor?: string; project_id?: string }) {
  assertCommunityEnabled();
  const bound = cursorBound({ kind, project_id: params.project_id ?? null });
  const page = parsePageRequest(params, bound);
  const after = page.cursor?.values[0];
  if (page.cursor && (page.cursor.values.length !== 1 || typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) throw ApiError.badRequest('Invalid cursor.');
  const conditions = [eq(communityRecords.kind, kind), eq(communityRecords.visibility, 'public'), eq(communityRecords.reviewState, 'accepted')];
  if (after) conditions.push(gt(communityRecords.id, String(after)));
  // Page by scanned records; hidden references cannot break pagination or leak content.
  const rows = await db().select().from(communityRecords).where(and(...conditions)).orderBy(asc(communityRecords.id)).limit(page.limit + 1);
  // One query for every reference on the page and one for curator handles, not several per record.
  const window = rows.slice(0, page.limit)
    .filter(row => !params.project_id || referencesOf(kind, row.payload).some(r => r.project_id === params.project_id));
  const published = await publishedVersions(window.flatMap(row => referencesOf(kind, row.payload)), db());
  const visible = window.filter(row => allPublished(referencesOf(kind, row.payload), published));
  const owners = [...new Set(visible.map(row => row.ownerUserId))];
  const handles = new Map(owners.length
    ? (await db().select({ userId: userProfiles.userId, handle: userProfiles.handle }).from(userProfiles).where(inArray(userProfiles.userId, owners))).map(p => [p.userId, p.handle])
    : []);
  const items = visible.map(row => serializeRecord(row, handles.get(row.ownerUserId) ?? null));
  const hasMore = rows.length > page.limit;
  return { items, has_more: hasMore, next_cursor: hasMore ? encodeCursor(bound, [rows[page.limit - 1]!.id]) : null };
}
export async function reviewCommunity(actor: Actor, id: string, decision: 'accepted' | 'rejected', reason: string) {
  assertCommunityEnabled();
  if (actor.kind === 'anonymous' || !isOperator(actor) || !UUID.test(id)) throw ApiError.notFound();
  return db().transaction(async tx => {
    const [row] = await tx.select().from(communityRecords).where(eq(communityRecords.id, id)).for('update');
    if (!row || row.visibility !== 'public') throw ApiError.notFound();
    if (row.ownerUserId === actor.userId) throw ApiError.forbidden('A curator cannot review their own contribution.');
    if (decision === 'accepted' && !await validateReferences(row.kind as CommunityKind, row.payload, tx, true)) throw ApiError.notFound();
    await tx.update(communityRecords).set({ reviewState: decision, reviewedByUserId: actor.userId, reviewReason: reason }).where(eq(communityRecords.id, id));
    await writeAudit(tx, actor, { action: 'community.reviewed', targetKind: row.kind, targetId: id, reason, metadata: { decision } });
    return { record_id: id, review_state: decision };
  });
}
export async function withdrawCommunity(actor: Actor, id: string) {
  assertCommunityEnabled();
  if (actor.kind === 'anonymous' || !UUID.test(id)) throw ApiError.notFound();
  return db().transaction(async tx => {
    await lockActiveAccount(tx, actor.userId);
    const [row] = await tx.select().from(communityRecords).where(eq(communityRecords.id, id)).for('update');
    if (!row || row.ownerUserId !== actor.userId) throw ApiError.notFound();
    await tx.update(communityRecords).set({ visibility: 'withdrawn' }).where(eq(communityRecords.id, id));
    await writeAudit(tx, actor, { action: 'community.withdrawn', targetKind: row.kind, targetId: id });
    return { record_id: id, visibility: 'withdrawn' };
  });
}
