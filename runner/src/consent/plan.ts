import type { LocalPlan } from '@localfirst/contracts';

/**
 * Human-readable plan summary shown at approval time. Deterministic and built
 * only from the plan, so what the user reads is exactly what the digest binds.
 */
export function describePlan(plan: LocalPlan): string {
  const { test, runtime, model, settings, effects } = plan;
  return [
    `Plan digest: ${plan.plan_digest}`,
    `Project: ${plan.project.project_id} @ ${plan.project.project_version_id} (${plan.project.configuration_key})`,
    `Test: ${test.key} (${test.scope}), data class: ${plan.data_class}`,
    `  manifest ${test.manifest_digest}`,
    `  fixture  ${test.fixture_digest}`,
    `  evaluator ${test.evaluator_digest}`,
    `  bundle   ${test.bundle_digest}`,
    `Runtime: ${runtime.family} at ${runtime.endpoint} (${runtime.adapter_profile})`,
    `  application ${runtime.application_version ?? 'unknown'}, cli ${runtime.cli_version ?? 'unknown'}, engine ${runtime.engine_version ?? 'unknown'}`,
    `Model: ${model.runtime_model_id} for role ${model.role} (locality: ${model.locality_method})`,
    `Settings: ${JSON.stringify(settings)}`,
    'Effects:',
    `  ${effects.inference_requests} inference request(s) to ${runtime.endpoint} only`,
    `  may load the model into memory: ${effects.may_load_model ? 'yes' : 'no'}`,
    '  no downloads, no tools, no project code, no upload',
    '  writes one local report',
  ].join('\n');
}

/** Interactive approval seam. The CLI implements it over a TTY; there is no `--yes`. */
export interface ApprovalPrompter {
  confirm(summary: string, planDigest: string): Promise<boolean>;
}

export interface ExecutionGrant {
  plan_digest: string;
  channel: 'interactive_tty' | 'stored_approval';
}

/** Show the exact plan and ask. Returns a grant only on an explicit yes. */
export async function approveInteractively(
  plan: LocalPlan,
  prompter: ApprovalPrompter,
): Promise<ExecutionGrant & { channel: 'interactive_tty' } | null> {
  const approved = await prompter.confirm(describePlan(plan), plan.plan_digest);
  return approved === true ? { plan_digest: plan.plan_digest, channel: 'interactive_tty' } : null;
}
