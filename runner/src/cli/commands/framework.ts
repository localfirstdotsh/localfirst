import { readFile, lstat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { digestOfBytes } from '@localfirst/contracts';
import { LocalBundleSource, validateBundle } from '../bundle.js';
import { frameworkRecipe, localDockerEndpoint, prepareFramework, BASE_IMAGE } from '../../frameworks/docker.js';
import { requireTty } from '../io.js';
import { ensurePrivateDir } from '../paths.js';
import { parse, str } from './common.js';
import type { CliEnv } from '../context.js';
import { EXIT, refusal, usageError } from '../errors.js';

/** Separate approval for dependency acquisition and image construction, not execution. */
export async function frameworkPrepare(env: CliEnv, argv: string[]): Promise<number> {
  const { values } = parse(argv, { source: { type: 'string' }, workspace: { type: 'string' }, environment: { type: 'string' }, out: { type: 'string' } }, { min: 0, max: 0 });
  if ((!str(values.source) && !str(values.workspace)) || (str(values.source) && str(values.workspace)) || !str(values.out)) throw usageError('Choose --workspace <prepared-workspace> or --source <creator-module.mjs>, plus --out <new-artifact.json>.');
  const recipe = await frameworkRecipe();
  let source: string;
  if (str(values.workspace)) {
    const bundle = await new LocalBundleSource(resolve(env.cwd, str(values.workspace)!)).load(), valid = validateBundle(bundle);
    const environment = valid.environments?.find(e => !str(values.environment) || e.manifest.key === str(values.environment))?.manifest;
    if (!environment?.framework || environment.framework.lock_digest !== digestOfBytes(recipe.lockText)) throw refusal('This workspace needs a matching supported framework lock.');
    source = bundle.files.find(f => f.path === environment.framework!.entry_path)!.content;
  } else {
    const sourcePath = resolve(env.cwd, str(values.source)!);
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw refusal('Source must be a regular bounded module.');
    source = await readFile(sourcePath, 'utf8');
  }
  requireTty(env.io, 'Preparing an isolated framework');
  env.io.out('Setup will inspect the local Docker context, verify an installed base image, download ' + recipe.artifacts.length +
    ' exact SHA-512-verified packages from https://registry.npmjs.org, and build a local image with networking disabled.\n' +
    'Lifecycle scripts are disabled. Creator code is copied but not executed during setup.\nBase: ' + BASE_IMAGE +
    '\nCreator entry: ' + digestOfBytes(source) + '\nLock: ' + digestOfBytes(recipe.lockText) + '\n');
  if (!await env.io.ask('Approve exactly this dependency setup? Type "yes": ')) throw refusal('Framework setup declined.');
  const endpoint = await localDockerEndpoint();
  const artifact = await prepareFramework(source, endpoint, env.signal);
  const path = resolve(env.cwd, str(values.out)!);
  await ensurePrivateDir(dirname(path));
  await writeFile(path, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  env.io.out('Prepared isolated framework artifact: ' + path + '\nImage: ' + artifact.image_id + '\nNo model inference or creator workflow ran. Bind this artifact only to an environment declaring these entry/lock digests.\n');
  return EXIT.ok;
}
