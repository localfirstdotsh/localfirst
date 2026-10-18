/**
 * Phase 2 acceptance, part 2: the opt-in contribution flow. A local run is
 * exported (reviewed), uploaded with a separate consent, stored private and
 * pending, published only through the exact-artifact human approval, reviewed
 * by an operator, aggregated, and only then changes a compatibility answer.
 * Tags like [C1] are referenced by the section 20.2 map in `coverage.test.ts`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digestOf, localPlanSchema, testResultSubmissionSchema } from '@localfirst/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { buildConfigurations, runReports } from '../../src/db/schema/evidence.js';
import { THINKER } from '../../../../packages/runner/test/support/fake-ollama.js';
import { createAccount, request, type TestAccount } from '../factories.js';
import { api, drainWorker, key, publishEvidenceProject, type EvidenceProject } from '../evidence-fixtures.js';
import {
  OLLAMA_MODEL,
  cli,
  exportPathOf,
  keychainFor,
  newRoot,
  ollamaReplying,
  planPathOf,
  reportPathOf,
  startRegistry,
  type Registry,
} from './support.js';

const closers: Array<() => Promise<void> | void> = [];
let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
});
afterAll(async () => {
  await registry.close();
});
beforeEach(() => {
  registry.log.length = 0;
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const GOOD = '{"label":"billing"}';
const SCOPES = ['tests:submit', 'builds:write'];
const SOURCE_URL = 'https://ollama.com/library/qwen2.5';

async function world() {
  const author = await createAccount();
  const operator = await createAccount({ operator: true });
  const contributor = await createAccount();
  const project = await publishEvidenceProject(author);
  return { author, operator, contributor, project };
}

/** Plan and run the registry test locally against a fake Ollama; returns the saved report. */
async function localRun(root: string, project: EvidenceProject, content = GOOD, model = OLLAMA_MODEL) {
  const fake = await ollamaReplying(content, closers, model);
  const planned = await cli(
    root,
    ['test', 'plan', project.published.projectId, '--test', 'request-label-v1', '--runtime', 'ollama', '--model', model, '--endpoint', fake.url, '--registry', registry.origin],
    { answers: ['yes'] },
  );
  expect(planned.code, planned.err).toBe(0);
  const planPath = planPathOf(planned.out);
  const plan = localPlanSchema.parse(JSON.parse(await readFile(planPath, 'utf8')).plan);
  const ran = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
  expect(ran.code, ran.err).toBe(0);
  return { fake, plan, reportPath: reportPathOf(ran.out) };
}

interface ExportOptions {
  hardware?: boolean;
  modelSourceUrl?: string;
  out?: string;
}

async function reviewExport(root: string, reportPath: string, options: ExportOptions = {}) {
  const args = ['report', 'export', reportPath, '--review'];
  if (options.modelSourceUrl) args.push('--model-source-url', options.modelSourceUrl);
  if (options.out) args.push('--out', options.out);
  const exported = await cli(root, args, { answers: [options.hardware ? 'yes' : 'no', 'yes'] });
  expect(exported.code, exported.err).toBe(0);
  return { ...exported, file: exportPathOf(exported.out) };
}

const reportRows = (submitter: TestAccount) => db().select().from(runReports).where(eq(runReports.submitterUserId, submitter.userId));
const buildRows = (owner: TestAccount) => db().select().from(buildConfigurations).where(eq(buildConfigurations.ownerUserId, owner.userId));

/** Draft, human-approve, and publish a record through the real routes. */
async function publishViaApi(
  account: TestAccount,
  kind: 'build' | 'test_result',
  recordId: string,
  selection: Record<string, unknown>,
) {
  const write = kind === 'build' ? 'builds:write' : 'tests:submit';
  const publish = kind === 'build' ? 'builds:publish' : 'tests:publish';
  const created = await request('/api/v1/drafts', {
    method: 'POST',
    user: account.userId,
    scopes: [write],
    actorKind: 'token',
    idempotencyKey: key('draft'),
    body: { kind, record_id: recordId, selection },
  });
  expect(created.status, created.text).toBe(201);
  const draft = created.json.data;

  // The approval is a human browser-session action over the exact projection; a token cannot mint it.
  const asToken = await request(`/api/v1/drafts/${draft.draft_id}/approval`, {
    method: 'POST',
    user: account.userId,
    scopes: [write],
    actorKind: 'token',
    body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes },
  });
  expect(asToken.status).toBe(403);
  const approved = await request(`/api/v1/drafts/${draft.draft_id}/approval`, {
    method: 'POST',
    user: account.userId,
    body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes },
  });
  expect(approved.status, approved.text).toBe(201);

  const published = await request(`/api/v1/drafts/${draft.draft_id}/publish`, {
    method: 'POST',
    user: account.userId,
    scopes: [publish],
    actorKind: 'token',
    idempotencyKey: key('publish'),
    body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
  });
  expect(published.status, published.text).toBeLessThan(300);
  return { draft, published };
}

