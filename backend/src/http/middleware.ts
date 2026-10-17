/**
 * Shared HTTP middleware (BACKEND_PRD sections 11, 17.3, 19.3).
 */

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { ErrorEnvelope, SuccessEnvelope } from '@localfirst/contracts';
import { ERROR_CODES } from '@localfirst/contracts';
import { config } from '../config.js';
import { createLogger, safeLogFields } from '../observability/logger.js';
import { recordRequest } from '../observability/metrics.js';
import { ApiError, isApiError } from './errors.js';
import type { AppEnv } from './context.js';
import { actorClientId, actorUserId } from './context.js';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { resolveClientIp } from './client-ip.js';

const log = createLogger('http');

export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export function success<T>(data: T, requestId: string, meta: Record<string, unknown> = {}): SuccessEnvelope<T> {
  return { data, meta: { request_id: requestId, ...meta } };
}

export function errorBody(
  error: ApiError,
  requestId: string,
): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
    meta: { request_id: requestId },
  };
}

export const requestContext = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const requestId = randomUUID();
  c.set('requestId', requestId);
  c.set('startedAt', Date.now());
  c.set('actor', { kind: 'anonymous' });
  const clientIp = resolveClientIp({
    peer: (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress,
    forwardedFor: c.req.header('x-forwarded-for'),
    trusted: config().trustedProxies?.list ?? null,
  });
  if (clientIp) c.set('clientIp', clientIp);
  c.header('X-Request-Id', requestId);
  await next();
};

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (config().isProduction) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
};

/** Explicit trusted origins only; never a wildcard with credentials. */
export const cors = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin && config().trustedOrigins.includes(origin);
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS' && origin) {
    if (!allowed) {
      // An untrusted origin gets no CORS grant and no execution.
      return c.body(null, 403);
    }
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Idempotency-Key, If-Match, MCP-Protocol-Version',
    );
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Expose-Headers', 'X-Request-Id, ETag, Location, Retry-After');
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  }
  await next();
  return undefined;
};

export const requestLogging = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  const actor = c.get('actor');
  const latencyMs = Date.now() - c.get('startedAt');
  const route = c.req.routePath ?? new URL(c.req.url).pathname;
  recordRequest(route, c.res.status, latencyMs);
  log.info(
    safeLogFields({
      request_id: c.get('requestId'),
      method: c.req.method,
      route,
      status: c.res.status,
      latency_ms: latencyMs,
      actor_kind: actor.kind,
      actor_user_id: actorUserId(actor),
      actor_client_id: actorClientId(actor),
      rate_limit_bucket: c.get('rateLimitBucket'),
    }),
    'request',
  );
};

/**
 * Refuse a declared length over the limit up front, and count the bytes of a
 * chunked or undeclared body as it arrives, stopping at the limit, so no
 * request body is buffered past it.
 */
export const bodyLimit = (maxBytes = MAX_REQUEST_BYTES): MiddlewareHandler<AppEnv> =>
  honoBodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw new ApiError({
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: `The request body exceeds ${maxBytes} bytes.`,
        details: { max_bytes: maxBytes },
        // The rest of the body is never read, so the connection cannot be reused.
        headers: { Connection: 'close' },
      });
    },
  });

/** JSON bodies only for domain mutations; everything else is 415. */
export const requireJson = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(c.req.method)) {
    const type = c.req.header('Content-Type') ?? '';
    const hasBody = c.req.header('Content-Length') !== '0';
    if (hasBody && type && !type.toLowerCase().startsWith('application/json')) {
      throw new ApiError({
        code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        message: 'Domain requests must use application/json.',
      });
    }
  }
  await next();
};

export function toErrorResponse(error: unknown, requestId: string): {
  body: ErrorEnvelope;
  status: number;
  headers: Record<string, string>;
} {
  if (isApiError(error)) {
    if (error.status >= 500) {
      log.error(
        safeLogFields({ request_id: requestId, code: error.code, ...(error.logContext ?? {}) }),
        'request failed',
      );
    }
    return { body: errorBody(error, requestId), status: error.status, headers: error.headers };
  }
  log.error(
    { request_id: requestId, error_class: (error as Error)?.name ?? 'unknown' },
    'unhandled error',
  );
  const internal = ApiError.internal();
  return { body: errorBody(internal, requestId), status: 500, headers: {} };
}
