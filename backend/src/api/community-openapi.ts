import { z } from 'zod';
import { collectionInputSchema, troubleshootingInputSchema, derivativeDraftInputSchema, verificationInputSchema } from '@localfirst/contracts';
import { independentVerificationEnabled, type AppConfig } from '../config.js';

export function communityPaths(config: AppConfig): Record<string, unknown> {
  if (!config.features.communityNetwork) return {};
  const paths: Record<string, any> = {};
  const operation = (summary: string, scope?: string, schema?: z.ZodType, parameters: any[] = []) => ({
    tags: ['community'], summary, parameters,
    ...(scope ? { security: [{ localfirstOAuth: [scope] }] } : {}),
    ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) } } } } : {}),
    responses: { [summary.startsWith('Human operator review') || summary.startsWith('Human operator revocation') ? '200' : schema ? '201' : '200']: { description: summary }, '400': { description: 'Invalid request' }, '404': { description: 'Unavailable or not accessible' }, '409': { description: 'Conflicting artifact or state' } },
  });
  const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
  const idem = { $ref: '#/components/parameters/IdempotencyKey' };
  const query = (name: string, schema: object, required = false) => ({ name, in: 'query', required, schema });
  paths['/api/v1/comparisons'] = { get: operation('Bounded public protocol groups, exclusions, intended variable and confounders', undefined, undefined, [query('project_version_id', { type: 'string', format: 'uuid' }, true), query('varies', { type: 'string', enum: ['model','hardware','runtime','settings'], default: 'model' }), query('metric', { type: 'string', enum: ['case_outcomes','latency_ms','time_to_first_token_ms','tokens_per_second','peak_memory_bytes','hardware_utilization'], default: 'case_outcomes' }), { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }]) };
  paths['/api/v1/projects/{project_id}/derivatives'] = { get: operation('Attributed immutable lineage; no inherited evidence', undefined, undefined, [id('project_id')]) };
  paths['/api/v1/projects/{project_id}/derivative-drafts'] = { post: operation('Private derivative draft; normal exact-artifact approval required', 'projects:draft', derivativeDraftInputSchema, [id('project_id'), idem]) };
  for (const [path, schema] of [['collections', collectionInputSchema], ['troubleshooting-notes', troubleshootingInputSchema]] as const) {
    paths[`/api/v1/${path}`] = { get: operation('Accepted public community contributions', undefined, undefined, [query('project_id', { type: 'string', format: 'uuid' }), { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }]), post: operation('Save a private immutable contribution; publish through contribution draft approval', 'community:write', schema, [idem]) };
    paths[`/api/v1/${path}/{record_id}`] = { get: operation('Public accepted contribution or own private record', undefined, undefined, [id('record_id')]) };
    paths[`/api/v1/${path}/{record_id}/withdraw`] = { post: { ...operation('Withdraw your own contribution', 'community:write', undefined, [id('record_id')]), responses: { '200': { description: 'Withdrawn' } } } };
  }
  for (const path of ['models','hardware']) paths[`/api/v1/${path}/{reference_id}/relationships`] = { get: operation('Current visible project references and scoped evidence', undefined, undefined, [id('reference_id')]) };
  paths['/api/v1/admin/community/{record_id}/review'] = { post: operation('Human operator review; curator cannot self-review', undefined, z.object({ decision: z.enum(['accepted','rejected']), reason: z.string().min(5).max(1000) }).strict(), [id('record_id')]) };
  if (independentVerificationEnabled(config.features)) {
    paths['/api/v1/verification-policy'] = { get: operation('Versioned independence policy and criteria') };
    paths['/api/v1/test-results/{report_id}/verifications'] = { get: operation('Active, revoked and ineligible independent provenance', undefined, undefined, [id('report_id')]) };
    paths['/api/v1/admin/independent-verifications'] = { post: operation('Human operator decision linking qualified independent runs', undefined, verificationInputSchema, [idem]) };
    paths['/api/v1/admin/independent-verifications/{verification_id}/revoke'] = { post: operation('Human operator revocation with audit and reaggregation', undefined, z.object({ reason: z.string().min(5).max(1000) }).strict(), [id('verification_id')]) };
  }
  return paths;
}
