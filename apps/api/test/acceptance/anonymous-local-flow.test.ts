/**
 * Phase 2 acceptance, part 1: the anonymous public-spec / local-test flow and
 * the failure paths, end to end (real backend on a socket, real CLI, real
 * adapters against fake runtimes). Tags like [A1] are referenced by the
 * BACKEND_PRD section 20.2 coverage map in `coverage.test.ts`.
 *
 * Cloud, remote-linked, and unknown-origin models come from SYNTHETIC fixtures
 * (none could be captured: no cloud model is installed); the tests say so.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_TEST_YAML, localPlanSchema, localReportSchema } from '@localfirst/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD, UNKNOWN_LOCALITY } from '../../../../packages/runner/test/support/fake-ollama.js';
import { REMOTE_MODEL, UNKNOWN_ORIGIN_MODEL } from '../../../../packages/runner/test/support/fake-lmstudio.js';
import { createAccount, request } from '../factories.js';
import { publishEvidenceProject, type EvidenceProject } from '../evidence-fixtures.js';
import {
  LMSTUDIO_MODEL,
  OLLAMA_MODEL,
  chatsOf,
  cli,
  lmChatsOf,
  lmStudioCommands,
  lmStudioReplying,
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
const TEST = 'request-label-v1';

async function world(testYaml?: string) {
  const author = await createAccount();
  const project = await publishEvidenceProject(author, testYaml);
  return { author, project };
}

const ollamaPlanArgs = (project: EvidenceProject, url: string, model = OLLAMA_MODEL) => [
  'test', 'plan', project.published.projectId, '--test', TEST, '--runtime', 'ollama', '--model', model, '--endpoint', url, '--registry', registry.origin,
];
const lmStudioPlanArgs = (project: EvidenceProject, endpoint: string, model = LMSTUDIO_MODEL) => [
  'test', 'plan', project.published.projectId, '--test', TEST, '--runtime', 'lmstudio', '--model', model, '--endpoint', endpoint, '--registry', registry.origin,
];
const lmOptions = { platform: 'darwin' as const, runCommand: lmStudioCommands };

describe('anonymous public-spec / local test flow', () => {
  it('[A1] exports, plans, and runs on Ollama with no account, saves a local report, and uploads nothing', async () => {
    const { project } = await world();
    const fake = await ollamaReplying(GOOD, closers);
    const root = await newRoot();

    const exported = await cli(root, ['project', 'export', project.published.projectId, '--out', 'bundle', '--registry', registry.origin]);
    expect(exported.code, exported.err).toBe(0);
    const meta = JSON.parse(await readFile(join(root, 'cwd', 'bundle', '.localfirst-bundle.json'), 'utf8'));
    expect(meta.content_digest).toBe(project.published.contentDigest);

    const planned = await cli(root, ollamaPlanArgs(project, fake.url), { answers: ['yes'] });
    expect(planned.code, planned.err).toBe(0);
    expect(planned.h.keychain.reads).toEqual([]);
    expect(chatsOf(fake)).toEqual([]);
    const planFile = JSON.parse(await readFile(planPathOf(planned.out), 'utf8'));
    const plan = localPlanSchema.parse(planFile.plan);
    expect(plan.test).toMatchObject({ test_definition_id: project.definition.id, bundle_digest: project.published.contentDigest });
    expect(plan.project.project_version_id).toBe(project.published.projectVersionId);
    expect(plan.runtime).toMatchObject({ family: 'ollama', application_version: '0.35.1', cli_version: null, engine_version: null });
    expect(plan.model.artifact_identity).toMatchObject({ scheme: 'ollama_manifest_sha256' });

    const ran = await cli(root, ['test', 'run', planPathOf(planned.out), '--remember'], { answers: ['yes'] });
    expect(ran.code, ran.err).toBe(0);
    expect(chatsOf(fake)).toHaveLength(1);
    const report = localReportSchema.parse(JSON.parse(await readFile(reportPathOf(ran.out), 'utf8')));
    expect(report).toMatchObject({ outcome: 'pass', execution_state: 'local_report_saved', data_class: 'public_fixture', checks: { locality: 'pass', offline: 'not_run' } });
    expect(ran.out).toContain('Nothing was uploaded');

    // A noninteractive rerun works only through the stored, digest-bound approval.
    const rerun = await cli(root, ['test', 'run', planPathOf(planned.out)], { tty: false });
    expect(rerun.code, rerun.err).toBe(0);
    expect(rerun.out).toContain('Using the stored approval');
    expect(chatsOf(fake)).toHaveLength(2);

    // Registry side: only anonymous reads. No token, no build, result, draft, or other write.
    expect(registry.log.length).toBeGreaterThan(0);
    expect(registry.log.every((entry) => entry.method === 'GET' && !entry.authorized)).toBe(true);
    expect(registry.log.some((entry) => /\/(builds|test-results|drafts)/.test(entry.path))).toBe(false);
  });

  it('[A2] plans and runs the same test on LM Studio, keeping app, CLI, and engine versions separate', async () => {
    const { project } = await world();
    const lm = await lmStudioReplying(GOOD, closers);
    const root = await newRoot();
    const planned = await cli(root, lmStudioPlanArgs(project, lm.endpoint), { answers: ['yes'], ...lmOptions });
    expect(planned.code, planned.err).toBe(0);
    expect(lmChatsOf(lm)).toEqual([]);
    const plan = localPlanSchema.parse(JSON.parse(await readFile(planPathOf(planned.out), 'utf8')).plan);
    expect(plan.runtime).toMatchObject({ family: 'lmstudio', application_version: '0.4.20+1', cli_version: '71bd99c' });
    expect(plan.runtime.engine_version).toContain('mlx');
    expect(plan.test.test_definition_id).toBe(project.definition.id);

    const ran = await cli(root, ['test', 'run', planPathOf(planned.out)], { answers: ['yes'], ...lmOptions });
    expect(ran.code, ran.err).toBe(0);
    const report = localReportSchema.parse(JSON.parse(await readFile(reportPathOf(ran.out), 'utf8')));
    expect(report.outcome).toBe('pass');
    expect(registry.log.every((entry) => entry.method === 'GET' && !entry.authorized)).toBe(true);
  });

  it('[A3] any edit to the saved source invalidates the plan, even with a stored approval, before the model is called', async () => {
    const { project } = await world();
    const fake = await ollamaReplying(GOOD, closers);
    const root = await newRoot();
    const planned = await cli(root, ollamaPlanArgs(project, fake.url), { answers: ['yes'] });
    const planPath = planPathOf(planned.out);
    expect((await cli(root, ['test', 'run', planPath, '--remember'], { answers: ['yes'] })).code).toBe(0);
    const chatsBefore = chatsOf(fake).length;

    const { bundle_dir: dir } = JSON.parse(await readFile(planPath, 'utf8'));
    await writeFile(join(dir, 'TESTS', 'request-label-v1.yaml'), EXAMPLE_TEST_YAML.replace('Please explain the charge on my invoice.', 'Please cancel my account.'));
    const edited = await cli(root, ['test', 'run', planPath, '--offline'], { tty: false });
    expect(edited.code).toBe(3);
    expect(edited.err).toContain('no longer matches');
    expect(chatsOf(fake)).toHaveLength(chatsBefore);
  });

  it('[A4] cancelling keeps an honest partial report and never retries', async () => {
    const { project } = await world();
    const fake = await ollamaReplying(GOOD, closers);
    fake.chat = () => ({ hang: true, json: {} });
    const root = await newRoot();
    const planned = await cli(root, ollamaPlanArgs(project, fake.url), { answers: ['yes'] });
    const controller = new AbortController();
    const running = cli(root, ['test', 'run', planPathOf(planned.out)], { answers: ['yes'], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await running;
    expect(result.code).toBe(1);
    expect(chatsOf(fake)).toHaveLength(1);
    const dir = join(root, 'home', 'data', 'reports');
    const [name] = await readdir(dir);
    const report = localReportSchema.parse(JSON.parse(await readFile(join(dir, name as string), 'utf8')));
    expect(report).toMatchObject({ outcome: 'cancelled', execution_state: 'cancelled_partial' });
    expect(report.counts.skipped + report.counts.errors).toBeGreaterThan(0);
  });

  it('[A5] checks the registry before running, refuses a withdrawn project, and states the offline freshness limit', async () => {
    const { author, project } = await world();
    const fake = await ollamaReplying(GOOD, closers);
    const root = await newRoot();
    const planned = await cli(root, ollamaPlanArgs(project, fake.url), { answers: ['yes'] });
    const planPath = planPathOf(planned.out);

    // Offline use of the saved bundle works but says what it cannot know.
    const offline = await cli(root, ['test', 'run', planPath, '--offline'], { answers: ['yes'] });
    expect(offline.code, offline.err).toBe(0);
    expect(offline.out).toContain('is not asked whether it was withdrawn');
    expect(chatsOf(fake)).toHaveLength(1);

    const unpublished = await request(`/api/v1/projects/${project.published.projectId}/unpublish`, { method: 'POST', user: author.userId });
    expect(unpublished.status).toBe(200);
    const refused = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('no longer serves this test definition');
    expect(refused.h.io.questions).toEqual([]);
    expect(chatsOf(fake)).toHaveLength(1);
  });
});

describe('failure paths fail before any inference request', () => {
  async function expectBlocked(argsFor: (url: string) => string[], codeText: string, options: { runtime: 'ollama' | 'lmstudio'; yaml?: string; model?: string }) {
    const { project } = await world(options.yaml);
    const root = await newRoot();
    if (options.runtime === 'ollama') {
      const fake = await ollamaReplying(GOOD, closers);
      const result = await cli(root, argsFor(fake.url).map((arg) => arg.replace('PROJECT', project.published.projectId)), { answers: ['yes'] });
      expect(result.code, result.out + result.err).toBe(3);
      expect(result.err).toContain(codeText);
      expect(chatsOf(fake)).toEqual([]);
    } else {
      const lm = await lmStudioReplying(GOOD, closers);
      const result = await cli(root, argsFor(lm.endpoint).map((arg) => arg.replace('PROJECT', project.published.projectId)), { answers: ['yes'], ...lmOptions });
      expect(result.code, result.out + result.err).toBe(3);
      expect(result.err).toContain(codeText);
      expect(lmChatsOf(lm)).toEqual([]);
    }
    await expect(readdir(join(root, 'home', 'data', 'plans'))).rejects.toThrow(); // no plan was written
  }

  const planFor = (runtime: 'ollama' | 'lmstudio', model: string) => (endpoint: string) => [
    'test', 'plan', 'PROJECT', '--test', TEST, '--runtime', runtime, '--model', model, '--endpoint', endpoint, '--registry', registry.origin,
  ];
  const BIG_CONTEXT = EXAMPLE_TEST_YAML.replace('context_tokens: 4096', 'context_tokens: 1000000');
  const VISION = EXAMPLE_TEST_YAML.replace('required_capabilities: [chat, json_output]', 'required_capabilities: [chat, vision]');

  it('[F1] Ollama: a cloud model (synthetic fixture) fails local-only preflight', async () => {
    await expectBlocked(planFor('ollama', CLOUD), 'model_remote', { runtime: 'ollama' });
  });
  it('[F1] Ollama: a model with no locality signal (synthetic fixture) fails closed', async () => {
    await expectBlocked(planFor('ollama', UNKNOWN_LOCALITY), 'locality_unknown', { runtime: 'ollama' });
  });
  it('[F2] Ollama: an oversized context and a missing capability fail instead of being dropped', async () => {
    await expectBlocked(planFor('ollama', OLLAMA_MODEL), 'context_exceeded', { runtime: 'ollama', yaml: BIG_CONTEXT });
    await expectBlocked(planFor('ollama', OLLAMA_MODEL), 'capability_', { runtime: 'ollama', yaml: VISION });
  });
  it('[F1] LM Studio: a remote-linked model (synthetic fixture) fails local-only preflight', async () => {
    await expectBlocked(planFor('lmstudio', REMOTE_MODEL), 'model_remote', { runtime: 'lmstudio' });
  });
  it('[F1] LM Studio: an unknown-origin model (synthetic fixture) fails closed', async () => {
    await expectBlocked(planFor('lmstudio', UNKNOWN_ORIGIN_MODEL), 'locality_unknown', { runtime: 'lmstudio' });
  });
  it('[F2] LM Studio: an oversized context and a missing capability fail instead of being dropped', async () => {
    await expectBlocked(planFor('lmstudio', LMSTUDIO_MODEL), 'context_exceeded', { runtime: 'lmstudio', yaml: BIG_CONTEXT });
    await expectBlocked(planFor('lmstudio', LMSTUDIO_MODEL), 'capability_', { runtime: 'lmstudio', yaml: VISION });
  });

  it('[F3] a declared test the runner cannot execute is not planned, is not advertised as runnable, and issues no plan', async () => {
    const workflow = EXAMPLE_TEST_YAML.replace('scope: component', 'scope: workflow');
    const { project } = await world(workflow);
    const fake = await ollamaReplying(GOOD, closers);
    const root = await newRoot();
    const result = await cli(root, ollamaPlanArgs(project, fake.url), { answers: ['yes'] });
    expect(result.code).not.toBe(0);
    expect(fake.requests).toEqual([]);
    expect((await request(`/api/v1/test-definitions/${project.definition.id}/plan`)).status).toBe(422);
    expect((await request(`/api/v1/projects/${project.published.projectId}/tests`)).json.data.items[0].runner_available).toBe(false);
  });
});
