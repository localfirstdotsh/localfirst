/**
 * Operator routes (BACKEND_PRD section 12.3).
 *
 * Operators hold administratively assigned roles. Every decision is audited
 * with actor, target, reason, and policy version.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { success } from '../../http/middleware.js';
import { requireOperator } from '../../auth/guards.js';
import {
  moderateProject,
  operatorProjectView,
  reviewClaimRequest,
  reviewQueue,
  searchAuditEvents,
} from '../../services/moderation.js';
import { requeueOperation } from '../../services/operations.js';
import { writeAudit } from '../../services/audit.js';
import { db } from '../../db/client.js';
import { REVIEW_REASON_CODES, reviewReport } from '../../services/reports.js';
import { manualReportOf } from '../../services/builds.js';
import { requireFeature } from './body.js';

async function parseJson<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest('The request body is not valid.', {
      issues: parsed.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireOperator('moderator'));

adminRoutes.get('/reviews', async (c) => {
  const kindRaw = c.req.query('kind') ?? 'all';
  if (!['claims', 'quarantined', 'evidence', 'community', 'all'].includes(kindRaw)) {
    throw ApiError.badRequest('`kind` must be one of claims, quarantined, evidence, community, all.');
  }
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw ApiError.badRequest('limit must be an integer between 1 and 100.');
  }
  const queue = await reviewQueue({ kind: kindRaw as 'claims' | 'quarantined' | 'evidence' | 'community' | 'all', limit });
  return c.json(success(queue, c.get('requestId')));
});

adminRoutes.get('/projects/:project_id', async (c) => {
  return c.json(success(await operatorProjectView(c.req.param('project_id')), c.get('requestId')));
});

const moderationSchema = z
  .object({
    action: z.enum(['quarantine', 'restore']),
    reason: z.string().min(5).max(1000),
  })
  .strict();

adminRoutes.post('/projects/:project_id/moderation', async (c) => {
  const body = await parseJson(c, moderationSchema);
  const result = await moderateProject({
    actor: c.get('actor'),
    projectId: c.req.param('project_id'),
    action: body.action,
    reason: body.reason,
  });
  return c.json(success(result, c.get('requestId')));
});

const claimReviewSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    reason: z.string().min(5).max(1000),
    /** Management transfer is explicit, never implied by acceptance. */
    transfer_management: z.boolean().default(false),
  })
  .strict();

adminRoutes.post('/claim-requests/:claim_id/review', async (c) => {
  const body = await parseJson(c, claimReviewSchema);
  const result = await reviewClaimRequest({
    actor: c.get('actor'),
    claimId: c.req.param('claim_id'),
    decision: body.decision,
    reason: body.reason,
    transferManagement: body.transfer_management,
  });
  return c.json(success(result, c.get('requestId')));
});

adminRoutes.post('/operations/:operation_id/retry', async (c) => {
  const operationId = c.req.param('operation_id');
  const requeued = await requeueOperation(operationId);
  if (!requeued) {
    throw ApiError.conflict(
      'INVALID_LIFECYCLE',
      'Only a failed operation can be retried.',
      { operation_id: operationId },
    );
  }
  await writeAudit(db(), c.get('actor'), {
    action: 'operation.retried',
    targetKind: 'operation',
    targetId: operationId,
  });
  return c.json(success({ operation_id: operationId, state: 'queued' }, c.get('requestId')));
});

adminRoutes.get('/audit-events', async (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw ApiError.badRequest('limit must be an integer between 1 and 200.');
  }
  const since = c.req.query('since') ? new Date(c.req.query('since') as string) : undefined;
  const until = c.req.query('until') ? new Date(c.req.query('until') as string) : undefined;
  if ((since && Number.isNaN(since.getTime())) || (until && Number.isNaN(until.getTime()))) {
    throw ApiError.badRequest('`since` and `until` must be RFC 3339 timestamps.');
  }
  const events = await searchAuditEvents({
    action: c.req.query('action'),
    targetId: c.req.query('target_id'),
    since,
    until,
    limit,
  });
  return c.json(
    success({ items: events, has_more: false, next_cursor: null }, c.get('requestId')),
  );
});

/**
 * Evidence review (BACKEND_PRD sections 9.1, 17.4). An operator accepts or
 * rejects a *published* report; the evidence level an accepted report gets is
 * derived by the server from its own checks and cannot be chosen here. A
 * reviewer cannot review their own report.
 */
const evidenceReviewSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    reason_code: z.enum(REVIEW_REASON_CODES),
    note: z.string().min(1).max(1000).nullable().default(null),
  })
  .strict();

async function decide(c: Context<AppEnv>, reportId: string) {
  requireFeature('evidenceClassification');
  const body = await parseJson(c, evidenceReviewSchema);
  const result = await reviewReport({
    actor: c.get('actor'),
    reportId,
    decision: body.decision,
    reasonCode: body.reason_code,
    note: body.note,
  });
  return c.json(
    success(
      {
        report_id: result.report.id,
        review_state: result.report.reviewState,
        evidence_level: result.evidenceLevel,
        reaggregation: 'scheduled',
      },
      c.get('requestId'),
    ),
  );
}

adminRoutes.post('/test-results/:result_id/review', (c) => decide(c, c.req.param('result_id')));

/** The manual report attached to a build is reviewed through its build. */
adminRoutes.post('/builds/:build_id/report-review', async (c) => {
  const report = await manualReportOf(c.req.param('build_id'));
  if (!report) throw ApiError.notFound();
  return decide(c, report.id);
});
