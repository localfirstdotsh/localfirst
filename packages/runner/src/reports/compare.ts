import type { LocalReport } from '@localfirst/contracts';

/**
 * Report comparison under BACKEND_PRD section 8.3. The result is eligibility
 * with reasons, never an aggregated score.
 *
 * Hard exclusions make the pair ineligible. Differences the caller did not
 * declare as the intended variable are listed as confounders. Metrics are
 * judged one by one, so a pair can be comparable on case outcomes while a
 * particular metric is not. Repeated runs by one contributor are still one
 * contributor: nothing here counts runs, and independence is a registry
 * policy (section 9.5), not a property of a local comparison.
 */
export interface ComparisonReason {
  /** Stable code, e.g. `test_digest_differs`, `settings_unknown`, `private_fixture`. */
  code: string;
  /** The compared dimension the reason is about, e.g. `fixture_digest`. */
  dimension: string;
  detail: string;
}

export interface ComparedDimension {
  dimension: string;
  status: 'match' | 'differs' | 'unknown';
  a: string | null;
  b: string | null;
}

export interface ComparedMetric {
  metric: string;
  comparable: boolean;
  /** Why the metric is not comparable; null when it is. */
  reason: string | null;
  method_a: string | null;
  method_b: string | null;
}

export interface ComparisonResult {
  /** True only when no hard exclusion applies. Confounders may still be listed. */
  eligible: boolean;
  /** Hard exclusions; empty when eligible. */
  reasons: ComparisonReason[];
  /** Differences that are not declared as the intended variable. */
  confounders: ComparisonReason[];
  /** Declared variables that actually differ between the two reports. */
  varies: string[];
  dimensions: ComparedDimension[];
  /** Per-metric comparability, each with its own reason. */
  metrics: ComparedMetric[];
  /** Interpretation warnings that do not change eligibility. */
  caveats: ComparisonReason[];
}

/** Dimensions a caller may declare as the intended variable. */
export const VARIABLE_DIMENSIONS = ['model', 'runtime', 'hardware', 'settings'] as const;
export type VariableDimension = (typeof VARIABLE_DIMENSIONS)[number];

export interface CompareOptions {
  /** Dimensions that intentionally differ, e.g. `model` or `hardware`. */
  intentionallyVaries?: VariableDimension[];
}

const METRICS = [
  'latency_ms',
  'time_to_first_token_ms',
  'tokens_per_second',
  'peak_memory_bytes',
  'hardware_utilization',
] as const;

const json = (value: unknown): string => JSON.stringify(value);

