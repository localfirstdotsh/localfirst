import type { TestManifest } from '@localfirst/contracts';
import { PASS, checkOutputSize, fail, type EvaluationResult, type HarnessLimits } from './limits.js';

type ExactMatch = Extract<TestManifest['cases'][number]['evaluation'], { kind: 'exact_match_v1' }>;

/** Deterministic normalization: collapse whitespace, trim, lowercase, as declared. */
export function normalizeText(text: string, options: ExactMatch['normalize']): string {
  let value = text;
  if (options.collapse_whitespace) value = value.replace(/\s+/g, ' ');
  if (options.trim) value = value.trim();
  if (options.lowercase) value = value.toLowerCase();
  return value;
}

export function evaluateExactMatch(
  spec: ExactMatch,
  output: string,
  limits: HarnessLimits,
): EvaluationResult {
  const oversized = checkOutputSize(output, limits);
  if (oversized) return oversized;
  return normalizeText(output, spec.normalize) === normalizeText(spec.expected, spec.normalize)
    ? PASS
    : fail('output_mismatch');
}
