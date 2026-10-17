import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_TEST_YAML, localPlanSchema, localReportSchema } from '@localfirst/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { ApprovalStore } from '../src/index.js';
import { CLOUD, LOCAL, startFakeOllama, type FakeOllama } from './support/fake-ollama.js';
import { LOCAL_MODEL, startFakeLmStudio, type FakeLmStudio } from './support/fake-lmstudio.js';
import {
  hostPort,
  makeHarness,
  startFakeRegistry,
  exampleRegistryDefinition,
  startNetworkGuard,
  writeBundle,
  type FakeRegistry,
  type Harness,
  type HarnessOptions,
} from './support/cli-harness.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function ollama(): Promise<FakeOllama> {
  const fake = await startFakeOllama();
  closers.push(() => fake.close());
  return fake;
}
async function registry(): Promise<FakeRegistry> {
  const fake = await startFakeRegistry();
  closers.push(() => fake.close());
  return fake;
}
const newRoot = () => mkdtemp(join(tmpdir(), 'lf-flow-'));

/** One CLI invocation sharing a root (and therefore a home and cwd) with others. */
async function cli(root: string, argv: string[], options: HarnessOptions = {}) {
  const h: Harness = await makeHarness({ root, ...options });
  const code = await runCli(argv, h.env);
  return { code, h, out: h.io.text(), err: h.io.stderr.join('') };
}

function reply(fake: FakeOllama, content: string) {
  fake.chat = () => ({
    json: {
      model: LOCAL,
      created_at: '2026-10-11T00:00:00Z',
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: 10,
      prompt_eval_duration: 1_000_000,
      eval_count: 5,
      eval_duration: 1_000_000,
    },
  });
}

const chats = (fake: FakeOllama) => fake.requests.filter((request) => request.path === '/api/chat');
const planPathOf = (out: string) => /Plan written to (.+)\n/.exec(out)?.[1] as string;

async function makePlan(root: string, fake: FakeOllama, model = LOCAL) {
  const bundle = await writeBundle(join(root, 'cwd', 'bundle'));
  const planned = await cli(root, ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', model, '--endpoint', fake.url, '--bundle', bundle], {
    answers: ['yes'],
  });
  return { bundle, planned, planPath: planPathOf(planned.out) };
}

describe('global behaviour', () => {
  it('rejects --yes and any other unknown flag as a usage error before doing anything', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const before = fake.requests.length;
    for (const flag of ['--yes', '-y', '--force', '--no-prompt']) {
      const result = await cli(root, ['test', 'run', planPath, flag], { tty: true, answers: ['yes'] });
      expect(result.code, flag).toBe(2);
    }
    expect(fake.requests.length).toBe(before);
  });

  it('prints help and version, and offers mcp add only for tested clients', async () => {
    const root = await newRoot();
    const help = (await cli(root, ['--help'])).out;
    expect(help).toContain('localfirstdotsh');
    expect(help).toContain('mcp add --client claude-code|codex|github-copilot|gemini-cli|cursor|vscode|opencode|windsurf|cline|claude-desktop|chatgpt');
    expect((await cli(root, ['--version'])).out).toMatch(/^\d+\.\d+\.\d+/);
    const mcp = await cli(root, ['mcp', 'add']);
    expect(mcp.code).toBe(2);
    expect(mcp.err).toContain('--client claude-code|codex|github-copilot|gemini-cli|cursor|vscode|opencode|windsurf|cline|claude-desktop|chatgpt');
    expect((await cli(root, ['nope'])).code).toBe(2);
  });
});

