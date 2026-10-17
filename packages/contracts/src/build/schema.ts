/**
 * Saved build, schema `localfirst/build/v0.1` (BACKEND_PRD section 6).
 *
 * `buildInputSchema` is what a client may submit. `id`, `visibility`, and
 * `reproducibility` are server-only (section 6.1): the strict input schema
 * rejects them, and `buildRecordSchema` is the shape the API returns.
 */

import { z } from 'zod';
import {
  CPU_ARCHITECTURES,
  LICENSE_STATES,
  OPERATING_SYSTEMS,
  RUNTIME_FAMILIES,
  SOURCE_KINDS,
  BUILD_SCHEMA_ID,
} from '../vocabulary.js';
import {
  byteCountSchema,
  digestSchema,
  idSchema,
  keySlugSchema,
  publicText,
  versionLabelSchema,
} from '../primitives.js';
import { buildReportSchema } from './report.js';


/**
 * Runtime-specific identities are not interchangeable: an Ollama manifest
 * digest is not a model-file hash (section 6.1).
 */
export const ARTIFACT_IDENTITY_SCHEMES = [
  'ollama_manifest_sha256',
  'gguf_file_sha256',
  'lmstudio_model_key',
] as const;

export const LOCALITY_METHODS = [
  'adapter_preflight',
  'adapter_preflight_and_user_confirmed_config',
  'user_declared',
  'unknown',
] as const;

export const BUILD_CHANGE_KINDS = [
  'model_selection',
  'setting_change',
  'runtime_change',
  'source_deviation',
  'other',
] as const;

export const BUILD_VISIBILITIES = ['private', 'public', 'withdrawn'] as const;
export const REPRODUCIBILITY_STATES = ['incomplete', 'partial', 'complete'] as const;

export const artifactIdentitySchema = z
  .object({
    scheme: z.enum(ARTIFACT_IDENTITY_SCHEMES),
    digest: digestSchema.nullable(),
    /** Runtime model key for schemes that have no digest. */
    reference: z.string().min(1).max(200).nullable().default(null),
  })
  .strict()
  .refine(
    (value) => value.digest !== null || value.reference !== null,
    'an artifact identity needs a digest or a reference',
  );

export const modelBindingSchema = z
  .object({
    role: keySlugSchema,
    /** Runtime alias. Distinct from the artifact identity. */
    runtime_model_id: z.string().min(1).max(200),
    model_version_id: idSchema.nullable(),
    artifact_identity: artifactIdentitySchema.nullable(),
    source_url: z.url({ protocol: /^https$/ }).max(500).nullable(),
    quantization: z.string().min(1).max(40).nullable(),
    license_state: z.enum(LICENSE_STATES),
    execution_location: z.enum(['local', 'remote', 'unknown']),
    locality_method: z.enum(LOCALITY_METHODS),
  })
  .strict();

/** Application, CLI, and engine versions stay separate; missing facts are null. */
export const buildRuntimeSchema = z
  .object({
    family: z.enum(RUNTIME_FAMILIES),
    application_version: versionLabelSchema.nullable(),
    cli_version: versionLabelSchema.nullable().default(null),
    engine_version: versionLabelSchema.nullable(),
    adapter_profile: z.string().min(1).max(80),
    backend: z.string().min(1).max(60).nullable(),
  })
  .strict();

export const buildHardwareSchema = z
  .object({
    platform: z.string().min(1).max(60).nullable(),
    os: z
      .object({ name: z.enum(OPERATING_SYSTEMS), version: versionLabelSchema.nullable() })
      .strict(),
    cpu_architecture: z.enum(CPU_ARCHITECTURES),
    cpu_model: z.string().min(1).max(100).nullable(),
    memory_bytes: byteCountSchema.nullable(),
    unified_memory: z.boolean().nullable(),
    accelerators: z
      .array(
        z
          .object({
            vendor: z.string().min(1).max(40),
            backend: z.string().min(1).max(40),
            memory_bytes: byteCountSchema.nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

/** `null` marks a setting the adapter could not confirm (section 7.3). */
export const effectiveSettingsSchema = z
  .object({
    temperature: z.number().min(0).max(2).nullable(),
    max_output_tokens: z.int().positive().max(8192).nullable(),
    context_tokens: z.int().positive().max(1_000_000).nullable(),
    concurrency: z.int().positive().max(64).nullable(),
    stream: z.boolean().nullable(),
    seed: z.int().nullable(),
    reasoning: z.enum(['default', 'disabled', 'unknown']),
  })
  .strict();

export const buildSourceSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    url: z.url({ protocol: /^https?$/ }).max(500).nullable(),
    revision: z.string().min(1).max(120).nullable(),
    project_manifest_digest: digestSchema,
  })
  .strict();

export const buildChangeSchema = z
  .object({
    kind: z.enum(BUILD_CHANGE_KINDS),
    role: keySlugSchema.nullable().default(null),
    note: publicText(300),
  })
  .strict();

export const buildInputSchema = z
  .object({
    schema: z.literal(BUILD_SCHEMA_ID),
    project_id: idSchema,
    project_version_id: idSchema,
    configuration_key: keySlugSchema,
    source: buildSourceSchema,
    model_bindings: z.array(modelBindingSchema).min(1).max(8),
    runtime: buildRuntimeSchema,
    /** `null` when the contributor declined to share hardware details (BACKEND_PRD section 14.2). */
    hardware: buildHardwareSchema.nullable(),
    effective_settings: effectiveSettingsSchema,
    changes: z.array(buildChangeSchema).max(20).default([]),
    parent_build_id: idSchema.nullable().default(null),
    /** Optional private-transaction manual report for projects without a harness. */
    manual_report: buildReportSchema.nullable().default(null),
  })
  .strict()
  .superRefine((build, ctx) => {
    const roles = new Set<string>();
    build.model_bindings.forEach((binding, index) => {
      if (roles.has(binding.role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model_bindings', index, 'role'],
          message: `duplicate model role \`${binding.role}\``,
        });
      }
      roles.add(binding.role);
    });
  });

/** API view: client input plus server-derived fields. */
export const buildRecordSchema = buildInputSchema.safeExtend({
  id: idSchema,
  visibility: z.enum(BUILD_VISIBILITIES),
  reproducibility: z.enum(REPRODUCIBILITY_STATES),
});

export type BuildInput = z.infer<typeof buildInputSchema>;
export type BuildRecord = z.infer<typeof buildRecordSchema>;
export type EffectiveSettings = z.infer<typeof effectiveSettingsSchema>;
export type ModelBinding = z.infer<typeof modelBindingSchema>;
