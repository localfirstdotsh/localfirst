/** Comparison keys contain protocol facts, never measurements or private payloads. */
import { digestOf, type ComparisonQuery } from '@localfirst/contracts';

export interface PublicRun {
  reportId: string;
  submitterId: string;
  report: Record<string, any>;
  build: Record<string, any>;
  definition: { manifestDigest: string; fixtureDigest: string; evaluatorDigest: string; executable: boolean; manifest: any };
}
const same = (a: unknown, b: unknown) => digestOf(a) === digestOf(b);
export function comparisonFacts(run: PublicRun, query: Pick<ComparisonQuery, 'varies' | 'metric'>) {
  const { report: r, build: b, definition: d } = run;
  const reasons: string[] = [];
  if (!d.executable || !['component', 'workflow'].includes(r.scope)) reasons.push('unsupported_scope_or_harness');
  if (r.fixture_kind !== 'public_inline') reasons.push('private_fixture');
  if (r.test_manifest_digest !== d.manifestDigest || r.fixture_digest !== d.fixtureDigest) reasons.push('definition_drift');
  if (!['pass', 'fail'].includes(r.outcome) || r.counts?.skipped || r.counts?.errors || r.counts?.evaluated !== r.counts?.defined) reasons.push('incomplete_run');
  if (!b.model_bindings?.length || b.model_bindings.some((m: any) => !m.artifact_identity?.digest || (!m.source_url && !m.model_version_id))) reasons.push('artifact_identity_incomplete');
  if (!b.runtime?.application_version || !b.runtime?.engine_version || !b.runtime?.backend) reasons.push('runtime_identity_incomplete');
  if (!b.hardware?.memory_bytes || !b.hardware?.cpu_architecture || !b.hardware?.os?.name) reasons.push('hardware_not_shared');
  if (!b.effective_settings || Object.entries(b.effective_settings).some(([k,v]) => k !== 'seed' && (v === null || v === 'unknown'))) reasons.push('settings_unknown');
  if (r.checks?.locality !== 'pass') reasons.push('locality_unresolved');
  if (r.scope === 'workflow' && (!b.workflow || !r.case_results || !r.workflow?.steps?.length)) reasons.push('workflow_protocol_not_shared');
  const metric = query.metric === 'case_outcomes' ? null : r.measurements?.[query.metric];
  if (query.metric !== 'case_outcomes' && (metric?.value === null || metric?.value === undefined || !metric?.method)) reasons.push('metric_unavailable');
  // Load/cache uncertainty does not invalidate evaluator outcomes, but timing cannot silently ignore it.
  if (query.metric !== 'case_outcomes' && ['unknown', undefined].includes(r.measurement_context?.load_state)) reasons.push('load_state_unknown');
  if (query.metric !== 'case_outcomes' && ['unknown', undefined].includes(r.measurement_context?.cache_state)) reasons.push('cache_state_unknown');
  const dimensions = {
    model: b.model_bindings?.map((m: any) => ({ role: m.role, artifact_identity: m.artifact_identity, quantization: m.quantization })).sort((a: any,b: any) => a.role.localeCompare(b.role)) ?? null,
    runtime: b.runtime ?? null,
    hardware: b.hardware ?? null,
    settings: b.effective_settings ?? null,
    load_state: r.measurement_context?.load_state ?? null,
    cache_state: r.measurement_context?.cache_state ?? null,
    changes: b.changes ?? [],
  };
  const protocol = {
    project_version_id: r.project_version_id, configuration_key: b.configuration_key,
    manifest_digest: d.manifestDigest, fixture_digest: d.fixtureDigest, evaluator_digest: d.evaluatorDigest,
    fixture_kind: r.fixture_kind, scope: r.scope, evaluator: r.evaluator,
    runner: r.runner, adapter_profile: b.runtime?.adapter_profile,
    ...(r.scope === 'workflow' ? { workflow: b.workflow ?? null } : {}),
    workload: { context_tokens: b.effective_settings?.context_tokens, concurrency: b.effective_settings?.concurrency },
    repetitions: r.measurement_context?.repetitions, warmup_runs: r.measurement_context?.warmup_runs,
    metric: query.metric, metric_method: metric?.method ?? 'declared_case_evaluator_v1',
    metric_samples: metric?.samples ?? r.counts?.defined,
  };
  return { reasons, protocol, dimensions, key: digestOf({ protocol, varies: query.varies }) };
}

export function comparePublicRuns(a: PublicRun, b: PublicRun, query: Pick<ComparisonQuery, 'varies' | 'metric'>) {
  const left = comparisonFacts(a, query), right = comparisonFacts(b, query);
  const reasons = [...new Set([...left.reasons, ...right.reasons])];
  if (left.key !== right.key) reasons.push('protocol_or_metric_method_differs');
  const differences = Object.keys(left.dimensions).filter(k => !same(left.dimensions[k as keyof typeof left.dimensions], right.dimensions[k as keyof typeof right.dimensions]));
  return {
    eligible: reasons.length === 0, reasons,
    varies: differences.filter(k => k === query.varies),
    confounders: differences.filter(k => k !== query.varies),
    caveats: ['Fixture outcomes at their declared scope are not general task accuracy or a complete business deployment.', 'Hardware is a coarse approved disclosure; unobserved hardware/software differences may remain.', ...(query.varies === 'model' && query.metric === 'tokens_per_second' ? ['Tokenizers differ across models; token rates are not equivalent throughput.'] : [])],
    dimensions: { a: left.dimensions, b: right.dimensions }, protocol: left.protocol,
  };
}
