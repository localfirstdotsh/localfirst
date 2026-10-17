import { z } from 'zod';

export const COMMUNITY_SCHEMA_ID = 'localfirst/community/v0.1' as const;
export const INDEPENDENCE_POLICY_VERSION = 'localfirst/independence/v0.1' as const;
export const comparisonQuerySchema = z.object({
  project_version_id: z.uuid(),
  varies: z.enum(['model', 'runtime', 'hardware', 'settings']).default('model'),
  metric: z.enum(['case_outcomes', 'latency_ms', 'time_to_first_token_ms', 'tokens_per_second', 'peak_memory_bytes', 'hardware_utilization']).default('case_outcomes'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
}).strict();
export type ComparisonQuery = z.infer<typeof comparisonQuerySchema>;
const reference = z.object({ project_id: z.uuid(), project_version_id: z.uuid(), note: z.string().max(500).default('') }).strict();
const source = z.object({ name: z.string().min(1).max(200), url: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; }) }).strict();
export const collectionInputSchema = z.object({
  schema: z.literal(COMMUNITY_SCHEMA_ID),
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(2000),
  entries: z.array(reference).min(1).max(50),
  sources: z.array(source).max(20).default([]),
  license: z.string().min(1).max(100),
}).strict().refine(v => new Set(v.entries.map(e => e.project_version_id)).size === v.entries.length, 'collection entries must be unique');
export const troubleshootingInputSchema = z.object({
  schema: z.literal(COMMUNITY_SCHEMA_ID),
  project_id: z.uuid(), project_version_id: z.uuid(),
  title: z.string().min(3).max(120),
  symptom: z.string().min(5).max(2000),
  resolution: z.string().min(5).max(4000),
  limitations: z.string().min(5).max(1000),
  sources: z.array(source).min(1).max(20),
  license: z.string().min(1).max(100),
  supersedes_id: z.uuid().nullable().default(null),
}).strict();
export const verificationInputSchema = z.object({
  original_report_id: z.uuid(), reproduction_report_id: z.uuid(),
  policy_version: z.literal(INDEPENDENCE_POLICY_VERSION),
  procedure: z.string().min(20).max(2000),
  evidence_url: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; }),
  independence: z.object({
    author_independent: z.literal(true), submitter_independent: z.literal(true),
    reviewer_independent: z.literal(true), conflicts_disclosed: z.literal(true),
    conflicts: z.array(z.string().min(5).max(500)).max(10),
  }).strict(),
  criteria: z.object({
    authorized_run: z.literal(true), identity_complete: z.literal(true),
    repeat_procedure_followed: z.literal(true), hardware_software_coverage: z.literal(true),
  }).strict(),
}).strict().refine(v => v.original_report_id !== v.reproduction_report_id, 'a reproduction must be a separate report');
export type VerificationInput = z.infer<typeof verificationInputSchema>;
export const derivativeDraftInputSchema = z.object({
  parent_version_id: z.uuid(),
  change_summary: z.string().min(5).max(1000),
  project_md: z.string().max(256 * 1024),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(512 * 1024) }).strict()).max(20).default([]),
}).strict();
