import { eq } from 'drizzle-orm';
import { digestOf, environmentSchema, parseSafeYaml, workflowDigests, type WorkflowResult, type WorkflowTest } from '@localfirst/contracts';
import { projectVersionFiles } from '../db/schema/registry.js';
import { db } from '../db/client.js';
import type { DefinitionRow } from '../services/test-definitions.js';
import type { BuildRecord } from '../services/builds.js';
import type { ServerCheck } from './evidence.js';

/** Verifies submitted identities and structural claims; never asserts observed inference. */
export async function evaluateWorkflowChecks(result: WorkflowResult, test: WorkflowTest, definition: DefinitionRow, build: BuildRecord, owner: string): Promise<ServerCheck[]> {
  const checks: ServerCheck[] = [];
  const check = (code: string, ok: boolean, kind: ServerCheck['kind'] = 'integrity') => checks.push({ code, status: ok ? 'pass' : 'fail', kind });
  check('schema_valid', true);
  check('build_owned_by_submitter', build.ownerUserId === owner);
  check('binding_consistent', result.project_id === definition.projectId && result.project_version_id === definition.projectVersionId &&
    build.projectVersionId === definition.projectVersionId && result.build_id === build.id && result.test_key === definition.key &&
    result.test_definition_id === definition.id && build.configurationKey === definition.configurationKey);
  const digests = workflowDigests(test);
  check('definition_digests_recomputed', digests.manifest_digest === definition.manifestDigest && digests.fixture_digest === definition.fixtureDigest && digests.evaluator_digest === definition.evaluatorDigest);
  check('manifest_digest_matches', result.test_manifest_digest === digests.manifest_digest);
  check('fixture_digest_matches', result.fixture_digest === digests.fixture_digest);
  check('scope_matches', result.scope === 'workflow' && definition.scope === 'workflow');
  check('evaluator_matches', result.evaluator.kind === 'json_assert_v1' && result.evaluator.version === '1');
  check('case_protocol_matches', result.case_results.length === test.cases.length && result.counts.defined === test.cases.length &&
    result.case_results.every(c => c.repetition === 1 && test.cases.some(t => t.key === c.key)));
  const files = await db().select().from(projectVersionFiles).where(eq(projectVersionFiles.projectVersionId, definition.projectVersionId));
  const environments = files.filter(f => f.kind === 'environment_manifest').map(f => environmentSchema.safeParse(parseSafeYaml(f.content)));
  const env = environments.find(e => e.success && e.data.key === test.environment_key);
  if (!env?.success || build.payload.schema !== 'localfirst/build/v0.2') {
    check('environment_bound', false);
    return checks;
  }
  const declared = env.data, identity = build.payload.workflow;
  check('environment_bound', digestOf(declared) === test.environment_digest && identity.environment_key === declared.key &&
    identity.environment_digest === test.environment_digest && result.workflow.environment_digest === test.environment_digest);
  check('framework_identity_matches', declared.framework ? identity.framework !== undefined && identity.framework.entry_digest === declared.framework.entry_digest && identity.framework.lock_digest === declared.framework.lock_digest && identity.framework.sdk_version === declared.framework.sdk_version : identity.framework === undefined);
  check('coordinator_and_operations_match', identity.coordinator === declared.coordinator &&
    identity.operation_digest === digestOf(declared.nodes.filter(n => n.kind === 'operation').map(n => ({ id: n.id, operation: n.operation }))));
  const { steps: _steps, ...resultIdentity } = result.workflow;
  void _steps;
  check('result_build_identity_matches', digestOf(resultIdentity) === digestOf(identity));
  check('role_bindings_complete', declared.model_roles.length === build.payload.model_bindings.length &&
    declared.model_roles.every(r => build.payload.model_bindings.some(b => b.role === r.key)));
  check('role_settings_match', declared.model_roles.every(r => identity.role_settings.some(s => s.role === r.key && digestOf(s.settings) === digestOf(r.settings))));
  check('steps_match_graph', result.case_results.every(c => {
    const steps = result.workflow.steps.filter(s => s.case_key === c.key);
    if (c.outcome === 'skipped') return steps.length === 0 || steps.every(s => s.outcome === 'skipped');
    return steps.length === declared.nodes.length && steps.every((s, i) => s.id === declared.nodes[i]!.id && s.kind === declared.nodes[i]!.kind) &&
      ((c.outcome !== 'pass' && c.outcome !== 'fail') || steps.every(s => s.outcome === 'completed'));
  }));
  check('definition_executable', definition.executable, 'eligibility');
  check('artifact_identity_present', build.payload.model_bindings.every(b => b.artifact_identity !== null), 'eligibility');
  check('build_identity_sufficient', build.reproducibility !== 'incomplete', 'eligibility');
  check('locality_verified', result.checks.locality === 'pass', 'eligibility');
  check('run_complete', result.outcome !== 'cancelled' && result.counts.skipped === 0 && result.counts.errors === 0, 'eligibility');
  return checks;
}
