import { z } from 'zod';
import { buildInputSchema } from '../build/schema.js';
import { resultBodySchema, testResultSchema, checkResultConsistency } from '../result/schema.js';
import { workflowSettingsSchema, frameworkIdentitySchema } from './schema.js';
import { digestSchema } from '../primitives.js';

export const workflowIdentitySchema = z.object({
  environment_key: z.string().max(64), environment_digest: digestSchema,
  coordinator: z.literal('localfirst/coordinator/v0.1'), operation_digest: digestSchema,
  role_settings: z.array(z.object({ role: z.string().max(64), settings: workflowSettingsSchema }).strict()).min(1).max(8),
  framework: frameworkIdentitySchema.extend({ image_id: digestSchema, worker_digest: digestSchema }).strict().optional(),
}).strict();
export const workflowBuildInputSchema = z.object({
  ...buildInputSchema.shape,
  schema: z.literal('localfirst/build/v0.2'), workflow: workflowIdentitySchema, manual_report: z.null().default(null),
}).strict().superRefine((build, ctx) => {
  const roles = build.model_bindings.map(b => b.role);
  if (new Set(roles).size !== roles.length || roles.length !== build.workflow.role_settings.length || roles.some(r => !build.workflow.role_settings.some(s => s.role === r)) ||
    new Set(build.workflow.role_settings.map(s => s.role)).size !== roles.length) ctx.addIssue({ code: 'custom', message: 'workflow role bindings/settings mismatch' });
});
const stepSummary = z.object({
  case_key: z.string().max(64), id: z.string().max(64), kind: z.enum(['agent', 'operation']),
  outcome: z.enum(['completed', 'error', 'skipped']), latency_ms: z.number().nonnegative().nullable(),
  error_code: z.string().max(80).nullable(),
}).strict();
export const workflowResultSchema = resultBodySchema.extend({
  schema: z.literal('localfirst/test-result/v0.2'), scope: z.literal('workflow'),
  runner: z.object({ version: z.string().max(60), contract: z.literal('localfirst/runner/v0.2') }).strict(),
  workflow: workflowIdentitySchema.extend({ steps: z.array(stepSummary).max(320) }).strict(),
}).superRefine((result, ctx) => {
  // The count invariants are identical across the two result versions.
  checkResultConsistency(result as unknown as Parameters<typeof checkResultConsistency>[0], ctx);
  const ids = result.workflow.steps.map(s => s.case_key + ':' + s.id);
  if (new Set(ids).size !== ids.length || result.workflow.steps.some(s => !result.case_results.some(c => c.key === s.case_key))) ctx.addIssue({ code: 'custom', message: 'duplicate or unbound workflow step' });
  if (result.measurement_context.repetitions !== 1 || result.measurement_context.warmup_runs !== 0) ctx.addIssue({ code: 'custom', message: 'unsupported workflow repetitions' });
});
export const anyBuildInputSchema = z.union([buildInputSchema, workflowBuildInputSchema]);
export const anyTestResultSchema = z.union([testResultSchema, workflowResultSchema]);
export const anyTestResultSubmissionSchema = z.object({ result: anyTestResultSchema, build: anyBuildInputSchema }).strict().superRefine((payload, ctx) => {
  if ((payload.result.schema === 'localfirst/test-result/v0.2') !== (payload.build.schema === 'localfirst/build/v0.2')) ctx.addIssue({ code: 'custom', message: 'build/result schema versions mismatch' });
});
export type WorkflowBuildInput = z.infer<typeof workflowBuildInputSchema>;
export type WorkflowResult = z.infer<typeof workflowResultSchema>;
export type AnyBuildInput = z.infer<typeof anyBuildInputSchema>;
export type AnyBuildPayload = Omit<z.infer<typeof buildInputSchema>, 'manual_report'> | Omit<WorkflowBuildInput, 'manual_report'>;
export type AnyTestResult = z.infer<typeof anyTestResultSchema>;

export type AnyTestResultSubmission = z.infer<typeof anyTestResultSubmissionSchema>;
