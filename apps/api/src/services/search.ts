/**
 * Search projection and query (BACKEND_PRD section 18.1).
 *
 * PostgreSQL full-text plus normalized facet joins; no dedicated search or
 * graph engine. Unknown filters fail rather than broadening silently. Multiple
 * values within a field are OR; fields combine with AND. The public visibility
 * predicate is applied on every query, and a lagging projection can never
 * expose hidden content because detail reads stay authoritative.
 */

import { and, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  EVIDENCE_LEVELS,
  OPERATING_SYSTEMS,
  PROJECT_TYPES,
  RUNTIME_FAMILIES,
  TASK_CATEGORIES,
  TEST_SUPPORT_KINDS_V3,
  type DerivedFacts,
} from '@localfirst/contracts';
import { projects, projectVersions, searchDocuments } from '../db/schema/registry.js';
import { compatibilitySummaries } from '../db/schema/evidence.js';
import { db, type DbOrTx } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { cursorBound, encodeCursor, type PageRequest } from '../http/envelope.js';
import { modelKeyFromHint } from './references.js';

export const SEARCH_SORTS = ['relevance', 'updated_at', 'evidence_freshness'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface SearchFilters {
  q: string | null;
  type: string[];
  category: string[];
  model: string[];
  runtime: string[];
  hardware: string[];
  os: string[];
  test_support: string[];
  evidence_level: string[];
  offline: 'yes' | 'no' | 'unknown' | null;
  /** `yes`: only derivatives (remixes) with a pinned parent; `no`: only originals. */
  derivative: 'yes' | 'no' | null;
  sort: SearchSort;
}

export interface SearchResultRow {
  project_id: string;
  slug: string;
  name: string;
  summary: string;
  type: string;
  categories: string[];
  runtime_families: string[];
  architectures: string[];
  operating_systems: string[];
  test_support: string[] | string;
  evidence_level: string;
  offline_declared: string;
  license_state: string;
  listing_origin: string;
  sources_pinned: boolean;
  project_version_id: string;
  updated_at: string;
  relevance: number | null;
}

const ALLOWED_PARAMS = new Set([
  'q',
  'type',
  'category',
  'model',
  'runtime',
  'hardware',
  'os',
  'test_support',
  'evidence_level',
  'offline',
  'derivative',
  'sort',
  'cursor',
  'limit',
]);

function assertAllowedValues(field: string, values: string[], allowed: readonly string[]): void {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw ApiError.badRequest(
        `\`${value}\` is not a supported \`${field}\` value. See /api/v1/catalog/facets.`,
        { parameter: field, supported: allowed },
      );
    }
  }
}

/** Parse query parameters strictly: an unknown parameter is a 400. */
export function parseSearchFilters(raw: Record<string, string | string[] | undefined>): SearchFilters {
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PARAMS.has(key)) {
      throw ApiError.badRequest(`\`${key}\` is not a supported query parameter.`, {
        parameter: key,
        supported: [...ALLOWED_PARAMS],
      });
    }
  }
  const list = (key: string): string[] => {
    const value = raw[key];
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  };
  const single = (key: string): string | null => {
    const value = raw[key];
    if (value === undefined) return null;
    const first = Array.isArray(value) ? value[0] : value;
    return first && first.trim().length > 0 ? first.trim() : null;
  };

  const type = list('type');
  const category = list('category');
  const runtime = list('runtime');
  const os = list('os');
  const testSupport = list('test_support');
  const evidenceLevel = list('evidence_level');

  assertAllowedValues('type', type, PROJECT_TYPES);
  assertAllowedValues('category', category, TASK_CATEGORIES);
  assertAllowedValues('runtime', runtime, RUNTIME_FAMILIES);
  assertAllowedValues('os', os, OPERATING_SYSTEMS);
  assertAllowedValues('test_support', testSupport, TEST_SUPPORT_KINDS_V3);
  // P0 records carry claimed/documented levels only; asking for stronger
  // evidence is valid and simply returns nothing.
  assertAllowedValues('evidence_level', evidenceLevel, EVIDENCE_LEVELS);

  const offlineRaw = single('offline');
  if (offlineRaw !== null && !['yes', 'no', 'unknown'].includes(offlineRaw)) {
    throw ApiError.badRequest('`offline` must be one of yes, no, unknown.', { parameter: 'offline' });
  }
  const derivativeRaw = single('derivative');
  if (derivativeRaw !== null && !['yes', 'no'].includes(derivativeRaw)) {
    throw ApiError.badRequest('`derivative` must be one of yes, no.', { parameter: 'derivative' });
  }
  const sortRaw = single('sort');
  if (sortRaw !== null && !SEARCH_SORTS.includes(sortRaw as SearchSort)) {
    throw ApiError.badRequest('`sort` must be one of relevance, updated_at, evidence_freshness.', {
      parameter: 'sort',
      supported: SEARCH_SORTS,
    });
  }
  const q = single('q');
  if (q !== null && q.length > 200) {
    throw ApiError.badRequest('`q` must be at most 200 characters.', { parameter: 'q' });
  }

  return {
    q,
    type,
    category,
    model: list('model').map((value) => modelKeyFromHint(value)),
    runtime,
    hardware: list('hardware'),
    os,
    test_support: testSupport,
    evidence_level: evidenceLevel,
    offline: (offlineRaw as SearchFilters['offline']) ?? null,
    derivative: (derivativeRaw as SearchFilters['derivative']) ?? null,
    sort: (sortRaw as SearchSort) ?? (q ? 'relevance' : 'updated_at'),
  };
}