describe('project export', () => {
  it('reads the public export anonymously and writes a complete, digest-verified bundle', async () => {
    const reg = await registry();
    const root = await newRoot();
    const result = await cli(root, ['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin]);
    expect(result.code, result.err).toBe(0);
    const text = await readFile(join(root, 'cwd', 'out', 'PROJECT.md'), 'utf8');
    expect(text).toContain('localfirst/project/v0.2');
    expect(await readFile(join(root, 'cwd', 'out', 'TESTS', 'request-label-v1.yaml'), 'utf8')).toBe(EXAMPLE_TEST_YAML);
    const meta = JSON.parse(await readFile(join(root, 'cwd', 'out', '.localfirst-bundle.json'), 'utf8'));
    expect(meta).toMatchObject({
      project_id: 'project_example',
      project_version_id: 'version_example',
      registry_origin: reg.origin,
      content_digest: exampleRegistryDefinition().bundleDigest,
      test_definition_ids: { 'request-label-v1': 'test_example' },
    });
    expect(reg.requests.map((request) => request.path)).toEqual([
      '/api/v1/projects/project_example',
      '/api/v1/projects/project_example/export?version=version_example',
      '/api/v1/projects/project_example/tests?version=version_example',
      '/api/v1/test-definitions/test_example',
    ]);
    expect(reg.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
    expect((await stat(join(root, 'cwd', 'out', 'PROJECT.md'))).mode & 0o777).toBe(0o600);
    expect(result.out).toContain('verified against the registry');
    expect(result.out).toContain('is not asked whether it was withdrawn');
  });

  it('writes nothing when the served files or digests do not verify', async () => {
    for (const tamper of [
      (reg: FakeRegistry) => (reg.projectMd = reg.projectMd.replace('Label a short customer request', 'Label something else')),
      (reg: FakeRegistry) => (reg.definition = { ...reg.definition, bundle_digest: `sha256:${'f'.repeat(64)}` }),
      (reg: FakeRegistry) => {
        const files = reg.definition.bundle_files as Array<{ content: string }>;
        reg.definition = { ...reg.definition, bundle_files: [{ ...files[0]!, content: `${files[0]!.content}# edited\n` }] };
      },
      (reg: FakeRegistry) => {
        const files = reg.definition.bundle_files as Array<{ path: string }>;
        reg.definition = { ...reg.definition, bundle_files: [{ ...files[0]!, path: '../escape.yaml' }] };
      },
    ]) {
      const reg = await registry();
      tamper(reg);
      const root = await newRoot();
      const result = await cli(root, ['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin]);
      expect(result.code).not.toBe(0);
      await expect(readdir(join(root, 'cwd', 'out'))).rejects.toThrow();
    }
  });

  it('refuses to overwrite, needs a configured registry, and rejects insecure origins', async () => {
    const reg = await registry();
    const root = await newRoot();
    await cli(root, ['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin]);
    expect((await cli(root, ['project', 'export', 'project_example', '--out', 'out', '--registry', reg.origin])).code).toBe(1);
    expect((await cli(root, ['project', 'export', 'project_example'])).err).toContain('No registry configured');
    const insecure = await cli(root, ['project', 'export', 'project_example', '--registry', 'http://registry.example.com']);
    expect(insecure.code).toBe(2);
    expect((await cli(root, ['project', 'export', 'project_example', '--registry', 'https://x.example/path'])).code).toBe(2);
  });

  it('reads the registry from LOCALFIRST_REGISTRY', async () => {
    const reg = await registry();
    const root = await newRoot();
    const result = await cli(root, ['project', 'export', 'project_example', '--out', 'o'], { vars: { LOCALFIRST_REGISTRY: reg.origin } });
    expect(result.code).toBe(0);
  });
});

describe('runtime discover', () => {
  it('contacts nothing and spawns nothing without an interactive yes', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const noTty = await cli(root, ['runtime', 'discover', '--runtime', 'ollama', '--endpoint', fake.url], { tty: false });
    expect(noTty.code).toBe(3);
    const declined = await cli(root, ['runtime', 'discover', '--runtime', 'ollama', '--endpoint', fake.url], { answers: ['no'] });
    expect(declined.code).toBe(3);
    expect(fake.requests).toEqual([]);
    expect(noTty.h.spawned).toEqual([]);
    expect(declined.h.spawned).toEqual([]);
  });

  it('names the exact endpoint, then lists models read-only', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const result = await cli(root, ['runtime', 'discover', '--runtime', 'ollama', '--endpoint', fake.url], { answers: ['yes'] });
    expect(result.code).toBe(0);
    expect(result.h.io.questions[0]).toContain(fake.url);
    expect(result.out).toContain(LOCAL);
    expect(result.out).toMatch(new RegExp(`${CLOUD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*locality: remote`));
    expect(fake.requests.map((request) => request.path).sort()).toEqual(expect.arrayContaining(['/api/version', '/api/tags', '/api/ps']));
    expect(fake.requests.every((request) => !['/api/chat', '/api/pull', '/api/delete', '/api/create'].includes(request.path))).toBe(true);
    expect(result.h.spawned).toEqual([]);
  });

  it('rejects non-loopback endpoints without any prompt or request', async () => {
    const root = await newRoot();
    const result = await cli(root, ['runtime', 'discover', '--runtime', 'ollama', '--endpoint', 'http://192.168.1.20:11434'], { answers: ['yes'] });
    expect(result.code).toBe(2);
    expect(result.h.io.questions).toEqual([]);
  });

  it('runs lms and reads the app plist only after LM Studio discovery is authorized', async () => {
    const lm: FakeLmStudio = await startFakeLmStudio();
    closers.push(() => lm.close());
    const fixtures = join(import.meta.dirname, 'fixtures', 'lmstudio');
    const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
    const runCommand = (command: string, args: string[]) => {
      const line = `${command} ${args.join(' ')}`;
      if (line === 'lms version') return { code: 0, stdout: read('lms-version.txt'), stderr: '', errorCode: null };
      if (line === 'lms runtime ls') return { code: 0, stdout: read('lms-runtime-ls.txt'), stderr: '', errorCode: null };
      if (command === 'plutil') return { code: 0, stdout: read('app-info-plist-excerpt.txt'), stderr: '', errorCode: null };
      return { code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' };
    };
    const root = await newRoot();
    const declined = await cli(root, ['runtime', 'discover', '--runtime', 'lmstudio', '--endpoint', lm.endpoint], { answers: ['no'], platform: 'darwin', runCommand });
    expect(declined.h.spawned).toEqual([]);
    expect(declined.h.keychain.reads).toEqual([]);
    expect(lm.requests).toEqual([]);

    const approved = await cli(root, ['runtime', 'discover', '--runtime', 'lmstudio', '--endpoint', lm.endpoint], { answers: ['yes'], platform: 'darwin', runCommand });
    expect(approved.code).toBe(0);
    expect(approved.out).toContain('lms version');
    expect(approved.h.io.questions[0]).toContain(lm.endpoint);
    expect(approved.h.spawned.map((entry) => entry.join(' '))).toEqual(expect.arrayContaining(['lms version', 'lms runtime ls']));
    expect(approved.out).toContain('71bd99c');
    expect(approved.out).toContain('0.4.20+1');
    expect(approved.out).toContain(LOCAL_MODEL);
  });
});

describe('test plan', () => {
  it('writes a sealed plan with no inference request and needs no account', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planned, planPath } = await makePlan(root, fake);
    expect(planned.code, planned.err).toBe(0);
    expect(chats(fake)).toEqual([]);
    expect(planned.h.keychain.reads).toEqual([]);
    expect(planned.h.fetched).toEqual([]);
    const file = JSON.parse(await readFile(planPath, 'utf8'));
    const plan = localPlanSchema.parse(file.plan);
    expect(plan).toMatchObject({ data_class: 'public_fixture', model: { runtime_model_id: LOCAL, execution_location: 'local' } });
    expect(plan.runtime.application_version).toBe('0.35.1');
    expect(planned.out).toContain(plan.plan_digest);
    expect(planned.out).toContain('No inference request was made');
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
  });

  it('asks for discovery authorization and refuses without it', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const bundle = await writeBundle(join(root, 'cwd', 'bundle'));
    const args = ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--bundle', bundle];
    expect((await cli(root, args, { tty: false })).code).toBe(3);
    expect((await cli(root, args, { answers: ['no'] })).code).toBe(3);
    expect(fake.requests).toEqual([]);
  });

  it('blocks a cloud model, a missing model, an unknown test, and a project mismatch without writing a plan', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const cloud = await makePlan(root, fake, CLOUD);
    expect(cloud.planned.code).toBe(3);
    expect(cloud.planned.err).toContain('Plan blocked');
    expect((await makePlan(root, fake, 'nope:0b')).planned.code).toBe(1);

    const bundle = join(root, 'cwd', 'bundle');
    const base = ['--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--bundle', bundle];
    expect((await cli(root, ['test', 'plan', 'project_example', '--test', 'other-test', ...base], { answers: ['yes'] })).err).toContain('no test `other-test`');
    expect((await cli(root, ['test', 'plan', 'someone_else', '--test', 'request-label-v1', ...base], { answers: ['yes'] })).code).toBe(2);
    await expect(readdir(join(root, 'home', 'data', 'plans'))).rejects.toThrow(); // no plan was ever written
  });

  it('refuses a test that enables tools, project code, or downloads', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const bundle = await writeBundle(join(root, 'cwd', 'bad'), { testYaml: EXAMPLE_TEST_YAML.replace('allow_tools: false', 'allow_tools: true') });
    const result = await cli(root, ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--bundle', bundle], { answers: ['yes'] });
    expect(result.code).not.toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it('plans anonymously from the registry, saves the verified bundle, and records the definition', async () => {
    const fake = await ollama();
    const reg = await registry();
    const root = await newRoot();
    const planned = await cli(
      root,
      ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--registry', reg.origin],
      { answers: ['yes'] },
    );
    expect(planned.code, planned.err).toBe(0);
    expect(planned.h.keychain.reads).toEqual([]);
    expect(reg.requests.every((request) => request.headers.authorization === undefined && request.method === 'GET')).toBe(true);
    expect(chats(fake)).toEqual([]);
    const file = JSON.parse(await readFile(planPathOf(planned.out), 'utf8'));
    const plan = localPlanSchema.parse(file.plan);
    expect(plan.test).toMatchObject({ test_definition_id: 'test_example', bundle_digest: exampleRegistryDefinition().bundleDigest });
    expect(file.bundle_dir).toContain(join('home', 'data', 'bundles'));
    expect(await readFile(join(file.bundle_dir, 'TESTS', 'request-label-v1.yaml'), 'utf8')).toBe(EXAMPLE_TEST_YAML);
    expect(planned.out).toContain('verified against the registry digest');

    // A second plan from the same version reuses the saved identical bundle.
    const again = await cli(
      root,
      ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--registry', reg.origin],
      { answers: ['yes'] },
    );
    expect(again.code, again.err).toBe(0);
  });

  it('refuses a registry test that is unknown, and a registry whose digests do not verify', async () => {
    const fake = await ollama();
    const reg = await registry();
    const root = await newRoot();
    const base = ['test', 'plan', 'project_example', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--registry', reg.origin];
    const unknown = await cli(root, [...base, '--test', 'nope-v1'], { answers: ['yes'] });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('has no test `nope-v1`');
    reg.definition = { ...reg.definition, fixture_digest: `sha256:${'e'.repeat(64)}` };
    const mismatch = await cli(root, [...base, '--test', 'request-label-v1'], { answers: ['yes'] });
    expect(mismatch.code).toBe(3);
    expect(fake.requests).toEqual([]);
  });

  it('plans against LM Studio with the app, CLI, and engine versions kept separate', async () => {
    const lm = await startFakeLmStudio();
    closers.push(() => lm.close());
    const fixtures = join(import.meta.dirname, 'fixtures', 'lmstudio');
    const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
    const runCommand = (command: string, args: string[]) => {
      const line = `${command} ${args.join(' ')}`;
      if (line === 'lms version') return { code: 0, stdout: read('lms-version.txt'), stderr: '', errorCode: null };
      if (line === 'lms runtime ls') return { code: 0, stdout: read('lms-runtime-ls.txt'), stderr: '', errorCode: null };
      if (command === 'plutil') return { code: 0, stdout: read('app-info-plist-excerpt.txt'), stderr: '', errorCode: null };
      return { code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' };
    };
    const root = await newRoot();
    const bundle = await writeBundle(join(root, 'cwd', 'bundle'));
    const result = await cli(root, ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'lmstudio', '--model', LOCAL_MODEL, '--endpoint', lm.endpoint, '--bundle', bundle], { answers: ['yes'], platform: 'darwin', runCommand });
    expect(result.code, result.err).toBe(0);
    const plan = localPlanSchema.parse(JSON.parse(await readFile(planPathOf(result.out), 'utf8')).plan);
    expect(plan.runtime).toMatchObject({ family: 'lmstudio', application_version: '0.4.20+1', cli_version: '71bd99c' });
    expect(plan.runtime.engine_version).toContain('mlx');
    expect(lm.requests.filter((request) => request.path.includes('chat'))).toEqual([]);
  });
});

async function makeRegistryPlan(root: string, fake: FakeOllama, reg: FakeRegistry) {
  const planned = await cli(
    root,
    ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', 'ollama', '--model', LOCAL, '--endpoint', fake.url, '--registry', reg.origin],
    { answers: ['yes'] },
  );
  expect(planned.code, planned.err).toBe(0);
  return planPathOf(planned.out);
}

describe('test run against a registry-sourced plan', () => {
  it('asks the registry, anonymously and before the approval prompt, whether the definition is still served', async () => {
    const fake = await ollama();
    const reg = await registry();
    reply(fake, '{"label":"billing"}');
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    reg.requests.length = 0;
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code, result.err).toBe(0);
    expect(reg.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /api/v1/test-definitions/test_example']);
    expect(reg.requests[0]!.headers.authorization).toBeUndefined();
    expect(result.out).toContain('still serves this test definition');
    expect(result.out.indexOf('still serves')).toBeLessThan(result.out.indexOf('Outcome:'));
  });

  it('refuses a withdrawn definition before asking for approval or calling the model', async () => {
    const fake = await ollama();
    const reg = await registry();
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    reg.definitionStatus = 404;
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('no longer serves this test definition');
    expect(result.h.io.questions).toEqual([]);
    expect(chats(fake)).toEqual([]);
  });

  it('refuses a definition whose digests changed', async () => {
    const fake = await ollama();
    const reg = await registry();
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    reg.definition = { ...reg.definition, evaluator_digest: `sha256:${'d'.repeat(64)}` };
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('different digests');
    expect(chats(fake)).toEqual([]);
  });

  it('runs from the saved bundle when the registry cannot be reached, and says withdrawal was not checked', async () => {
    const fake = await ollama();
    const reg = await registry();
    reply(fake, '{"label":"billing"}');
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    await reg.close();
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('could not be reached, so withdrawal was not checked');
  });

  it('does not contact the registry with --offline and states the freshness limit', async () => {
    const fake = await ollama();
    const reg = await registry();
    reply(fake, '{"label":"billing"}');
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    reg.requests.length = 0;
    const result = await cli(root, ['test', 'run', planPath, '--offline'], { answers: ['yes'] });
    expect(result.code, result.err).toBe(0);
    expect(reg.requests).toEqual([]);
    expect(result.out).toContain('Registry status was not checked');
  });

  it('refuses a saved bundle edited after planning', async () => {
    const fake = await ollama();
    const reg = await registry();
    const root = await newRoot();
    const planPath = await makeRegistryPlan(root, fake, reg);
    const { bundle_dir: dir } = JSON.parse(await readFile(planPath, 'utf8'));
    const yamlPath = join(dir, 'TESTS', 'request-label-v1.yaml');
    await writeFile(yamlPath, EXAMPLE_TEST_YAML.replace('Please explain the charge on my invoice.', 'Please cancel my account.'));
    const result = await cli(root, ['test', 'run', planPath, '--offline'], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('no longer matches');
    expect(chats(fake)).toEqual([]);
  });
});

describe('test run', () => {
  it('refuses without a terminal or a stored approval, and never calls the model', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const result = await cli(root, ['test', 'run', planPath], { tty: false });
    expect(result.code).toBe(3);
    expect(result.err).toContain('no non-interactive override');
    expect(chats(fake)).toEqual([]);
    await expect(readdir(join(root, 'home', 'data', 'reports'))).rejects.toThrow();
  });

  it('shows the exact digest and effects, and a "no" runs nothing', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const plan = localPlanSchema.parse(JSON.parse(await readFile(planPath, 'utf8')).plan);
    const declined = await cli(root, ['test', 'run', planPath], { answers: ['no'] });
    expect(declined.code).toBe(3);
    expect(declined.out).toContain(plan.plan_digest);
    expect(declined.out).toContain('1 inference request(s)');
    expect(declined.h.io.questions[0]).toContain(plan.plan_digest);
    expect(chats(fake)).toEqual([]);
  });

  it('runs after an interactive yes and saves a private local report; nothing is uploaded', async () => {
    const fake = await ollama();
    const reg = await registry();
    reply(fake, '{"label":"billing"}');
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code, result.err).toBe(0);
    expect(chats(fake)).toHaveLength(1);
    expect(reg.requests).toEqual([]);
    const dir = join(root, 'home', 'data', 'reports');
    const [name] = await readdir(dir);
    expect((await stat(join(dir, name as string))).mode & 0o777).toBe(0o600);
    const report = localReportSchema.parse(JSON.parse(await readFile(join(dir, name as string), 'utf8')));
    expect(report).toMatchObject({ outcome: 'pass', execution_state: 'local_report_saved', data_class: 'public_fixture' });
    expect(result.out).toContain('Nothing was uploaded');
    expect(await new ApprovalStore(join(root, 'home', 'data', 'approvals')).find(report.plan_digest)).toBeNull();
  });

  it('records the interface observation of the run, defaulting to not_run', async () => {
    const fake = await ollama();
    reply(fake, '{"label":"billing"}');
    const saved = async (root: string) => {
      const dir = join(root, 'home', 'data', 'reports');
      const [name] = await readdir(dir);
      return localReportSchema.parse(JSON.parse(await readFile(join(dir, name as string), 'utf8')));
    };
    const rootOnline = await newRoot();
    const online = await makePlan(rootOnline, fake);
    expect((await cli(rootOnline, ['test', 'run', online.planPath], { answers: ['yes'] })).code).toBe(0);
    expect((await saved(rootOnline)).checks.offline).toBe('not_run');

    const rootOffline = await newRoot();
    const offline = await makePlan(rootOffline, fake);
    let stopped = 0;
    const watchNetwork = () => ({ stop: () => (stopped += 1, { observation: 'no_route_observed' as const, samples: 5 }) });
    expect((await cli(rootOffline, ['test', 'run', offline.planPath], { answers: ['yes'], watchNetwork })).code).toBe(0);
    expect((await saved(rootOffline)).checks.offline).toBe('no_route_observed');
    expect(stopped).toBeGreaterThan(0);
  });

  it('reports a failing case honestly with exit code 1', async () => {
    const fake = await ollama();
    reply(fake, '{"label":"support"}');
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Outcome: fail');
  });

  it('stores an approval only with --remember, bound to that digest, and then runs noninteractively', async () => {
    const fake = await ollama();
    reply(fake, '{"label":"billing"}');
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const first = await cli(root, ['test', 'run', planPath, '--remember'], { answers: ['yes'] });
    expect(first.code).toBe(0);
    const second = await cli(root, ['test', 'run', planPath], { tty: false });
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain('stored approval');
    expect(chats(fake)).toHaveLength(2);
  });

  it('does not store an approval without --remember', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect((await cli(root, ['test', 'run', planPath], { tty: false })).code).toBe(3);
  });

  it('a changed bundle invalidates even a stored approval', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath, bundle } = await makePlan(root, fake);
    await cli(root, ['test', 'run', planPath, '--remember'], { answers: ['yes'] });
    const before = chats(fake).length;
    await writeBundle(bundle, { testYaml: EXAMPLE_TEST_YAML.replace('Please explain the charge on my invoice.', 'Please cancel my account.') });
    const result = await cli(root, ['test', 'run', planPath], { tty: false });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/bundle_digest_mismatch|fixture_digest_mismatch/);
    expect(chats(fake)).toHaveLength(before);
  });

  it('refuses an edited plan file', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const file = JSON.parse(await readFile(planPath, 'utf8'));
    file.plan.model.runtime_model_id = CLOUD;
    await (await import('node:fs/promises')).writeFile(planPath, JSON.stringify(file));
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(chats(fake)).toEqual([]);
  });

  it('refuses when the installed model changed since planning', async () => {
    const fake = await ollama();
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const entry = fake.tags.find((tag) => tag.name === LOCAL);
    entry!.digest = 'f'.repeat(64);
    const result = await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
    expect(result.code).toBe(3);
    expect(result.err).toContain('model identity');
    expect(chats(fake)).toEqual([]);
  });

  it('keeps a partial report when interrupted, and does not retry', async () => {
    const fake = await ollama();
    fake.chat = () => ({ hang: true, json: {} });
    const root = await newRoot();
    const { planPath } = await makePlan(root, fake);
    const controller = new AbortController();
    const running = cli(root, ['test', 'run', planPath], { answers: ['yes'], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await running;
    expect(result.code).toBe(1);
    expect(result.out).toContain('cancelled');
    expect(chats(fake)).toHaveLength(1);
    const dir = join(root, 'home', 'data', 'reports');
    const [name] = await readdir(dir);
    const report = localReportSchema.parse(JSON.parse(await readFile(join(dir, name as string), 'utf8')));
    expect(report).toMatchObject({ outcome: 'cancelled', execution_state: 'cancelled_partial' });
  });
});

describe('network guard', () => {
  it('only ever connects to the approved runtime and the configured registry', async () => {
    const fake = await ollama();
    const reg = await registry();
    reply(fake, '{"label":"billing"}');
    const guard = startNetworkGuard();
    try {
      const root = await newRoot();
      await cli(root, ['project', 'export', 'project_example', '--out', 'exported', '--registry', reg.origin]);
      const { planPath } = await makePlan(root, fake);
      await cli(root, ['test', 'run', planPath], { answers: ['yes'] });
      const allowed = new Set([hostPort(fake.url), hostPort(reg.origin)]);
      expect(guard.connections.length).toBeGreaterThan(0);
      for (const target of guard.connections) expect(allowed, `unexpected connection to ${target}`).toContain(target);
    } finally {
      guard.stop();
    }
  });

  it('is able to see a stray connection (self-check)', async () => {
    const other = await registry();
    const guard = startNetworkGuard();
    try {
      await fetch(`${other.origin}/api/v1/nothing`);
      expect(guard.connections).toContain(hostPort(other.origin));
    } finally {
      guard.stop();
    }
  });
});
