/**
 * Response envelope, cursors, and ETag helpers (BACKEND_PRD section 11).
 */

import { digestOf, PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from '@localfirst/contracts';
import { ApiError } from './errors.js';

export interface PageRequest {
  limit: number;
  cursor: DecodedCursor | null;
}

export interface DecodedCursor {
  /** Digest of the filter/sort set this cursor was issued for. */
  bound: string;
  values: Array<string | number>;
}

/** Cursors are opaque and bound to their filter and sort set. */
export function encodeCursor(bound: string, values: Array<string | number>): string {
  return Buffer.from(JSON.stringify({ v: 1, b: bound, k: values }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, bound: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw ApiError.badRequest('The cursor is not valid.', { parameter: 'cursor' });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { b?: unknown }).b !== 'string' ||
    !Array.isArray((parsed as { k?: unknown }).k)
  ) {
    throw ApiError.badRequest('The cursor is not valid.', { parameter: 'cursor' });
  }
  const record = parsed as { b: string; k: unknown[] };
  if (record.b !== bound) {
    throw ApiError.badRequest('The cursor does not match the current filters or sort order.', {
      parameter: 'cursor',
    });
  }
  return {
    bound: record.b,
    values: record.k.filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    ),
  };
}

/** Digest of the filter/sort set, used to bind cursors to a query shape. */
export function cursorBound(query: Record<string, unknown>): string {
  return digestOf(query).slice('sha256:'.length, 'sha256:'.length + 16);
}

export function parsePageRequest(
  params: { limit?: string | undefined; cursor?: string | undefined },
  bound: string,
): PageRequest {
  let limit = PAGE_DEFAULT_LIMIT;
  if (params.limit !== undefined && params.limit !== '') {
    const parsed = Number(params.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > PAGE_MAX_LIMIT) {
      throw ApiError.badRequest(`limit must be an integer between 1 and ${PAGE_MAX_LIMIT}.`, {
        parameter: 'limit',
      });
    }
    limit = parsed;
  }
  return {
    limit,
    cursor: params.cursor ? decodeCursor(params.cursor, bound) : null,
  };
}

/** Weak ETag over a draft revision, used for If-Match preconditions. */
export function revisionEtag(revision: number): string {
  return `W/"rev-${revision}"`;
}

export function parseIfMatchRevision(header: string | undefined | null): number | null {
  if (!header) return null;
  const match = /^W\/"rev-(\d+)"$/.exec(header.trim());
  if (!match) return null;
  return Number(match[1]);
}
