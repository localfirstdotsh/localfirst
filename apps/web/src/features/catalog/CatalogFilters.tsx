import Link from 'next/link';
import {
  ADVANCED_FILTER_KEYS,
  FILTER_VOCABULARY,
  advancedFilterCount,
  toPagePath,
  withoutAdvancedFilters,
  withoutFilter,
  withoutSearchText,
  type CatalogQuery,
  type ClosedFilterKey,
  type FilterKey,
} from '../../lib/catalog-query';
import { humanize } from '../../lib/format';
import { CategoryTabs } from './CategoryTabs';
import { FilterPopover } from './FilterPopover';
import { SearchField } from './SearchField';
import { SortSelect, type SortOption } from './SortSelect';

const FIELD_LABELS: Record<ClosedFilterKey, string> = {
  type: 'Category',
  category: 'AI task',
  runtime: 'Runtime',
  os: 'Operating system',
  test_support: 'Test support',
  evidence_level: 'Evidence',
};

function filterLabel(key: FilterKey, value: string): string {
  const field = key in FIELD_LABELS ? FIELD_LABELS[key as ClosedFilterKey] : humanize(key);
  return `${field}: ${humanize(value)}`;
}

/**
 * Only orderings the registry implements. Without a search or filter it always lists by last
 * update, so the control says so and is disabled rather than offering choices that do nothing.
 */
const SORT_OPTIONS: SortOption[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'updated_at', label: 'Recently updated' },
  { value: 'evidence_freshness', label: 'Recent evidence' },
];

/**
 * Search, categories, advanced filters, and sort share one GET form, so the whole state is in
 * the URL and works without JavaScript. Filters are applied explicitly (Apply); search, a
 * category, and sort apply immediately. Values with no control here (the category row and the
 * open model/hardware keys) ride along as hidden inputs so submitting never drops them.
 */
export function CatalogControls({ query, action = '/projects' }: { query: CatalogQuery; action?: string }) {
  const narrowed = Boolean(query.q) || hasFilters(query);
  const count = advancedFilterCount(query);
  return (
    <div className="stack gap-16">
      <form action={action} method="get" role="search" aria-label="Search and filter projects" className="stack gap-16">
        <SearchField defaultValue={query.q ?? ''} clearHref={toPagePath(withoutSearchText(query))} />
        {(['type', 'model', 'hardware'] as const).flatMap((key) =>
          query.filters[key].map((value) => <input key={`${key}:${value}`} type="hidden" name={key} value={value} />),
        )}
        <div className="discovery-toolbar">
          <CategoryTabs query={query} />
          <div className="toolbar">
            <FilterPopover label="Filters" badge={count}>
              <div className="popover-body">
                {ADVANCED_FILTER_KEYS.map((key) => {
                  const selected = query.filters[key].length;
                  return (
                    <details key={key} className="filter-group" open={selected > 0}>
                      <summary>
                        {FIELD_LABELS[key]}
                        {selected > 0 && <span className="count">{selected}</span>}
                      </summary>
                      <fieldset>
                        <legend className="visually-hidden">{FIELD_LABELS[key]}</legend>
                        {FILTER_VOCABULARY[key].map((value) => (
                          <label key={value}>
                            <input type="checkbox" name={key} value={value} defaultChecked={query.filters[key].includes(value)} />
                            {humanize(value)}
                          </label>
                        ))}
                      </fieldset>
                    </details>
                  );
                })}
              </div>
              <div className="popover-actions">
                <button type="submit" className="button button-primary">
                  Apply filters
                </button>
                {count > 0 && (
                  <Link href={toPagePath(withoutAdvancedFilters(query))} className="button">
                    Clear filters
                  </Link>
                )}
              </div>
            </FilterPopover>
            <SortSelect
              options={narrowed ? SORT_OPTIONS : SORT_OPTIONS.filter((option) => option.value === 'updated_at')}
              value={narrowed ? (query.sort ?? 'relevance') : 'updated_at'}
              disabled={!narrowed}
              hint={narrowed ? undefined : 'Without a search or filter, projects are listed by last update.'}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

function hasFilters(query: CatalogQuery): boolean {
  return Object.values(query.filters).some((values) => values.length > 0);
}

/** Active filters with individual removal and Clear (FRONTEND_PRD section 5.2). */
export function ActiveFilters({ query }: { query: CatalogQuery }) {
  const chips: Array<{ key: string; label: string; href: string }> = [];
  if (query.q) chips.push({ key: 'q', label: `Search: ${query.q}`, href: toPagePath(withoutSearchText(query)) });
  for (const key of Object.keys(query.filters) as FilterKey[]) {
    // A single category is already shown as the selected tab.
    if (key === 'type' && query.filters.type.length === 1) continue;
    for (const value of query.filters[key]) {
      chips.push({ key: `${key}:${value}`, label: filterLabel(key, value), href: toPagePath(withoutFilter(query, key, value)) });
    }
  }
  if (chips.length === 0) return null;
  return (
    <div className="chips" aria-label="Active filters">
      {chips.map((chip) => (
        <Link key={chip.key} href={chip.href} className="chip-link" aria-label={`Remove filter ${chip.label}`}>
          {chip.label} ✕
        </Link>
      ))}
      <Link href="/projects">Clear all</Link>
    </div>
  );
}
