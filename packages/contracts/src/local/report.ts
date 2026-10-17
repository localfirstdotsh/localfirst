/**
 * Local report, schema `localfirst/local-report/v0.1` (BACKEND_PRD sections
 * 7.1, 8.2, 8.4).
 *
 * A superset of the sanitized test result that stays on the machine: it adds
 * the approved plan digest, the execution state, raw provider statistics, and
 * per-case detail. `exportSanitizedResult` is the only path to the uploadable
 * shape: it copies the allowlisted result fields and re-validates them.
 */

import { z } from 'zod';
import {
  checkResultConsistency,
  resultBodySchema,
  testResultSchema,
  type TestResult,
} from '../result/schema.js';
import { buildHardwareSchema } from '../build/schema.js';
import { DATA_CLASSES, LOCAL_REPORT_SCHEMA_ID, localPlanSchema } from './plan.js';
import { caseKeySchema, codeSchema, digestSchema } from '../primitives.js';

export const EXECUTION_STATES = [
  'local_report_saved',
  'cancelled_partial',
  'failed_partial',
] as const;

/** Bounded JSON for raw provider statistics (units as the provider reported them). */
const providerStatsSchema = z.record(z.string().max(64), z.union([z.number(), z.string().max(200), z.boolean(), z.null()])).refine(
  (value) => Object.keys(value).length <= 40,
  'at most 40 provider statistics per case',
);

export const localCaseDetailSchema = z
  .object({
    key: caseKeySchema,
    repetition: z.int().positive().max(10),
    outcome: z.enum(['pass', 'fail', 'error', 'skipped']),
    /** Model output, kept local. Never part of the sanitized export. */
    output_text: z.string().max(64 * 1024).nullable(),
    error_code: codeSchema.nullable(),
    started_at_monotonic_ms: z.number().nonnegative().nullable(),
    provider_stats: providerStatsSchema,
  })
  .strict();

const sanitizedShape = resultBodySchema.shape;

export const localReportSchema = z
  .object({
    ...sanitizedShape,
    schema: z.literal(LOCAL_REPORT_SCHEMA_ID),
    plan_digest: digestSchema,
    /** Carried from the approved plan. Only `public_fixture` reports can be exported. */
    data_class: z.enum(DATA_CLASSES),
    execution_state: z.enum(EXECUTION_STATES),
    /**
     * The sealed approved plan this run executed. Local only: it carries the
     * model, runtime, and settings identity that report comparison needs, and
     * the sanitized export drops it.
     */
    plan: localPlanSchema,
    /** Coarse hardware summary; `null` means it was not collected. Local only. */
    hardware: buildHardwareSchema.nullable(),
    case_details: z.array(localCaseDetailSchema).max(200),
  })
  .strict()
  .superRefine(checkResultConsistency)
  .superRefine((report, ctx) => {
    const { plan } = report;
    const mismatch = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: ['plan', path], message });
    if (plan.plan_digest !== report.plan_digest) mismatch('plan_digest', 'plan snapshot does not match plan_digest');
    if (plan.project.project_id !== report.project_id) mismatch('project', 'project_id differs from the plan');
    if (plan.project.project_version_id !== report.project_version_id) {
      mismatch('project', 'project_version_id differs from the plan');
    }
    if (plan.test.key !== report.test_key) mismatch('test', 'test_key differs from the plan');
    if (plan.test.manifest_digest !== report.test_manifest_digest) mismatch('test', 'manifest digest differs from the plan');
    if (plan.test.fixture_digest !== report.fixture_digest) mismatch('test', 'fixture digest differs from the plan');
    if (plan.test.scope !== report.scope) mismatch('test', 'scope differs from the plan');
    if (plan.data_class !== report.data_class) mismatch('data_class', 'data class differs from the plan');
    if (plan.runner.version !== report.runner.version || plan.runner.contract !== report.runner.contract) {
      mismatch('runner', 'runner differs from the plan');
    }
  });

export type LocalReport = z.infer<typeof localReportSchema>;

/** The exact set of fields a sanitized export may carry. */
export const SANITIZED_RESULT_KEYS = Object.keys(sanitizedShape) as (keyof TestResult)[];

/**
 * Allowlist copy of a local report into the uploadable result. Local-only
 * fields are dropped by construction; the result is then validated strictly.
 */
export function exportSanitizedResult(report: LocalReport): TestResult {
  const picked: Record<string, unknown> = {};
  for (const key of SANITIZED_RESULT_KEYS) picked[key] = report[key as keyof LocalReport];
  picked.schema = 'localfirst/test-result/v0.1';
  return testResultSchema.parse(picked);
}
