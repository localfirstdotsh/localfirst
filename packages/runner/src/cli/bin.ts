#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { compareReports } from '../reports/compare.js';
import type { CliEnv } from './context.js';
import { collectHardware } from './hardware.js';
import { watchNetwork } from '../sensors/network.js';
import { createTerminalIo } from './io.js';
import { systemKeychain } from './keychain.js';
import { runCli } from './main.js';
import { resolveHome } from './paths.js';
import { runCommand, runInteractive } from './process.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const openers: Partial<Record<NodeJS.Platform, string>> = { darwin: 'open', linux: 'xdg-open' };

const env: CliEnv = {
  io: createTerminalIo(),
  home: resolveHome(process.env),
  vars: process.env,
  fetch: globalThis.fetch,
  keychain: systemKeychain(platform(), runCommand),
  runCommand,
  runInteractive,
  platform: platform(),
  userHome: homedir(),
  now: () => new Date(),
  signal: controller.signal,
  compare: compareReports,
  async openUrl(url) {
    const opener = openers[platform()];
    if (!opener) throw new Error(`Opening a browser is not supported on ${platform()}; open the URL yourself.`);
    await runCommand(opener, [url]);
  },
  hardware: collectHardware,
  watchNetwork: () => watchNetwork(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomId: () => randomBytes(4).toString('hex'),
  cwd: process.cwd(),
};

process.exitCode = await runCli(process.argv.slice(2), env);
