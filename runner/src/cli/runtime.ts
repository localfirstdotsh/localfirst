import { loopbackEndpointSchema } from '@localfirst/contracts';
import { ConsentSession } from '../consent/state-machine.js';
import { LmStudioAdapter } from '../adapters/lmstudio/adapter.js';
import {
  engineFacts,
  parseAppVersion,
  parseLmsVersion,
  parseRuntimeList,
  unobservedVersions,
  type LmStudioVersions,
  type VersionSource,
} from '../adapters/lmstudio/versions.js';
import { OllamaAdapter } from '../adapters/ollama/adapter.js';
import { unobserved, type RuntimeAdapter, type RuntimeFamily } from '../adapters/contract.js';
import type { CliEnv } from './context.js';
import { refusal, usageError } from './errors.js';
import { requireTty } from './io.js';
import { KeychainError, runtimeAccount } from './keychain.js';
import type { CommandRunner } from './process.js';

export const DEFAULT_ENDPOINTS: Record<RuntimeFamily, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
};

export function parseFamily(value: string | undefined): RuntimeFamily {
  if (value === 'ollama' || value === 'lmstudio') return value;
  throw usageError('--runtime must be `ollama` or `lmstudio`.');
}

/** The approved endpoint: the default or an override, which must be loopback. */
export function resolveEndpoint(family: RuntimeFamily, override: string | undefined): string {
  const candidate = override ?? DEFAULT_ENDPOINTS[family];
  if (!loopbackEndpointSchema.safeParse(candidate).success) {
    throw usageError('The runtime endpoint must be a loopback http(s) URL without credentials, query, or fragment.');
  }
  return new URL(candidate).origin;
}

/** What discovery will do, shown before the user is asked. Nothing is contacted before an explicit yes. */
export function discoveryDescription(family: RuntimeFamily, endpoint: string): string {
  const lines = [
    `Discovery will contact the ${family} runtime at ${endpoint} to read its version and the list of installed models and their details.`,
    'It makes no inference request and changes nothing (no pull, load, unload, or delete).',
  ];
  if (family === 'lmstudio') {
    lines.push(
      'To report application, CLI, and engine versions it will also run `lms version` and `lms runtime ls`, and read the LM Studio app\'s Info.plist.',
    );
  }
  return lines.join('\n');
}

/** Interactive authorization for contacting a runtime. Returns a session that has entered `preflight`. */
export async function authorizeDiscovery(
  env: CliEnv,
  family: RuntimeFamily,
  endpoint: string,
  manifestDigest: string,
): Promise<ConsentSession> {
  requireTty(env.io, 'Authorizing runtime discovery');
  env.io.out(`${discoveryDescription(family, endpoint)}\n`);
  const approved = await env.io.ask(`Allow discovery at ${endpoint}? Type "yes" to allow: `);
  if (!approved) throw refusal('Discovery was not authorized. Nothing was contacted.');
  const session = new ConsentSession({ project_manifest_digest: manifestDigest }, env.now);
  session.advance('local_discovery_authorized', { runtime: family, endpoint, channel: 'interactive_tty' });
  session.advance('preflight', {});
  return session;
}

const LMS_FALLBACK = (userHome: string) => `${userHome}/.lmstudio/bin/lms`;
const LM_STUDIO_PLIST = '/Applications/LM Studio.app/Contents/Info.plist';

/**
 * Version facts for LM Studio, gathered by running its own tools. Only used
 * after discovery was authorized. Each source fails independently to "unobserved".
 */
export function systemVersionSource(run: CommandRunner, platform: NodeJS.Platform, userHome: string): VersionSource {
  return {
    async read(): Promise<LmStudioVersions> {
      const lms = async (args: string[]) => {
        for (const command of ['lms', LMS_FALLBACK(userHome)]) {
          const result = await run(command, args);
          if (result.errorCode !== 'ENOENT') return result.code === 0 ? result.stdout : null;
        }
        return null;
      };
      const [versionText, runtimeText] = [await lms(['version']), await lms(['runtime', 'ls'])];
      let application = unobserved<string>();
      if (platform === 'darwin') {
        const plist = await run('plutil', ['-p', LM_STUDIO_PLIST]);
        if (plist.code === 0) application = parseAppVersion(plist.stdout);
      }
      return {
        application,
        cli: versionText === null ? unobserved() : parseLmsVersion(versionText),
        engines: runtimeText === null ? {} : engineFacts(parseRuntimeList(runtimeText)),
      };
    },
  };
}

export interface MakeAdapterOptions {
  /** Run `lms`/plist version discovery. Only true inside authorized discovery. */
  withVersions: boolean;
}

/** Build the runtime adapter for an approved endpoint, loading an optional server token from the keychain. */
export async function makeAdapter(
  env: CliEnv,
  family: RuntimeFamily,
  endpoint: string,
  options: MakeAdapterOptions,
): Promise<RuntimeAdapter> {
  if (family === 'ollama') return new OllamaAdapter({ endpoint });
  let credential: string | null = null;
  try {
    credential = await env.keychain.get(runtimeAccount(endpoint));
  } catch (cause) {
    if (!(cause instanceof KeychainError)) throw cause;
  }
  return new LmStudioAdapter({
    endpoint,
    ...(credential ? { credential } : {}),
    versions: options.withVersions ? systemVersionSource(env.runCommand, env.platform, env.userHome) : unobservedVersions,
  });
}

/**
 * The engine fact for a plan: the selected engine for the model's own format,
 * not the combined `gguf=...;mlx=...` summary. Null when it cannot be told or
 * would not fit the 60-character version label.
 */
export function engineForFormat(summary: string | null, format: string | null): string | null {
  if (summary === null || format === null) return null;
  for (const part of summary.split(';')) {
    const [key, value] = part.split('=');
    if (key === format.toLowerCase() && value && value.length <= 60) return value;
  }
  return null;
}
