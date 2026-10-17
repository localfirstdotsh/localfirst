import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localPlanSchema } from '@localfirst/contracts';
import { bindModel } from '../../adapters/contract.js';
import { ApprovalStore } from '../../consent/approvals.js';
import { approveInteractively, type ExecutionGrant } from '../../consent/plan.js';
import { ConsentSession } from '../../consent/state-machine.js';
import { verifyForExecution } from '../../consent/verify.js';
import { RefusedTestError, runTest } from '../../harnesses/run.js';
import { buildLocalReport } from '../../reports/build.js';
import { saveLocalReport } from '../../reports/store.js';
import type { LocalPlan } from '@localfirst/contracts';
import type { CliEnv } from '../context.js';
import { CliError, EXIT, refusal } from '../errors.js';
import { LocalBundleSource, type BundleMeta } from '../bundle.js';
import { requireTty, ttyPrompter } from '../io.js';
import { ensurePrivateDir } from '../paths.js';
import { makeAdapter } from '../runtime.js';
import { RegistryClient, RegistryError, parseRegistryOrigin } from '../registry.js';
import { OFFLINE_FRESHNESS_NOTE, PLAN_FILE_SCHEMA, type PlanFile } from './test-plan.js';
import { parse, str } from './common.js';

async function readPlanFile(path: string): Promise<PlanFile> {
  let parsed: PlanFile;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as PlanFile;
  } catch {
    throw new CliError(`Could not read a plan file at ${path}.`, EXIT.failed);
  }
  if (parsed.schema !== PLAN_FILE_SCHEMA || typeof parsed.bundle_dir !== 'string') {
    throw new CliError('That file is not a localfirstdotsh plan file.', EXIT.failed);
  }
  return parsed;
}

interface Freshness {
  /** `null` when the registry could not be asked. */
  withdrawn: boolean | null;
  note: string;
}

/**
 * Before execution, ask the registry (anonymously) whether the planned test
 * definition is still served unchanged. A withdrawn/unpublished definition or
 * differing digests refuse the run; an unreachable registry (or `--offline`)
 * lets a previously saved bundle run, and says that withdrawal was not checked.
 */
async function checkFreshness(
  env: CliEnv,
  plan: LocalPlan,
  meta: BundleMeta | null,
  options: { offline: boolean; registry: string | undefined },
): Promise<Freshness> {
  const definitionId = plan.test.test_definition_id;
  const originText = options.registry ?? meta?.registry_origin ?? env.vars.LOCALFIRST_REGISTRY;
  if (options.offline || !definitionId || !originText) {
    return { withdrawn: null, note: `Registry status was not checked. ${OFFLINE_FRESHNESS_NOTE}` };
  }
  const client = new RegistryClient(parseRegistryOrigin(originText), env.fetch);
  try {
    const definition = await client.testDefinition(definitionId);
    if (
      definition.bundle_digest !== plan.test.bundle_digest ||
      definition.manifest_digest !== plan.test.manifest_digest ||
      definition.fixture_digest !== plan.test.fixture_digest ||
      definition.evaluator_digest !== plan.test.evaluator_digest
    ) {
      throw refusal('The registry now names different digests for this test definition. Create a new plan.');
    }
    if (!definition.runner_available) throw refusal('The registry no longer lists this test as executable by the runner.');
    return { withdrawn: false, note: 'The registry still serves this test definition with the planned digests.' };
  } catch (cause) {
    if (cause instanceof RegistryError) {
      if (cause.status === 404) {
        throw refusal('The registry no longer serves this test definition (withdrawn, unpublished, or removed). Nothing was run.');
      }
      if (cause.status === 0 || cause.status >= 500) {
        return { withdrawn: null, note: `The registry could not be reached, so withdrawal was not checked. ${OFFLINE_FRESHNESS_NOTE}` };
      }
      throw refusal(`The registry refused the status check (${cause.code ?? cause.status}). Nothing was run.`);
    }
    throw cause;
  }
}

/**
 * `test run <plan-file> [--remember] [--bundle <dir>] [--offline] [--registry <url>]`.
 *
 * Execution needs a local approval bound to the exact plan digest: an
 * interactive terminal prompt, or a stored approval from an earlier
 * interactive yes. There is no flag or variable that skips this, and a
 * manifest's `allow_run` is never consulted.
 */
