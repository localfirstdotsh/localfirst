import { z } from './validation';
import { projectSpecSchema, environmentSchema } from '@localfirst/contracts';
import { usageSchema } from './schemas';
import { approvalSchema } from './approval-response';

export const browserConfigSchema = z.object({
  auth_base_path: z.string().startsWith('/'), sign_in_enabled: z.boolean(), resource: z.string(),
  scope_descriptions: z.record(z.string(), z.string()),
});
export const clientIdentitySchema = z.object({
  kind: z.enum(['local', 'recognized', 'unrecognized']), label: z.string().nullable(), destinations: z.array(z.string()), claims_to_be: z.string().nullable(),
});
export type ClientIdentity = z.infer<typeof clientIdentitySchema>;
export const consentSchema = browserConfigSchema.extend({ client_id: z.string(), client_name: z.string().nullable(), app: clientIdentitySchema.nullable(), scopes: z.array(z.string()) });
export type ConsentData = z.infer<typeof consentSchema>;
export const connectionSchema = z.object({ connection_id: z.string(), client_id: z.string(), client_name: z.string().nullable(), scopes: z.array(z.string()), created_at: z.string().nullable(), updated_at: z.string().nullable() });
export const connectionsSchema = browserConfigSchema.extend({ items: z.array(connectionSchema) });
export type ConnectionsData = z.infer<typeof connectionsSchema>;
export const ownedProjectSchema = z.object({ project_id: z.string(), slug: z.string(), name: z.string(), visibility: z.string(), usage: usageSchema });
export type OwnedProject = z.infer<typeof ownedProjectSchema>;
export const ownedProjectsSchema = z.object({ items: z.array(ownedProjectSchema) });
export const usageDaySchema = z.object({ day: z.string(), spec_exports: z.number().nonnegative(), agent_retrievals: z.number().nonnegative() });
export const ownedUsageSchema = z.object({ project: ownedProjectSchema, range: z.union([z.literal(30), z.literal(90)]), days: z.array(usageDaySchema) });
export type OwnedUsage = z.infer<typeof ownedUsageSchema>;
export const deviceSchema = z.object({ device_id: z.string(), label: z.string(), created_at: z.string(), expires_at: z.string(), last_used_at: z.string().nullable() });
export const devicesSchema = z.object({ link: z.object({ client_label: z.string(), user_code: z.string() }).nullable(), devices: z.array(deviceSchema) });
export type DevicesData = z.infer<typeof devicesSchema>;
export const deletionPreviewSchema = z.object({ handle: z.string(), managed_projects: z.array(z.object({ slug: z.string() })) });
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;

export const draftReviewSchema = z.object({
  draft: z.object({ draft_id: z.string(), kind: z.string(), state: z.string(), revision: z.number().int(), payload_digest: z.string(), approval: approvalSchema.nullable() }).passthrough(),
  review: z.object({ content: z.string(), contentLabel: z.string(), contentDigest: z.string().nullable(), slug: z.string().nullable(), stale: z.boolean(), issues: z.array(z.object({ code: z.string(), message: z.string(), severity: z.string() })), warningCodes: z.array(z.string()), spec: projectSpecSchema.nullable(), environments: z.array(environmentSchema).optional(), projection: z.record(z.string(), z.unknown()).nullable(), source: projectSpecSchema.nullable() }),
  status: z.enum(['published', 'discarded', 'approved', 'denied', 'expired', 'changed', 'review']),
  published: z.object({ slug: z.string(), version_number: z.number() }).nullable(),
  blocked: z.boolean(), decision_allowed: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })), approval_window_seconds: z.number(),
  profiles: z.object({ declarative: z.boolean(), framework: z.boolean() }),
});
export type DraftReview = z.infer<typeof draftReviewSchema>;
