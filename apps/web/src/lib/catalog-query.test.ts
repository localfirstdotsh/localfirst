import { describe, expect, it } from 'vitest';
import {
  advancedFilterCount,
  emptyQuery,
  parseCatalogQuery,
  selectedFilterCount,
  toApiSearchParams,
  toPagePath,
  withoutAdvancedFilters,
  withoutFilter,
  withType,
} from './catalog-query';

describe('parseCatalogQuery', () => {
  it('accepts supported filters, repeated or comma separated, and de-duplicates', () => {
    const { query, rejected } = parseCatalogQuery({
      runtime: ['ollama', 'lmstudio,ollama'],
      evidence_level: 'documented',
      q: '  jetson  ',
    });
    expect(rejected).toEqual([]);
    expect(query.filters.runtime).toEqual(['ollama', 'lmstudio']);
    expect(query.filters.evidence_level).toEqual(['documented']);
    expect(query.q).toBe('jetson');
  });

  it('reports unsupported parameters and values instead of broadening the query', () => {
    const { query, rejected } = parseCatalogQuery({
      runtime: 'not-a-runtime',
      page: '2',
      sort: 'popularity',
      hardware: 'has space',
    });
    expect(query.filters.runtime).toEqual([]);
    expect(query.sort).toBeNull();
    expect(rejected).toEqual(
      expect.arrayContaining(['page', 'runtime=not-a-runtime', 'sort=popularity', 'hardware=has space']),
    );
  });

  it('accepts stable open keys for model and hardware but never display strings', () => {
    const { query } = parseCatalogQuery({ hardware: 'apple-silicon', model: 'llama3.2:3b' });
    expect(query.filters.hardware).toEqual(['apple-silicon']);
    expect(query.filters.model).toEqual(['llama3.2:3b']);
  });

  it('rejects an over-long search text', () => {
    const { query, rejected } = parseCatalogQuery({ q: 'x'.repeat(201) });
    expect(query.q).toBeNull();
    expect(rejected).toContain('q (too long)');
  });
});

describe('serialization', () => {
  it('joins OR values with commas for the API and always sets a bounded limit', () => {
    const { query } = parseCatalogQuery({ runtime: ['ollama', 'lmstudio'], q: 'edge' });
    const params = toApiSearchParams(query);
    expect(params.get('runtime')).toBe('ollama,lmstudio');
    expect(params.get('q')).toBe('edge');
    expect(params.get('limit')).toBe('20');
    expect(params.has('cursor')).toBe(false);
  });

  it('drops the cursor when a filter changes, so a cursor from another query is never reused', () => {
    const { query } = parseCatalogQuery({ runtime: 'ollama', type: 'workflow', cursor: 'abc' });
    expect(query.cursor).toBe('abc');
    const changed = withoutFilter(query, 'type', 'workflow');
    expect(changed.cursor).toBeNull();
    expect(toPagePath(changed)).toBe('/projects?runtime=ollama');
  });

  it('keeps the cursor only when asked, for next-page links', () => {
    const { query } = parseCatalogQuery({ runtime: 'ollama', cursor: 'abc' });
    expect(toPagePath(query)).toBe('/projects?runtime=ollama');
    expect(toPagePath(query, { keepCursor: true })).toBe('/projects?runtime=ollama&cursor=abc');
  });

  it('serializes an empty query to the bare path', () => {
    expect(toPagePath(emptyQuery())).toBe('/projects');
  });
});

describe('selectedFilterCount', () => {
  it('counts selected filter values but not the search text', () => {
    const { query } = parseCatalogQuery({ runtime: ['ollama', 'lmstudio'], type: 'workflow', q: 'edge' });
    expect(selectedFilterCount(query)).toBe(3);
    expect(selectedFilterCount(emptyQuery())).toBe(0);
  });
});

describe('discovery helpers', () => {
  const { query } = parseCatalogQuery({ q: 'jetson', type: 'workflow', runtime: 'ollama', os: 'linux', sort: 'updated_at', model: 'm1' });

  it('switching category keeps search, filters, and sort, and drops the cursor', () => {
    const next = withType({ ...query, cursor: 'abc' }, 'robotics');
    expect(toPagePath(next)).toBe('/projects?q=jetson&type=robotics&runtime=ollama&os=linux&model=m1&sort=updated_at');
    expect(next.cursor).toBeNull();
  });

  it('All removes only the category', () => {
    expect(withType(query, null).filters.type).toEqual([]);
    expect(withType(query, null).filters.runtime).toEqual(['ollama']);
  });

  it('counts and clears only the advanced filters', () => {
    expect(advancedFilterCount(query)).toBe(2);
    const cleared = withoutAdvancedFilters(query);
    expect(advancedFilterCount(cleared)).toBe(0);
    expect(cleared.filters.type).toEqual(['workflow']);
    expect(cleared.filters.model).toEqual(['m1']);
    expect(cleared.q).toBe('jetson');
    expect(cleared.sort).toBe('updated_at');
  });
});
