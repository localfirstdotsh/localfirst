import type { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { config, independentVerificationEnabled } from '../../config.js';

/** Parse a JSON body against a strict schema; unknown members are rejected, never stripped. */
export async function parseJson<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw ApiError.badRequest('A JSON request body is required.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ApiError.badRequest('The request body is not valid.', {
      issues: result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export type PhaseFeature = 'testDefinitions' | 'resultSubmission' | 'evidenceClassification' | 'communityNetwork' | 'independentVerification';

const FEATURE_NAME: Record<PhaseFeature, string> = {
  communityNetwork: 'Community compatibility network',
  independentVerification: 'Independent verification',
  testDefinitions: 'Test definitions and builds',
  resultSubmission: 'Test result submission',
  evidenceClassification: 'Evidence review',
};

/** A disabled phase answers as unavailable rather than pretending to exist. */
export function requireFeature(feature: PhaseFeature): void {
  const enabled = feature === 'independentVerification' ? independentVerificationEnabled() : config().features[feature];
  if (!enabled) throw ApiError.phaseUnavailable(FEATURE_NAME[feature]);
}
