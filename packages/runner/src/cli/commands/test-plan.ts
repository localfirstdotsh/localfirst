import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localPlanSchema, sealLocalPlan, testDigests, type LocalPlanBody } from '@localfirst/contracts';
import { describePlan } from '../../consent/plan.js';
import { checkExecutable } from '../../harnesses/executable.js';
import { plannedInferenceRequests } from '../../harnesses/run.js';
import { AdapterError } from '../../adapters/types.js';
import type { CliEnv } from '../context.js';
import { CliError, EXIT, refusal, usageError } from '../errors.js';
import { LocalBundleSource, validateBundle, writeBundleDir, type LoadedBundle } from '../bundle.js';
import { RegistryTestSource } from '../registry-source.js';
import { ensurePrivateDir } from '../paths.js';
import { RegistryClient } from '../registry.js';
import { authorizeDiscovery, engineForFormat, makeAdapter, parseFamily, resolveEndpoint } from '../runtime.js';
import { RUNNER_VERSION } from '../version.js';
import { hexOf, parse, registryOrigin, str } from './common.js';

export const PLAN_FILE_SCHEMA = 'localfirst/plan-file/v0.1' as const;

/** Said whenever a saved bundle is used without asking the registry (BACKEND_PRD section 20.2). */
export const OFFLINE_FRESHNESS_NOTE =
  'A saved bundle works offline, but the registry is not asked whether it was withdrawn or changed; running later without the registry cannot detect that.';

export interface PlanFile {
  schema: typeof PLAN_FILE_SCHEMA;
  plan: unknown;
  /** Where the validated bundle was read from when planning. */
  bundle_dir: string;
}

/**
 * `test plan <project-id> --test <key> --runtime <r> --model <id> [--bundle <dir>]`.
 * Gets the test bundle from a saved directory or, anonymously, from the
 * registry (saving it for offline reuse), checks the model with a read-only
 * preflight (no inference), and writes a sealed local plan. No account is needed.
 */
