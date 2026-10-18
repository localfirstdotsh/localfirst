/**
 * Liveness for the platform's health check. It reports only that this server is running: it makes
 * no call to the registry, so an API outage never makes the platform restart a healthy website,
 * and the site's own "registry is unavailable" states stay visible instead of a failed deploy.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
