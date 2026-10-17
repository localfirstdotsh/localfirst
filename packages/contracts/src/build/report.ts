/**
 * Manual build report, schema `localfirst/build-report/v0.1`
 * (BACKEND_PRD section 6.2).
 *
 * For projects without a harness. It has no test-definition ID and no
 * evaluator: it is a human claim and caps at `community_reported`.
 */

import { z } from 'zod';
import { BUILD_REPORT_SCHEMA_ID } from '../vocabulary.js';
import { clientRunIdSchema, codeSchema, publicText, timestampSchema } from '../primitives.js';

export const MANUAL_REPORT_OUTCOMES = ['reported_success', 'reported_failure', 'partial'] as const;
export const MANUAL_CHECK_RESULTS = ['reported_pass', 'reported_fail', 'not_checked'] as const;

export const buildReportSchema = z
  .object({
    schema: z.literal(BUILD_REPORT_SCHEMA_ID),
    client_run_id: clientRunIdSchema,
    outcome: z.enum(MANUAL_REPORT_OUTCOMES),
    method: publicText(1000),
    changes: publicText(1000).nullable().default(null),
    checks: z
      .array(z.object({ name: publicText(80), result: z.enum(MANUAL_CHECK_RESULTS) }).strict())
      .max(20)
      .default([]),
    diagnostic_codes: z.array(codeSchema).max(20).default([]),
    completed_at: timestampSchema,
  })
  .strict();

export type BuildReport = z.infer<typeof buildReportSchema>;
