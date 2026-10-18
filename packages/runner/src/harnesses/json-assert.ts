import type { TestManifest } from '@localfirst/contracts';
import {
  PASS,
  checkOutputSize,
  error,
  fail,
  type EvaluationResult,
  type HarnessLimits,
} from './limits.js';

type JsonAssert = Extract<TestManifest['cases'][number]['evaluation'], { kind: 'json_assert_v1' }>;

/**
 * Nesting depth of JSON text, computed without recursion so adversarial input
 * cannot exhaust the stack. Returns early once `limit` is exceeded.
 */
export function jsonDepthExceeds(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1; // backslash: skip the escaped character
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (char === 0x5d || char === 0x7d) depth -= 1;
  }
  return false;
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

type Resolved = { found: true; value: unknown } | { found: false };

/** RFC 6901 lookup that only follows own properties and valid array indices. */
export function resolvePointer(root: unknown, pointer: string): Resolved {
  let current: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function evaluateJsonAssert(
  spec: JsonAssert,
  output: string,
  limits: HarnessLimits,
): EvaluationResult {
  const oversized = checkOutputSize(output, limits);
  if (oversized) return oversized;
  if (jsonDepthExceeds(output, limits.maxJsonDepth)) return error('json_depth_exceeded');

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return fail('invalid_json');
  }

  for (const assertion of spec.assertions) {
    if (limits.deadlineMs !== null && limits.nowMs() >= limits.deadlineMs) {
      return error('evaluation_timeout');
    }
    const resolved = resolvePointer(parsed, assertion.path);
    if (!resolved.found) return fail('path_missing');
    if (assertion.equals !== undefined && resolved.value !== assertion.equals) {
      return fail('value_mismatch');
    }
    if (assertion.one_of !== undefined && !assertion.one_of.includes(resolved.value as never)) {
      return fail('value_not_in_set');
    }
  }
  return PASS;
}
