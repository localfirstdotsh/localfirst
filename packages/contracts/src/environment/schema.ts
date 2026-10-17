import { z } from 'zod';
import { digestOf, digestOfBytes } from '../canonical.js';
import { bundlePath } from '../project/schema.js';

export const ENVIRONMENT_SCHEMA_ID = 'localfirst/environment/v0.1' as const;
export const WORKFLOW_TEST_SCHEMA_ID = 'localfirst/test/v0.2' as const;
export const WORKFLOW_RUNNER_CONTRACT = 'localfirst/runner/v0.2' as const;
export const COORDINATOR_CONTRACT = 'localfirst/coordinator/v0.1' as const;
/** Normative dependency lock for the supported SDK profile, verified against the shipped asset. */
export const LANGGRAPH_LOCK_DIGEST = 'sha256:6bb0f402a695eea3b8a2dbc583e58735b2fa64ea344b14595397f8b09830d4b3' as const;
export const WORKFLOW_LIMITS = { agents: 8, nodes: 16, cases: 20, bytes: 65536, depth: 12 } as const;
const key = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON accepted at a state/tool boundary, including prototype and resource checks. */
export function checkJson(value: unknown, depth = 0): boolean {
  if (depth > WORKFLOW_LIMITS.depth) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(v => checkJson(v, depth + 1));
  if (typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([k, v]) => !forbidden.has(k) && checkJson(v, depth + 1));
}
export function boundedJson(value: unknown): boolean {
  return checkJson(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= WORKFLOW_LIMITS.bytes;
}
export const jsonValueSchema = z.unknown().refine(boundedJson, 'invalid or oversized bounded JSON');
export const pointerSchema = z.string().max(256).regex(/^(?:\/(?:[^~\/]|~[01])*)*$/)
  .refine(p => p.split('/').every(k => !forbidden.has(k.replaceAll('~1', '/').replaceAll('~0', '~'))));
const ref = z.object({ source: z.string().max(64).regex(/^(input|data:[a-z0-9-]+|node:[a-z0-9-]+)$/), path: pointerSchema }).strict();
export type StateRef = z.infer<typeof ref>;
export const workflowSettingsSchema = z.object({
  temperature: z.number().min(0).max(2), max_output_tokens: z.int().min(1).max(8192),
  context_tokens: z.int().min(1).max(131072), concurrency: z.literal(1), stream: z.literal(false),
  seed: z.int().nullable(), reasoning: z.enum(['default', 'disabled']),
}).strict();
export const outputSchemaSchema: z.ZodType<unknown> = z.lazy(() => z.object({
  type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean']),
  properties: z.record(z.string().max(64), outputSchemaSchema).optional(),
  items: outputSchemaSchema.optional(), required: z.array(z.string().max(64)).max(64).optional(),
  additionalProperties: z.literal(false).optional(),
  enum: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(64).optional(),
  description: z.string().max(500).optional(),
}).strict());
const inputs = z.record(key, ref).refine(v => Object.keys(v).length <= 32);
const agent = z.object({
  kind: z.literal('agent'), id: key, role: key, prompt: key, inputs,
  response_schema: outputSchemaSchema,
  constraints: z.array(z.object({ path: pointerSchema, equals_from: ref }).strict()).max(20).optional(),
}).strict();
export const TRUSTED_OPERATIONS = ['lookup_v1', 'capacity_v1', 'price_v1', 'order_decision_v1', 'replenishment_v1'] as const;
export const frameworkIdentitySchema = z.object({
  profile: z.literal('langgraph-docker/v0.1'), sdk_version: z.literal('1.5.0'),
  entry_digest: digest, lock_digest: z.literal(LANGGRAPH_LOCK_DIGEST),
}).strict();
const operation = z.object({ kind: z.literal('operation'), id: key, operation: z.enum(TRUSTED_OPERATIONS), inputs }).strict();
const file = z.object({ key, path: bundlePath, digest }).strict();
export const environmentSchema = z.object({
  schema: z.literal(ENVIRONMENT_SCHEMA_ID), key, coordinator: z.literal(COORDINATOR_CONTRACT),
  runner_contract: z.literal(WORKFLOW_RUNNER_CONTRACT),
  model_roles: z.array(z.object({
    key, required_capabilities: z.array(z.enum(['chat', 'json_output'])).length(2).refine(v => new Set(v).size === 2),
    settings: workflowSettingsSchema,
  }).strict()).min(1).max(8),
  prompts: z.array(file).min(1).max(8), data: z.array(file).max(8),
  nodes: z.array(z.discriminatedUnion('kind', [agent, operation])).min(1).max(16),
  output: inputs,
  framework: frameworkIdentitySchema.extend({ entry_path: bundlePath }).strict().optional(),
  limits: z.object({
    step_timeout_ms: z.int().min(1).max(120000), run_timeout_ms: z.int().min(1).max(300000),
    max_state_bytes: z.int().min(1).max(WORKFLOW_LIMITS.bytes), max_inference_requests: z.int().min(1).max(8),
    max_output_tokens: z.int().min(1).max(65536), concurrency: z.literal(1),
  }).strict(),
  execution: z.object({ locality: z.literal('local_required'), project_code: z.boolean(), downloads: z.literal(false), network: z.literal('loopback_only') }).strict(),
  tested_configuration: z.object({
    model: z.string().max(200).nullable(), artifact_digest: digest.nullable(), quantization: z.string().max(60).nullable(),
    runtime: z.enum(['ollama', 'lmstudio']).nullable(), runtime_version: z.string().max(60).nullable(),
    hardware: z.string().max(200).nullable(), evidence_reference: z.string().max(200).nullable(),
  }).strict(),
}).strict().superRefine((env, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (env.execution.project_code !== (env.framework !== undefined)) issue('project code requires a declared isolated framework profile');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (![env.model_roles.map(r => r.key), env.prompts.map(p => p.key), env.data.map(d => d.key), env.nodes.map(n => n.id),
    [...env.prompts, ...env.data].map(f => f.path)].every(unique)) issue('duplicate role, file, or node identity');
  const available = new Set(['input', ...env.data.map(d => 'data:' + d.key)]);
  const roles = new Set(env.model_roles.map(r => r.key));
  const prompts = new Set(env.prompts.map(p => p.key));
  let requests = 0, tokens = 0;
  for (const node of env.nodes) {
    for (const r of Object.values(node.inputs)) if (!available.has(r.source)) issue('dangling, cyclic, or forward state reference: ' + r.source);
    if (node.kind === 'agent') {
      for (const c of node.constraints ?? []) if (!available.has(c.equals_from.source)) issue('unknown constraint state reference');
      if (!roles.has(node.role) || !prompts.has(node.prompt)) issue('unknown agent role or prompt');
      requests++;
      tokens += env.model_roles.find(r => r.key === node.role)?.settings.max_output_tokens ?? 0;
    }
    available.add('node:' + node.id);
  }
  for (const r of Object.values(env.output)) if (!available.has(r.source)) issue('unknown output reference');
  if (requests > env.limits.max_inference_requests || requests > 8 || tokens > env.limits.max_output_tokens) issue('workflow exceeds request/token budgets');
  if (requests === 0 || env.model_roles.some(r => !env.nodes.some(n => n.kind === 'agent' && n.role === r.key))) issue('workflow must execute its declared model roles');
});
export type AgentEnvironment = z.infer<typeof environmentSchema>;

export const workflowTestSchema = z.object({
  schema: z.literal(WORKFLOW_TEST_SCHEMA_ID), key, project_key: key, configuration_key: key,
  scope: z.literal('workflow'), harness: z.literal('declarative_workflow_v1'), runner_contract: z.literal(WORKFLOW_RUNNER_CONTRACT),
  environment_key: key, environment_digest: digest, fixture_kind: z.literal('public_inline'), fixture_license: z.string().max(100),
  profile: z.enum(['declarative', 'langgraph-docker/v0.1']).default('declarative'),
  cases: z.array(z.object({
    key, input: jsonValueSchema,
    assertions: z.array(z.object({ path: pointerSchema, equals: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]) }).strict()).min(1).max(20),
  }).strict()).min(1).max(20),
  sharing: z.object({ default: z.literal('local_only'), allow_public_fixture_case_ids: z.boolean() }).strict(),
}).strict().superRefine((test, ctx) => {
  if (new Set(test.cases.map(c => c.key)).size !== test.cases.length) ctx.addIssue({ code: 'custom', message: 'duplicate case key' });
});
export type WorkflowTest = z.infer<typeof workflowTestSchema>;
export function workflowDigests(test: WorkflowTest) {
  return {
    manifest_digest: digestOf(test), fixture_digest: digestOf(test.cases.map(c => ({ key: c.key, input: c.input }))),
    evaluator_digest: digestOf({ kind: 'workflow_json_assert_v1', assertions: test.cases.map(c => ({ key: c.key, assertions: c.assertions })) }),
  };
}
export function environmentFilePaths(env: AgentEnvironment): string[] { return [...env.prompts, ...env.data].map(f => f.path).concat(env.framework ? [env.framework.entry_path] : []); }
export function verifyEnvironmentFiles(env: AgentEnvironment, files: Map<string, string>): void {
  if (env.framework) {
    const source = files.get(env.framework.entry_path);
    if (source === undefined || !env.framework.entry_path.endsWith('.mjs') || Buffer.byteLength(source) > 65536 || digestOfBytes(source) !== env.framework.entry_digest) throw new Error('framework entry digest mismatch');
  }
  for (const f of [...env.prompts, ...env.data]) {
    const content = files.get(f.path);
    if (content === undefined || digestOfBytes(content) !== f.digest) throw new Error('environment file digest mismatch: ' + f.path);
    if (env.data.includes(f) && !boundedJson(JSON.parse(content))) throw new Error('invalid business data: ' + f.path);
    if (env.prompts.includes(f) && (content.length === 0 || content.length > 8000)) throw new Error('invalid prompt: ' + f.path);
  }
}
