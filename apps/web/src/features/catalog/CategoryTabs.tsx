import Link from 'next/link';
import { FILTER_VOCABULARY, toPagePath, withType, type CatalogQuery } from '../../lib/catalog-query';
import { humanize } from '../../lib/format';

/** Presentation only: which values exist comes from the contracts vocabulary, not from here. */
const PLURAL: Record<string, string> = {
  application: 'Applications',
  workflow: 'Workflows',
  demo: 'Demos',
  experiment: 'Experiments',
  hardware_build: 'Hardware',
  documentation: 'Documentation',
};

/**
 * Project categories, a single choice on the `type` filter. Plain links keep the rest of the
 * query (search, advanced filters, sort) and need no JavaScript. On a narrow screen the row
 * scrolls sideways instead of wrapping.
 */
export function CategoryTabs({ query }: { query: CatalogQuery }) {
  const selected = query.filters.type.length === 1 ? query.filters.type[0]! : null;
  const allActive = query.filters.type.length === 0;
  const items = [
    { value: null as string | null, label: 'All', active: allActive },
    ...FILTER_VOCABULARY.type.map((value) => ({ value: value as string | null, label: PLURAL[value] ?? humanize(value), active: selected === value })),
  ];
  return (
    <nav aria-label="Project categories" className="category-tabs">
      <ul>
        {items.map((item) => (
          <li key={item.value ?? 'all'}>
            <Link href={toPagePath(withType(query, item.value))} aria-current={item.active ? 'true' : undefined} scroll={false}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
