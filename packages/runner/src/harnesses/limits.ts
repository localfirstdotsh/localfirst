/** Hard limits applied by the trusted evaluators (BACKEND_PRD section 5.1). */
export interface HarnessLimits {
  /** Model output larger than this is an error, never evaluated. */
  maxOutputBytes: number;
  /** Maximum JSON nesting depth in a model reply. */
  maxJsonDepth: number;
  /** Monotonic millisecond deadline for evaluation work, or null. */
  deadlineMs: number | null;
  nowMs: () => number;
}

export const DEFAULT_MAX_JSON_DEPTH = 32;

export function harnessLimits(partial: Partial<HarnessLimits> & { maxOutputBytes: number }): HarnessLimits {
  return {
    maxJsonDepth: DEFAULT_MAX_JSON_DEPTH,
    deadlineMs: null,
    nowMs: () => performance.now(),
    ...partial,
  };
}

export type EvaluationOutcome = 'pass' | 'fail' | 'error';

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Stable snake_case reason; null for a plain pass. */
  code: string | null;
}

export const PASS: EvaluationResult = { outcome: 'pass', code: null };
export const fail = (code: string): EvaluationResult => ({ outcome: 'fail', code });
export const error = (code: string): EvaluationResult => ({ outcome: 'error', code });

/** Returns an `error` result when the output is over the size limit, else null. */
export function checkOutputSize(output: string, limits: HarnessLimits): EvaluationResult | null {
  // Byte length of UTF-8; cheap upper bound first so a huge string is never encoded.
  if (output.length > limits.maxOutputBytes) return error('output_too_large');
  if (Buffer.byteLength(output, 'utf8') > limits.maxOutputBytes) return error('output_too_large');
  return null;
}
