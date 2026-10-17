/**
 * Schema `localfirst/project/v0.2` — the portable project specification
 * (BACKEND_PRD section 4).
 *
 * `null` means unknown, never zero/false/empty. Unknown fields are rejected
 * except inside the bounded `extensions` object.
 */

import { z } from 'zod';
import {
  ACCELERATOR_REQUIREMENTS,
  ATTRIBUTION_RELATIONSHIPS,
  CPU_ARCHITECTURES,
  DECLARATION_STATES,
  INFERENCE_BOUNDARIES,
  LICENSE_STATES,
  MODEL_CAPABILITIES,
  NETWORK_BOUNDARIES,
  OPERATING_SYSTEMS,
  PROJECT_TYPES,
  RUNTIME_FAMILIES,
  SETUP_KINDS,
  SOURCE_KINDS,
  SPEC_SCHEMA_ID,
  STORAGE_BOUNDARIES,
  SUBSTITUTION_POLICIES,
  TASK_CATEGORIES,
  TEST_SCHEMA_ID,
  TEST_SUPPORT_KINDS,
} from '../vocabulary.js';
import { DIGEST_PATTERN } from '../canonical.js';

export const SPEC_LIMITS = {
  markdownBytes: 256 * 1024,
  manifestBytes: 512 * 1024,
  bundleFiles: 20,
  bundleBytes: 2 * 1024 * 1024,
  bundleFileBytes: 512 * 1024,
} as const;

const keySlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lower-case kebab-case');

const semverish = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.\-+]*$/, 'must be a simple version string');

const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return true;
  }, 'must be an https URL without embedded credentials');

const digest = z.string().regex(DIGEST_PATTERN, 'must be sha256:<64 hex>');

/** A relative, traversal-free bundle path. */
export const bundlePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'must be a relative path')
  .refine((value) => !value.includes('..'), 'must not traverse parent directories')
  .refine((value) => !value.endsWith('/'), 'must not be a directory')
  .refine((value) => !value.includes('//'), 'must not contain empty path segments');

const licenseReference = z
  .object({
    state: z.enum(LICENSE_STATES),
    id: z.string().min(1).max(100).nullable().default(null),
    reference: httpsUrl.nullable().default(null),
  })
  .strict();

const sourceEntry = z
  .object({
    key: keySlug,
    kind: z.enum(SOURCE_KINDS),
    url: httpsUrl.nullable(),
    /** Immutable upstream revision (commit SHA, document revision) when known. */
    revision: z.string().min(1).max(200).nullable().default(null),
    /** Digest of the exact retrieved content when known. */
    content_digest: digest.nullable().default(null),
    /** Manifest path inside a repository source, when the project is one of several. */
    path: bundlePath.nullable().default(null),
    license: licenseReference.nullable().default(null),
    note: z.string().max(500).nullable().default(null),
  })
  .strict();

const author = z
  .object({
    name: z.string().min(1).max(200),
    url: httpsUrl.nullable().default(null),
  })
  .strict();

