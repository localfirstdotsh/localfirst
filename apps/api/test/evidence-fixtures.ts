/**
 * Fixtures for the P1 evidence surface. Everything is built through the same
 * services and routes the product uses, from the PRD reference project and its
 * `request-label-v1` test, so a test cannot bypass a policy.
 */

import {
  EXAMPLE_PROJECT_MD,
  EXAMPLE_TEST_PATH,
  EXAMPLE_TEST_YAML,
  digestOf,
  type BuildInput,
  type TestResult,
} from '@localfirst/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { buildConfigurations } from '../src/db/schema/evidence.js';
import { createApproval, loadOwnedDraft } from '../src/services/drafts.js';
import { createRecordDraft, publishRecordDraft } from '../src/services/contributions.js';
import { listVersionDefinitions, type DefinitionRow } from '../src/services/test-definitions.js';
import { createWorkerCycle } from '../src/jobs/worker.js';
import {
  createAccount,
  publishProject,
  request,
  type PublishedProject,
  type TestAccount,
} from './factories.js';

export interface EvidenceProject {
  published: PublishedProject;
  definition: DefinitionRow;
}

/** Publish the PRD reference project with its executable component test. */
export async function publishEvidenceProject(
  account: TestAccount,
  testYaml = EXAMPLE_TEST_YAML,
  projectMd = EXAMPLE_PROJECT_MD,
): Promise<EvidenceProject> {
  const published = await publishProject(account, projectMd, [{ path: EXAMPLE_TEST_PATH, content: testYaml }]);
  const [definition] = await listVersionDefinitions(published.projectVersionId);
  if (!definition) throw new Error('expected a materialized test definition');
  return { published, definition };
}

const sha = (char: string) => `sha256:${char.repeat(64)}`;

export function buildFor(project: EvidenceProject, overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    schema: 'localfirst/build/v0.1',
    project_id: project.published.projectId,
    project_version_id: project.published.projectVersionId,
    configuration_key: 'local-chat',
    source: {
      kind: 'documentation',
      url: 'https://example.org/request-labeler',
      revision: null,
      project_manifest_digest: project.published.contentDigest,
    },
    model_bindings: [
      {
        role: 'classifier',
        runtime_model_id: 'qwen2.5:1.5b',
        model_version_id: null,
        artifact_identity: { scheme: 'ollama_manifest_sha256', digest: sha('6'), reference: null },
        source_url: 'https://ollama.com/library/qwen2.5',
        quantization: 'Q4_K_M',
        license_state: 'known',
        execution_location: 'local',
        locality_method: 'adapter_preflight',
      },
    ],
    runtime: {
      family: 'ollama',
      application_version: '0.35.1',
      cli_version: null,
      engine_version: 'llama.cpp-b1',
      adapter_profile: 'ollama-native/v0.1',
      backend: 'metal',
    },
    hardware: {
      platform: 'apple-silicon',
      os: { name: 'macos', version: '26.0' },
      cpu_architecture: 'arm64',
      cpu_model: 'Example chip',
      memory_bytes: 17179869184,
      unified_memory: true,
      accelerators: [{ vendor: 'apple', backend: 'metal', memory_bytes: null }],
    },
    effective_settings: { ...(project.definition.manifest.inference as BuildInput['effective_settings']) },
    changes: [],
    parent_build_id: null,
    manual_report: null,
    ...overrides,
  };
}

let runCounter = 0;
export const runId = (prefix = 'run') => `${prefix}_${Date.now().toString(36)}_${(runCounter += 1)}`;

