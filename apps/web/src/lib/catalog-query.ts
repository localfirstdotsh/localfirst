import {
  EVIDENCE_LEVELS,
  OPERATING_SYSTEMS,
  PROJECT_TYPES,
  RUNTIME_FAMILIES,
  TASK_CATEGORIES,
  TEST_SUPPORT_KINDS,
} from '@localfirst/contracts';

/**
 * Catalog filter state lives in the URL (FRONTEND_PRD section 5.3). Only
 * parameters the API supports are accepted, and values come from the controlled
 * vocabulary; anything else is reported instead of silently broadening a query.
 */

export const FILTER_VOCABULARY = {
  type: PROJECT_TYPES,
  category: TASK_CATEGORIES,
  runtime: RUNTIME_FAMILIES,
  os: OPERATING_SYSTEMS,
  test_support: TEST_SUPPORT_KINDS,
  evidence_level: EVIDENCE_LEVELS,
} as const satisfies Record<string, readonly string[]>;

/** Filters without a closed vocabulary: stable returned keys, validated by shape. */
const OPEN_FILTERS = ['model', 'hardware'] as const;
const OPEN_KEY = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;

export type ClosedFilterKey = keyof typeof FILTER_VOCABULARY;
export type OpenFilterKey = (typeof OPEN_FILTERS)[number];
export type FilterKey = ClosedFilterKey | OpenFilterKey;
export const FILTER_KEYS: readonly FilterKey[] = [
  ...(Object.keys(FILTER_VOCABULARY) as ClosedFilterKey[]),
  ...OPEN_FILTERS,
];

export const SORTS = ['relevance', 'updated_at', 'evidence_freshness'] as const;
export type Sort = (typeof SORTS)[number];

/**
 * Filters behind the Filters popover. `type` is the category row and the open keys
 * (`model`, `hardware`) have no control; both are carried through the form unchanged.
 */
export const ADVANCED_FILTER_KEYS = ['runtime', 'os', 'category', 'test_support', 'evidence_level'] as const satisfies readonly ClosedFilterKey[];

export const PAGE_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 512;

export interface CatalogQuery {
  q: string | null;
  filters: Record<FilterKey, string[]>;
  sort: Sort | null;
  cursor: string | null;
}

export interface ParsedCatalogQuery {
  query: CatalogQuery;
  /** Parameters or values that were dropped, for an explanation in the UI. */
  rejected: string[];
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function emptyQuery(): CatalogQuery {
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, [] as string[]])) as Record<
    FilterKey,
    string[]
  >;
  return { q: null, filters, sort: null, cursor: null };
}

function values(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function first(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseCatalogQuery(raw: RawSearchParams): ParsedCatalogQuery {
  const query = emptyQuery();
  const rejected: string[] = [];
  const known = new Set<string>(['q', 'sort', 'cursor', ...FILTER_KEYS]);

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rejected.push(key);
  }

  for (const key of FILTER_KEYS) {
    const vocabulary = (FILTER_VOCABULARY as Record<string, readonly string[]>)[key];
    const seen = new Set<string>();
    for (const value of values(raw[key])) {
      const valid = vocabulary ? vocabulary.includes(value) : OPEN_KEY.test(value);
      if (!valid) {
        rejected.push(`${key}=${value.slice(0, 40)}`);
        continue;
      }
      if (!seen.has(value)) {
        seen.add(value);
        query.filters[key].push(value);
      }
    }
  }

  const q = first(raw.q);
  if (q !== null) {
    if (q.length > MAX_QUERY_LENGTH) rejected.push('q (too long)');
    else query.q = q;
  }

  const sort = first(raw.sort);
  if (sort !== null) {
    if ((SORTS as readonly string[]).includes(sort)) query.sort = sort as Sort;
    else rejected.push(`sort=${sort.slice(0, 40)}`);
  }

  const cursor = first(raw.cursor);
  if (cursor !== null && cursor.length <= MAX_CURSOR_LENGTH) query.cursor = cursor;

  return { query, rejected };
}

/** Parameters for the registry API: repeated values joined with commas (OR within a field). */
export function toApiSearchParams(query: CatalogQuery, limit: number = PAGE_LIMIT): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const key of FILTER_KEYS) {
    if (query.filters[key].length > 0) params.set(key, query.filters[key].join(','));
  }
  if (query.sort) params.set('sort', query.sort);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(limit));
  return params;
}

/**
 * Browser URL for a query. A changed filter, search, or sort never carries a
 * cursor: a cursor from another query must not be reused (section 5.3).
 */
export function toPagePath(query: CatalogQuery, options: { keepCursor?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const key of FILTER_KEYS) {
    for (const value of query.filters[key]) params.append(key, value);
  }
  if (query.sort) params.set('sort', query.sort);
  if (options.keepCursor && query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return qs ? `/projects?${qs}` : '/projects';
}

export function withoutFilter(query: CatalogQuery, key: FilterKey, value: string): CatalogQuery {
  return {
    ...query,
    cursor: null,
    filters: { ...query.filters, [key]: query.filters[key].filter((entry) => entry !== value) },
  };
}

export function withoutSearchText(query: CatalogQuery): CatalogQuery {
  return { ...query, q: null, cursor: null };
}

/** Selected filter values only; search text is not a filter. */
export function selectedFilterCount(query: CatalogQuery): number {
  return FILTER_KEYS.reduce((total, key) => total + query.filters[key].length, 0);
}

export function activeFilterCount(query: CatalogQuery): number {
  return selectedFilterCount(query) + (query.q ? 1 : 0);
}

/** Selected values behind the Filters popover; the category row is counted separately. */
export function advancedFilterCount(query: CatalogQuery): number {
  return ADVANCED_FILTER_KEYS.reduce((total, key) => total + query.filters[key].length, 0);
}

/** Same query with one category (project type), or none for "All". Other state is kept. */
export function withType(query: CatalogQuery, type: string | null): CatalogQuery {
  return { ...query, cursor: null, filters: { ...query.filters, type: type ? [type] : [] } };
}

/** Same query without any advanced filter; search, category, and sort are kept. */
export function withoutAdvancedFilters(query: CatalogQuery): CatalogQuery {
  const filters = { ...query.filters };
  for (const key of ADVANCED_FILTER_KEYS) filters[key] = [];
  return { ...query, cursor: null, filters };
}
