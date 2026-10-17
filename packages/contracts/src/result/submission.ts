/**
 * The upload a first-party client sends to `POST /test-results` when it also
 * creates the build in the same request: the sanitized result plus the inline
 * `localfirst/build/v0.1`. One object, so one digest covers exactly what the
 * user reviewed and what the server's idempotency check sees.
 */

import { z } from 'zod';
import { buildInputSchema } from '../build/schema.js';
import { testResultSchema } from './schema.js';

export const testResultSubmissionSchema = z
  .object({
    result: testResultSchema,
    build: buildInputSchema,
  })
  .strict();

export type TestResultSubmission = z.infer<typeof testResultSubmissionSchema>;