export function resultFor(
  project: EvidenceProject,
  buildId: string,
  overrides: Partial<TestResult> = {},
): TestResult {
  const { definition, published } = project;
  return {
    schema: 'localfirst/test-result/v0.1',
    client_run_id: runId(),
    project_id: published.projectId,
    project_version_id: published.projectVersionId,
    build_id: buildId,
    test_key: definition.key,
    test_definition_id: definition.id,
    test_manifest_digest: definition.manifestDigest,
    fixture_digest: definition.fixtureDigest,
    fixture_kind: 'public_inline',
    evaluator: { kind: 'json_assert_v1', version: '1' },
    scope: 'component',
    runner: { version: '0.1.0', contract: 'localfirst/runner/v0.1' },
    outcome: 'pass',
    counts: { defined: 1, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 },
    case_results: [{ key: 'billing-001', outcome: 'pass', repetition: 1 }],
    measurements: {
      latency_ms: { value: 1200, method: 'client_monotonic_end_to_end_v1', samples: 1 },
      time_to_first_token_ms: { value: null, reason: 'nonstreaming_run' },
      tokens_per_second: { value: null, reason: 'generation_interval_not_exported' },
      peak_memory_bytes: { value: null, reason: 'runtime_sensor_unavailable' },
      hardware_utilization: { value: null, reason: 'sensor_unavailable' },
    },
    measurement_context: { load_state: 'unknown', cache_state: 'unknown', repetitions: 1, warmup_runs: 0 },
    checks: { locality: 'pass', offline: 'not_run' },
    completed_at: '2026-10-11T20:00:00Z',
    redaction_version: 'localfirst/export/v0.1',
    diagnostic_codes: [],
    visibility_requested: 'private',
    ...overrides,
  };
}

/** A failing run of the same test (counts and case outcomes stay consistent). */
export function failingResultFor(project: EvidenceProject, buildId: string): TestResult {
  return resultFor(project, buildId, {
    outcome: 'fail',
    counts: { defined: 1, evaluated: 1, passed: 0, failed: 1, errors: 0, skipped: 0 },
    case_results: [{ key: 'billing-001', outcome: 'fail', repetition: 1 }],
  });
}

