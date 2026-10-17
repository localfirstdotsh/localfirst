/**
 * Compatibility request/response contract (BACKEND_PRD section 9).
 *
 * The caller voluntarily shares a minimal environment summary. Raw inventory,
 * endpoint credentials, prompts, and document contents are rejected.
 */

import { z } from 'zod';
import { workflowIdentitySchema } from './environment/shared.js';
import {
  ACCELERATOR_REQUIREMENTS,
  COMPATIBILITY_OUTCOMES,
  CPU_ARCHITECTURES,
  EVIDENCE_LEVELS,
  MODEL_CAPABILITIES,
  OPERATING_SYSTEMS,
  RUNTIME_FAMILIES,
} from './vocabulary.js';
import { effectiveSettingsSchema, artifactIdentitySchema } from './build/schema.js';

export const hardwareSummarySchema = z
  .object({
    cpu_architecture: z.enum(CPU_ARCHITECTURES).nullable().default(null),
    platform: z.string().min(1).max(60).nullable().default(null),
    os: z.enum(OPERATING_SYSTEMS).nullable().default(null),
    os_version: z.string().min(1).max(60).nullable().default(null),
    memory_bytes: z.int().positive().max(2 ** 53 - 1).nullable().default(null),
    /** Discrete accelerator memory. Never added to unified system memory. */
    vram_bytes: z.int().positive().max(2 ** 53 - 1).nullable().default(null),
    unified_memory: z.boolean().nullable().default(null),
    accelerator: z.enum(['cuda', 'metal', 'rocm', 'vulkan', 'cpu', 'other']).nullable().default(null),
  })
  .strict();

export const selectedModelSummarySchema = z
  .object({
    role: z.string().min(1).max(64),
    capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(9).default([]),
    /** Capabilities the caller knows are unsupported, as opposed to unknown. */
    unsupported_capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(9).default([]),
    context_tokens: z.int().positive().max(100_000_000).nullable().default(null),
    execution_location: z.enum(['local', 'remote', 'unknown']).default('unknown'),
    identity_known: z.boolean().default(false),
    /**
     * Runtime-specific artifact identity the caller chose to share. Needed to
     * match accepted evidence exactly; a name or parameter count never matches.
     */
    artifact_identity: artifactIdentitySchema.nullable().default(null),
    quantization: z.string().max(40).nullable().optional(),
  })
  .strict();

export const runtimeSummarySchema = z
  .object({
    family: z.enum(RUNTIME_FAMILIES),
    version: z.string().min(1).max(60).nullable().default(null),
    backend: z.string().min(1).max(60).nullable().default(null),
    api_profile: z.string().min(1).max(80).nullable().default(null),
    engine_version: z.string().max(60).nullable().optional(),
  })
  .strict();

export const compatibilityRequestSchema = z
  .object({
    project_version_id: z.string().min(1).max(64).nullable().default(null),
    configuration_key: z.string().min(1).max(64).nullable().default(null),
    /** Caller requirements, e.g. a strict local/offline requirement. */
    requirements: z
      .object({
        inference: z.enum(['local_required', 'any']).default('any'),
        offline: z.boolean().default(false),
        accelerator: z.enum(ACCELERATOR_REQUIREMENTS).nullable().default(null),
      })
      .strict()
      .default({ inference: 'any', offline: false, accelerator: null }),
    hardware: hardwareSummarySchema.nullable().default(null),
    runtime: runtimeSummarySchema.nullable().default(null),
    selected_models: z.array(selectedModelSummarySchema).max(8).default([]),
    effective_settings: effectiveSettingsSchema.optional(),
    workflow_identity: workflowIdentitySchema.optional(),
  })
  .strict();

export type CompatibilityRequest = z.infer<typeof compatibilityRequestSchema>;
export type HardwareSummary = z.infer<typeof hardwareSummarySchema>;
export type SelectedModelSummary = z.infer<typeof selectedModelSummarySchema>;
export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>;

export const CHECK_STATUSES = ['pass', 'fail', 'unknown', 'not_applicable'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CompatibilityCheck {
  requirement: string;
  status: CheckStatus;
  /** Where the fact came from; caller-supplied facts stay attributed. */
  source: string;
  detail?: string;
}

export interface CompatibilityAssessment {
  project_id: string;
  project_version_id: string;
  configuration_key: string | null;
  outcome: (typeof COMPATIBILITY_OUTCOMES)[number];
  evidence_level: (typeof EVIDENCE_LEVELS)[number];
  evidence_scope: 'requirements_only' | 'component' | 'workflow' | 'end_to_end';
  rules_version: string;
  checks: CompatibilityCheck[];
  blockers: string[];
  uncertainties: string[];
  /** Missing prerequisites are separated from hard incompatibility. */
  missing_prerequisites: string[];
  evidence_ids: string[];
  test_support: { declared_kind: string; runner_available: boolean };
}