function environment(plan: ReturnType<typeof localPlanSchema.parse>) {
  return {
    requirements: { inference: 'local_required', offline: false, accelerator: null },
    hardware: { cpu_architecture: 'arm64', platform: 'apple-silicon', os: 'macos', os_version: null, memory_bytes: 17179869184, vram_bytes: null, unified_memory: true, accelerator: null },
    runtime: { family: 'ollama', version: plan.runtime.application_version, backend: null, api_profile: plan.runtime.adapter_profile, engine_version: plan.runtime.engine_version },
    effective_settings: plan.settings,
    selected_models: [
      {
        role: plan.model.role,
        capabilities: ['chat', 'json_output'],
        unsupported_capabilities: [],
        context_tokens: 4096,
        execution_location: 'local',
        identity_known: true,
        artifact_identity: plan.model.artifact_identity,
        quantization: null,
      },
    ],
  };
}

const compat = (project: EvidenceProject, body: unknown) =>
  request(`/api/v1/projects/${project.published.projectId}/compatibility-checks`, { method: 'POST', body });

describe('opt-in contribution flow', () => {
  it('[C1] reviews the exact upload, needs its own consent, and stores a private pending report with no evidence level', async () => {
    const { contributor, project } = await world();
    const root = await newRoot();
    const { reportPath } = await localRun(root, project);
    registry.log.length = 0;

    const { file, out } = await reviewExport(root, reportPath, { hardware: true, modelSourceUrl: SOURCE_URL });
    expect(registry.log).toEqual([]); // review contacts nothing
    const exportFile = JSON.parse(await readFile(file, 'utf8'));
    const payload = testResultSubmissionSchema.parse(exportFile.payload);
    expect(exportFile.payload_digest).toBe(digestOf(payload));
    expect(out).toContain(exportFile.payload_digest);
    expect(payload.build.hardware).toMatchObject({ os: { name: 'macos' }, cpu_architecture: 'arm64' });
    expect(payload.build.model_bindings[0]).toMatchObject({ runtime_model_id: OLLAMA_MODEL, source_url: SOURCE_URL });

    // Upload needs a token, the right scopes, and its own explicit yes.
    const noToken = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'] });
    expect(noToken.code).toBe(1);
    const declined = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['no'], keychain: await keychainFor(registry.origin, contributor, SCOPES) });
    expect(declined.code).toBe(3);
    const submitOnly = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain: await keychainFor(registry.origin, contributor, ['tests:submit']) });
    expect(submitOnly.code).toBe(1);
    expect(submitOnly.err).toContain('tests:submit and builds:write');
    expect(await reportRows(contributor)).toEqual([]);
    expect(registry.log.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/test-results')).toHaveLength(1); // only the scoped attempt reached the server

    const submitted = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain: await keychainFor(registry.origin, contributor, SCOPES) });
    expect(submitted.code, submitted.err).toBe(0);
    expect(submitted.out).toContain('review: pending');
    expect(submitted.out).toContain('visibility: private');
    expect(submitted.out).toContain('Metadata validation is queued as operation');

    const [report] = await reportRows(contributor);
    expect(report).toMatchObject({ kind: 'test_run', reviewState: 'pending', visibility: 'private', evidenceLevel: null, outcome: 'pass' });
    const [build] = await buildRows(contributor);
    expect(build).toMatchObject({ visibility: 'private' });
    expect(report!.buildId).toBe(build!.id);
    expect(build!.payload.hardware).not.toBeNull();
    // Private means private: the public views do not show it.
    expect((await request(`/api/v1/test-results/${report!.id}`)).status).toBe(404);
    expect((await request(`/api/v1/builds/${build!.id}`)).status).toBe(404);
    expect((await request(`/api/v1/projects/${project.published.projectId}/test-results?review_state=all`)).json.data.items).toEqual([]);

    await drainWorker();
    const owner = await api(contributor, `/api/v1/test-results/${report!.id}`, { scopes: SCOPES, token: true });
    expect(owner.status).toBe(200);
    expect(owner.json.data.validation).toBeTruthy();
    expect(owner.json.data.evidence_level).toBeNull();
    expect(owner.json.data.review_state).toBe('pending');
  });

  it('[C2] a retry replays the original, and a reused run ID with different content conflicts', async () => {
    const { contributor, project } = await world();
    const root = await newRoot();
    const { reportPath } = await localRun(root, project);
    const { file } = await reviewExport(root, reportPath);
    const keychain = await keychainFor(registry.origin, contributor, SCOPES);
    const first = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain });
    expect(first.code, first.err).toBe(0);
    const retry = await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain });
    expect(retry.code, retry.err).toBe(0);
    expect(retry.out).toContain('This was a retry');
    expect(await reportRows(contributor)).toHaveLength(1);
    expect(await buildRows(contributor)).toHaveLength(1);

    // Same client run ID, different reviewed content: a conflict, never a second contributor.
    const original = JSON.parse(await readFile(file, 'utf8'));
    const altered = structuredClone(original);
    altered.payload.result.diagnostic_codes = ['operator_note'];
    altered.payload_digest = digestOf(altered.payload);
    const alteredPath = join(root, 'altered.export.json');
    await writeFile(alteredPath, JSON.stringify(altered));
    const conflict = await cli(root, ['report', 'submit', alteredPath, '--registry', registry.origin], { answers: ['yes'], keychain });
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain('conflict');
    expect(await reportRows(contributor)).toHaveLength(1);
  });

  it('[C3] uploads carry no prompt, model output, path, hostname, provider statistic, or inventory', async () => {
    const { contributor, project } = await world();
    const root = await newRoot();
    const { reportPath, plan } = await localRun(root, project, '{"label":"billing","private_note":"customer 4242"}');
    const { file } = await reviewExport(root, reportPath, { hardware: true });
    const keychain = await keychainFor(registry.origin, contributor, SCOPES);
    expect((await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain })).code).toBe(0);

    const sent = JSON.stringify(JSON.parse(await readFile(file, 'utf8')).payload);
    for (const forbidden of [
      'Please explain the charge', // fixture prompt text
      'Return a JSON object', // system prompt
      'private_note',
      'customer 4242', // model output (the whole phrase: bare digits also occur in measured numbers)
      '"eval_duration"',
      '"eval_count"',
      '"load_duration"',
      'provider_stats',
      'output_text',
      'case_details',
      'endpoint',
      '127.0.0.1',
      root, // local paths
      'bundle_dir',
      'hostname',
    ]) {
      expect(sent, forbidden).not.toContain(forbidden);
    }
    // The only model facts are the selected binding; no inventory of other installed models.
    expect(sent).not.toContain('qwen3.6');
    expect(sent).not.toContain('gemma');
    const [build] = await buildRows(contributor);
    expect(build!.payload.model_bindings).toHaveLength(1);
    expect(build!.payload.model_bindings[0]!.runtime_model_id).toBe(OLLAMA_MODEL);
    expect(plan.model.artifact_identity).toEqual(build!.payload.model_bindings[0]!.artifact_identity);
    // The stored report never holds raw output either.
    const [report] = await reportRows(contributor);
    expect(JSON.stringify(report!.payload)).not.toContain('customer 4242');
  });

  it('[C4] publication needs a human approval of the exact projection; an operator accepts; evidence appears only then', async () => {
    const { operator, contributor, project } = await world();
    const root = await newRoot();
    const { reportPath, plan } = await localRun(root, project);
    const { file } = await reviewExport(root, reportPath, { hardware: true, modelSourceUrl: SOURCE_URL });
    const keychain = await keychainFor(registry.origin, contributor, SCOPES);
    expect((await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain })).code).toBe(0);
    await drainWorker();
    const [report] = await reportRows(contributor);
    const [build] = await buildRows(contributor);

    // Private and pending: no effect on any compatibility answer yet.
    expect((await compat(project, environment(plan))).json.data.outcome).not.toBe('evidence_match');

    // An operator cannot review what the owner has not published.
    const early = await api(operator, `/api/v1/admin/test-results/${report!.id}/review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } });
    expect(early.status).toBeGreaterThanOrEqual(400);

    await publishViaApi(contributor, 'build', build!.id, { hardware: 'coarse' });
    await publishViaApi(contributor, 'test_result', report!.id, {});
    const [published] = await reportRows(contributor);
    expect(published).toMatchObject({ visibility: 'public', reviewState: 'pending', evidenceLevel: null });
    // Published but unreviewed: visible, labelled pending, and still no evidence effect.
    expect((await request(`/api/v1/test-results/${report!.id}`)).json.data).toMatchObject({ review_state: 'pending', evidence_level: null });
    expect((await compat(project, environment(plan))).json.data.outcome).not.toBe('evidence_match');

    const accepted = await api(operator, `/api/v1/admin/test-results/${report!.id}/review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } });
    expect(accepted.status, accepted.text).toBe(200);
    await drainWorker();

    const assessment = (await compat(project, environment(plan))).json.data;
    expect(assessment.outcome).toBe('evidence_match');
    expect(assessment.evidence_level).toBe('reproducible_test');
    expect(assessment.evidence_scope).toBe('component');
    expect(assessment.evidence_ids).toHaveLength(1);
    // Component evidence never implies offline use, and verification is never reachable here.
    expect(assessment.checks.find((entry: { requirement: string }) => entry.requirement === 'offline').status).toBe('unknown');
    const view = await request(`/api/v1/projects/${project.published.projectId}/compatibility-reports`);
    expect(JSON.stringify(view.json)).not.toContain('independently_verified');
    expect((await db().select().from(runReports).where(eq(runReports.id, report!.id)))[0]!.evidenceLevel).toBe('reproducible_test');

    // A different model artifact does not inherit the evidence.
    const other = environment(plan);
    other.selected_models[0]!.artifact_identity = { scheme: 'ollama_manifest_sha256', digest: `sha256:${'7'.repeat(64)}`, reference: null } as never;
    expect((await compat(project, other)).json.data.outcome).not.toBe('evidence_match');

    // Withdrawal removes it from matching again.
    const withdrawn = await api(contributor, `/api/v1/test-results/${report!.id}/withdraw`, { method: 'POST', scopes: ['tests:submit'], token: true });
    expect(withdrawn.status).toBe(200);
    await drainWorker();
    expect((await compat(project, environment(plan))).json.data.outcome).not.toBe('evidence_match');
  });

  it('[C5] without a declared model source or shared hardware, accepted evidence stays a community report and never matches a platform', async () => {
    const { operator, contributor, project } = await world();
    const root = await newRoot();
    const { reportPath, plan } = await localRun(root, project);
    const { file } = await reviewExport(root, reportPath); // no hardware, no model source
    const keychain = await keychainFor(registry.origin, contributor, SCOPES);
    expect((await cli(root, ['report', 'submit', file, '--registry', registry.origin], { answers: ['yes'], keychain })).code).toBe(0);
    await drainWorker();
    const [report] = await reportRows(contributor);
    const [build] = await buildRows(contributor);
    expect(build!.reproducibility).toBe('incomplete');
    expect(build!.payload.hardware).toBeNull();

    await publishViaApi(contributor, 'build', build!.id, {});
    await publishViaApi(contributor, 'test_result', report!.id, {});
    const accepted = await api(operator, `/api/v1/admin/test-results/${report!.id}/review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } });
    expect(accepted.status, accepted.text).toBe(200);
    await drainWorker();
    const [reviewed] = await db().select().from(runReports).where(eq(runReports.id, report!.id));
    expect(reviewed).toMatchObject({ reviewState: 'accepted', evidenceLevel: 'community_reported' });
    expect((await compat(project, environment(plan))).json.data.outcome).not.toBe('evidence_match');
  });

  it('[C6] a changed model is a new build with its own identity, and the first model’s evidence does not transfer', async () => {
    const { operator, contributor, project } = await world();
    const root = await newRoot();
    const keychain = await keychainFor(registry.origin, contributor, SCOPES);

    const first = await localRun(root, project);
    const one = await reviewExport(root, first.reportPath, { hardware: true, modelSourceUrl: SOURCE_URL, out: 'one.json' });
    expect((await cli(root, ['report', 'submit', one.file, '--registry', registry.origin], { answers: ['yes'], keychain })).code).toBe(0);

    // A different installed model (the fake runtime's SYNTHETIC local model) on the same machine and test.
    const second = await localRun(root, project, GOOD, THINKER);
    expect(second.plan.model.artifact_identity).not.toEqual(first.plan.model.artifact_identity);
    const two = await reviewExport(root, second.reportPath, { hardware: true, modelSourceUrl: 'https://ollama.com/library/thinker', out: 'two.json' });
    expect((await cli(root, ['report', 'submit', two.file, '--registry', registry.origin], { answers: ['yes'], keychain })).code).toBe(0);

    const builds = await buildRows(contributor);
    expect(builds).toHaveLength(2);
    expect(new Set(builds.map((build) => build.fingerprint)).size).toBe(2);
    expect(builds.map((build) => build.payload.model_bindings[0]!.runtime_model_id).sort()).toEqual([OLLAMA_MODEL, THINKER].sort());
    await drainWorker();

    // Accept only the first model's run: its evidence applies to that exact artifact, not the other model.
    const firstBuild = builds.find((build) => build.payload.model_bindings[0]!.runtime_model_id === OLLAMA_MODEL)!;
    const firstReport = (await reportRows(contributor)).find((report) => report.buildId === firstBuild.id)!;
    await publishViaApi(contributor, 'build', firstBuild.id, { hardware: 'coarse' });
    await publishViaApi(contributor, 'test_result', firstReport.id, {});
    expect((await api(operator, `/api/v1/admin/test-results/${firstReport.id}/review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } })).status).toBe(200);
    await drainWorker();
    expect((await compat(project, environment(first.plan))).json.data.outcome).toBe('evidence_match');
    expect((await compat(project, environment(second.plan))).json.data.outcome).not.toBe('evidence_match');
  });

  it('[C7] a manual build report needs no test definition and reaches at most community_reported', async () => {
    const { operator, contributor, project } = await world();
    const root = await newRoot();
    const { reportPath } = await localRun(root, project);
    const { file } = await reviewExport(root, reportPath, { hardware: true, modelSourceUrl: SOURCE_URL });
    const payload = JSON.parse(await readFile(file, 'utf8')).payload;
    const build = { ...payload.build, manual_report: {
      schema: 'localfirst/build-report/v0.1',
      client_run_id: key('manual').replace(/[^A-Za-z0-9_.-]/g, '_').padEnd(10, '0'),
      outcome: 'reported_success',
      method: 'Followed the documented setup on a laptop and sent one request by hand.',
      changes: null,
      checks: [{ name: 'Server starts', result: 'reported_pass' }],
      diagnostic_codes: [],
      completed_at: '2026-10-11T20:30:00Z',
    } };
    const saved = await api(contributor, '/api/v1/builds', { method: 'POST', body: build, key: key('build'), scopes: ['builds:write'], token: true });
    expect(saved.status, JSON.stringify({ project: build.project_id, version: build.project_version_id, published: project.published, text: saved.text })).toBe(201);
    const reportId = saved.json.data.manual_report.report_id as string;
    await drainWorker(); // server-side metadata validation must pass before review
    // A manual report is published with its build (one exact projection), and reviewed through the build.
    await publishViaApi(contributor, 'build', saved.json.data.build_id, { manual_report: true });
    const reviewed = await api(operator, `/api/v1/admin/builds/${saved.json.data.build_id}/report-review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } });
    expect(reviewed.status, reviewed.text).toBe(200);
    const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId));
    expect(row).toMatchObject({ kind: 'manual_build', testDefinitionId: null, evidenceLevel: 'community_reported' });
  });
});