export function searchCursorBound(filters: SearchFilters): string {
  return cursorBound(filters as unknown as Record<string, unknown>);
}

/** `jsonb ?| text[]`: any of these strings is an element of the array column. */
function jsonbAny(column: AnyColumn, values: string[]): SQL {
  const literals = sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
  return sql`${column} ?| array[${literals}]::text[]`;
}

export interface SearchOutput {
  items: SearchResultRow[];
  hasMore: boolean;
  nextCursor: string | null;
  /** True when the projection is known to lag for some matching records. */
  projectionStale: boolean;
}

export async function searchProjects(
  filters: SearchFilters,
  page: PageRequest,
): Promise<SearchOutput> {
  const conditions: SQL[] = [sql`${searchDocuments.visibility} = 'published'`];

  if (filters.type.length > 0) {
    conditions.push(inArray(searchDocuments.type, filters.type));
  }
  if (filters.test_support.length > 0) {
    conditions.push(inArray(searchDocuments.testSupport, filters.test_support));
  }
  if (filters.evidence_level.length > 0) {
    conditions.push(inArray(searchDocuments.evidenceLevel, filters.evidence_level));
  }
  if (filters.offline !== null) {
    conditions.push(sql`${searchDocuments.offlineDeclared} = ${filters.offline}`);
  }
  if (filters.derivative !== null) {
    // Lineage is recorded per published version; the projection names the current one.
    const lineage = sql`exists (select 1 from derivative_relationships r where r.child_version_id = ${searchDocuments.projectVersionId})`;
    conditions.push(filters.derivative === 'yes' ? lineage : sql`not ${lineage}`);
  }
  if (filters.category.length > 0) conditions.push(jsonbAny(searchDocuments.categories, filters.category));
  if (filters.runtime.length > 0) conditions.push(jsonbAny(searchDocuments.runtimeFamilies, filters.runtime));
  if (filters.os.length > 0) conditions.push(jsonbAny(searchDocuments.operatingSystems, filters.os));
  if (filters.model.length > 0) conditions.push(jsonbAny(searchDocuments.modelKeys, filters.model));
  if (filters.hardware.length > 0) conditions.push(jsonbAny(searchDocuments.hardwareKeys, filters.hardware));

  const query = filters.q;
  const relevance = query
    ? sql<number>`ts_rank(${searchDocuments.searchVector}, websearch_to_tsquery('english', ${query}))`
    : sql<number>`null::float4`;
  if (query) {
    conditions.push(
      sql`${searchDocuments.searchVector} @@ websearch_to_tsquery('english', ${query})`,
    );
  }

  // Keyset pagination on (sort value, project_id) so a cursor is stable.
  if (page.cursor && page.cursor.values.length === 2) {
    const [sortValue, lastId] = page.cursor.values as [string | number, string];
    if (filters.sort === 'relevance' && query) {
      conditions.push(
        sql`(${relevance}, ${searchDocuments.projectId}) < (${Number(sortValue)}::float4, ${lastId}::uuid)`,
      );
    } else {
      conditions.push(
        sql`(${searchDocuments.projectUpdatedAt}, ${searchDocuments.projectId}) < (${new Date(String(sortValue))}, ${lastId}::uuid)`,
      );
    }
  }

  const orderBy =
    filters.sort === 'relevance' && query
      ? sql`${relevance} desc, ${searchDocuments.projectId} desc`
      : sql`${searchDocuments.projectUpdatedAt} desc, ${searchDocuments.projectId} desc`;

  const rows = await db()
    .select({
      project_id: searchDocuments.projectId,
      slug: searchDocuments.slug,
      name: searchDocuments.name,
      summary: searchDocuments.summary,
      type: searchDocuments.type,
      categories: searchDocuments.categories,
      runtime_families: searchDocuments.runtimeFamilies,
      architectures: searchDocuments.architectures,
      operating_systems: searchDocuments.operatingSystems,
      test_support: searchDocuments.testSupport,
      evidence_level: searchDocuments.evidenceLevel,
      offline_declared: searchDocuments.offlineDeclared,
      license_state: searchDocuments.licenseState,
      listing_origin: searchDocuments.listingOrigin,
      sources_pinned: searchDocuments.sourcesPinned,
      project_version_id: searchDocuments.projectVersionId,
      updated_at: searchDocuments.projectUpdatedAt,
      stale: searchDocuments.stale,
      relevance,
    })
    .from(searchDocuments)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(page.limit + 1);

  const hasMore = rows.length > page.limit;
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  const bound = searchCursorBound(filters);
  const nextCursor =
    hasMore && last
      ? encodeCursor(bound, [
          filters.sort === 'relevance' && query
            ? Number(last.relevance ?? 0)
            : new Date(last.updated_at).toISOString(),
          last.project_id,
        ])
      : null;

  return {
    items: items.map((row) => ({
      ...row,
      categories: (row.categories ?? []) as string[],
      runtime_families: (row.runtime_families ?? []) as string[],
      architectures: (row.architectures ?? []) as string[],
      operating_systems: (row.operating_systems ?? []) as string[],
      updated_at: new Date(row.updated_at).toISOString(),
      relevance: row.relevance === null ? null : Number(row.relevance),
    })) as SearchResultRow[],
    hasMore,
    nextCursor,
    projectionStale: items.some((row) => row.stale === true),
  };
}

