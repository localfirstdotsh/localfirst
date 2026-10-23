import { z } from './validation';

/**
 * Response shapes the website relies on. Every API response is validated; a
 * mismatch is surfaced as a contract error rather than rendered from guesses
 * (FRONTEND_PRD section 16.3).
 */

export const usageSchema = z.object({
  spec_exports: z.number().int().nonnegative(),
  agent_retrievals: z.number().int().nonnegative(),
  since: z.string().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const projectSummarySchema = z.object({
  project_id: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  type: z.string(),
  categories: z.array(z.string()),
  spec_version: z.string(),
  license: z.object({ state: z.string(), id: z.string().nullable() }),
  test_support: z.object({ declared_kind: z.string(), runner_available: z.boolean() }),
  evidence_level: z.string(),
  listing_origin: z.string(),
  sources_pinned: z.boolean(),
  offline_declared: z.string(),
  runtime_families: z.array(z.string()),
  architectures: z.array(z.string()),
  operating_systems: z.array(z.string()),
  required_capabilities: z.array(z.string()),
  updated_at: z.string(),
  url: z.string(),
  usage: usageSchema.optional(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectPageSchema = z.object({
  items: z.array(projectSummarySchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ProjectPage = z.infer<typeof projectPageSchema>;

/** How a version was authorized: a person's exact approval, or a connection its owner lets publish without asking. */
export const publicationSchema = z.object({
  authorization: z.string(),
  via_client_name: z.string().nullable(),
  via_client_name_is_unverified: z.boolean(),
});
export type Publication = z.infer<typeof publicationSchema>;

export const versionSummarySchema = z.object({
  project_version_id: z.string(),
  version_number: z.number().int(),
  spec_version: z.string(),
  content_digest: z.string(),
  published_at: z.string(),
  publication: publicationSchema.optional(),
});
export type VersionSummary = z.infer<typeof versionSummarySchema>;

export const projectDetailSchema = projectSummarySchema.extend({
  visibility: z.string(),
  project_key: z.string(),
  manager: z.object({ handle: z.string().nullable() }),
  created_at: z.string(),
  current_version: versionSummarySchema.passthrough(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const slugResolutionSchema = z.object({ project_id: z.string(), slug: z.string(), url: z.string() });

export const facetsSchema = z
  .object({
    counts: z
      .object({
        published_projects: z.number(),
        published_versions: z.number(),
        connections_authorized: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type Facets = z.infer<typeof facetsSchema>;

export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, meta: z.object({ request_id: z.string() }).passthrough() });

export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).passthrough(),
  meta: z.object({ request_id: z.string() }).passthrough(),
});

export const versionListSchema = z.object({
  items: z.array(versionSummarySchema.extend({ is_current: z.boolean() })),
});
export type VersionList = z.infer<typeof versionListSchema>;

const sourceSchema = z
  .object({
    key: z.string(),
    kind: z.string(),
    url: z.string().nullable(),
    revision: z.string().nullable(),
    content_digest: z.string().nullable(),
    path: z.string().nullable(),
    pinned: z.boolean().nullable(),
    license_state: z.string().nullable(),
    license_id: z.string().nullable(),
  })
  .passthrough();

export const versionDetailSchema = versionSummarySchema.extend({
  project_id: z.string(),
  schema: z.string(),
  acknowledged_warning_codes: z.array(z.string()),
  markdown: z.string(),
  sources: z.array(sourceSchema),
  attribution: z.object({
    authors: z.array(
      z.object({ name: z.string(), url: z.string().nullable(), relationship: z.string() }).passthrough(),
    ),
    submitted_by: z.object({ handle: z.string().nullable() }).passthrough().nullable(),
    listing_origin: z.string(),
  }),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;
export type VersionSource = z.infer<typeof sourceSchema>;

export const assessmentSchema = z.object({
  project_id: z.string(),
  project_version_id: z.string(),
  outcome: z.string(),
  evidence_level: z.string(),
  evidence_scope: z.string(),
  checks: z.array(
    z.object({
      requirement: z.string(),
      status: z.string(),
      source: z.string(),
      detail: z.string().optional(),
    }),
  ),
  blockers: z.array(z.string()),
  uncertainties: z.array(z.string()),
  missing_prerequisites: z.array(z.string()),
});
export type Assessment = z.infer<typeof assessmentSchema>;

const referenceListMeta = z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() });

export const modelReferenceSchema = z.object({
  model_reference_id: z.string(),
  key: z.string(),
  display_name: z.string().nullable(),
  family: z.string().nullable(),
  source_url: z.string().nullable(),
  license_state: z.string(),
  license_id: z.string().nullable(),
  identity_scheme: z.string().nullable().optional(),
  project_count: z.number().int().nonnegative(),
});
export type ModelReference = z.infer<typeof modelReferenceSchema>;
export const modelListSchema = referenceListMeta.extend({ items: z.array(modelReferenceSchema) });

export const hardwareReferenceSchema = z.object({
  hardware_descriptor_id: z.string(),
  key: z.string(),
  display_name: z.string().nullable(),
  platform: z.string().nullable(),
  cpu_architecture: z.string().nullable(),
  accelerator: z.string().nullable(),
  memory_bytes: z.number().nullable(),
  vram_bytes: z.number().nullable(),
  unified_memory: z.boolean().nullable(),
  docs_url: z.string().nullable(),
  project_count: z.number().int().nonnegative(),
});
export type HardwareReference = z.infer<typeof hardwareReferenceSchema>;
export const hardwareListSchema = referenceListMeta.extend({ items: z.array(hardwareReferenceSchema) });
