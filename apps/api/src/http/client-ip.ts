/**
 * The client address behind trusted proxies (BACKEND_PRD sections 17.1 and
 * 19.2: per-ingress quotas must not be bypassable).
 *
 * `X-Forwarded-For` is written left to right by every hop, and anything left
 * of the last trusted proxy is whatever the client chose to send. So the
 * chain (forwarded addresses, then the socket peer) is read from the right,
 * skipping addresses that belong to a configured trusted proxy; the first
 * address that is not one is the client. With no trusted proxies configured
 * the socket peer is the client and every forwarding header is ignored.
 */

import { BlockList, isIP } from 'node:net';

/** Header the app sets for Better Auth after computing the address itself. */
export const CLIENT_IP_HEADER = 'x-localfirst-client-ip';

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and
 * /ips-v6, fetched 2026-10-12). Cloudflare changes them rarely and announces
 * changes; refresh this list when it does.
 */
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

/** Private and loopback ranges, where a platform's internal load balancer lives. */
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', 'fc00::/7', '::1/128'];

const PRESETS: Record<string, string[]> = { cloudflare: CLOUDFLARE, private: PRIVATE };

/** Parse `TRUSTED_PROXIES`: CIDRs, single addresses, and the `cloudflare` / `private` presets. */
export function parseTrustedProxies(spec: string | undefined): { list: BlockList; entries: string[] } | null {
  const tokens = (spec ?? '').split(',').map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const list = new BlockList();
  const entries: string[] = [];
  for (const token of tokens) {
    for (const entry of PRESETS[token.toLowerCase()] ?? [token]) {
      const [address, prefix] = entry.split('/');
      const family = isIP(address ?? '');
      if (family === 0) throw new Error(`TRUSTED_PROXIES: \`${entry}\` is not an address, a CIDR, or a preset (cloudflare, private)`);
      const type = family === 6 ? 'ipv6' : 'ipv4';
      const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32)) {
        throw new Error(`TRUSTED_PROXIES: \`${entry}\` has an invalid prefix length`);
      }
      list.addSubnet(address!, bits, type);
      entries.push(entry);
    }
  }
  return { list, entries };
}

/** A bare address: IPv4-mapped IPv6 unwrapped, brackets and zone stripped; null if not an address. */
function normalize(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  value = value.split('%')[0]!;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) value = value.slice(7);
  return isIP(value) === 0 ? null : value;
}

function isTrusted(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The client address, or undefined when none can be trusted. `peer` is the
 * socket's remote address; `forwardedFor` the raw `X-Forwarded-For` value.
 */
export function resolveClientIp(input: {
  peer: string | undefined;
  forwardedFor: string | null | undefined;
  trusted: BlockList | null;
}): string | undefined {
  const peer = normalize(input.peer);
  if (!input.trusted || !peer || !isTrusted(input.trusted, peer)) return peer ?? undefined;
  const chain = (input.forwardedFor ?? '').split(',');
  let nearest = peer;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = normalize(chain[index]);
    // A malformed entry can only come from beyond the last trusted hop: stop at
    // the nearest trusted proxy rather than guess.
    if (!address) return nearest;
    if (!isTrusted(input.trusted, address)) return address;
    nearest = address;
  }
  return nearest;
}
