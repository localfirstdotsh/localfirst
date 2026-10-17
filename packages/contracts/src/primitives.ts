/**
 * Field primitives shared by the build, build-report, test-result and local
 * runner contracts (BACKEND_PRD sections 6, 8). Every object built from these
 * is strict: unknown members are rejected, never stripped.
 */

import { z } from 'zod';
import { scanSecrets } from './safety.js';

export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>');

/** Opaque server or client identifier. Not a path, URL, or free text. */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'must be an opaque identifier');

/** Submitter-scoped run identifier used for idempotent submission (section 8.4). */
export const clientRunIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be 8-80 identifier characters');

export const keySlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lower-case kebab-case');

export const caseKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'must be a lower-case case key');

/** Machine-readable code such as `runtime_sensor_unavailable`. Never free text. */
export const codeSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a snake_case code');

/** UTC timestamp with a `Z` suffix. */
export const timestampSchema = z.iso.datetime({ offset: false });

export const versionLabelSchema = z.string().min(1).max(60);

export const byteCountSchema = z.int().positive().max(2 ** 53 - 1);

/** Bounded public-safe prose. Rejects credential-looking content. */
export function publicText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => scanSecrets(value, 'text').length === 0, 'must not contain credentials');
}
