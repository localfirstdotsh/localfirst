import type { MetadataRoute } from 'next';
import { listAllProjects } from '../lib/api';
import { siteUrl } from '../lib/site';
import { DOCS_GUIDES } from '../lib/docs';

// Built per request from the live registry; hidden and removed projects never appear.
export const dynamic = 'force-dynamic';

const STATIC_ROUTES = ['/', '/projects', '/models', '/hardware', '/builds', '/privacy', '/docs', ...DOCS_GUIDES.map((guide) => guide.href)] as const;

/**
 * Visible public records only (FRONTEND_PRD section 18.3). Exact-version pages are left
 * out on purpose: they are reachable from each project, and listing them would
 * present historical content as if it were current. If the registry is
 * unreachable the static pages are still listed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const entries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({ url: `${base}${path === '/' ? '' : path}` }));
  try {
    for (const project of await listAllProjects()) {
      entries.push({
        url: `${base}/projects/${encodeURIComponent(project.slug)}`,
        lastModified: new Date(project.updated_at),
      });
    }
  } catch {
    // Fall through with the static entries rather than failing the sitemap.
  }
  return entries;
}