export interface ProjectionInput {
  projectId: string;
  projectVersionId: string;
  visibility: string;
  slug: string;
  listingOrigin: string;
  derived: DerivedFacts;
  modelKeys: string[];
  hardwareKeys: string[];
  projectUpdatedAt: Date;
}

/**
 * Upsert the search projection for one project. Evidence level is derived
 * server-side: Phase 1 can only reach `documented` (pinned sources) or
 * `claimed`, because no accepted run evidence exists.
 */
export async function writeSearchDocument(conn: DbOrTx, input: ProjectionInput): Promise<void> {
  const derived = input.derived;
  const evidenceLevel = await strongestEvidenceLevel(
    conn,
    input.projectVersionId,
    derived.sources_pinned ? 'documented' : 'claimed',
  );
  await conn
    .insert(searchDocuments)
    .values({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      visibility: input.visibility,
      slug: input.slug,
      name: derived.name,
      summary: derived.summary,
      type: derived.type,
      categories: derived.categories,
      runtimeFamilies: derived.runtime_families,
      architectures: derived.architectures,
      operatingSystems: derived.operating_systems,
      capabilities: derived.required_capabilities,
      modelKeys: input.modelKeys,
      hardwareKeys: input.hardwareKeys,
      testSupport: derived.test_support,
      evidenceLevel,
      offlineDeclared: derived.offline_declared,
      licenseState: derived.license_state,
      listingOrigin: input.listingOrigin,
      sourcesPinned: derived.sources_pinned,
      searchVector: sql`to_tsvector('english', ${derived.search_text})` as unknown as string,
      projectUpdatedAt: input.projectUpdatedAt,
      indexedAt: new Date(),
      stale: false,
    })
    .onConflictDoUpdate({
      target: searchDocuments.projectId,
      set: {
        projectVersionId: input.projectVersionId,
        visibility: input.visibility,
        slug: input.slug,
        name: derived.name,
        summary: derived.summary,
        type: derived.type,
        categories: derived.categories,
        runtimeFamilies: derived.runtime_families,
        architectures: derived.architectures,
        operatingSystems: derived.operating_systems,
        capabilities: derived.required_capabilities,
        modelKeys: input.modelKeys,
        hardwareKeys: input.hardwareKeys,
        testSupport: derived.test_support,
        evidenceLevel,
        offlineDeclared: derived.offline_declared,
        licenseState: derived.license_state,
        listingOrigin: input.listingOrigin,
        sourcesPinned: derived.sources_pinned,
        searchVector: sql`to_tsvector('english', ${derived.search_text})` as unknown as string,
        projectUpdatedAt: input.projectUpdatedAt,
        indexedAt: new Date(),
        stale: false,
      },
    });
}

