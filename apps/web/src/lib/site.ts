/**
 * The public origin of this website, used for canonical URLs and the sitemap.
 * Absolute URLs cannot be derived from a request here, so deployment sets it.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.LOCALFIRST_SITE_URL ?? 'http://localhost:3000';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    return url.origin;
  } catch {
    throw new Error('LOCALFIRST_SITE_URL must be an absolute http(s) URL.');
  }
}