const modelRole = z
  .object({
    key: keySlug,
    required_capabilities: z.array(z.enum(MODEL_CAPABILITIES)).min(1).max(9),
    minimum_context_tokens: z.int().positive().max(100_000_000).nullable().default(null),
    substitution: z.enum(SUBSTITUTION_POLICIES),
    /** A creator suggestion, never a resolved local model identity. */
    preferred: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

const configuration = z
  .object({
    key: keySlug,
    model_roles: z.array(keySlug).max(8).default([]),
    setup_kind: z.enum(SETUP_KINDS),
    workload: z
      .object({
        context_tokens: z.int().positive().max(100_000_000).nullable().default(null),
        concurrency: z.int().positive().max(1024).nullable().default(null),
      })
      .strict()
      .default({ context_tokens: null, concurrency: null }),
    note: z.string().max(500).nullable().default(null),
  })
  .strict();

const testDeclaration = z
  .object({
    key: keySlug,
    schema: z.literal(TEST_SCHEMA_ID),
    path: bundlePath,
  })
  .strict();

/**
 * Evidence entries in a submitted specification are references/claims, not
 * authority (section 4.3). The server never promotes them to evidence levels.
 */
const evidenceClaim = z
  .object({
    kind: z.enum(['documented', 'claimed']),
    summary: z.string().min(1).max(500),
    reference: httpsUrl.nullable().default(null),
  })
  .strict();

const mediaReference = z
  .object({
    kind: z.enum(['image', 'video', 'diagram', 'other']),
    url: httpsUrl,
    caption: z.string().max(300).nullable().default(null),
    license: licenseReference.nullable().default(null),
  })
  .strict();

export const projectSpecV2Schema = z
  .object({
    schema: z.literal(SPEC_SCHEMA_ID),
    project: z
      .object({
        key: keySlug,
        name: z.string().min(2).max(120),
        summary: z.string().min(10).max(400),
        type: z.enum(PROJECT_TYPES),
        categories: z.array(z.enum(TASK_CATEGORIES)).min(1).max(5),
        version: semverish,
        license: licenseReference,
      })
      .strict(),
    sources: z.array(sourceEntry).min(1).max(10),
    attribution: z
      .object({
        authors: z.array(author).min(1).max(20),
        relationship: z.enum(ATTRIBUTION_RELATIONSHIPS),
      })
      .strict(),
    models: z
      .object({
        state: z.enum(DECLARATION_STATES),
        roles: z.array(modelRole).max(8).default([]),
      })
      .strict(),
    runtimes: z
      .object({
        state: z.enum(DECLARATION_STATES),
        supported: z
          .array(
            z
              .object({
                family: z.enum(RUNTIME_FAMILIES),
                version_constraint: z.string().min(1).max(100).nullable().default(null),
              })
              .strict(),
          )
          .max(10)
          .default([]),
      })
      .strict(),
    hardware: z
      .object({
        state: z.enum(DECLARATION_STATES),
        architectures: z.array(z.enum(CPU_ARCHITECTURES)).max(3).default([]),
        minimum_memory_bytes: z.int().positive().max(2 ** 53 - 1).nullable().default(null),
        minimum_vram_bytes: z.int().positive().max(2 ** 53 - 1).nullable().default(null),
        accelerator: z.enum(ACCELERATOR_REQUIREMENTS).default('unknown'),
        devices: z.array(z.string().min(1).max(120)).max(10).default([]),
      })
      .strict(),
    operating_systems: z
      .object({
        state: z.enum(DECLARATION_STATES),
        supported: z.array(z.enum(OPERATING_SYSTEMS)).max(4).default([]),
      })
      .strict(),
    dependencies: z
      .object({
        state: z.enum(DECLARATION_STATES),
        items: z
          .array(
            z
              .object({
                name: z.string().min(1).max(200),
                kind: z.enum(['system', 'language_runtime', 'package', 'container', 'other']),
                version_constraint: z.string().min(1).max(100).nullable().default(null),
                license: licenseReference.nullable().default(null),
              })
              .strict(),
          )
          .max(50)
          .default([]),
      })
      .strict(),
    configurations: z.array(configuration).min(1).max(10),
    data_boundary: z
      .object({
        inference: z.enum(INFERENCE_BOUNDARIES),
        storage: z.enum(STORAGE_BOUNDARIES),
        runtime_network: z.enum(NETWORK_BOUNDARIES),
        external_services: z.array(z.string().min(1).max(200)).max(20).default([]),
      })
      .strict(),
    test_support: z.enum(TEST_SUPPORT_KINDS),
    tests: z.array(testDeclaration).max(10).default([]),
    limitations: z.array(z.string().min(5).max(500)).min(1).max(20),
    evidence: z.array(evidenceClaim).max(20).default([]),
    media: z.array(mediaReference).max(10).default([]),
    derivative_of: z
      .object({
        project_key: keySlug,
        project_id: z.string().max(64).nullable().default(null),
        project_version_id: z.uuid().optional(),
        version: semverish.nullable().default(null),
        change_summary: z.string().min(5).max(1000),
      })
      .strict()
      .nullable()
      .default(null),
    /** Bounded forward-compatibility escape hatch; never interpreted. */
    extensions: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .strict();

export const projectSpecV3Schema = projectSpecV2Schema.extend({
  schema: z.literal('localfirst/project/v0.3'),
  test_support: z.enum([...TEST_SUPPORT_KINDS, 'declarative_workflow_v1']),
  tests: z.array(testDeclaration.extend({ schema: z.enum([TEST_SCHEMA_ID, 'localfirst/test/v0.2']) })).max(10).default([]),
  environments: z.array(z.object({ key: keySlug, path: bundlePath, digest }).strict()).min(1).max(8),
}).strict();
export const projectSpecSchema = z.discriminatedUnion('schema', [projectSpecV2Schema, projectSpecV3Schema]);
export type ProjectSpec = z.infer<typeof projectSpecSchema>;
export type SourceEntry = z.infer<typeof sourceEntry>;
export type ModelRole = z.infer<typeof modelRole>;
export type ProjectConfiguration = z.infer<typeof configuration>;
export type TestDeclaration = z.infer<typeof testDeclaration>;
export type LicenseReference = z.infer<typeof licenseReference>;
