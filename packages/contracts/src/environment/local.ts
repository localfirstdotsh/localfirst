import { z } from 'zod';
import { digestOf } from '../canonical.js';
import { localPlanSchema } from '../local/plan.js';
import { environmentSchema, workflowTestSchema, workflowSettingsSchema, workflowDigests, frameworkIdentitySchema, type AgentEnvironment } from './schema.js';
import { digestSchema, clientRunIdSchema } from '../primitives.js';

const body = z.object({
  schema: z.literal('localfirst/local-plan/v0.2'), created_at: z.iso.datetime(),
  runner: z.object({ version: z.string().max(60), contract: z.literal('localfirst/runner/v0.2') }).strict(),
  project: localPlanSchema.shape.project,
  environment_key: z.string().max(64), environment_digest: digestSchema, bundle_digest: digestSchema,
  test: z.object({ key: z.string().max(64), definition_id: z.uuid().nullable(), manifest_digest: digestSchema, fixture_digest: digestSchema, evaluator_digest: digestSchema }).strict(),
  runtime: localPlanSchema.shape.runtime,
  bindings: z.array(localPlanSchema.shape.model.safeExtend({ settings: workflowSettingsSchema, quantization: z.string().max(60).nullable() })).min(1).max(8),
  data_class: z.enum(['public_fixture', 'private_local']),
  private_input_digest: digestSchema.nullable(),
  private_environment_digest: digestSchema.nullable().default(null),
  framework: frameworkIdentitySchema.extend({
    image_id: digestSchema, worker_digest: digestSchema, base_image: z.string().max(150),
    docker_endpoint: z.string().regex(/^unix:\/\/\/[^\n\r\0]+$/), artifact_digest: digestSchema,
  }).strict().optional(),
  effects: z.object({
    network: z.literal('loopback_only'), downloads: z.literal(false), project_code: z.boolean(),
    operations: z.array(z.string().max(64)).max(16), inference_requests: z.int().min(1).max(160),
    output_token_budget: z.int().min(1).max(1310720), run_timeout_ms: z.int().min(1).max(300000),
    writes_local_report: z.literal(true),
  }).strict(),
}).strict();
export const workflowPlanSchema = body.safeExtend({ plan_digest: digestSchema }).superRefine((plan, ctx) => {
  const { plan_digest, ...content } = plan;
  if (digestOf(content) !== plan_digest) ctx.addIssue({ code: 'custom', message: 'plan digest mismatch' });
  if (new Set(plan.bindings.map(b => b.role)).size !== plan.bindings.length) ctx.addIssue({ code: 'custom', message: 'duplicate model role' });
  if ((plan.data_class === 'public_fixture') !== (plan.private_input_digest === null)) ctx.addIssue({ code: 'custom', message: 'private data class mismatch' });
  if ((plan.data_class === 'public_fixture') !== (plan.private_environment_digest === null)) ctx.addIssue({ code: 'custom', message: 'private environment identity mismatch' });
  if (plan.effects.project_code !== (plan.framework !== undefined)) ctx.addIssue({ code: 'custom', message: 'framework capability mismatch' });
});
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export function sealWorkflowPlan(content: z.infer<typeof body>): WorkflowPlan {
  return workflowPlanSchema.parse({ ...content, plan_digest: digestOf(content) });
}
export function validateWorkflowPlan(plan: WorkflowPlan, env: AgentEnvironment, test: z.infer<typeof workflowTestSchema>, bundleDigest: string, executions = test.cases.length): void {
  const digests = workflowDigests(test);
  if (env.execution.project_code !== plan.effects.project_code || (env.framework !== undefined) !== (plan.framework !== undefined) ||
    (env.framework && (!plan.framework || env.framework.profile !== test.profile || env.framework.entry_digest !== plan.framework.entry_digest || env.framework.lock_digest !== plan.framework.lock_digest))) throw new Error('framework identity mismatch');
  if (digestOf(env) !== plan.environment_digest || bundleDigest !== plan.bundle_digest || env.key !== plan.environment_key ||
    Object.entries(digests).some(([k, v]) => plan.test[k as keyof typeof plan.test] !== v) ||
    env.model_roles.length !== plan.bindings.length || env.model_roles.some(r => !plan.bindings.some(b => b.role === r.key && digestOf(b.settings) === digestOf(r.settings)))) throw new Error('workflow plan no longer matches workspace');
  const requests = env.nodes.filter(n => n.kind === 'agent').length * executions;
  if (executions < 1 || executions > test.cases.length || plan.effects.inference_requests !== requests || plan.effects.output_token_budget !== env.model_roles.reduce((n, r) => n + env.nodes.filter(a => a.kind === 'agent' && a.role === r.key).length * r.settings.max_output_tokens, 0) * executions ||
    plan.effects.run_timeout_ms !== env.limits.run_timeout_ms ||
    digestOf(plan.effects.operations) !== digestOf(env.nodes.filter(n => n.kind === 'operation').map(n => n.operation))) throw new Error('workflow effects mismatch');
}
const step = z.object({
  id: z.string().max(64), kind: z.enum(['agent', 'operation']), outcome: z.enum(['completed', 'error', 'skipped']),
  latency_ms: z.number().nonnegative().nullable(), output: z.unknown(), error_code: z.string().max(80).nullable(),
  provider_stats: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).refine(s => Object.keys(s).length <= 40),
}).strict();
const run = z.object({
  state: z.enum(['completed', 'cancelled', 'run_timeout']), elapsed_ms: z.number().nonnegative(),
  cases: z.array(z.object({
    key: z.string().max(64), outcome: z.enum(['pass', 'fail', 'error', 'skipped']),
    steps: z.array(step).max(16), output: z.unknown(), error_code: z.string().max(80).nullable(), elapsed_ms: z.number().nonnegative(),
  }).strict()).min(1).max(20),
}).strict();
export const workflowLocalReportSchema = z.object({
  schema: z.literal('localfirst/local-report/v0.2'), client_run_id: clientRunIdSchema,
  completed_at: z.iso.datetime(), plan: workflowPlanSchema, environment: environmentSchema,
  run, locality: z.enum(['pass', 'fail', 'unknown']), offline: z.enum(['unknown', 'not_run', 'no_route_observed']),
  private_context: z.object({ input: z.unknown(), data: z.unknown() }).strict().nullable().default(null),
}).strict().superRefine((report, ctx) => {
  const expected = report.plan.data_class === 'private_local' ? report.plan.private_environment_digest : report.plan.environment_digest;
  if (expected !== digestOf(report.environment)) ctx.addIssue({ code: 'custom', message: 'report environment mismatch' });
  if (report.plan.data_class === 'public_fixture' ? report.private_context !== null : report.private_context === null || digestOf(report.private_context) !== report.plan.private_input_digest) ctx.addIssue({ code: 'custom', message: 'report private context mismatch' });
  if (new Set(report.run.cases.map(c => c.key)).size !== report.run.cases.length) ctx.addIssue({ code: 'custom', message: 'duplicate result case' });
});
export type WorkflowLocalReport = z.infer<typeof workflowLocalReportSchema>;
