import { emptyQuery, selectedFilterCount, toPagePath, withoutSearchText, type CatalogQuery } from '../../lib/catalog-query';
import { categoryLabel } from './CategoryTabs';

/** Called only after a successful empty response. Registry emptiness takes precedence,
 * then search, additional filters, and a single category. Sort alone never narrows results. */
export function catalogEmptyState(query: CatalogQuery, hasProjects: boolean) {
  if (!hasProjects) return {
    title: 'No projects yet',
    description: "Projects will appear here once they're published.",
  };
  if (query.q) return {
    title: `No results for "${query.q}"`,
    description: 'Try a different search term or browse all projects.',
    action: { label: 'Clear search', href: toPagePath(withoutSearchText(query)) },
  };
  const category = query.filters.type.length === 1 ? query.filters.type[0] : null;
  if (selectedFilterCount(query) > (category ? 1 : 0)) return {
    title: 'No matching projects',
    description: 'Try adjusting your filters to find more projects.',
    action: { label: 'Clear filters', href: toPagePath({ ...emptyQuery(), sort: query.sort }) },
  };
  if (category) return {
    title: `No ${categoryLabel(category).toLowerCase()} yet`,
    description: "There aren't any projects in this category yet.",
    action: { label: 'Explore all projects', href: '/projects' },
  };
  // An exhausted cursor is not an empty registry.
  return {
    title: 'No more projects',
    description: "You've reached the end of these results.",
    action: { label: 'Explore all projects', href: '/projects' },
  };
}
