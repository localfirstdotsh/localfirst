/**
 * Schema `localfirst/test/v0.1`, harness `declarative_task_v1`
 * (BACKEND_PRD section 5).
 *
 * Phase 1 publishes test definitions as declared preview fixtures only: the
 * registry validates and stores them, and `runner_available` stays false until
 * a Phase 2 runner ships. No evaluator here is executable server-side.
 */

import { z } from 'zod';
import {
  MODEL_CAPABILITIES,
  RUNNER_CONTRACT_ID,
  TEST_SCHEMA_ID,
  TEST_SCOPES,
} from '../vocabulary.js';

const keySlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lower-case kebab-case');

const caseKey = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'must be a lower-case case key');

/** A JSON Pointer into a parsed model response. */
const jsonPointer = z
  .string()
  .max(200)
  .regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/, 'must be a JSON Pointer');

const assertion = z
  .object({
    path: jsonPointer,
    equals: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
    one_of: z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(50).optional(),
  })
  .strict()
  .refine(
    (value) => value.equals !== undefined || value.one_of !== undefined,
    'an assertion needs `equals` or `one_of`',
  );

const evaluation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('exact_match_v1'),
      expected: z.string().max(2000),
      normalize: z
        .object({
          trim: z.boolean().default(true),
          lowercase: z.boolean().default(false),
          collapse_whitespace: z.boolean().default(false),
        })
        .strict()
        .default({ trim: true, lowercase: false, collapse_whitespace: false }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('json_assert_v1'),
      assertions: z.array(assertion).min(1).max(20),
    })
    .strict(),
]);

const message = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(8000),
  })
  .strict();

/**
 * A bounded JSON-Schema subset for structured output. The runtime adapter maps
 * it; it is not copied into every provider request unchanged (section 5.2).
 */
const responseSchemaNode: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean']),
      properties: z.record(z.string().max(64), responseSchemaNode).optional(),
      items: responseSchemaNode.optional(),
      required: z.array(z.string().max(64)).max(32).optional(),
      enum: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(50).optional(),
      additionalProperties: z.boolean().optional(),
      description: z.string().max(300).optional(),
    })
    .strict(),
);

export const TEST_LIMITS = {
  maxCases: 20,
  maxRequestTimeoutMs: 120_000,
  maxRunTimeoutMs: 300_000,
  maxResponseBytes: 64 * 1024,
  maxRepetitions: 10,
} as const;

export const testManifestSchema = z
  .object({
    schema: z.literal(TEST_SCHEMA_ID),
    key: keySlug,
    project_key: keySlug,
    configuration_key: keySlug,
    scope: z.enum(TEST_SCOPES),
    /** Phase 1/2 support only this harness. */
    harness: z.literal('declarative_task_v1'),
    runner_contract: z.literal(RUNNER_CONTRACT_ID),
    model_role: keySlug,
    required_capabilities: z.array(z.enum(MODEL_CAPABILITIES)).min(1).max(9),
    fixture_kind: z.literal('public_inline'),
    fixture_license: z.string().min(1).max(100),
    inference: z
      .object({
        temperature: z.number().min(0).max(2),
        max_output_tokens: z.int().positive().max(8192),
        context_tokens: z.int().positive().max(1_000_000),
        concurrency: z.literal(1),
        stream: z.boolean(),
        seed: z.int().nullable(),
        reasoning: z.enum(['default', 'disabled']),
      })
      .strict(),
    response_schema: responseSchemaNode.nullable().default(null),
    cases: z
      .array(
        z
          .object({
            key: caseKey,
            messages: z.array(message).min(1).max(10),
            evaluation,
          })
          .strict(),
      )
      .min(1)
      .max(TEST_LIMITS.maxCases),
    limits: z
      .object({
        max_cases: z.int().positive().max(TEST_LIMITS.maxCases),
        request_timeout_ms: z.int().positive().max(TEST_LIMITS.maxRequestTimeoutMs),
        run_timeout_ms: z.int().positive().max(TEST_LIMITS.maxRunTimeoutMs),
        max_response_bytes: z.int().positive().max(TEST_LIMITS.maxResponseBytes),
      })
      .strict(),
    execution: z
      .object({
        locality: z.enum(['local_required', 'local_preferred']),
        allow_tools: z.literal(false),
        allow_project_code: z.literal(false),
        allow_downloads: z.literal(false),
      })
      .strict(),
    measurement: z
      .object({
        repetitions: z.int().positive().max(TEST_LIMITS.maxRepetitions),
        warmup_runs: z.int().min(0).max(5),
        load_state: z.enum(['observe', 'require_loaded', 'require_cold']),
        cache_policy: z.enum(['observe', 'ignore']),
        timing: z.literal('end_to_end_v1'),
      })
      .strict(),
    sharing: z
      .object({
        default: z.enum(['local_only', 'prompt_to_share']),
        allow_public_fixture_case_ids: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.cases.length > manifest.limits.max_cases) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases'],
        message: `cases (${manifest.cases.length}) exceed declared limits.max_cases (${manifest.limits.max_cases})`,
      });
    }
    const seen = new Set<string>();
    manifest.cases.forEach((testCase, index) => {
      if (seen.has(testCase.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'key'],
          message: `duplicate case key \`${testCase.key}\``,
        });
      }
      seen.add(testCase.key);
      if (testCase.evaluation.kind === 'json_assert_v1' && manifest.response_schema === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'evaluation'],
          message: 'json_assert_v1 requires a declared response_schema',
        });
      }
    });
    if (manifest.limits.run_timeout_ms < manifest.limits.request_timeout_ms) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'run_timeout_ms'],
        message: 'run_timeout_ms must not be shorter than request_timeout_ms',
      });
    }
  });

export type TestManifest = z.infer<typeof testManifestSchema>;
