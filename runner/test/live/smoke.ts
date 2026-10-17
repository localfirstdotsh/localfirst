import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_TEST_YAML, localReportSchema } from '@localfirst/contracts';
import { expect } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { runCommand } from '../../src/cli/process.js';
import { makeHarness, writeBundle, type HarnessOptions } from '../support/cli-harness.js';

async function cli(root: string, argv: string[], options: HarnessOptions = {}) {
  const h = await makeHarness({ root, ...options });
  const code = await runCli(argv, h.env);
  return { code, out: h.io.text(), err: h.io.stderr.join(''), h };
}

/**
 * The BACKEND_PRD section 5.2 smoke test through the real CLI and adapter
 * against a REAL runtime and an already installed model. The model's answer
 * is whatever it is: a wrong label is a legitimate `fail`, and the check
 * records the exact outcome instead of forcing a pass.
 */
export async function liveSmoke(family: 'ollama' | 'lmstudio', endpoint: string, model: string, extra: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `lf-live-${family}-`));
  const bundle = await writeBundle(join(root, 'cwd', 'bundle'));
  const options: HarnessOptions = { runCommand: (command, args) => realCommand(command, args), ...extra };
  const planned = await cli(
    root,
    ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', family, '--model', model, '--endpoint', endpoint, '--bundle', bundle],
    { answers: ['yes'], ...options },
  );
  expect(planned.code, planned.err).toBe(0);
  const planPath = /Plan written to (.+)\n/.exec(planned.out)?.[1] as string;
  const ran = await cli(root, ['test', 'run', planPath, '--offline'], { answers: ['yes'], ...options });
  const reportPath = /Local report: (.+)\n/.exec(ran.out)?.[1] as string;
  expect(reportPath, ran.err).toBeTruthy();
  const report = localReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
  return { root, planned, ran, report, reportPath };
}

/** A command runner that really spawns, used only inside authorized discovery. */
const realCommand = (command: string, args: string[]) => runCommand(command, args) as never;

/** The same test requiring a capability the model does not have; planning must refuse it. */
export async function liveUnsupportedCapability(family: 'ollama' | 'lmstudio', endpoint: string, model: string, extra: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `lf-live-cap-${family}-`));
  const bundle = await writeBundle(join(root, 'cwd', 'bundle'), {
    testYaml: EXAMPLE_TEST_YAML.replace('required_capabilities: [chat, json_output]', 'required_capabilities: [chat, audio_output]'),
  });
  return cli(
    root,
    ['test', 'plan', 'project_example', '--test', 'request-label-v1', '--runtime', family, '--model', model, '--endpoint', endpoint, '--bundle', bundle],
    { answers: ['yes'], ...extra },
  );
}