/**
 * Strongest accepted level for exactly this version, else the provenance level.
 * Evidence for an earlier version never raises a newer one.
 */
async function strongestEvidenceLevel(
  conn: DbOrTx,
  versionId: string,
  base: 'documented' | 'claimed',
): Promise<string> {
  const rows = await conn
    .select({ level: compatibilitySummaries.evidenceLevel })
    .from(compatibilitySummaries)
    .where(eq(compatibilitySummaries.projectVersionId, versionId));
  const levels = new Set(rows.map((row) => row.level));
  for (const level of ['independently_verified', 'reproducible_test', 'community_reported']) {
    if (levels.has(level)) return level;
  }
  return base;
}

/** Hidden or quarantined content is removed from the projection. */
export async function removeSearchDocument(conn: DbOrTx, projectId: string): Promise<void> {
  await conn.delete(searchDocuments).where(eq(searchDocuments.projectId, projectId));
}

export async function markProjectionStale(conn: DbOrTx, projectId: string): Promise<void> {
  await conn
    .update(searchDocuments)
    .set({ stale: true })
    .where(eq(searchDocuments.projectId, projectId));
}

/** Recompute a projection from authoritative rows; used by the index job. */
export async function reindexProject(projectId: string): Promise<'indexed' | 'removed' | 'missing'> {
  const [row] = await db()
    .select({
      projectId: projects.id,
      slug: projects.slug,
      visibility: projects.visibility,
      listingOrigin: projects.listingOrigin,
      updatedAt: projects.updatedAt,
      currentVersionId: projects.currentVersionId,
      derived: projectVersions.derived,
      versionId: projectVersions.id,
    })
    .from(projects)
    .leftJoin(projectVersions, eq(projects.currentVersionId, projectVersions.id))
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) return 'missing';
  if (row.visibility !== 'published' || !row.versionId || !row.derived) {
    await removeSearchDocument(db(), projectId);
    return 'removed';
  }
  const derived = row.derived as DerivedFacts;
  const [keys] = await db().execute<{ model_keys: string[]; hardware_keys: string[] }>(sql`
    select
      coalesce((select jsonb_agg(mr.key) from project_version_model_roles pvmr
        join model_references mr on mr.id = pvmr.model_reference_id
        where pvmr.project_version_id = ${row.versionId}), '[]'::jsonb) as model_keys,
      coalesce((select jsonb_agg(hd.key) from project_version_hardware pvh
        join hardware_descriptors hd on hd.id = pvh.hardware_descriptor_id
        where pvh.project_version_id = ${row.versionId}), '[]'::jsonb) as hardware_keys
  `).then((result) => (result.rows ?? result) as Array<{ model_keys: string[]; hardware_keys: string[] }>);

  await writeSearchDocument(db(), {
    projectId,
    projectVersionId: row.versionId,
    visibility: row.visibility,
    slug: row.slug,
    listingOrigin: row.listingOrigin,
    derived,
    modelKeys: keys?.model_keys ?? [],
    hardwareKeys: keys?.hardware_keys ?? [],
    projectUpdatedAt: row.updatedAt,
  });
  return 'indexed';
}
