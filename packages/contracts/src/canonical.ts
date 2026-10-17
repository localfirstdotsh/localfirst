/**
 * Canonical serialization and content digests.
 *
 * Approved artifact bytes must not drift through ambiguous normalization
 * (BACKEND_PRD section 11). The serializer is versioned
 * (`localfirst/canonical/v0.1`) so a future change is an explicit new version.
 *
 * Rules: object keys sorted by UTF-16 code unit, no insignificant whitespace,
 * `undefined` object members dropped, `undefined` array members rejected,
 * non-finite numbers rejected, integers emitted without exponent.
 */

import { createHash } from 'node:crypto';
import { CANONICAL_SERIALIZER_VERSION } from './vocabulary.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalizationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path || '/'}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError('Non-finite numbers are not canonicalizable', path);
  }
  if (Number.isInteger(value)) {
    // Avoid "-0" and exponent forms for integral values.
    return value === 0 ? '0' : String(BigInt(value));
  }
  return JSON.stringify(value);
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'number':
      out.push(canonicalNumber(value, path));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'bigint':
      out.push(value.toString());
      return;
    case 'undefined':
      throw new CanonicalizationError('undefined is not canonicalizable', path);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`${typeof value} is not canonicalizable`, path);
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',');
      write(value[index], `${path}/${index}`, out);
    }
    out.push(']');
    return;
  }

  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  out.push('{');
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    if (index > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(record[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
  }
  out.push('}');
}

/** Deterministic JSON text for digesting and for byte-stable approvals. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}

/** `sha256:<64 hex>` over the canonical bytes of `value`. */
export function digestOf(value: unknown): string {
  return digestOfBytes(Buffer.from(canonicalize(value), 'utf8'));
}

/** `sha256:<64 hex>` over raw bytes or UTF-8 text. */
export function digestOfBytes(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

export interface ManifestDigestInput {
  /** Normalized specification manifest (frontmatter object). */
  manifest: unknown;
  /** Markdown body exactly as published. */
  markdown: string;
  /** Bundled file paths mapped to their own content digests. */
  files?: Record<string, string>;
}

/**
 * Version content digest. Includes approved public content plus source/test
 * references, so identical content cannot create two versions of one project
 * (section 16.2).
 */
export function versionContentDigest(input: ManifestDigestInput): string {
  return digestOf({
    serializer: CANONICAL_SERIALIZER_VERSION,
    manifest: input.manifest,
    markdown_digest: digestOfBytes(input.markdown),
    files: input.files ?? {},
  });
}
