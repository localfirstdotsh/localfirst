import { digestOfBytes, testDigests, workflowDigests } from '@localfirst/contracts';
import { isSafeBundlePath, validateBundle, type BundleMeta, type LoadedBundle, type TestSource } from './bundle.js';
import { CliError, EXIT } from './errors.js';
import { RegistryClient, RegistryError, type RegistryTestDefinition } from './registry.js';

const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface RegistryBundle {
  bundle: LoadedBundle;
  versionId: string;
  contentDigest: string;
  /** Test definition IDs in this version by test key. */
  definitionIds: Record<string, string>;
  /** The definition the bundle was fetched through, when the project has tests. */
  definition: RegistryTestDefinition | null;
}

/**
 * Fetch a complete, verifiable bundle for one published project version
 * anonymously: `PROJECT.md` from the export route and the public test files
 * from a test definition. Nothing is trusted until the recomputed version
 * content digest equals the one the registry names and every served file
 * matches its own digest.
 */
export async function fetchRegistryBundle(
  client: RegistryClient,
  options: { projectId: string; versionId?: string | undefined; testKey?: string | undefined; now: () => Date },
): Promise<RegistryBundle> {
  const current = options.versionId ? null : await client.currentVersion(options.projectId);
  const versionId = options.versionId ?? (current as { versionId: string }).versionId;
  const exported = await client.exportProject(options.projectId, versionId);
  const items = await client.projectTests(options.projectId, versionId);
  const definitionIds: Record<string, string> = {};
  for (const item of items) if (item.test_definition_id) definitionIds[item.key] = item.test_definition_id;

  const chosen = options.testKey ? items.find((item) => item.key === options.testKey) : items.find((item) => item.test_definition_id);
  if (options.testKey && !chosen) {
    const keys = items.map((item) => item.key).join(', ') || '(none)';
    throw new CliError(`Project ${options.projectId} @ ${versionId} has no test \`${options.testKey}\`. Tests: ${keys}`, EXIT.failed);
  }

  let definition: RegistryTestDefinition | null = null;
  const files: LoadedBundle['files'] = [];
  if (chosen?.test_definition_id) {
    definition = await client.testDefinition(chosen.test_definition_id);
    if (definition.project_version_id !== versionId) {
      throw new CliError('The registry returned a test definition for a different project version.', EXIT.failed);
    }
    if (definition.bundle_files.length > MAX_FILES) throw new CliError('The registry bundle has too many files.', EXIT.refused);
    let total = Buffer.byteLength(exported.text, 'utf8');
    for (const file of definition.bundle_files) {
      if (!isSafeBundlePath(file.path)) throw new CliError(`The registry named an unsafe bundle path: ${file.path}`, EXIT.refused);
      if (digestOfBytes(file.content) !== file.content_digest) {
        throw new CliError(`Bundle file ${file.path} does not match its digest; refusing the bundle.`, EXIT.refused);
      }
      total += Buffer.byteLength(file.content, 'utf8');
      files.push({ path: file.path, content: file.content });
    }
    if (total > MAX_TOTAL_BYTES) throw new CliError('The registry bundle exceeds the 2 MiB limit.', EXIT.refused);
  }

  const bundle: LoadedBundle = { project_md: exported.text, files, meta: null };
  const validated = validateBundle(bundle);
  const contentDigest = validated.content_digest as string;
  const claimed = [definition?.bundle_digest, exported.etag?.replace(/^W\//, '').replaceAll('"', ''), current?.contentDigest].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const digest of claimed) {
    if (digest !== contentDigest) {
      throw new CliError(
        `The bundle does not match the registry's digest (computed ${contentDigest}, registry ${digest}). Nothing was saved.`,
        EXIT.refused,
      );
    }
  }
  if (definition && options.testKey) {
    const found = validated.tests.find((entry) => entry.manifest.key === options.testKey);
    const workflow = validated.workflow_tests?.find(entry => entry.manifest.key === options.testKey);
    const digests = found ? testDigests(found.manifest) : workflow ? workflowDigests(workflow.manifest) : null;
    if (
      !digests ||
      digests.manifest_digest !== definition.manifest_digest ||
      digests.fixture_digest !== definition.fixture_digest ||
      digests.evaluator_digest !== definition.evaluator_digest
    ) {
      throw new CliError('The test files do not match the definition digests the registry named. Nothing was saved.', EXIT.refused);
    }
  }
  return { bundle, versionId, contentDigest, definitionIds, definition };
}

export function registryMeta(
  fetched: RegistryBundle,
  input: { projectId: string; origin: string; now: () => Date },
): BundleMeta {
  return {
    schema: 'localfirst/bundle-meta/v0.1',
    project_id: input.projectId,
    project_version_id: fetched.versionId,
    registry_origin: input.origin,
    content_digest: fetched.contentDigest,
    test_definition_ids: fetched.definitionIds,
    exported_at: input.now().toISOString(),
  };
}

/** A `TestSource` backed by the anonymous registry routes. */
export class RegistryTestSource implements TestSource {
  fetched: RegistryBundle | null = null;
  constructor(
    private readonly client: RegistryClient,
    private readonly options: { projectId: string; versionId?: string | undefined; testKey: string; now: () => Date },
  ) {}

  async load(): Promise<LoadedBundle> {
    try {
      this.fetched = await fetchRegistryBundle(this.client, this.options);
    } catch (cause) {
      if (cause instanceof RegistryError) throw new CliError(`Could not fetch the test bundle (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
      throw cause;
    }
    return {
      ...this.fetched.bundle,
      meta: registryMeta(this.fetched, { projectId: this.options.projectId, origin: this.client.origin, now: this.options.now }),
    };
  }
}
