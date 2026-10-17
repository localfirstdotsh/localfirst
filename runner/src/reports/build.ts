import {
  localReportSchema,
  type LocalPlan,
  type LocalReport,
  type TestManifest,
} from '@localfirst/contracts';
import type { RunRecord } from '../harnesses/run.js';
import {
  cacheStateOf,
  loadStateOf,
  measurementsFor,
  type ObservedFacts,
  type SensorObservations,
} from './measure.js';

export * from './measure.js';

/** Placeholder for server-assigned IDs a purely local report does not have yet. */
export const UNASSIGNED_ID = 'local';

export interface BuildReportInput {
  plan: LocalPlan;
  manifest: TestManifest;
  run: RunRecord;
  clientRunId: string;
  completedAt: string;
  /** Facts seen outside the run (e.g. preflight model state). Defaults to none. */
  observed?: ObservedFacts;
  /** Sensor observations. Without one, the metric is unavailable with a reason. */
  sensors?: SensorObservations;
  /** Coarse hardware summary the user approved sharing locally; `null` = not collected. */
  hardware?: LocalReport['hardware'];
  /** Interface-sampling result for the run; defaults to `not_run`. */
  offline?: LocalReport['checks']['offline'];
}

const MAX_DIAGNOSTICS = 20;

/**
 * Assemble the local report: the sanitized result fields plus raw provider
 * statistics and model output that never leave the machine. Measurements are
 * method-tagged (see measure.ts); a quantity with no method is `null` plus a reason.
 */
export function buildLocalReport(input: BuildReportInput): LocalReport {
  const { plan, manifest, run } = input;
  const kinds = new Set(manifest.cases.map((testCase) => testCase.evaluation.kind));
  const [kind] = [...kinds];
  if (kinds.size !== 1 || kind === undefined) {
    throw new Error('a result carries one evaluator identity; mixed evaluators are not supported');
  }

  const tally = { pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const entry of run.cases) tally[entry.outcome] += 1;
  const evaluated = tally.pass + tally.fail + tally.error;

  let outcome: LocalReport['outcome'];
  if (run.state === 'cancelled') outcome = 'cancelled';
  else if (run.state === 'run_timeout' || tally.error > 0) outcome = 'error';
  else if (tally.fail > 0) outcome = 'fail';
  else outcome = tally.skipped === 0 && tally.pass > 0 ? 'pass' : 'error';

  const locality =
    plan.model.execution_location === 'local' &&
    (plan.model.locality_method === 'adapter_preflight' ||
      plan.model.locality_method === 'adapter_preflight_and_user_confirmed_config')
      ? 'pass'
      : 'unknown';

  const report: LocalReport = {
    schema: 'localfirst/local-report/v0.1',
    client_run_id: input.clientRunId,
    project_id: plan.project.project_id,
    project_version_id: plan.project.project_version_id,
    build_id: UNASSIGNED_ID,
    test_key: plan.test.key,
    test_definition_id: plan.test.test_definition_id ?? UNASSIGNED_ID,
    test_manifest_digest: plan.test.manifest_digest,
    fixture_digest: plan.test.fixture_digest,
    fixture_kind: 'public_inline',
    evaluator: { kind, version: '1' },
    scope: plan.test.scope,
    runner: plan.runner,
    outcome,
    counts: {
      defined: run.cases.length,
      evaluated,
      passed: tally.pass,
      failed: tally.fail,
      errors: tally.error,
      skipped: tally.skipped,
    },
    case_results: run.cases.map((entry) => ({
      key: entry.key,
      outcome: entry.outcome,
      repetition: entry.repetition,
    })),
    measurements: measurementsFor(run, manifest, input.sensors),
    measurement_context: {
      load_state: loadStateOf(run, manifest, input.observed ?? {}),
      cache_state: cacheStateOf(run),
      repetitions: manifest.measurement.repetitions,
      warmup_runs: manifest.measurement.warmup_runs,
    },
    checks: { locality, offline: input.offline ?? 'not_run' },
    completed_at: input.completedAt,
    redaction_version: 'localfirst/export/v0.1',
    diagnostic_codes: run.diagnostic_codes.slice(0, MAX_DIAGNOSTICS),
    visibility_requested: 'private',
    plan_digest: plan.plan_digest,
    data_class: plan.data_class,
    plan,
    hardware: input.hardware ?? null,
    execution_state:
      run.state === 'completed'
        ? 'local_report_saved'
        : run.state === 'cancelled'
          ? 'cancelled_partial'
          : 'failed_partial',
    case_details: run.cases.map((entry) => ({
      key: entry.key,
      repetition: entry.repetition,
      outcome: entry.outcome,
      output_text: entry.output_text,
      error_code: entry.error_code,
      started_at_monotonic_ms: entry.started_at_monotonic_ms,
      provider_stats: entry.provider_stats,
    })),
  };
  return localReportSchema.parse(report);
}
