import { digestOfBytes } from '@localfirst/contracts';
import type { CliEnv } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { authorizeDiscovery, makeAdapter, parseFamily, resolveEndpoint } from '../runtime.js';
import { parse, str } from './common.js';

/** `runtime discover --runtime ollama|lmstudio`: authorized, read-only inventory. */
export async function runtimeDiscover(env: CliEnv, argv: string[]): Promise<number> {
  const { values } = parse(argv, { runtime: { type: 'string' }, endpoint: { type: 'string' } }, { min: 0, max: 0 });
  const family = parseFamily(str(values.runtime));
  const endpoint = resolveEndpoint(family, str(values.endpoint));

  // Nothing is contacted or spawned before this returns.
  await authorizeDiscovery(env, family, endpoint, digestOfBytes(`discovery:${family}:${endpoint}`));

  const adapter = await makeAdapter(env, family, endpoint, { withVersions: true });
  const probe = await adapter.probe();
  if (!probe.reachable) {
    throw new CliError(`The ${family} runtime at ${endpoint} is not reachable (${probe.failure ?? 'unknown'}).`, EXIT.failed);
  }
  const show = (fact: { value: string | null; source: string | null }) =>
    fact.value === null ? 'unknown' : `${fact.value} (${fact.source})`;
  env.io.out(
    `Runtime: ${probe.family} (${probe.api_profile}) at ${endpoint}\n` +
      `  application: ${show(probe.versions.application)}\n` +
      `  cli:         ${show(probe.versions.cli)}\n` +
      `  engine:      ${show(probe.versions.engine)}\n`,
  );
  const models = await adapter.list_models();
  env.io.out(`Models (${models.length}):\n`);
  for (const model of models) {
    env.io.out(
      `  ${model.runtime_model_id}  [${model.state}]  locality: ${model.locality.value}` +
        `${model.locality.reason ? ` (${model.locality.reason})` : ''}  context: ${model.context_tokens ?? 'unknown'}\n`,
    );
  }
  return EXIT.ok;
}
