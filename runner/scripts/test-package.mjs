import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(runner, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'localfirst-package-'));

function run(command, args, cwd = temporary) {
  return new Promise((resolve, reject) => {
    // The installed CLI must not inherit credentials, registry configuration,
    // or module paths from the developer's environment.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]));
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) :
      reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

const server = createServer((request, response) => {
  if (request.url !== '/.well-known/oauth-protected-resource/mcp') {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ resource: `http://127.0.0.1:${server.address().port}/mcp` }));
});

try {
  await run('pnpm', ['pack', '--pack-destination', temporary], runner);
  const tarball = join(temporary, `localfirstdotsh-${manifest.version}.tgz`);
  const archive = (await run('tar', ['-tzf', tarball])).trim().split('\n');
  for (const file of ['package/README.md', 'package/LICENSE', 'package/dist/cli/bin.js',
    'package/dist/contracts/index.js', 'package/dist/contracts/index.d.ts',
    'package/frameworks/langgraph/npm-shrinkwrap.json',
    'package/frameworks/langgraph/worker.mjs', 'package/frameworks/langgraph/bakery.mjs']) {
    assert(archive.includes(file), `Missing package file: ${file}`);
  }
  assert(!archive.some(file => /^package\/(?:src|test|scripts|coverage)(?:\/|$)|(?:^|\/)(?:node_modules|\.git)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)/.test(file)),
    'Tarball includes development files or environment files');
  const packed = JSON.parse(await run('tar', ['-xOf', tarball, 'package/package.json']));
  assert.equal(packed.version, '0.1.0');
  assert.equal(packed.license, 'MIT');
  assert.notEqual(packed.private, true);
  assert(!Object.hasOwn(packed.dependencies, '@localfirst/contracts'));
  assert(!Object.values(packed.dependencies).some(version => version.startsWith('workspace:')));

  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', tarball]);
  const installed = join(temporary, 'node_modules/localfirstdotsh');
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
        const text = await readFile(path, 'utf8');
        assert(!/(['"])@localfirst\/contracts\1/.test(text), `Private workspace import in ${path}`);
      }
    }
  }
  await inspect(join(installed, 'dist'));
  const cli = join(temporary, 'node_modules/.bin/localfirstdotsh');
  assert((await run(cli, ['help'])).startsWith(`localfirstdotsh ${manifest.version}\n`));
  await run(process.execPath, ['--input-type=module', '-e',
    "import { compareReports } from 'localfirstdotsh'; if (typeof compareReports !== 'function') process.exit(1);"]);
  await run(process.execPath, ['--input-type=module', '-e',
    "import { frameworkRecipe } from './node_modules/localfirstdotsh/dist/frameworks/docker.js'; const r = await frameworkRecipe(); if (!r.worker || !r.artifacts.length) process.exit(1);"]);

  // Resolve the public declarations from a consumer with no workspace packages.
  await writeFile(join(temporary, 'consumer.ts'),
    "import { compareReports } from 'localfirstdotsh'; const compare: typeof compareReports = compareReports; void compare;\n");
  await run(process.execPath, [join(runner, 'node_modules/typescript/bin/tsc'), '--noEmit',
    '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--typeRoots',
    join(runner, 'node_modules/@types'), join(temporary, 'consumer.ts')]);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [client, expected] of [
    ['gemini-cli', `gemini mcp add --transport http --scope user localfirst ${origin}/mcp\n`],
    ['codex', `codex mcp add localfirst --url ${origin}/mcp\n`],
    ['claude-code', `claude mcp add --transport http --scope user localfirst ${origin}/mcp\n`],
  ]) {
    assert.equal(await run(cli, ['mcp', 'add', '--client', client, '--registry', origin, '--print']), expected);
  }
  console.log(`Package smoke test passed: ${manifest.name}@${manifest.version} (npm install, CLI, all three MCP clients, library types, framework assets).`);
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
