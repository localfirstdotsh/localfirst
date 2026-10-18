import { z } from './validation';
export const approvalSchema = z.object({ approval_id: z.string(), expires_at: z.iso.datetime() }).passthrough();
export const decisionResponse = z.object({ data: z.object({ decision: z.enum(['approved', 'denied']), draft: z.object({ approval: approvalSchema.nullable() }) }) });
