/**
 * Bounded, allowlisted outbound retrieval (BACKEND_PRD section 15.3).
 *
 * Only allowlisted provider endpoints are reachable. Redirects are rejected
 * rather than followed, destination addresses must be public, bodies are size
 * capped, and every request has a timeout. Arbitrary documentation links are
 * never server-fetched in Phase 1.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SourceFetchError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'SourceFetchError';
    this.code = code;
    this.status = status;
  }
}

/** Hosts the backend may contact for public source ingestion. */
export const ALLOWED_SOURCE_HOSTS = new Set(['api.github.com']);

export const FETCH_LIMITS = {
  perFileBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  maxFiles: 100,
  requestTimeoutMs: 10_000,
  attemptDeadlineMs: 5 * 60 * 1000,
} as const;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('::ffff:')
    );
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Validate scheme, host allowlist, and resolved destination addresses. */
export async function assertAllowedSourceUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'The source URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Only https source URLs are retrieved.');
  }
  if (url.username || url.password) {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      'A source URL carrying credentials is rejected.',
    );
  }
  if (!ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      `\`${url.hostname}\` is not an allowlisted source host.`,
    );
  }
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source host could not be resolved.');
  }
  for (const address of addresses) {
    if (isPrivateAddress(address.address)) {
      throw new SourceFetchError(
        'SOURCE_NOT_ALLOWED',
        'The source host resolves to a non-public address.',
      );
    }
  }
  return url;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  status: number;
  body: string;
  bytes: number;
}

/** GET an allowlisted URL with no redirect following and a hard body cap. */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const url = await assertAllowedSourceUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? FETCH_LIMITS.requestTimeoutMs,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      // A redirect could leave the allowlist, so it is an error, not a hop.
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'localfirst-registry/0.2 (+https://localfirst.sh)',
        ...options.headers,
      },
    });
    const maxBytes = options.maxBytes ?? FETCH_LIMITS.perFileBytes;
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > maxBytes) {
      await response.body?.cancel();
      throw new SourceFetchError(
        'SOURCE_TOO_LARGE',
        `The source response exceeds ${maxBytes} bytes.`,
        response.status,
      );
    }
    // Enforce the cap while reading, including chunked responses with no length.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new SourceFetchError('SOURCE_TOO_LARGE', `The source response exceeds ${maxBytes} bytes.`, response.status);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { status: response.status, body, bytes };
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    const name = (error as Error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source request timed out.');
    }
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source could not be retrieved.');
  } finally {
    clearTimeout(timeout);
  }
}
