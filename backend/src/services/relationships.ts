import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { hardwareDescriptors, modelReferences } from '../db/schema/registry.js';
import { assertCommunityEnabled } from './community.js';
import { ApiError } from '../http/errors.js';
import { cursorBound, encodeCursor, parsePageRequest } from '../http/envelope.js';
import { config } from '../config.js';
import { compatibilityReportsViews } from './evidence.js';
import { visibleDeclarations } from './references.js';

/** References are declarations; evidence views remain bound to their exact versions. */
export async function referenceRelationships(kind: 'model' | 'hardware', id: string, params: { limit?: string; cursor?: string } = {}) {
  const bound = cursorBound({ kind, id });
  const page = parsePageRequest(params, bound);
  const after = page.cursor?.values[0];
  if (page.cursor && (page.cursor.values.length !== 1 || typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) throw ApiError.badRequest('Invalid reference cursor.');
  assertCommunityEnabled();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound();
  const [exists] = kind === 'model'
    ? await db().select({ id: modelReferences.id }).from(modelReferences).where(eq(modelReferences.id, id))
    : await db().select({ id: hardwareDescriptors.id }).from(hardwareDescriptors).where(eq(hardwareDescriptors.id, id));
  if (!exists) throw ApiError.notFound();
  const declared = await visibleDeclarations(kind, id, { limit: page.limit, after: typeof after === 'string' ? after : undefined });
  const window = declared.items.map((row) => ({ project_id: row.project_id, version_id: row.project_version_id, slug: row.slug }));
  // One batched evidence read for the whole page, not one per project.
  const evidence = config().features.evidenceClassification
    ? await compatibilityReportsViews(window.map((row) => ({ projectId: row.project_id, currentVersionId: row.version_id, versionId: row.version_id })))
    : window.map(() => ({ summaries: [], classification_available: false }));
  const items = window.map((row, i) => ({ ...row, relation: 'declared_reference', evidence: evidence[i] }));
  return { reference_id: id, kind, items, has_more: declared.has_more, next_cursor: declared.has_more ? encodeCursor(bound, [window[window.length - 1]!.project_id]) : null, note: 'A declared reference is not an observed fit. Evidence applies only to its disclosed exact build, protocol and scope; there is no transitive compatibility guarantee.' };
}
