import { mkdir, readFile, writeFile, lstat, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import {
  sampleBundle, SAMPLE_ENVIRONMENTS, BAKERY_HOLIDAY_REMIX, bakeryHolidayBundle, STOCK_REPLENISHMENT_SAMPLE, stockReplenishmentBundle, digestOf, digestOfBytes, boundedJson, workflowPlanSchema, sealWorkflowPlan, validateWorkflowPlan,
  workflowLocalReportSchema, workflowDigests, type WorkflowPlan,
} from '@localfirst/contracts';
import { LocalBundleSource, validateBundle, writeBundleDir, type BundleMeta } from '../bundle.js';
import { fetchRegistryBundle, registryMeta } from '../registry-source.js';
import { RegistryClient } from '../registry.js';
import { parse, str, registryOrigin, hexOf } from './common.js';
import { requireTty } from '../io.js';
import { authorizeDiscovery, makeAdapter, parseFamily, resolveEndpoint, engineForFormat } from '../runtime.js';
import { ensurePrivateDir } from '../paths.js';
import { refusal, usageError, EXIT } from '../errors.js';
import type { CliEnv } from '../context.js';
import { RUNNER_VERSION } from '../version.js';
import { runWorkflow } from '../../workflows/run.js';
import { bindModel } from '../../adapters/contract.js';
import { applyPrivateData } from '../../workflows/private-data.js';
import { preparedFrameworkSchema, DockerWorkflowScheduler, localDockerEndpoint } from '../../frameworks/docker.js';

const PLAN_FILE = 'localfirst/workflow-plan-file/v0.1';
const bundledSamples = [
  ...SAMPLE_ENVIRONMENTS.map(sample => ({ ...sample, load: () => sampleBundle(sample.key) })),
  { ...BAKERY_HOLIDAY_REMIX, load: bakeryHolidayBundle },
  { ...STOCK_REPLENISHMENT_SAMPLE, load: stockReplenishmentBundle },
];
/** Lists authored fixtures without touching a model or creating files. */
export async function environmentSamples(env: CliEnv, argv: string[]): Promise<number> {
  parse(argv, {}, { min: 0, max: 0 });
  for (const sample of bundledSamples) env.io.out(sample.key + ': ' + sample.name + '\n  ' + sample.description + '\n');
  env.io.out('Fictional data; drafts require owner review. Prepare with environment prepare --sample <key> --out <new-dir>.\n');
  return EXIT.ok;
}
async function readJson(path: string, max = 2 * 1024 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw refusal('Expected a bounded regular local file.');
  return JSON.parse(await readFile(path, 'utf8'));
}
export function describeWorkflowPlan(plan: WorkflowPlan): string {
  return [
    'Plan digest: ' + plan.plan_digest,
    'Environment: ' + plan.environment_key + ' @ ' + plan.environment_digest,
    'Project version: ' + plan.project.project_version_id,
    'Runtime: ' + plan.runtime.family + ' at ' + plan.runtime.endpoint,
    ...plan.bindings.map(b => 'Role ' + b.role + ': ' + JSON.stringify(b.runtime_model_id) + ' ' + JSON.stringify(b.settings)),
    'Data class: ' + plan.data_class,
    ...(plan.data_class === 'private_local' ? ['Private input/business data stays local; checks cover structure and execution, not public-fixture accuracy. Export is disabled.'] : []),
    ...(plan.framework ? ['Framework: ' + plan.framework.profile + ' SDK ' + plan.framework.sdk_version + ' image ' + plan.framework.image_id, 'Creator entry: ' + plan.framework.entry_digest, 'Container: local Linux Docker engine; no network/mounts/secrets, read-only root, non-root, capped memory/CPU/processes.'] : []),
    'Operations: ' + plan.effects.operations.join(', '),
    'Maximum requests: ' + plan.effects.inference_requests + ', output tokens: ' + plan.effects.output_token_budget + ', run timeout ms: ' + plan.effects.run_timeout_ms,
    'Effects: local inference may load the model; writes a private local report; no downloads or upload; project code: ' + plan.effects.project_code,
  ].join('\n');
}
export async function environmentPrepare(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { sample: { type: 'string' }, bundle: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, registry: { type: 'string' }, out: { type: 'string' } }, { min: 0, max: 1 });
  const destination = str(values.out);
  if (!destination) throw usageError('--out <new-workspace> is required.');
  const modes = [str(values.sample), str(values.bundle), positionals[0]].filter(Boolean);
  if (modes.length !== 1) throw usageError('Choose a project ID, --bundle, or --sample bakery.');
  let bundle;
  if (str(values.sample)) {
    const entry = bundledSamples.find(s => s.key === values.sample);
    if (!entry) throw usageError('Supported samples: ' + bundledSamples.map(s => s.key).join(', ') + '.');
    const sample = entry.load();
    const meta: BundleMeta = { schema: 'localfirst/bundle-meta/v0.1', project_id: randomUUID(), project_version_id: randomUUID(), registry_origin: null, content_digest: null, exported_at: env.now().toISOString() };
    bundle = { project_md: sample.project_md, files: sample.files, meta };
  } else if (str(values.bundle)) bundle = await new LocalBundleSource(resolve(env.cwd, str(values.bundle)!)).load();
  else {
    const projectId = positionals[0]!, versionId = str(values.version);
    if (!versionId) throw usageError('--version <exact-version-id> is required.');
    const origin = registryOrigin(env, str(values.registry));
    const fetched = await fetchRegistryBundle(new RegistryClient(origin, env.fetch), { projectId, versionId, now: env.now });
    bundle = { ...fetched.bundle, meta: registryMeta(fetched, { projectId, origin, now: env.now }) };
  }
  const validated = validateBundle(bundle);
  const chosen = validated.environments?.find(e => e.manifest.key === str(values.environment)) ?? (str(values.environment) ? undefined : validated.environments?.[0]);
  if (!chosen) throw refusal('No matching supported environment in the bundle.');
  const out = resolve(env.cwd, destination);
  requireTty(env.io, 'Preparing an environment');
  env.io.out('Prepare ' + chosen.manifest.key + ' @ ' + validated.content_digest + '\nWrite a new private workspace: ' + out + '\nCopies declared project files; runtime/model installation remains manual.\n');
  if (!await env.io.ask('Prepare exactly this workspace? Type "yes": ')) throw refusal('Workspace preparation declined.');
  await ensurePrivateDir(dirname(out));
  await mkdir(out, { mode: 0o700 }); // Exclusive directory creation: never overwrite an existing workspace.
  const meta: BundleMeta = bundle.meta ?? { schema: 'localfirst/bundle-meta/v0.1', project_id: randomUUID(), project_version_id: randomUUID(), registry_origin: null, content_digest: null, exported_at: env.now().toISOString() };
  const preparedFiles = [{ path: 'PROJECT.md', digest: digestOfBytes(bundle.project_md) }, ...bundle.files.map(f => ({ path: f.path, digest: digestOfBytes(f.content) }))];
  await writeBundleDir(out, bundle.project_md, { ...meta, content_digest: validated.content_digest, prepared_files: preparedFiles }, bundle.files);
  env.io.out('Prepared ' + out + '\nNext: localfirstdotsh environment plan ' + out + ' --runtime ollama --model <installed-id>\n');
  return EXIT.ok;
}
export async function environmentRemove(env: CliEnv, argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { min: 1, max: 1 });
  const workspace = resolve(env.cwd, positionals[0]!);
  if ((await lstat(workspace)).isSymbolicLink()) throw refusal('Cannot clean a symlinked workspace.');
  const loaded = await new LocalBundleSource(workspace).load();
  validateBundle(loaded); // Changed or additional files block cleanup; preserve user work.
  const receipt = loaded.meta?.prepared_files;
  if (!receipt || receipt.length !== loaded.files.length + 1) throw refusal('No matching environment preparation receipt.');
  const content = new Map([['PROJECT.md', loaded.project_md], ...loaded.files.map(f => [f.path, f.content] as [string, string])]);
  if (new Set(receipt.map(f => f.path)).size !== receipt.length || receipt.some(f => !content.has(f.path) || digestOfBytes(content.get(f.path)!) !== f.digest)) throw refusal('Prepared files were changed; cleanup refused.');
  requireTty(env.io, 'Removing a prepared environment');
  env.io.out('Remove only these unchanged prepared files from ' + workspace + ':\n' + receipt.map(f => '  ' + f.path).join('\n') + '\nLocal plans and reports are retained.\n');
  if (!await env.io.ask('Remove these prepared files? Type "yes": ')) throw refusal('Cleanup declined.');
  // Recheck after approval. Unlinking never follows a replaced symlink.
  validateBundle(await new LocalBundleSource(workspace).load());
  for (const file of receipt) {
    const path = join(workspace, file.path);
    if (digestOfBytes(await readFile(path, 'utf8')) !== file.digest) throw refusal('Prepared content changed during cleanup.');
    await unlink(path);
  }
  await unlink(join(workspace, '.localfirst-bundle.json'));
  const dirs = [...new Set(receipt.map(f => dirname(join(workspace, f.path))))].filter(d => d !== workspace).sort((a, b) => b.length - a.length);
  for (const directory of [...dirs, workspace]) { try { await rmdir(directory); } catch (cause) { if (!['ENOTEMPTY', 'ENOENT'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause; } }
  env.io.out('Prepared files removed.\n');
  return EXIT.ok;
}
export async function environmentPlan(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { environment: { type: 'string' }, test: { type: 'string' }, runtime: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' }, input: { type: 'string' }, data: { type: 'string' }, framework: { type: 'string' } }, { min: 1, max: 1 });
  const workspace = resolve(env.cwd, positionals[0]!);
  const bundle = await new LocalBundleSource(workspace).load(), validated = validateBundle(bundle);
  const selected = validated.environments?.find(e => e.manifest.key === str(values.environment)) ?? (str(values.environment) ? undefined : validated.environments?.[0]);
  if (!selected) throw refusal('No supported environment in workspace.');
  const environment = selected.manifest;
  const artifact = str(values.framework) ? preparedFrameworkSchema.parse(await readJson(resolve(env.cwd, str(values.framework)!))) : undefined;
  if ((artifact !== undefined) !== (environment.framework !== undefined) ||
    (environment.framework && (!artifact || artifact.entry_digest !== environment.framework.entry_digest || artifact.lock_digest !== environment.framework.lock_digest))) throw refusal('A matching prepared isolated framework is required for this environment.');
  const test = validated.workflow_tests?.find(t => t.manifest.environment_key === environment.key && (!str(values.test) || t.manifest.key === str(values.test)))?.manifest;
  if (!test || !bundle.meta?.project_version_id) throw refusal('The workspace needs a workflow test and exact project/version metadata.');
  const family = parseFamily(str(values.runtime)), endpoint = resolveEndpoint(family, str(values.endpoint)), model = str(values.model);
  if (!model) throw usageError('--model <installed-id> is required.');
  const privateInput = str(values.input) ? await readJson(resolve(env.cwd, str(values.input)!), 65536) : null;
  const privateData = str(values.data) ? await readJson(resolve(env.cwd, str(values.data)!), 65536) : null;
  if (bundle.meta?.content_digest && bundle.meta.content_digest !== validated.content_digest) throw refusal('The workspace was modified. Prepare it as a new local bundle/version before planning.');
  if (privateInput !== null && !boundedJson(privateInput)) throw refusal('Private input must be bounded JSON.');
  const effective = applyPrivateData(environment, new Map(bundle.files.map(f => [f.path, f.content])), privateData);
  const privateContext = privateInput !== null || privateData !== null ? { input: privateInput, data: privateData } : null;
  await authorizeDiscovery(env, family, endpoint, validated.content_digest!);
  const adapter = await makeAdapter(env, family, endpoint, { withVersions: true });
  const probe = await adapter.probe();
  if (!probe.reachable) throw refusal('Runtime is unavailable.');
  const details = await adapter.inspect_model(model);
  if (details.locality.value !== 'local') throw refusal('Selected model is not established as local.');
  const restricted = validated.spec?.models.roles.some(r => environment.model_roles.some(m => m.key === r.key) && r.substitution === 'not_allowed');
  if (restricted && (!environment.tested_configuration.artifact_digest || details.artifact_identity?.digest !== environment.tested_configuration.artifact_digest)) throw refusal('This creator forbids model substitution; the tested model artifact must match.');
  const bindings = [];
  for (const role of environment.model_roles) {
    const preflight = await adapter.preflight({ model, requirements: { capabilities: [...role.required_capabilities], locality: 'local_required', settings: role.settings, structured_output: true } });
    if (!preflight.ok) throw refusal('Role ' + role.key + ' preflight failed: ' + preflight.blockers.map(b => b.code).join(', '));
    bindings.push({ role: role.key, runtime_model_id: model, artifact_identity: details.artifact_identity, quantization: details.quantization, execution_location: 'local' as const, locality_method: details.locality.method, settings: role.settings });
  }
  const executions = privateInput === null ? test.cases.length : 1;
  const plan = sealWorkflowPlan({
    schema: 'localfirst/local-plan/v0.2', created_at: env.now().toISOString(), runner: { version: RUNNER_VERSION, contract: 'localfirst/runner/v0.2' },
    project: { project_id: bundle.meta.project_id, project_version_id: bundle.meta.project_version_id, configuration_key: test.configuration_key },
    environment_key: environment.key, environment_digest: digestOf(environment), bundle_digest: validated.content_digest!,
    test: { key: test.key, definition_id: bundle.meta.test_definition_ids?.[test.key] ?? null, ...workflowDigests(test) },
    runtime: { family, endpoint, application_version: probe.versions.application.value, cli_version: probe.versions.cli.value, engine_version: engineForFormat(probe.versions.engine.value, details.format), adapter_profile: probe.api_profile },
    bindings, data_class: privateContext === null ? 'public_fixture' : 'private_local', private_input_digest: privateContext === null ? null : digestOf(privateContext),
    private_environment_digest: privateContext === null ? null : digestOf(effective.environment),
    ...(artifact ? { framework: { profile: artifact.profile, sdk_version: artifact.sdk_version, entry_digest: artifact.entry_digest, lock_digest: artifact.lock_digest, image_id: artifact.image_id, worker_digest: artifact.worker_digest, base_image: artifact.base_image, docker_endpoint: artifact.docker_endpoint, artifact_digest: artifact.artifact_digest } } : {}),
    effects: {
      network: 'loopback_only', downloads: false, project_code: environment.execution.project_code, writes_local_report: true,
      operations: environment.nodes.filter(n => n.kind === 'operation').map(n => n.operation),
      inference_requests: environment.nodes.filter(n => n.kind === 'agent').length * executions,
      output_token_budget: environment.model_roles.reduce((n, r) => n + environment.nodes.filter(a => a.kind === 'agent' && a.role === r.key).length * r.settings.max_output_tokens, 0) * executions,
      run_timeout_ms: environment.limits.run_timeout_ms,
    },
  });
  await ensurePrivateDir(env.home.plansDir);
  const path = join(env.home.plansDir, hexOf(plan.plan_digest) + '.workflow-plan.json');
  await writeFile(path, JSON.stringify({ schema: PLAN_FILE, workspace, plan, private_context: privateContext }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  env.io.out(describeWorkflowPlan(plan) + '\nPlan saved: ' + path + '\nNo inference made. Next: localfirstdotsh environment run ' + path + '\n');
  return EXIT.ok;
}
export async function environmentRun(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { offline: { type: 'boolean' } }, { min: 1, max: 1 });
  const file = await readJson(resolve(env.cwd, positionals[0]!)) as { schema?: string; workspace?: unknown; plan?: unknown; private_context?: { input: unknown; data: unknown } | null };
  if (file.schema !== PLAN_FILE || typeof file.workspace !== 'string') throw refusal('Invalid workflow plan file.');
  const plan = workflowPlanSchema.parse(file.plan);
  if (plan.runner.version !== RUNNER_VERSION) throw refusal('Runner release changed; prepare a new plan.');
  const bundle = await new LocalBundleSource(file.workspace).load(), validated = validateBundle(bundle);
  const environment = validated.environments?.find(e => e.manifest.key === plan.environment_key)?.manifest;
  const test = validated.workflow_tests?.find(t => t.manifest.key === plan.test.key)?.manifest;
  if (!environment || !test) throw refusal('Workflow content missing.');
  if (file.private_context != null && (!boundedJson(file.private_context.input) || !boundedJson(file.private_context.data))) throw refusal('Invalid private input envelope.');
  validateWorkflowPlan(plan, environment, test, validated.content_digest!, file.private_context?.input != null ? 1 : test.cases.length);
  if (plan.private_input_digest !== (file.private_context == null ? null : digestOf(file.private_context))) throw refusal('Private input/data changed after planning.');
  const effective = applyPrivateData(environment, new Map(bundle.files.map(f => [f.path, f.content])), file.private_context?.data);
  if (plan.data_class === 'private_local' && digestOf(effective.environment) !== plan.private_environment_digest) throw refusal('Private environment changed after planning.');
  if (plan.bindings.some(b => b.runtime_model_id !== plan.bindings[0]!.runtime_model_id)) throw refusal('This profile requires one shared model.');
  if (bundle.meta?.registry_origin && values.offline !== true) {
    const definition = plan.test.definition_id ? await new RegistryClient(bundle.meta.registry_origin, env.fetch).testDefinition(plan.test.definition_id) : null;
    if (!definition || definition.bundle_digest !== plan.bundle_digest || !definition.runner_available) throw refusal('Registry definition is unavailable or changed.');
  } else env.io.out('Registry freshness was not checked; this does not establish offline verification.\n');
  requireTty(env.io, 'Running an environment');
  env.io.out(describeWorkflowPlan(plan) + '\n');
  if (!await env.io.ask('Run exactly this plan? Type "yes": ')) throw refusal('Execution declined.');
  const adapter = await makeAdapter(env, plan.runtime.family, plan.runtime.endpoint, { withVersions: true });
  const selected = plan.bindings[0]!;
  if (plan.bindings.some(b => digestOf(b.artifact_identity) !== digestOf(selected.artifact_identity) || b.quantization !== selected.quantization)) throw refusal('Shared-model role identities must agree; prepare a new plan.');
  const details = await adapter.inspect_model(selected.runtime_model_id);
  const probe = await adapter.probe();
  if (!probe.reachable || details.locality.value !== 'local' ||
    digestOf(details.artifact_identity) !== digestOf(selected.artifact_identity) ||
    probe.api_profile !== plan.runtime.adapter_profile ||
    (plan.runtime.family === 'ollama' && probe.versions.application.value !== plan.runtime.application_version)) throw refusal('Runtime/model identity changed; prepare a new plan.');
  if (plan.runtime.family === 'lmstudio' && (probe.versions.application.value !== plan.runtime.application_version ||
    engineForFormat(probe.versions.engine.value, details.format) !== plan.runtime.engine_version)) throw refusal('LM Studio application/engine changed; prepare a new plan.');
  const artifact = plan.framework ? preparedFrameworkSchema.parse({ schema: 'localfirst/prepared-framework/v0.1', ...plan.framework }) : undefined;
  if (artifact && await localDockerEndpoint() !== artifact.docker_endpoint) throw refusal('Docker context changed after planning.');
  for (const binding of plan.bindings) {
    const preflight = await adapter.preflight({ model: binding.runtime_model_id, requirements: { capabilities: ['chat', 'json_output'], locality: 'local_required', settings: binding.settings, structured_output: true } });
    if (!preflight.ok) throw refusal('Execution preflight failed.');
  }
  const bound = bindModel(adapter, selected.runtime_model_id, { plan_digest: plan.plan_digest, channel: 'interactive_tty' });
  const effectiveTest = { ...test, environment_digest: digestOf(effective.environment), ...(file.private_context?.input != null ? { cases: [{ key: 'private-input', input: file.private_context.input, assertions: [{ path: '/decision/status', equals: 'needs_owner_review' }] }] } : {}) };
  const run = await runWorkflow({ environment: effective.environment, test: effectiveTest, files: effective.files, adapter: bound, ...(env.signal ? { signal: env.signal } : {}), ...(artifact ? { scheduler: new DockerWorkflowScheduler(artifact) } : {}), observeOnly: plan.data_class === 'private_local' });
  const report = workflowLocalReportSchema.parse({ schema: 'localfirst/local-report/v0.2', client_run_id: 'workflow-' + env.randomId(), completed_at: env.now().toISOString(), plan, environment: effective.environment, run, locality: 'pass', offline: 'not_run', private_context: file.private_context ?? null });
  await ensurePrivateDir(env.home.reportsDir);
  const path = join(env.home.reportsDir, report.client_run_id + '.report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const label = plan.data_class === 'private_local' ? ' inputs completed structural checks; public-fixture accuracy was not evaluated.' : ' cases passed.';
  env.io.out('Workflow ' + run.state + ': ' + run.cases.filter(c => c.outcome === 'pass').length + '/' + run.cases.length + label + '\nPrivate report: ' + path + '\n');
  return run.state === 'completed' && run.cases.every(c => c.outcome === 'pass') ? EXIT.ok : EXIT.failed;
}
