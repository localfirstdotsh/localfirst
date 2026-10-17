/**
 * Domain error type and HTTP status mapping (BACKEND_PRD section 11).
 *
 * Compatibility `incompatible` and `unknown` are normal assessment outcomes,
 * not HTTP failures, so they never travel as errors.
 */

import { ERROR_CODES, type ErrorCode } from '@localfirst/contracts';

export interface ApiErrorInit {
  code: ErrorCode | string;
  message: string;
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Internal-only context for logs; never serialized to the client. */
  logContext?: Record<string, unknown>;
}

const STATUS_BY_CODE: Record<string, number> = {
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ERROR_CODES.UNAUTHENTICATED]: 401,
  [ERROR_CODES.INVALID_CREDENTIAL]: 401,
  [ERROR_CODES.INSUFFICIENT_SCOPE]: 403,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.ACCOUNT_SUSPENDED]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.PHASE_UNAVAILABLE]: 404,
  [ERROR_CODES.FEATURE_DISABLED]: 404,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.INVALID_LIFECYCLE]: 409,
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 409,
  [ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED]: 400,
  [ERROR_CODES.APPROVAL_REQUIRED]: 409,
  [ERROR_CODES.APPROVAL_EXPIRED]: 409,
  [ERROR_CODES.APPROVAL_STALE]: 409,
  [ERROR_CODES.APPROVAL_WARNINGS_UNACKNOWLEDGED]: 409,
  [ERROR_CODES.REVISION_PRECONDITION_REQUIRED]: 428,
  [ERROR_CODES.REVISION_PRECONDITION_FAILED]: 412,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.VALIDATION_FAILED]: 422,
  [ERROR_CODES.PUBLICATION_BLOCKED]: 422,
  [ERROR_CODES.PLAN_BLOCKED]: 422,
  [ERROR_CODES.QUARANTINED]: 409,
  [ERROR_CODES.DUPLICATE_CONTENT]: 409,
  [ERROR_CODES.SLUG_TAKEN]: 409,
  [ERROR_CODES.SOURCE_NOT_ALLOWED]: 422,
  [ERROR_CODES.SOURCE_UNAVAILABLE]: 422,
  [ERROR_CODES.SOURCE_TOO_LARGE]: 413,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.DEPENDENCY_UNAVAILABLE]: 503,
  [ERROR_CODES.DURABLE_WORK_UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL]: 500,
};

const RETRYABLE_CODES = new Set<string>([
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.DEPENDENCY_UNAVAILABLE,
  ERROR_CODES.DURABLE_WORK_UNAVAILABLE,
  ERROR_CODES.INTERNAL,
]);

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
  readonly logContext: Record<string, unknown> | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? STATUS_BY_CODE[init.code] ?? 500;
    this.retryable = init.retryable ?? RETRYABLE_CODES.has(init.code);
    this.details = init.details;
    this.headers = init.headers ?? {};
    this.logContext = init.logContext;
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError({ code: ERROR_CODES.BAD_REQUEST, message, details });
  }

  /**
   * Missing or inaccessible record. The same response covers an unimplemented
   * phase route so nothing private is disclosed (section 11).
   */
  static notFound(message = 'The requested record does not exist or is not accessible.'): ApiError {
    return new ApiError({ code: ERROR_CODES.NOT_FOUND, message });
  }

  static phaseUnavailable(feature: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.PHASE_UNAVAILABLE,
      message: `${feature} is not available in this phase of Localfirst.`,
      details: { feature, phase_status: 'not_implemented' },
    });
  }

  static unauthenticated(message = 'Authentication is required.', challenge?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.UNAUTHENTICATED,
      message,
      headers: challenge ? { 'WWW-Authenticate': challenge } : {},
    });
  }

  static invalidCredential(message = 'The supplied credential is not valid.', challenge?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INVALID_CREDENTIAL,
      message,
      headers: challenge ? { 'WWW-Authenticate': challenge } : {},
    });
  }

  static insufficientScope(required: string[], challenge?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INSUFFICIENT_SCOPE,
      message: `This operation requires the ${required.join(', ')} scope.`,
      details: { required_scopes: required },
      headers: challenge ? { 'WWW-Authenticate': challenge } : {},
    });
  }

  static forbidden(message = 'This account may not perform that action.'): ApiError {
    return new ApiError({ code: ERROR_CODES.FORBIDDEN, message });
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError({ code, message, status: STATUS_BY_CODE[code] ?? 409, details });
  }

  static validationFailed(issues: unknown, message = 'The submitted content is not valid.'): ApiError {
    return new ApiError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message,
      details: { issues },
    });
  }

  static internal(message = 'The request could not be completed.', logContext?: Record<string, unknown>): ApiError {
    return new ApiError({ code: ERROR_CODES.INTERNAL, message, logContext });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