export async function api(
  account: TestAccount,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    scopes?: string[];
    token?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  return request(path, {
    method: options.method ?? 'GET',
    user: account.userId,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.key ? { idempotencyKey: options.key } : {}),
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.token ? { actorKind: 'token' as const } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

/**
 * Run every due outbox event and job to completion (validation, aggregation).
 * Uses single poll cycles, never the background loop, so the shared pool stays
 * open for the rest of the test.
 */
export async function drainWorker(maxTicks = 12): Promise<void> {
  const cycle = createWorkerCycle('test-drain');
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if ((await cycle()) === 0 && (await cycle()) === 0) return;
  }
}

let keyCounter = 0;
export const key = (prefix = 'k') => `${prefix}-${Date.now().toString(36)}-${(keyCounter += 1)}`;

/** Save a build and submit a result for it through the REST routes, then validate. */
export async function submitThroughApi(
  account: TestAccount,
  project: EvidenceProject,
  options: { build?: BuildInput; result?: (buildId: string) => TestResult } = {},
) {
  const build = options.build ?? buildFor(project);
  const saved = await api(account, '/api/v1/builds', { method: 'POST', body: build, key: key('build') });
  if (saved.status >= 300) throw new Error(`build save failed: ${saved.text}`);
  const buildId = saved.json.data.build_id as string;
  const result = options.result ? options.result(buildId) : resultFor(project, buildId);
  const submitted = await api(account, '/api/v1/test-results', {
    method: 'POST',
    body: { result, build_id: buildId },
    key: key('result'),
  });
  if (submitted.status !== 202) throw new Error(`result submit failed: ${submitted.text}`);
  await drainWorker();
  return { buildId, reportId: submitted.json.data.report_id as string, result };
}

/** Publish a build and then its result through the exact-artifact approval flow. */
export async function publishRecords(
  account: TestAccount,
  buildId: string,
  reportId: string | null,
  selection: { build?: Record<string, unknown>; result?: Record<string, unknown> } = {},
) {
  const approveAndPublish = async (kind: 'build' | 'test_result', recordId: string, picked: Record<string, unknown>) => {
    const { draftRow } = await createRecordDraft({
      actor: account.actor,
      kind,
      recordId,
      selection: picked,
    });
    const loaded = await loadOwnedDraft(account.actor, draftRow.id);
    const approval = await createApproval({
      actor: account.actor,
      draftId: loaded.id,
      draftRevision: loaded.revision,
      payloadDigest: loaded.payloadDigest,
      acknowledgedWarningCodes: loaded.warningCodes,
      decision: 'approved',
      sessionId: 'test-session',
    });
    return publishRecordDraft({
      actor: account.actor,
      draftId: loaded.id,
      approvalId: approval.approvalId as string,
      draftRevision: loaded.revision,
      payloadDigest: loaded.payloadDigest,
    });
  };
  // A repeat run by the same contributor reuses a build that is already public.
  const [build] = await db().select().from(buildConfigurations).where(eq(buildConfigurations.id, buildId));
  if (build?.visibility !== 'public') {
    await approveAndPublish('build', buildId, selection.build ?? { hardware: 'coarse' });
  }
  if (reportId) await approveAndPublish('test_result', reportId, selection.result ?? {});
}

export { createAccount, digestOf };

// --------------------------------------------------------------------------
// Aggregation helpers
// --------------------------------------------------------------------------

/** Submit, publish, and have an operator accept one contributor's run. */
export async function acceptedRun(
  project: EvidenceProject,
  operator: TestAccount,
  options: {
    contributor?: TestAccount;
    build?: BuildInput;
    result?: (buildId: string) => TestResult;
    decision?: 'accepted' | 'rejected';
  } = {},
) {
  const contributor = options.contributor ?? (await createAccount());
  const { buildId, reportId } = await submitThroughApi(contributor, project, {
    ...(options.build ? { build: options.build } : {}),
    ...(options.result ? { result: options.result } : {}),
  });
  await publishRecords(contributor, buildId, reportId);
  const reviewed = await api(operator, `/api/v1/admin/test-results/${reportId}/review`, {
    method: 'POST',
    body: { decision: options.decision ?? 'accepted', reason_code: options.decision === 'rejected' ? 'rejected_unverifiable' : 'accepted_as_reported' },
  });
  if (reviewed.status !== 200) throw new Error(`review failed: ${reviewed.text}`);
  await drainWorker();
  return { contributor, buildId, reportId };
}

/** Publish an update of an existing project with a new spec version label. */
export async function publishUpdate(
  account: TestAccount,
  project: EvidenceProject,
  specVersion = '0.2.0',
): Promise<EvidenceProject> {
  const { createDirectProjectDraft, revalidateDraft, createApproval: approve } = await import('../src/services/drafts.js');
  const { publishProjectDraft } = await import('../src/services/publication.js');
  const document = EXAMPLE_PROJECT_MD.replace('version: "0.1.0"', `version: "${specVersion}"`);
  const { draft } = await createDirectProjectDraft({
    actor: account.actor,
    ownerUserId: account.userId,
    projectId: project.published.projectId,
    payload: { project_md: document, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] },
  });
  const { draft: validated, validation } = await revalidateDraft(account.actor, draft.id);
  if (!validation.readyForReview) throw new Error(JSON.stringify(validation.issues));
  const { approvalId } = await approve({
    actor: account.actor,
    draftId: validated.id,
    draftRevision: validated.revision,
    payloadDigest: validated.payloadDigest,
    acknowledgedWarningCodes: validation.warning_codes,
    decision: 'approved',
    sessionId: 'test-session',
  });
  const result = await publishProjectDraft({
    actor: account.actor,
    draftId: validated.id,
    approvalId: approvalId as string,
    draftRevision: validated.revision,
    payloadDigest: validated.payloadDigest,
  });
  const [definition] = await listVersionDefinitions(result.project_version_id);
  return {
    published: {
      ...project.published,
      projectVersionId: result.project_version_id,
      contentDigest: result.content_digest,
    },
    definition: definition as DefinitionRow,
  };
}

/** A compatibility request that names the exact build used by `buildFor`. */
export function exactEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    requirements: { inference: 'local_required', offline: false, accelerator: null },
    hardware: {
      cpu_architecture: 'arm64',
      platform: 'apple-silicon',
      os: 'macos',
      os_version: '26.0',
      memory_bytes: 17179869184,
      vram_bytes: null,
      unified_memory: true,
      accelerator: 'metal',
    },
    runtime: { family: 'ollama', version: '0.35.1', backend: 'metal', api_profile: 'ollama-native/v0.1', engine_version: 'llama.cpp-b1' },
    effective_settings: { temperature: 0, max_output_tokens: 32, context_tokens: 4096, concurrency: 1, stream: false, seed: null, reasoning: 'default' },
    selected_models: [
      {
        role: 'classifier',
        quantization: 'Q4_K_M',
        capabilities: ['chat', 'json_output'],
        unsupported_capabilities: [],
        context_tokens: 4096,
        execution_location: 'local',
        identity_known: true,
        artifact_identity: { scheme: 'ollama_manifest_sha256', digest: `sha256:${'6'.repeat(64)}`, reference: null },
      },
    ],
    ...overrides,
  };
}
