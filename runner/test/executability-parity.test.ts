import { testExecutability } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { checkExecutable } from '../src/index.js';
import { exampleManifest } from './helpers.js';

/**
 * The backend decides `runner_available` with the contracts mirror because it
 * cannot import the runner. These two must never disagree.
 */
const base = () => structuredClone(exampleManifest()) as unknown as Record<string, any>;

const mutations: Array<[string, (value: Record<string, any>) => void]> = [
  ['the supported example', () => undefined],
  ['an unsupported harness', (v) => (v.harness = 'python_script_v1')],
  ['allow_tools: true', (v) => (v.execution.allow_tools = true)],
  ['allow_project_code: true', (v) => (v.execution.allow_project_code = true)],
  ['allow_downloads: true', (v) => (v.execution.allow_downloads = true)],
  ['a workflow scope', (v) => (v.scope = 'workflow')],
  ['an end_to_end scope', (v) => (v.scope = 'end_to_end')],
  ['a private fixture kind', (v) => (v.fixture_kind = 'private_local')],
  ['an unknown runner contract', (v) => (v.runner_contract = 'localfirst/runner/v9')],
  ['an unknown evaluator', (v) => (v.cases[0].evaluation = { kind: 'regex_v1', pattern: '.*' })],
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
  ],
  ['no cases', (v) => (v.cases = [])],
  ['a missing execution block', (v) => delete v.execution],
  ['a string temperature', (v) => (v.inference.temperature = 'hot')],
  ['stacked refusals', (v) => { v.execution.allow_tools = true; v.scope = 'workflow'; v.harness = 'x'; }],
];

describe('contracts testExecutability mirrors the runner', () => {
  for (const [name, edit] of mutations) {
    it(`agrees on ${name}`, () => {
      const value = base();
      edit(value);
      const runner = checkExecutable(value);
      const contracts = testExecutability(value);
      expect(contracts.executable).toBe(runner.executable);
      if (!runner.executable && !contracts.executable) {
        expect([...contracts.reasons].sort()).toEqual([...runner.reasons].sort());
      }
    });
  }

  it('agrees on non-object input', () => {
    for (const input of [null, undefined, 'x', 42, [], {}]) {
      const runner = checkExecutable(input);
      const contracts = testExecutability(input);
      expect(contracts.executable).toBe(runner.executable);
      if (!runner.executable && !contracts.executable) {
        expect([...contracts.reasons].sort()).toEqual([...runner.reasons].sort());
      }
    }
  });
});
