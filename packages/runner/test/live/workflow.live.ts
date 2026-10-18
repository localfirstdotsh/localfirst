import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { workflowLocalReportSchema } from '@localfirst/contracts';
import { runCli } from '../../src/cli/main.js';
import { runCommand } from '../../src/cli/process.js';
import { makeHarness } from '../support/cli-harness.js';
import { ollamaTarget, lmStudioTarget, isTarget } from './gate.js';

const enabled = process.env.LOCALFIRST_LIVE_WORKFLOWS === '1';
for (const family of ['ollama', 'lmstudio'] as const) {
  describe('live workflow: ' + family, () => {
    it.skipIf(!enabled)('prepares a fresh sample, approves a pinned plan and records real workflow outcomes', async () => {
      const target = family === 'ollama' ? ollamaTarget() : await lmStudioTarget();
      if (!isTarget(target)) throw new Error(target.skip);
      const root = await mkdtemp(join(tmpdir(), 'lf-workflow-' + family + '-'));
      const setup = await makeHarness({ root, answers: ['yes'], platform: process.platform });
      expect(await runCli(['environment', 'prepare', '--sample', 'bakery', '--out', 'bakery'], setup.env), setup.io.stderr.join('')).toBe(0);
      const planned = await makeHarness({ root, answers: ['yes'], platform: process.platform, runCommand: (c, a) => runCommand(c, a) as never });
      planned.env.userHome = homedir(); planned.env.now = () => new Date();
      expect(await runCli(['environment', 'plan', 'bakery', '--runtime', family, '--endpoint', target.endpoint, '--model', target.model], planned.env), planned.io.stderr.join('')).toBe(0);
      const path = /Plan saved: (.+)\n/.exec(planned.io.text())![1]!;
      const executed = await makeHarness({ root, answers: ['yes'], platform: process.platform, runCommand: (c, a) => runCommand(c, a) as never });
      executed.env.userHome = homedir(); executed.env.now = () => new Date();
      const code = await runCli(['environment', 'run', path, '--offline'], executed.env);
      const reportPath = /Private report: (.+)\n/.exec(executed.io.text())?.[1];
      expect(reportPath, executed.io.stderr.join('')).toBeTruthy();
      const report = workflowLocalReportSchema.parse(JSON.parse(await readFile(reportPath!, 'utf8')));
      expect(report.plan.bindings).toHaveLength(3);
      expect(report.run.cases).toHaveLength(8);
      expect(report.plan.runtime.family).toBe(family);
      expect([0, 1]).toContain(code);
      // Model quality is measured, not forced: wrong extraction is a recorded failure.
      console.log('LIVE workflow ' + JSON.stringify({ family, model: target.model, runtime: report.plan.runtime, report_path: reportPath, state: report.run.state, elapsed_ms: report.run.elapsed_ms, cases: report.run.cases.map(c => ({ key: c.key, outcome: c.outcome, error_code: c.error_code })) }));
    }, 360000);
  });
}
