import { describe, expect, it } from 'vitest';
import {
  checkExecutable,
  evaluate,
  harnessLimits,
  jsonDepthExceeds,
  normalizeText,
  resolvePointer,
  type Evaluation,
} from '../src/index.js';
import { exampleManifest } from './helpers.js';

const limits = harnessLimits({ maxOutputBytes: 65_536 });
const jsonAssert = (assertions: Array<Record<string, unknown>>) =>
  ({ kind: 'json_assert_v1', assertions }) as Evaluation;
const exact = (expected: string, normalize: Record<string, boolean> = {}) =>
  ({
    kind: 'exact_match_v1',
    expected,
    normalize: { trim: true, lowercase: false, collapse_whitespace: false, ...normalize },
  }) as Evaluation;

describe('exact_match_v1', () => {
  it('trims by default and is case sensitive unless lowercase is declared', () => {
    expect(evaluate(exact('Billing'), '  Billing\n', limits).outcome).toBe('pass');
    expect(evaluate(exact('Billing'), 'billing', limits)).toEqual({ outcome: 'fail', code: 'output_mismatch' });
    expect(evaluate(exact('Billing', { lowercase: true }), 'bIlLiNg', limits).outcome).toBe('pass');
  });

  it('collapses whitespace only when declared', () => {
    expect(evaluate(exact('a b'), 'a   b', limits).outcome).toBe('fail');
    expect(evaluate(exact('a b', { collapse_whitespace: true }), 'a \n\t b', limits).outcome).toBe('pass');
    expect(normalizeText('  A   B ', { trim: true, lowercase: true, collapse_whitespace: true })).toBe('a b');
  });

  it('errors on oversized output instead of comparing it', () => {
    const result = evaluate(exact('x'), 'x'.repeat(70_000), limits);
    expect(result).toEqual({ outcome: 'error', code: 'output_too_large' });
  });

  it('measures output size in bytes, not characters', () => {
    const wide = 'é'.repeat(40_000); // 40k characters, 80k UTF-8 bytes
    expect(evaluate(exact('x'), wide, limits).code).toBe('output_too_large');
  });
});

