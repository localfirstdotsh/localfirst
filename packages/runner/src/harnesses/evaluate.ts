import type { TestManifest } from '@localfirst/contracts';
import { evaluateExactMatch } from './exact-match.js';
import { evaluateJsonAssert } from './json-assert.js';
import type { EvaluationResult, HarnessLimits } from './limits.js';

export type Evaluation = TestManifest['cases'][number]['evaluation'];

export class UnsupportedEvaluatorError extends Error {
  constructor(kind: unknown) {
    super(`unsupported evaluator: ${String(kind)}`);
    this.name = 'UnsupportedEvaluatorError';
  }
}

/** Dispatch to a trusted evaluator. There is no plugin, expression, or regex evaluator. */
export function evaluate(evaluation: Evaluation, output: string, limits: HarnessLimits): EvaluationResult {
  switch (evaluation.kind) {
    case 'exact_match_v1':
      return evaluateExactMatch(evaluation, output, limits);
    case 'json_assert_v1':
      return evaluateJsonAssert(evaluation, output, limits);
    default:
      throw new UnsupportedEvaluatorError((evaluation as { kind?: unknown }).kind);
  }
}
