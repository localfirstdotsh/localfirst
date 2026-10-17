import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';

// Not prerendered: the sitemap URL comes from LOCALFIRST_SITE_URL, which is set at deploy time,
// and a prerendered robots.txt would bake in whatever the build machine had.
export const dynamic = 'force-dynamic';

/** Private browser surfaces are excluded from discovery (FRONTEND_PRD section 18.3). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/account', '/review', '/consent', '/sign-in', '/design-system'] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
