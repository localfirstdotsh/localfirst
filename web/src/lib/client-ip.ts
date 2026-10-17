import { headers } from 'next/headers';
import { isIP } from 'node:net';

/**
 * The visitor's address, forwarded to the registry API so that its per-client rate limits
 * apply to each visitor and not to this web server (BACKEND_PRD section 19.2).
 *
 * Without this, every request the site makes arrives from one address, so all visitors share
 * a single anonymous allowance. It is off by default. A deployment turns it on by naming a header
 * that its own edge sets or overwrites, so a visitor cannot choose the value:
 *
 *   LOCALFIRST_CLIENT_IP_HEADER=cf-connecting-ip      (behind Cloudflare)
 *
 * `X-Forwarded-For` is refused: every hop appends to it and its left side is whatever the visitor
 * sent, so trusting it would let anyone pick their own rate-limit bucket. The API ignores the
 * forwarded address unless this server's hop is in its TRUSTED_PROXIES, so setting only this
 * variable changes nothing until both sides are configured.
 */

const FORBIDDEN = new Set(['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto']);

/** The configured header name, or null when forwarding is off or the setting is unusable. */
export function clientIpHeaderName(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.LOCALFIRST_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9-]{1,60}$/.test(raw)) return null;
  if (FORBIDDEN.has(raw)) return null;
  return raw;
}

/** A single valid IP address from a header value, or null. Never a list, name, or port. */
export function parseVisitorIp(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.includes(',') || candidate.length > 45) return null;
  return isIP(candidate) === 0 ? null : candidate;
}

/** The visitor's address for the request being served, or null when there is none to forward. */
export async function visitorIp(): Promise<string | null> {
  const name = clientIpHeaderName();
  if (!name) return null;
  try {
    return parseVisitorIp((await headers()).get(name));
  } catch {
    // Outside a request (tests, build): there is no visitor.
    return null;
  }
}
