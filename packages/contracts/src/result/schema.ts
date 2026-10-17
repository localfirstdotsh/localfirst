/**
 * Sanitized test result, schema `localfirst/test-result/v0.1`
 * (BACKEND_PRD section 8.1).
 *
 * This is an allowlist. Every object is strict, so private extras (prompts,
 * outputs, paths, inventory) are rejected rather than stripped, and there is
 * no field through which a client can assert `verified`, a review state, an
 * evidence level, a badge, or a submitter. The server derives those.
 */

import { z } from 'zod';
import { measurementsSchema } from '../metrics.js';
import {
  EVALUATOR_KINDS,
  EXPORT_REDACTION_VERSION,
  RUNNER_CONTRACT_ID,
  TEST_RESULT_SCHEMA_ID,
  TEST_SCOPES,
} from '../vocabulary.js';
import {
  caseKeySchema,
  clientRunIdSchema,
  codeSchema,
  digestSchema,
  idSchema,
  keySlugSchema,
  timestampSchema,
  versionLabelSchema,
} from '../primitives.js';

export const RESULT_OUTCOMES = ['pass', 'fail', 'error', 'cancelled'] as const;
export const CASE_OUTCOMES = ['pass', 'fail', 'error', 'skipped'] as const;
export const LOCALITY_CHECKS = ['pass', 'fail', 'unknown', 'not_run'] as const;
/** `no_route_observed` is a self-reported sample of the machine's interfaces, not a verified offline claim. */
export const OFFLINE_CHECKS = ['unknown', 'not_run', 'no_route_observed'] as const;
export const LOAD_STATES = ['unknown', 'cold', 'loaded'] as const;
export const CACHE_STATES = ['unknown', 'cold', 'warm', 'ignored'] as const;
export const VISIBILITY_REQUESTS = ['private', 'public'] as const;

export const resultCountsSchema = z
  .object({
    defined: z.int().nonnegative().max(1000),
    evaluated: z.int().nonnegative().max(1000),
    passed: z.int().nonnegative().max(1000),
    failed: z.int().nonnegative().max(1000),
    errors: z.int().nonnegative().max(1000),
    skipped: z.int().nonnegative().max(1000),
  })
  .strict();

export const caseResultSchema = z
  .object({
    key: caseKeySchema,
    outcome: z.enum(CASE_OUTCOMES),
    repetition: z.int().positive().max(10),
  })
  .strict();

export const resultBodySchema = z
  .object({
    schema: z.literal(TEST_RESULT_SCHEMA_ID),
    client_run_id: clientRunIdSchema,
    project_id: idSchema,
    project_version_id: idSchema,
    build_id: idSchema,
    test_key: keySlugSchema,
    test_definition_id: idSchema,
    test_manifest_digest: digestSchema,
    fixture_digest: digestSchema,
    fixture_kind: z.literal('public_inline'),
    evaluator: z
      .object({ kind: z.enum(EVALUATOR_KINDS), version: versionLabelSchema })
      .strict(),
    scope: z.enum(TEST_SCOPES),
    runner: z
      .object({ version: versionLabelSchema, contract: z.literal(RUNNER_CONTRACT_ID) })
      .strict(),
    outcome: z.enum(RESULT_OUTCOMES),
    counts: resultCountsSchema,
    case_results: z.array(caseResultSchema).min(1).max(200),
    measurements: measurementsSchema,
    measurement_context: z
      .object({
        load_state: z.enum(LOAD_STATES),
        cache_state: z.enum(CACHE_STATES),
        repetitions: z.int().positive().max(10),
        warmup_runs: z.int().min(0).max(5),
      })
      .strict(),
    checks: z
      .object({ locality: z.enum(LOCALITY_CHECKS), offline: z.enum(OFFLINE_CHECKS) })
      .strict(),
    completed_at: timestampSchema,
    redaction_version: z.literal(EXPORT_REDACTION_VERSION),
    diagnostic_codes: z.array(codeSchema).max(20),
    visibility_requested: z.enum(VISIBILITY_REQUESTS),
  })
  .strict();

type ResultBody = Omit<z.infer<typeof resultBodySchema>, 'schema'>;

/** Count and outcome invariants shared by the sanitized result and the local report. */
export function checkResultConsistency(result: ResultBody, ctx: z.RefinementCtx): void {
  const { counts } = result;
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  if (counts.evaluated !== counts.passed + counts.failed + counts.errors) {
    issue(['counts', 'evaluated'], 'evaluated must equal passed + failed + errors');
  }
  if (counts.defined !== counts.evaluated + counts.skipped) {
    issue(['counts', 'defined'], 'defined must equal evaluated + skipped; skipped cases cannot disappear');
  }
  if (result.case_results.length !== counts.defined) {
    issue(['case_results'], 'case_results must list every defined case execution');
  }
  const tally = { pass: 0, fail: 0, error: 0, skipped: 0 };
  const seen = new Set<string>();
  result.case_results.forEach((entry, index) => {
    tally[entry.outcome] += 1;
    const id = `${entry.key}#${entry.repetition}`;
    if (seen.has(id)) issue(['case_results', index], `duplicate case execution ${id}`);
    seen.add(id);
    if (entry.repetition > result.measurement_context.repetitions) {
      issue(['case_results', index, 'repetition'], 'repetition exceeds measurement_context.repetitions');
    }
  });
  if (
    tally.pass !== counts.passed ||
    tally.fail !== counts.failed ||
    tally.error !== counts.errors ||
    tally.skipped !== counts.skipped
  ) {
    issue(['case_results'], 'case outcomes do not match counts');
  }
  const clean =
    counts.defined > 0 && counts.passed === counts.defined && counts.skipped === 0;
  if (result.outcome === 'pass' && !clean) {
    issue(['outcome'], 'pass requires every defined case to be evaluated and passed');
  }
  if (result.outcome === 'fail' && counts.failed === 0) {
    issue(['outcome'], 'fail requires at least one failed case');
  }
}

export const testResultSchema = resultBodySchema.superRefine(checkResultConsistency);

export type TestResult = z.infer<typeof testResultSchema>;
export type ResultCounts = z.infer<typeof resultCountsSchema>;