export async function testPlan(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      test: { type: 'string' },
      runtime: { type: 'string' },
      model: { type: 'string' },
      bundle: { type: 'string' },
      endpoint: { type: 'string' },
      version: { type: 'string' },
      registry: { type: 'string' },
      out: { type: 'string' },
    },
    { min: 1, max: 1 },
  );
  const projectId = positionals[0] as string;
  const testKey = str(values.test);
  const model = str(values.model);
  if (!testKey) throw usageError('--test <key> is required.');
  if (!model) throw usageError('--model <installed-id> is required.');
  const family = parseFamily(str(values.runtime));
  const endpoint = resolveEndpoint(family, str(values.endpoint));

  let bundle: LoadedBundle;
  let bundleDir: string;
  let fresh = false;
  const given = str(values.bundle);
  if (given) {
    bundleDir = resolve(env.cwd, given);
    bundle = await new LocalBundleSource(bundleDir).load();
  } else {
    // Anonymous registry retrieval: no account, no token.
    const origin = registryOrigin(env, str(values.registry));
    const source = new RegistryTestSource(new RegistryClient(origin, env.fetch), {
      projectId,
      versionId: str(values.version),
      testKey,
      now: env.now,
    });
    bundle = await source.load();
    const fetched = source.fetched;
    bundleDir = resolve(env.cwd, str(values.out) ?? join(env.home.bundlesDir, `${projectId}-${(fetched?.versionId ?? 'version').slice(0, 8)}`));
    await ensurePrivateDir(env.home.bundlesDir);
    try {
      await writeBundleDir(bundleDir, bundle.project_md, bundle.meta as NonNullable<typeof bundle.meta>, bundle.files);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        // A previous plan already saved this exact verified bundle (same version => same digest).
        const saved = await new LocalBundleSource(bundleDir).load();
        if (validateBundle(saved).content_digest !== validateBundle(bundle).content_digest) {
          throw new CliError(`${bundleDir} already holds a different bundle; choose another --out.`, EXIT.failed);
        }
      } else throw cause;
    }
    fresh = true;
  }
  const validated = validateBundle(bundle);
  const found = validated.tests.find((entry) => entry.manifest.key === testKey);
  if (!found) {
    const keys = validated.tests.map((entry) => entry.manifest.key).join(', ') || '(none)';
    throw new CliError(`The bundle has no test \`${testKey}\`. Tests in it: ${keys}`, EXIT.failed);
  }
  const check = checkExecutable(found.manifest);
  if (!check.executable) throw refusal(`This test is not executable by the runner: ${check.reasons.join(', ')}`);
  const manifest = check.manifest;

  if (bundle.meta && bundle.meta.project_id !== projectId) {
    throw usageError(`The bundle is for project ${bundle.meta.project_id}, not ${projectId}.`);
  }
  const versionId = bundle.meta?.project_version_id ?? str(values.version) ?? null;
  if (!versionId) throw usageError('The bundle has no recorded project version; pass --version <id>.');

  // Contacting the runtime needs its own interactive authorization.
  await authorizeDiscovery(env, family, endpoint, validated.content_digest as string);
  const adapter = await makeAdapter(env, family, endpoint, { withVersions: true });
  const probe = await adapter.probe();
  if (!probe.reachable) {
    throw new CliError(`The ${family} runtime at ${endpoint} is not reachable (${probe.failure ?? 'unknown'}).`, EXIT.failed);
  }

  let details;
  try {
    details = await adapter.inspect_model(model);
  } catch (cause) {
    if (cause instanceof AdapterError) throw new CliError(`Model \`${model}\` could not be inspected: ${cause.code}.`, EXIT.failed);
    throw cause;
  }

  const preflight = await adapter.preflight({
    model,
    requirements: {
      capabilities: [...manifest.required_capabilities],
      locality: manifest.execution.locality,
      settings: { ...manifest.inference },
      structured_output: manifest.response_schema !== null,
    },
  });
  for (const finding of preflight.unknowns) env.io.out(`unknown: ${finding.code}: ${finding.message}\n`);
  if (!preflight.ok) {
    const lines = preflight.blockers.map((blocker) => `  ${blocker.code}: ${blocker.message}`);
    throw new CliError(`Plan blocked:\n${lines.join('\n')}`, EXIT.refused);
  }
  if (details.locality.value !== 'local') {
    throw refusal(`Model \`${model}\` is not established as local (${details.locality.value}); a plan needs local execution.`);
  }

  const body: LocalPlanBody = {
    schema: 'localfirst/local-plan/v0.1',
    created_at: env.now().toISOString(),
    runner: { version: RUNNER_VERSION, contract: 'localfirst/runner/v0.1' },
    project: { project_id: projectId, project_version_id: versionId, configuration_key: manifest.configuration_key },
    test: {
      key: manifest.key,
      test_definition_id: bundle.meta?.test_definition_ids?.[manifest.key] ?? null,
      scope: manifest.scope,
      ...testDigests(manifest),
      bundle_digest: validated.content_digest as string,
    },
    runtime: {
      family,
      endpoint,
      application_version: probe.versions.application.value,
      cli_version: probe.versions.cli.value,
      engine_version: engineForFormat(probe.versions.engine.value, details.format),
      adapter_profile: probe.api_profile,
    },
    model: {
      role: manifest.model_role,
      runtime_model_id: model,
      artifact_identity: details.artifact_identity,
      execution_location: 'local',
      locality_method: details.locality.method,
    },
    settings: { ...manifest.inference },
    data_class: 'public_fixture',
    effects: {
      may_load_model: preflight.effects.may_load_model,
      inference_requests: plannedInferenceRequests(manifest),
      network: 'loopback_only',
      downloads: false,
      tools: false,
      project_code: false,
      writes_local_report: true,
    },
  };
  const plan = localPlanSchema.parse(sealLocalPlan(body));

  await ensurePrivateDir(env.home.plansDir);
  const path = join(env.home.plansDir, `${hexOf(plan.plan_digest)}.plan.json`);
  const file: PlanFile = { schema: PLAN_FILE_SCHEMA, plan, bundle_dir: bundleDir };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });

  env.io.out(`${describePlan(plan)}\n\nPlan written to ${path}\nNo inference request was made.\n${fresh ? `Bundle saved to ${bundleDir} and verified against the registry digest.\n` : ''}${OFFLINE_FRESHNESS_NOTE}\nTo run it: localfirstdotsh test run ${path}\n`);
  return EXIT.ok;
}
