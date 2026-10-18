import { afterEach, it, expect } from 'vitest';
import { bakeryBundle, digestOf, workflowDigests, workflowBuildInputSchema, workflowResultSchema, anyTestResultSchema } from '@localfirst/contracts';
import { config } from '../src/config.js';
import { createAccount, publishProject } from './factories.js';
import { loadDefinitionByKey } from '../src/services/test-definitions.js';
import { submitTestResult, validateStoredReport, reviewReport } from '../src/services/reports.js';
import { publishRecords } from './evidence-fixtures.js';
import { reaggregateProject, summariesForProject } from '../src/services/evidence.js';
import { buildSubject, matchSubject } from '../src/domain/evidence-match.js';
import { compatibilityRequestSchema } from '@localfirst/contracts';

afterEach(() => { config().features.workflowResults = false; config().features.agentEnvironments = false; });
async function world() {
  const owner = await createAccount(), sample = bakeryBundle();
  const project = await publishProject(owner, sample.project_md, sample.files);
  const definition = (await loadDefinitionByKey(project.projectVersionId, sample.test.key))!;
  const workflow = { environment_key: sample.environment.key, environment_digest: digestOf(sample.environment), coordinator: sample.environment.coordinator,
    operation_digest: digestOf(sample.environment.nodes.filter(n => n.kind === 'operation').map(n => ({ id: n.id, operation: n.operation }))),
    role_settings: sample.environment.model_roles.map(r => ({ role: r.key, settings: r.settings })) };
  const modelIdentity = { scheme: 'ollama_manifest_sha256', digest: 'sha256:' + '6'.repeat(64), reference: null };
  const build = workflowBuildInputSchema.parse({
    schema: 'localfirst/build/v0.2', project_id: project.projectId, project_version_id: project.projectVersionId, configuration_key: sample.test.configuration_key,
    source: { kind: 'authored_specification', url: null, revision: null, project_manifest_digest: project.contentDigest },
    model_bindings: sample.environment.model_roles.map(r => ({ role: r.key, runtime_model_id: 'synthetic-model', model_version_id: null, artifact_identity: modelIdentity, source_url: 'https://example.org/synthetic-model', quantization: 'Q4_K_M', license_state: 'known', execution_location: 'local', locality_method: 'adapter_preflight' })),
    runtime: { family: 'ollama', application_version: '0.35.1', cli_version: null, engine_version: 'synthetic-engine', adapter_profile: 'ollama-native/v0.1', backend: 'metal' },
    hardware: null, effective_settings: sample.environment.model_roles[0]!.settings, workflow,
  });
  const unavailable = { value: null, reason: 'not_measured' };
  const result = workflowResultSchema.parse({
    schema: 'localfirst/test-result/v0.2', client_run_id: 'synthetic-workflow-run', project_id: project.projectId, project_version_id: project.projectVersionId,
    build_id: '00000000-0000-4000-8000-000000000000', test_key: sample.test.key, test_definition_id: definition.id,
    test_manifest_digest: workflowDigests(sample.test).manifest_digest, fixture_digest: workflowDigests(sample.test).fixture_digest,
    fixture_kind: 'public_inline', evaluator: { kind: 'json_assert_v1', version: '1' }, scope: 'workflow', runner: { version: '0.2.0', contract: 'localfirst/runner/v0.2' },
    outcome: 'pass', counts: { defined: 8, evaluated: 8, passed: 8, failed: 0, errors: 0, skipped: 0 },
    case_results: sample.test.cases.map(c => ({ key: c.key, outcome: 'pass', repetition: 1 })),
    measurements: { latency_ms: unavailable, time_to_first_token_ms: unavailable, tokens_per_second: unavailable, peak_memory_bytes: unavailable, hardware_utilization: unavailable },
    measurement_context: { load_state: 'unknown', cache_state: 'unknown', repetitions: 1, warmup_runs: 0 },
    checks: { locality: 'pass', offline: 'not_run' }, completed_at: '2026-10-14T20:00:00Z', redaction_version: 'localfirst/export/v0.1', diagnostic_codes: [], visibility_requested: 'private',
    workflow: { ...workflow, steps: sample.test.cases.flatMap(c => sample.environment.nodes.map(n => ({ case_key: c.key, id: n.id, kind: n.kind, outcome: 'completed', latency_ms: 1, error_code: null }))) },
  });
  return { owner, sample, project, definition, build, result };
}
it('stores private versioned workflow evidence, validates it, and preserves workflow scope after publication/review', async () => {
  const w = await world();
  config().features.workflowResults = true; config().features.agentEnvironments = true;
  const saved = await submitTestResult({ actor: w.owner.actor, result: w.result, build: w.build });
  expect(saved.report.visibility).toBe('private');
  expect(saved.report.reviewState).toBe('pending');
  expect(await validateStoredReport(saved.report.id)).toBe('valid');
  await publishRecords(w.owner, saved.build.id, saved.report.id);
  const operator = await createAccount({ operator: true });
  const reviewed = await reviewReport({ actor: operator.actor, reportId: saved.report.id, decision: 'accepted', reasonCode: 'accepted_as_reported', note: null });
  expect(reviewed.evidenceLevel).toBe('reproducible_test');
  await reaggregateProject(w.project.projectId);
  const summaries = await summariesForProject(w.project.projectId);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]!.scope).toBe('workflow');
  expect(summaries[0]!.subject.workflow?.environment_digest).toBe(w.result.workflow.environment_digest);
});
it('does not interpret component configuration facts as matching complete workflow evidence', async () => {
  const w = await world(), subject = buildSubject(w.build);
  const request = compatibilityRequestSchema.parse({ effective_settings: w.build.effective_settings });
  expect(matchSubject(subject, request).unmatched).toContain('workflow_identity_not_shared');
  expect(matchSubject(subject, { ...request, workflow_identity: { ...w.build.workflow, operation_digest: 'sha256:' + '7'.repeat(64) } }).unmatched).toContain('workflow_identity_differs');
});
it('rejects private trace extras and gates new writes independently of historical reads', async () => {
  const w = await world();
  const raw = structuredClone(w.result) as any;
  raw.workflow.steps[0].output = { customer: 'private' };
  expect(anyTestResultSchema.safeParse(raw).success).toBe(false);
  await expect(submitTestResult({ actor: w.owner.actor, result: w.result, build: w.build })).rejects.toMatchObject({ code: 'PHASE_UNAVAILABLE' });
});
