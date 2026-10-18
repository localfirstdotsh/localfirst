import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

/** Private pages are dynamic, uncached, same-origin surfaces. Next applies this nonce to its own scripts. */
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'", "img-src 'self' data:", "form-action 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-browser-query', request.nextUrl.search.slice(1));
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export const config = { matcher: ['/sign-in', '/consent', '/account/:path*', '/review/:path*', '/privacy'] };
