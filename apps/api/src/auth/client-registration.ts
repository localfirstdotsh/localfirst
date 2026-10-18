/**
 * Dynamic client registration defaults (BACKEND_PRD section 10.5).
 *
 * OAuth treats a client that registers without `application_type` as a web
 * client, and web clients may not use `http://localhost` callbacks. MCP
 * applications such as CLIs receive the callback on the person's own machine
 * through a loopback listener: they are native apps (RFC 8252). When a
 * registration names no application type and every redirect URI is an http
 * loopback address, it is registered as native, so the library applies its
 * native-client rules (loopback http only, PKCE) instead of refusing it.
 * Anything else is passed through unchanged.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isHttpLoopback(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function withNativeLoopbackDefault(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const registration = body as Record<string, unknown>;
  if (registration.application_type !== undefined) return body;
  const uris = registration.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return body;
  return { ...registration, application_type: 'native' };
}