describe('json_assert_v1', () => {
  const ok = '{"label":"billing","n":3,"flags":[true,false],"nested":{"a/b":1,"c~d":2}}';

  it('supports equals and one_of over JSON Pointers', () => {
    expect(evaluate(jsonAssert([{ path: '/label', equals: 'billing' }]), ok, limits).outcome).toBe('pass');
    expect(evaluate(jsonAssert([{ path: '/label', one_of: ['x', 'billing'] }]), ok, limits).outcome).toBe('pass');
    expect(evaluate(jsonAssert([{ path: '/flags/1', equals: false }]), ok, limits).outcome).toBe('pass');
    expect(evaluate(jsonAssert([{ path: '/nested/a~1b', equals: 1 }]), ok, limits).outcome).toBe('pass');
    expect(evaluate(jsonAssert([{ path: '/nested/c~0d', equals: 2 }]), ok, limits).outcome).toBe('pass');
  });

  it('fails with a specific code, and compares types strictly', () => {
    expect(evaluate(jsonAssert([{ path: '/label', equals: 'support' }]), ok, limits).code).toBe('value_mismatch');
    expect(evaluate(jsonAssert([{ path: '/label', one_of: ['x'] }]), ok, limits).code).toBe('value_not_in_set');
    expect(evaluate(jsonAssert([{ path: '/n', equals: '3' }]), ok, limits).code).toBe('value_mismatch');
    expect(evaluate(jsonAssert([{ path: '/nope', equals: 1 }]), ok, limits).code).toBe('path_missing');
    expect(evaluate(jsonAssert([{ path: '/label', equals: 'billing' }]), 'not json', limits)).toEqual({
      outcome: 'fail',
      code: 'invalid_json',
    });
  });

  it('requires every assertion to hold', () => {
    const both = jsonAssert([
      { path: '/label', equals: 'billing' },
      { path: '/n', equals: 4 },
    ]);
    expect(evaluate(both, ok, limits).outcome).toBe('fail');
  });

  it('never follows prototype properties or malformed array indices', () => {
    const output = '{"items":[1,2,3]}';
    for (const path of ['/__proto__', '/constructor', '/toString', '/items/length', '/items/01', '/items/-1', '/items/1.0', '/items/9']) {
      expect(resolvePointer(JSON.parse(output), path).found, path).toBe(false);
    }
    expect(resolvePointer(JSON.parse('{"__proto__":{"x":1}}'), '/__proto__/x')).toEqual({ found: true, value: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  describe('adversarial input', () => {
    const assertion = jsonAssert([{ path: '/a', equals: 1 }]);

    it('rejects very deep nesting without exhausting the stack', () => {
      for (const open of ['[', '{"a":']) {
        const hostile = open.repeat(200_000);
        const result = evaluate(assertion, hostile, harnessLimits({ maxOutputBytes: 1_000_000 }));
        expect(result).toEqual({ outcome: 'error', code: 'json_depth_exceeded' });
      }
    });

    it('allows nesting at the limit and counts only structural brackets', () => {
      const atLimit = `${'['.repeat(32)}${']'.repeat(32)}`;
      expect(jsonDepthExceeds(atLimit, 32)).toBe(false);
      expect(jsonDepthExceeds(`${'['.repeat(33)}`, 32)).toBe(true);
      expect(jsonDepthExceeds(JSON.stringify({ a: '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[' }), 32)).toBe(false);
      expect(jsonDepthExceeds('{"a":"\\"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[["}', 32)).toBe(false);
    });

    it('errors on oversized JSON before parsing it', () => {
      const big = JSON.stringify({ a: 'x'.repeat(100_000) });
      expect(evaluate(assertion, big, limits)).toEqual({ outcome: 'error', code: 'output_too_large' });
    });

    it('stops at the evaluation deadline', () => {
      let now = 0;
      const timed = harnessLimits({ maxOutputBytes: 1000, deadlineMs: 5, nowMs: () => (now += 10) });
      const many = jsonAssert(Array.from({ length: 10 }, () => ({ path: '/a', equals: 1 })));
      expect(evaluate(many, '{"a":1}', timed)).toEqual({ outcome: 'error', code: 'evaluation_timeout' });
    });

    it('treats truncated and trailing-garbage replies as failures, not errors', () => {
      expect(evaluate(assertion, '{"a":1', limits).code).toBe('invalid_json');
      expect(evaluate(assertion, '{"a":1} extra', limits).code).toBe('invalid_json');
      expect(evaluate(assertion, '', limits).code).toBe('invalid_json');
    });
  });

  it('has no evaluator beyond the two trusted kinds', () => {
    const bogus = { kind: 'regex_v1', pattern: '.*' } as unknown as Evaluation;
    expect(() => evaluate(bogus, 'x', limits)).toThrow(/unsupported evaluator/);
  });
});

describe('executable check', () => {
  const raw = () => structuredClone(exampleManifest()) as unknown as Record<string, any>;

  it('accepts the supported declarative component test', () => {
    const check = checkExecutable(exampleManifest());
    expect(check.executable).toBe(true);
  });

  const refusals: Array<[string, (value: Record<string, any>) => void, string]> = [
    ['an unsupported harness', (v) => (v.harness = 'python_script_v1'), 'unsupported_harness'],
    ['allow_tools: true', (v) => (v.execution.allow_tools = true), 'tools_not_allowed'],
    ['allow_project_code: true', (v) => (v.execution.allow_project_code = true), 'project_code_not_allowed'],
    ['allow_downloads: true', (v) => (v.execution.allow_downloads = true), 'downloads_not_allowed'],
    ['a workflow scope', (v) => (v.scope = 'workflow'), 'unsupported_scope'],
    ['a private fixture kind', (v) => (v.fixture_kind = 'private_local'), 'unsupported_fixture_kind'],
    ['an unknown runner contract', (v) => (v.runner_contract = 'localfirst/runner/v9'), 'unsupported_runner_contract'],
    ['an unknown evaluator', (v) => (v.cases[0].evaluation = { kind: 'regex_v1', pattern: '.*' }), 'unsupported_evaluator'],
    [
      'mixed evaluators',
      (v) => {
        v.cases.push({
          key: 'second-001',
          messages: [{ role: 'user', content: 'hi' }],
          evaluation: { kind: 'exact_match_v1', expected: 'x', normalize: { trim: true, lowercase: false, collapse_whitespace: false } },
        });
        v.limits.max_cases = 2;
      },
      'mixed_evaluators',
    ],
  ];

  for (const [name, edit, code] of refusals) {
    it(`refuses ${name}`, () => {
      const value = raw();
      edit(value);
      const check = checkExecutable(value);
      expect(check.executable).toBe(false);
      if (!check.executable) expect(check.reasons).toContain(code);
    });
  }

  it('refuses malformed and non-object input', () => {
    for (const input of [null, undefined, 'x', 42, [], {}]) {
      expect(checkExecutable(input).executable).toBe(false);
    }
    const invalid = raw();
    invalid.cases = [];
    expect(checkExecutable(invalid)).toEqual({ executable: false, reasons: ['invalid_manifest'] });
  });
});
