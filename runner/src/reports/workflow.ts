import {
  digestOf, workflowLocalReportSchema, anyTestResultSubmissionSchema,
  type WorkflowLocalReport, type BuildInput,
} from '@localfirst/contracts';
import { UNASSIGNED_ID } from './build.js';
import { ExportRefusedError } from './export.js';

export function exportWorkflowUpload(raw: WorkflowLocalReport, options: { definitionId?: string; modelSourceUrl?: string | null; hardware?: BuildInput['hardware'] }) {
  const report = workflowLocalReportSchema.parse(raw), { plan, environment, run } = report;
  if (plan.data_class !== 'public_fixture') throw new ExportRefusedError('private_data_class');
  const definition = options.definitionId ?? plan.test.definition_id;
  if (!definition) throw new ExportRefusedError('test_definition_unresolved');
  const identity = {
    environment_key: environment.key, environment_digest: plan.environment_digest, coordinator: environment.coordinator,
    operation_digest: digestOf(environment.nodes.filter(n => n.kind === 'operation').map(n => ({ id: n.id, operation: n.operation }))),
    role_settings: plan.bindings.map(b => ({ role: b.role, settings: b.settings })),
    ...(plan.framework ? { framework: { profile: plan.framework.profile, sdk_version: plan.framework.sdk_version, entry_digest: plan.framework.entry_digest, lock_digest: plan.framework.lock_digest, image_id: plan.framework.image_id, worker_digest: plan.framework.worker_digest } } : {}),
  };
  const counts = {
    defined: run.cases.length, evaluated: run.cases.filter(c => c.outcome !== 'skipped').length,
    passed: run.cases.filter(c => c.outcome === 'pass').length, failed: run.cases.filter(c => c.outcome === 'fail').length,
    errors: run.cases.filter(c => c.outcome === 'error').length, skipped: run.cases.filter(c => c.outcome === 'skipped').length,
  };
  const unavailable = { value: null, reason: 'not_measured' };
  const payload = anyTestResultSubmissionSchema.parse({
    build: {
      schema: 'localfirst/build/v0.2', ...plan.project,
      source: { kind: 'authored_specification', url: null, revision: null, project_manifest_digest: plan.bundle_digest },
      model_bindings: plan.bindings.map(b => ({
        role: b.role, runtime_model_id: b.runtime_model_id, artifact_identity: b.artifact_identity, model_version_id: null,
        quantization: b.quantization, source_url: options.modelSourceUrl ?? null, license_state: 'unknown', execution_location: 'local', locality_method: b.locality_method,
      })),
      runtime: { family: plan.runtime.family, application_version: plan.runtime.application_version, cli_version: plan.runtime.cli_version, engine_version: plan.runtime.engine_version, adapter_profile: plan.runtime.adapter_profile, backend: null },
      hardware: options.hardware ?? null, effective_settings: plan.bindings[0]!.settings,
      changes: [{ kind: 'model_selection', note: 'Selected an already installed local model for workflow roles.', role: null }],
      parent_build_id: null, manual_report: null, workflow: identity,
    },
    result: {
      schema: 'localfirst/test-result/v0.2', client_run_id: report.client_run_id, project_id: plan.project.project_id, project_version_id: plan.project.project_version_id,
      build_id: UNASSIGNED_ID, test_key: plan.test.key, test_definition_id: definition,
      test_manifest_digest: plan.test.manifest_digest, fixture_digest: plan.test.fixture_digest,
      fixture_kind: 'public_inline', evaluator: { kind: 'json_assert_v1', version: '1' }, scope: 'workflow', runner: plan.runner,
      outcome: run.state === 'cancelled' ? 'cancelled' : counts.errors > 0 || counts.skipped > 0 ? 'error' : counts.failed > 0 ? 'fail' : 'pass',
      counts, case_results: run.cases.map(c => ({ key: c.key, outcome: c.outcome, repetition: 1 })),
      measurements: { latency_ms: { value: run.elapsed_ms, method: 'client_monotonic_end_to_end_v1', samples: 1 }, time_to_first_token_ms: unavailable, tokens_per_second: unavailable, peak_memory_bytes: unavailable, hardware_utilization: unavailable },
      measurement_context: { repetitions: 1, warmup_runs: 0, load_state: 'unknown', cache_state: 'unknown' },
      checks: { locality: report.locality, offline: report.offline }, completed_at: report.completed_at,
      redaction_version: 'localfirst/export/v0.1', diagnostic_codes: [...new Set(run.cases.map(c => c.error_code).filter((c): c is string => c !== null))].slice(0, 20),
      visibility_requested: 'private',
      workflow: { ...identity, steps: run.cases.flatMap(c => c.steps.map(s => ({ case_key: c.key, id: s.id, kind: s.kind, outcome: s.outcome, latency_ms: s.latency_ms, error_code: s.error_code }))) },
    },
  });
  return { payload, payload_digest: digestOf(payload) };
}

export function compareWorkflowReports(a: WorkflowLocalReport, b: WorkflowLocalReport) {
  const reasons: string[] = [];
  for (const r of [a, b]) {
    if (r.plan.data_class !== 'public_fixture') reasons.push('private_fixture');
    if (r.run.state !== 'completed' || r.run.cases.some(c => c.outcome === 'error' || c.outcome === 'skipped')) reasons.push('incomplete_run');
    if (r.plan.bindings.some(m => m.artifact_identity === null)) reasons.push('artifact_identity_incomplete');
  }
  if (a.plan.bundle_digest !== b.plan.bundle_digest || a.plan.test.manifest_digest !== b.plan.test.manifest_digest ||
    a.plan.test.fixture_digest !== b.plan.test.fixture_digest || a.plan.test.evaluator_digest !== b.plan.test.evaluator_digest ||
    a.plan.environment_digest !== b.plan.environment_digest || a.plan.runner.contract !== b.plan.runner.contract) reasons.push('workflow_protocol_differs');
  const dimensions = { model: digestOf(a.plan.bindings.map(m => ({ role: m.role, identity: m.artifact_identity }))) !== digestOf(b.plan.bindings.map(m => ({ role: m.role, identity: m.artifact_identity }))), runtime: digestOf(a.plan.runtime) !== digestOf(b.plan.runtime) };
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], dimensions, metric: 'case_outcomes', caveats: ['Timing comparisons require known load/cache and comparable hardware; this compares fixture outcomes only.'] };
}