export function compareReports(a: LocalReport, b: LocalReport, options: CompareOptions = {}): ComparisonResult {
  const declared = new Set<string>(options.intentionallyVaries ?? []);
  for (const name of declared) {
    if (!(VARIABLE_DIMENSIONS as readonly string[]).includes(name)) {
      throw new RangeError(`unknown comparison variable \`${name}\``);
    }
  }

  const reasons: ComparisonReason[] = [];
  const confounders: ComparisonReason[] = [];
  const caveats: ComparisonReason[] = [];
  const dimensions: ComparedDimension[] = [];
  const varies: string[] = [];

  const exclude = (code: string, dimension: string, detail: string) => reasons.push({ code, dimension, detail });
  const dimension = (name: string, left: string | null, right: string | null, unknown = false): ComparedDimension => {
    const entry: ComparedDimension = {
      dimension: name,
      status: unknown ? 'unknown' : left === right ? 'match' : 'differs',
      a: left,
      b: right,
    };
    dimensions.push(entry);
    return entry;
  };

  // Completeness: a partial or errored run cannot support a comparison.
  for (const [label, report] of [['a', a], ['b', b]] as const) {
    if (report.execution_state !== 'local_report_saved' || report.outcome === 'cancelled') {
      exclude('incomplete_report', 'completion', `report ${label} is a partial run (${report.execution_state}, ${report.outcome})`);
    } else if (report.counts.skipped > 0) {
      exclude('incomplete_report', 'completion', `report ${label} skipped ${report.counts.skipped} case(s)`);
    } else if (report.counts.errors > 0) {
      exclude('case_errors', 'completion', `report ${label} has ${report.counts.errors} errored case(s)`);
    }
  }
  dimension('completion', `${a.execution_state}/${a.outcome}`, `${b.execution_state}/${b.outcome}`);

  for (const [label, report] of [['a', a], ['b', b]] as const) {
    if (report.data_class !== 'public_fixture') {
      exclude('private_fixture', 'data_class', `report ${label} used private local inputs and is not comparable to the public protocol`);
    }
  }
  dimension('data_class', a.data_class, b.data_class);

  // The protocol: test, fixtures, evaluator, runner, scope.
  const protocol: Array<[string, string, string, string]> = [
    ['test_key', a.test_key, b.test_key, 'test_digest_differs'],
    ['test_manifest_digest', a.test_manifest_digest, b.test_manifest_digest, 'test_digest_differs'],
    ['fixture_digest', a.fixture_digest, b.fixture_digest, 'fixture_digest_differs'],
    ['evaluator_digest', a.plan.test.evaluator_digest, b.plan.test.evaluator_digest, 'evaluator_differs'],
    ['evaluator', `${a.evaluator.kind}@${a.evaluator.version}`, `${b.evaluator.kind}@${b.evaluator.version}`, 'evaluator_differs'],
    ['runner_contract', a.runner.contract, b.runner.contract, 'runner_contract_differs'],
    ['test_scope', a.scope, b.scope, 'scope_differs'],
  ];
  for (const [name, left, right, code] of protocol) {
    if (dimension(name, left, right).status === 'differs') exclude(code, name, `${name} differs between the reports`);
  }
  for (const [label, report] of [['a', a], ['b', b]] as const) {
    if (report.scope !== 'component') {
      exclude('unsupported_scope', 'test_scope', `report ${label} is ${report.scope}; only component tests are comparable in P1`);
    }
  }

  const protocolRepeat = dimension('repetition_protocol',
    `${a.measurement_context.repetitions}x+${a.measurement_context.warmup_runs}w`,
    `${b.measurement_context.repetitions}x+${b.measurement_context.warmup_runs}w`);
  if (protocolRepeat.status === 'differs') {
    exclude('measurement_protocol_differs', 'repetition_protocol', 'repetitions or warmup runs differ');
  }

  // Effective settings: unknown values block, known differences are confounders.
  // `seed: null` is the declared unseeded value, not an unconfirmed one, so it is exempt.
  const settingsUnknown = (report: LocalReport) =>
    Object.entries(report.plan.settings)
      .filter(([key, value]) => key !== 'seed' && (value === null || value === 'unknown'))
      .map(([key]) => key);
  for (const [label, report] of [['a', a], ['b', b]] as const) {
    const unknown = settingsUnknown(report);
    if (unknown.length > 0) {
      exclude('settings_unknown', 'settings', `report ${label} has unconfirmed settings: ${unknown.join(', ')}`);
    }
  }
  const settingsDiffer = Object.keys(a.plan.settings).filter(
    (key) => json((a.plan.settings as Record<string, unknown>)[key]) !== json((b.plan.settings as Record<string, unknown>)[key]),
  );
  const settings = dimension('settings', json(a.plan.settings), json(b.plan.settings));
  if (settings.status === 'differs') vary('settings', 'settings_differ', `settings differ: ${settingsDiffer.join(', ')}`);

  // Model identity.
  for (const [label, report] of [['a', a], ['b', b]] as const) {
    if (report.plan.model.artifact_identity === null) {
      exclude('artifact_identity_missing', 'model', `report ${label} has no model artifact identity`);
    }
  }
  const identity = (report: LocalReport) =>
    `${report.plan.model.runtime_model_id} | ${json(report.plan.model.artifact_identity)}`;
  const model = dimension('model', identity(a), identity(b));
  const modelDiffers = model.status === 'differs';
  if (modelDiffers) vary('model', 'model_differs', 'the selected model differs (a task experiment, not an equivalence claim)');

  // Runtime and backend.
  const runtimeText = (report: LocalReport) =>
    `${report.plan.runtime.family} app=${report.plan.runtime.application_version ?? '?'} cli=${report.plan.runtime.cli_version ?? '?'} engine=${report.plan.runtime.engine_version ?? '?'} profile=${report.plan.runtime.adapter_profile}`;
  const runtimeUnknown = a.plan.runtime.application_version === null || b.plan.runtime.application_version === null;
  const runtime = dimension('runtime', runtimeText(a), runtimeText(b), false);
  if (runtime.status === 'differs') vary('runtime', 'runtime_differs', 'runtime, version, or adapter profile differs');
  else if (runtimeUnknown) {
    runtime.status = 'unknown';
    confounders.push({ code: 'runtime_version_unknown', dimension: 'runtime', detail: 'an application version is unknown, so a version match cannot be confirmed' });
  }

  // Hardware: null means not collected, so no hardware claim either way.
  const hardwareUnknown = a.hardware === null || b.hardware === null;
  const hardware = dimension('hardware', a.hardware === null ? null : json(a.hardware), b.hardware === null ? null : json(b.hardware), hardwareUnknown);
  if (hardware.status === 'differs') vary('hardware', 'hardware_differs', 'hardware differs');
  if (hardwareUnknown) {
    if (declared.has('hardware')) {
      exclude('hardware_unknown', 'hardware', 'hardware was declared as the variable but is not collected in both reports');
    } else {
      caveats.push({ code: 'hardware_unknown', dimension: 'hardware', detail: 'hardware was not collected in both reports; no hardware equivalence is claimed' });
    }
  }

  // Observed run context.
  const load = dimension('load_state', a.measurement_context.load_state, b.measurement_context.load_state,
    a.measurement_context.load_state === 'unknown' || b.measurement_context.load_state === 'unknown');
  const cache = dimension('cache_state', a.measurement_context.cache_state, b.measurement_context.cache_state,
    a.measurement_context.cache_state === 'unknown' || b.measurement_context.cache_state === 'unknown');
  if (load.status === 'unknown') caveats.push({ code: 'load_state_unknown', dimension: 'load_state', detail: 'warm versus cold model loading was not established for both runs' });
  if (cache.status === 'unknown') caveats.push({ code: 'cache_state_unknown', dimension: 'cache_state', detail: 'prompt cache state was not established for both runs' });

  // Metrics, one by one.
  const metrics: ComparedMetric[] = METRICS.map((name) => {
    const left = a.measurements[name];
    const right = b.measurements[name];
    const methodA = left.value === null ? null : left.method;
    const methodB = right.value === null ? null : right.method;
    let reason: string | null = null;
    if (left.value === null && right.value === null) reason = 'metric_unavailable';
    else if (left.value === null || right.value === null) reason = 'metric_unavailable_in_one_report';
    else if (methodA !== methodB) reason = 'method_differs';
    else if (name === 'latency_ms' && load.status === 'differs') reason = 'load_state_differs';
    else if (name === 'latency_ms' && cache.status === 'differs') reason = 'cache_state_differs';
    return { metric: name, comparable: reason === null, reason, method_a: methodA, method_b: methodB };
  });
  if (modelDiffers && metrics.find((entry) => entry.metric === 'tokens_per_second')?.comparable) {
    caveats.push({ code: 'tokenizer_differs_across_models', dimension: 'tokens_per_second', detail: 'token counts depend on each model\'s tokenizer, so cross-model token rates are not equivalent throughput' });
  }
  if (a.client_run_id === b.client_run_id) {
    caveats.push({ code: 'same_run', dimension: 'client_run_id', detail: 'both reports are the same run' });
  }

  return { eligible: reasons.length === 0, reasons, confounders, varies, dimensions, metrics, caveats };

  /** A difference is the declared variable, or else a confounder. */
  function vary(group: VariableDimension, code: string, detail: string): void {
    if (declared.has(group)) varies.push(group);
    else confounders.push({ code, dimension: group, detail });
  }
}