export async function testRun(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { remember: { type: 'boolean' }, bundle: { type: 'string' }, offline: { type: 'boolean' }, registry: { type: 'string' } },
    { min: 1, max: 1 },
  );
  const file = await readPlanFile(resolve(env.cwd, positionals[0] as string));
  const parsedPlan = localPlanSchema.safeParse(file.plan);
  if (!parsedPlan.success) throw refusal('The plan is invalid or was edited after it was sealed.');
  const plan = parsedPlan.data;

  const bundle = await new LocalBundleSource(resolve(env.cwd, str(values.bundle) ?? file.bundle_dir)).load();
  const bundleInput = { project_md: bundle.project_md, files: bundle.files };

  // The bundle must still match the plan before anything is shown for approval.
  const preCheck = verifyForExecution({ plan, bundle: bundleInput, approvedPlanDigest: plan.plan_digest });
  if (!preCheck.ok) throw refusal(`The plan no longer matches what would run: ${preCheck.reasons.join(', ')}`);

  const freshness = await checkFreshness(env, plan, bundle.meta, {
    offline: values.offline === true,
    registry: str(values.registry),
  });
  env.io.out(`${freshness.note}\n`);

  const store = new ApprovalStore(env.home.approvalsDir, env.now);
  let grant: ExecutionGrant | null = await store.grantFor(plan.plan_digest);
  if (grant) {
    env.io.out(`Using the stored approval for plan ${plan.plan_digest}.\n`);
  } else {
    requireTty(env.io, 'Approving a plan (no stored approval exists for this digest)');
    const approved = await approveInteractively(plan, ttyPrompter(env.io));
    if (!approved) throw refusal('The plan was not approved. Nothing was run.');
    grant = approved;
    if (values.remember === true) {
      await store.save(approved);
      env.io.out('Stored this approval for this exact plan digest.\n');
    }
  }

  const verification = verifyForExecution({
    plan,
    bundle: bundleInput,
    approvedPlanDigest: grant.plan_digest,
    ...(freshness.withdrawn === null ? {} : { registry: { withdrawn: freshness.withdrawn } }),
  });
  if (!verification.ok) throw refusal(`Verification failed: ${verification.reasons.join(', ')}`);
  const manifest = verification.manifest;

  const session = new ConsentSession({ project_manifest_digest: plan.test.bundle_digest }, env.now);
  session.advance('local_discovery_authorized', { runtime: plan.runtime.family, endpoint: plan.runtime.endpoint, channel: 'approved_plan' });
  session.advance('preflight', {});

  const adapter = await makeAdapter(env, plan.runtime.family, plan.runtime.endpoint, { withVersions: false });
  const details = await adapter.inspect_model(plan.model.runtime_model_id).catch((cause: unknown) => {
    throw new CliError(`Model \`${plan.model.runtime_model_id}\` is not available: ${(cause as { code?: string }).code ?? 'error'}.`, EXIT.failed);
  });
  const planned = plan.model.artifact_identity;
  if (planned && JSON.stringify(details.artifact_identity) !== JSON.stringify(planned)) {
    throw refusal('The installed model no longer matches the planned model identity. Create a new plan.');
  }
  const preflight = await adapter.preflight({
    model: plan.model.runtime_model_id,
    requirements: {
      capabilities: [...manifest.required_capabilities],
      locality: 'local_required',
      settings: { ...manifest.inference },
      structured_output: manifest.response_schema !== null,
    },
  });
  if (!preflight.ok) {
    session.fail('preflight_blocked');
    throw refusal(`Preflight blocked the run: ${preflight.blockers.map((blocker) => blocker.code).join(', ')}`);
  }

  session.advance('plan_reviewed', { plan_digest: plan.plan_digest });
  session.advance('execution_authorized', { plan_digest: plan.plan_digest, channel: grant.channel });
  session.advance('running', { plan_digest: plan.plan_digest, bundle_verified: true });

  const controller = new AbortController();
  const forward = () => controller.abort();
  if (env.signal?.aborted) controller.abort();
  env.signal?.addEventListener('abort', forward, { once: true });

  const network = env.watchNetwork();
  let run;
  try {
    run = await runTest({ manifest, adapter: bindModel(adapter, plan.model.runtime_model_id, grant), signal: controller.signal });
  } catch (cause) {
    session.fail('run_refused');
    if (cause instanceof RefusedTestError) throw refusal(cause.message);
    throw cause;
  } finally {
    env.signal?.removeEventListener('abort', forward);
    network.stop();
  }
  const { observation: offline } = network.stop();

  const report = buildLocalReport({
    plan,
    manifest,
    run,
    clientRunId: `run_${env.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${env.randomId()}`,
    completedAt: env.now().toISOString(),
    offline,
  });
  await ensurePrivateDir(env.home.reportsDir);
  const saved = await saveLocalReport(env.home.reportsDir, report);

  if (run.state === 'completed') session.advance('local_report_saved', { report_digest: saved.digest });
  else {
    if (run.state === 'cancelled') session.cancel('interrupted');
    else session.fail(run.state);
    session.markPartialReportSaved(saved.digest);
  }

  const { counts } = report;
  env.io.out(
    `Outcome: ${report.outcome}${run.state === 'completed' ? '' : ` (${run.state}; partial report kept)`}\n` +
      `Cases: ${counts.defined} defined, ${counts.evaluated} evaluated, ${counts.passed} passed, ${counts.failed} failed, ` +
      `${counts.errors} errors, ${counts.skipped} skipped\n` +
      `Local report: ${saved.path}\nNothing was uploaded. ${freshness.note}\n`,
  );
  return report.outcome === 'pass' ? EXIT.ok : EXIT.failed;
}

