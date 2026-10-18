import { join, resolve } from 'node:path';
import { parseProjectDocument } from '@localfirst/contracts';
import type { CliEnv } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { writeBundleDir } from '../bundle.js';
import { RegistryClient, RegistryError } from '../registry.js';
import { fetchRegistryBundle, registryMeta } from '../registry-source.js';
import { OFFLINE_FRESHNESS_NOTE } from './test-plan.js';
import { parse, registryOrigin, str } from './common.js';

const MAX_PROJECT_MD_BYTES = 256 * 1024 + 64 * 1024;

/**
 * `project export <project-id>`: anonymous public read. Writes a complete,
 * digest-verified local bundle (`PROJECT.md` plus the public test files) that
 * `test plan --bundle` can use offline.
 */
export async function projectExport(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { version: { type: 'string' }, out: { type: 'string' }, registry: { type: 'string' }, test: { type: 'string' } },
    { min: 1, max: 1 },
  );
  const projectId = positionals[0] as string;
  const origin = registryOrigin(env, str(values.registry));
  const client = new RegistryClient(origin, env.fetch);

  try {
    const fetched = await fetchRegistryBundle(client, {
      projectId,
      versionId: str(values.version),
      testKey: str(values.test),
      now: env.now,
    });
    if (Buffer.byteLength(fetched.bundle.project_md, 'utf8') > MAX_PROJECT_MD_BYTES) {
      throw new CliError('The exported PROJECT.md is larger than the allowed size.', EXIT.failed);
    }
    try {
      parseProjectDocument(fetched.bundle.project_md);
    } catch (cause) {
      throw new CliError(`The registry returned a PROJECT.md that does not parse: ${(cause as Error).message}`, EXIT.failed);
    }
    const out = resolve(env.cwd, str(values.out) ?? join(env.cwd, projectId));
    await writeBundleDir(out, fetched.bundle.project_md, registryMeta(fetched, { projectId, origin, now: env.now }), fetched.bundle.files);
    const tests = Object.keys(fetched.definitionIds);
    env.io.out(
      `Exported ${projectId} @ ${fetched.versionId} to ${out}\n` +
        `Bundle digest ${fetched.contentDigest} (verified against the registry).\n` +
        (tests.length > 0 ? `Tests: ${tests.join(', ')}\n` : 'This version declares no tests.\n') +
        `${OFFLINE_FRESHNESS_NOTE}\n`,
    );
    return EXIT.ok;
  } catch (cause) {
    if (cause instanceof RegistryError) throw new CliError(`Export failed (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError('PROJECT.md already exists in the output directory; choose another --out.', EXIT.failed);
    }
    throw cause;
  }
}
