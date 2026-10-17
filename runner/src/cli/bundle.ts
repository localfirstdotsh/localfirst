import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { validateProjectBundle, type BundleFile } from '@localfirst/contracts';
import { CliError, EXIT } from './errors.js';

export const BUNDLE_META_FILE = '.localfirst-bundle.json';
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface BundleMeta {
  schema: 'localfirst/bundle-meta/v0.1';
  project_id: string;
  project_version_id: string | null;
  registry_origin: string | null;
  content_digest: string | null;
  /** Registry test definition IDs by test key, when the bundle came from the registry. */
  test_definition_ids?: Record<string, string>;
  exported_at: string;
  /** Files created by explicit environment preparation; used only for reviewed cleanup. */
  prepared_files?: Array<{ path: string; digest: string }>;
}

export interface LoadedBundle {
  project_md: string;
  files: BundleFile[];
  meta: BundleMeta | null;
}

/** Where an executable test bundle comes from: a saved directory or the registry. */
export interface TestSource {
  load(): Promise<LoadedBundle>;
}

async function walk(root: string, directory: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new CliError(`Refusing symlink in bundle: ${relative(root, full)}`, EXIT.refused);
    if (info.isDirectory()) await walk(root, full, found);
    else if (info.isFile()) found.push(full);
    else throw new CliError(`Refusing non-regular file in bundle: ${relative(root, full)}`, EXIT.refused);
  }
}

/**
 * Read a saved bundle directory: `PROJECT.md` plus every other regular file
 * under it (the provenance file excluded). Symlinks and special files are refused.
 */
export async function readBundleDir(dir: string): Promise<LoadedBundle> {
  const root = resolve(dir);
  let projectMd: string;
  try {
    projectMd = await readFile(join(root, 'PROJECT.md'), 'utf8');
  } catch {
    throw new CliError(`No PROJECT.md in ${root}. Run \`localfirstdotsh project export\` first.`, EXIT.failed);
  }

  const files: BundleFile[] = [];
  const found: string[] = [];
  await walk(root, root, found);
  const paths = found.filter((path) => {
    const name = relative(root, path).split(sep).join('/');
    return name !== 'PROJECT.md' && name !== BUNDLE_META_FILE;
  });
  if (paths.length > MAX_FILES) throw new CliError(`A bundle may have at most ${MAX_FILES} files besides PROJECT.md.`, EXIT.refused);
  let total = Buffer.byteLength(projectMd, 'utf8');
  for (const path of paths.sort()) {
    const content = await readFile(path, 'utf8');
    total += Buffer.byteLength(content, 'utf8');
    files.push({ path: relative(root, path).split(sep).join('/'), content });
  }
  if (total > MAX_TOTAL_BYTES) throw new CliError('The bundle exceeds the 2 MiB limit.', EXIT.refused);

  let meta: BundleMeta | null = null;
  try {
    const parsed = JSON.parse(await readFile(join(root, BUNDLE_META_FILE), 'utf8')) as BundleMeta;
    if (parsed.schema === 'localfirst/bundle-meta/v0.1') meta = parsed;
  } catch {
    meta = null;
  }
  return { project_md: projectMd, files, meta };
}

export class LocalBundleSource implements TestSource {
  constructor(private readonly dir: string) {}
  load(): Promise<LoadedBundle> {
    return readBundleDir(this.dir);
  }
}

/** A bundle file path the registry may name: simple, relative, and inside the bundle. */
export function isSafeBundlePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 200 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !/[^A-Za-z0-9._\-/]/.test(path) &&
    path !== 'PROJECT.md' &&
    path !== BUNDLE_META_FILE
  );
}

/**
 * Write a bundle: `PROJECT.md`, the given files (each path re-checked), and
 * the provenance file. Never overwrites an existing `PROJECT.md`.
 */
export async function writeBundleDir(dir: string, projectMd: string, meta: BundleMeta, files: BundleFile[] = []): Promise<void> {
  const root = resolve(dir);
  for (const file of files) {
    if (!isSafeBundlePath(file.path)) throw new CliError(`Refusing unsafe bundle path: ${file.path}`, EXIT.refused);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'PROJECT.md'), projectMd, { mode: 0o600, flag: 'wx' });
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
  }
  await writeFile(join(root, BUNDLE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/** Validate a loaded bundle and return the result, or explain why it is unusable. */
export function validateBundle(bundle: LoadedBundle) {
  const validated = validateProjectBundle({ project_md: bundle.project_md, files: bundle.files });
  if (!validated.ok || validated.content_digest === null) {
    const errors = validated.issues.filter((issue) => issue.severity === 'error').map((issue) => `  ${issue.code}: ${issue.message}`);
    throw new CliError(`The bundle does not validate:\n${errors.join('\n') || '  (no detail)'}`, EXIT.failed);
  }
  return validated;
}
