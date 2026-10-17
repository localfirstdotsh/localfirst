import { EVALUATOR_KINDS, RUNNER_CONTRACT_ID, testManifestSchema, type TestManifest } from '@localfirst/contracts';

export type RefusalCode =
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

export type ExecutableCheck =
  | { executable: true; manifest: TestManifest }
  | { executable: false; reasons: RefusalCode[] };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * Decide whether the runner may execute a test, before and independent of
 * schema parsing. Anything outside the supported declarative component
 * protocol is refused as non-executable; it is never run "best effort"
 * (BACKEND_PRD sections 5.1, 7.6). `allow_*: true` is a refusal, not a grant.
 */
export function checkExecutable(input: unknown): ExecutableCheck {
  const raw = record(input);
  const execution = record(raw.execution);
  const reasons = new Set<RefusalCode>();

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
  // The sanitized result schema carries a single evaluator identity (test-result/v0.1).
  if (kinds.size > 1) reasons.add('mixed_evaluators');

  if (reasons.size > 0) return { executable: false, reasons: [...reasons] };

  const parsed = testManifestSchema.safeParse(input);
  if (!parsed.success) return { executable: false, reasons: ['invalid_manifest'] };
  return { executable: true, manifest: parsed.data };
}
