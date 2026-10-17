/**
 * What the consent screen can honestly say about an OAuth client.
 *
 * With dynamic registration on, anyone can register a client with any name, so
 * the name proves nothing. What the person can check is where their approval
 * goes: the registered callback addresses. This module turns those into a kind
 * the screen can show. "Recognized" means every callback is on a host that
 * belongs to a well-known app; it is not a verification of who registered the
 * client.
 */

export type ClientKind = 'local' | 'recognized' | 'unrecognized';

export interface ClientIdentity {
  kind: ClientKind;
  /** The known app that owns every callback host, for `recognized`. */
  label: string | null;
  /** Where approval is sent, for display: hosts, or `scheme://` for custom schemes. */
  destinations: string[];
  /** A well-known app name this client's own name imitates while sending you elsewhere. */
  claims_to_be: string | null;
}

/** Hosts that belong to the app, from each vendor's documented OAuth callback. */
const KNOWN_HOSTS: Readonly<Record<string, string>> = {
  'claude.ai': 'Claude',
  'chatgpt.com': 'ChatGPT',
  'www.cursor.com': 'Cursor',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(uri: unknown): URL | null {
  if (typeof uri !== 'string') return null;
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

export function describeClient(input: { name: string | null; redirectUris: unknown }): ClientIdentity {
  const urls = (Array.isArray(input.redirectUris) ? input.redirectUris : []).map(parse);
  const valid = urls.filter((url): url is URL => url !== null);
  const destinations = [...new Set(valid.map((url) => (url.protocol === 'http:' || url.protocol === 'https:' ? url.host : `${url.protocol}//`)))];
  const complete = valid.length > 0 && valid.length === urls.length;

  if (complete && valid.every((url) => url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return { kind: 'local', label: null, destinations, claims_to_be: null };
  }
  const labels = valid.map((url) => (url.protocol === 'https:' ? KNOWN_HOSTS[url.hostname] : undefined));
  if (complete && labels.every((label) => label !== undefined) && new Set(labels).size === 1) {
    return { kind: 'recognized', label: labels[0] ?? null, destinations, claims_to_be: null };
  }
  const name = (input.name ?? '').toLowerCase();
  const imitated = Object.values(KNOWN_HOSTS).find((label) => name.includes(label.toLowerCase())) ?? null;
  return { kind: 'unrecognized', label: null, destinations, claims_to_be: imitated };
}
