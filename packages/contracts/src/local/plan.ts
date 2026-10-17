/**
 * Local execution plan, schema `localfirst/local-plan/v0.1`
 * (BACKEND_PRD sections 5.3, 7.1, 7.2).
 *
 * The plan is what the user approves before a run. Its digest binds the spec,
 * model, settings, and data class, so editing the source, fixtures, or model
 * choice after approval invalidates it. The runner verifies the bundle digests
 * against an approved plan before executing. Local only: never uploaded.
 */

import { z } from 'zod';
import { digestOf } from '../canonical.js';
import { effectiveSettingsSchema, artifactIdentitySchema, LOCALITY_METHODS } from '../build/schema.js';
import {
  RUNNER_CONTRACT_ID,
  TEST_SCOPES,
} from '../vocabulary.js';
import {
  digestSchema,
  idSchema,
  keySlugSchema,
  timestampSchema,
  versionLabelSchema,
} from '../primitives.js';

export const LOCAL_PLAN_SCHEMA_ID = 'localfirst/local-plan/v0.1' as const;
export const LOCAL_REPORT_SCHEMA_ID = 'localfirst/local-report/v0.1' as const;
export const LOCAL_RUNTIMES = ['ollama', 'lmstudio'] as const;
export const DATA_CLASSES = ['public_fixture', 'private_local'] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** An approved runtime endpoint. Only loopback http(s) without credentials. */
export const loopbackEndpointSchema = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        LOOPBACK_HOSTS.has(url.hostname) &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }, 'must be a loopback http(s) URL without credentials, query, or fragment');

/** Resource effects previewed before execution (section 7.1). */
export const planEffectsSchema = z
  .object({
    may_load_model: z.boolean(),
    inference_requests: z.int().positive().max(2000),
    network: z.literal('loopback_only'),
    downloads: z.literal(false),
    tools: z.literal(false),
    project_code: z.literal(false),
    writes_local_report: z.literal(true),
  })
  .strict();

const planBodySchema = z
  .object({
    schema: z.literal(LOCAL_PLAN_SCHEMA_ID),
    created_at: timestampSchema,
    runner: z
      .object({ version: versionLabelSchema, contract: z.literal(RUNNER_CONTRACT_ID) })
      .strict(),
    project: z
      .object({
        project_id: idSchema,
        project_version_id: idSchema,
        configuration_key: keySlugSchema,
      })
      .strict(),
    test: z
      .object({
        key: keySlugSchema,
        test_definition_id: idSchema.nullable(),
        scope: z.enum(TEST_SCOPES),
        manifest_digest: digestSchema,
        fixture_digest: digestSchema,
        evaluator_digest: digestSchema,
        bundle_digest: digestSchema,
      })
      .strict(),
    runtime: z
      .object({
        family: z.enum(LOCAL_RUNTIMES),
        endpoint: loopbackEndpointSchema,
        application_version: versionLabelSchema.nullable(),
        cli_version: versionLabelSchema.nullable(),
        engine_version: versionLabelSchema.nullable(),
        adapter_profile: z.string().min(1).max(80),
      })
      .strict(),
    model: z
      .object({
        role: keySlugSchema,
        runtime_model_id: z.string().min(1).max(200),
        artifact_identity: artifactIdentitySchema.nullable(),
        execution_location: z.literal('local'),
        locality_method: z.enum(LOCALITY_METHODS),
      })
      .strict(),
    settings: effectiveSettingsSchema,
    data_class: z.enum(DATA_CLASSES),
    effects: planEffectsSchema,
  })
  .strict();

export type LocalPlanBody = z.infer<typeof planBodySchema>;

/** Digest of every plan field except the digest itself. */
export function computePlanDigest(body: LocalPlanBody): string {
  return digestOf(body);
}

export const localPlanSchema = planBodySchema
  .safeExtend({ plan_digest: digestSchema })
  .superRefine((plan, ctx) => {
    const { plan_digest: claimed, ...body } = plan;
    if (computePlanDigest(body) !== claimed) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan_digest'],
        message: 'plan_digest does not match the plan content',
      });
    }
  });

export type LocalPlan = z.infer<typeof localPlanSchema>;

/** Build a plan with its digest filled in. */
export function sealLocalPlan(body: LocalPlanBody): LocalPlan {
  return { ...body, plan_digest: computePlanDigest(body) };
}
