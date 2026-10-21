import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';
import { DOCS_GUIDES } from '../lib/docs';

// Deployment origin is read per request. Shared projects are not enumerated here.
export const dynamic = 'force-dynamic';

const PUBLIC_ROUTES = ['/', '/privacy', '/docs', ...DOCS_GUIDES.map((guide) => guide.href)] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return PUBLIC_ROUTES.map((path) => ({ url: `${base}${path === '/' ? '' : path}` }));
}
