/**
 * Whether a first-party runner can execute a test definition.
 *
 * The hosted registry cannot depend on the runner, so this is a pure mirror of
 * the runner's `checkExecutable` (runner/src/harnesses/executable.ts). A parity
 * test in the runner package asserts the two agree. A declared harness is not a
 * shipped runner: `runner_available` is true only for definitions this accepts.
 */

import { EVALUATOR_KINDS, RUNNER_CONTRACT_ID } from '../vocabulary.js';
import { testManifestSchema, type TestManifest } from './schema.js';

export type ExecutabilityRefusal =
  | 'unsupported_harness'
  | 'unsupported_runner_contract'
  | 'unsupported_scope'
  | 'unsupported_fixture_kind'
  | 'unsupported_evaluator'
  | 'mixed_evaluators'
  | 'tools_not_allowed'
  | 'project_code_not_allowed'
  | 'downloads_not_allowed'
  | 'invalid_manifest';

export type TestExecutability =
  | { executable: true; manifest: TestManifest }
  | { executable: false; reasons: ExecutabilityRefusal[] };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export function testExecutability(input: unknown): TestExecutability {
  const raw = record(input);
  const execution = record(raw.execution);
  const reasons = new Set<ExecutabilityRefusal>();

  if (raw.harness !== 'declarative_task_v1') reasons.add('unsupported_harness');
  if (raw.runner_contract !== RUNNER_CONTRACT_ID) reasons.add('unsupported_runner_contract');
  if (raw.scope !== 'component') reasons.add('unsupported_scope');
  if (raw.fixture_kind !== 'public_inline') reasons.add('unsupported_fixture_kind');
  if (execution.allow_tools !== false) reasons.add('tools_not_allowed');
  if (execution.allow_project_code !== false) reasons.add('project_code_not_allowed');
  if (execution.allow_downloads !== false) reasons.add('downloads_not_allowed');

  const kinds = new Set<unknown>();
  if (Array.isArray(raw.cases)) {
    for (const testCase of raw.cases) kinds.add(record(record(testCase).evaluation).kind);
  }
  for (const kind of kinds) {
    if (!(EVALUATOR_KINDS as readonly unknown[]).includes(kind)) reasons.add('unsupported_evaluator');
  }
  // The sanitized result schema carries one evaluator identity (test-result/v0.1).
  if (kinds.size > 1) reasons.add('mixed_evaluators');

  if (reasons.size > 0) return { executable: false, reasons: [...reasons] };

  const parsed = testManifestSchema.safeParse(input);
  if (!parsed.success) return { executable: false, reasons: ['invalid_manifest'] };
  return { executable: true, manifest: parsed.data };
}
