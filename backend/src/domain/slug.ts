/**
 * Public project slugs (BACKEND_PRD section 16.2: unique stable project slug).
 */

const RESERVED = new Set([
  'new',
  'api',
  'mcp',
  'admin',
  'schemas',
  'health',
  'metrics',
  'sign-in',
  'consent',
  'review',
  'account',
  'openapi',
  'by-slug',
  'projects',
  'models',
  'hardware',
  'runtimes',
  'drafts',
  'builds',
  'collections',
  'comparisons',
]);

export function slugify(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `project-${base}`.slice(0, 60);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug);
}

/** Deterministic candidate list; the first unused candidate wins. */
export function slugCandidates(name: string, projectKey: string): string[] {
  const primary = slugify(name);
  const secondary = slugify(projectKey);
  const candidates = [primary, secondary, `${primary}-${secondary}`];
  const unique = [...new Set(candidates.filter((candidate) => !isReservedSlug(candidate)))];
  return unique.length > 0 ? unique : [`${primary}-project`];
}
