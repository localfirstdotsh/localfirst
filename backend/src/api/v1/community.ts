import { Hono } from 'hono';
import { z } from 'zod';
import { collectionInputSchema, troubleshootingInputSchema, derivativeDraftInputSchema, verificationInputSchema, INDEPENDENCE_POLICY_VERSION } from '@localfirst/contracts';
import type { AppEnv } from '../../http/context.js';
import { requireHuman, requireOperator, requireScope } from '../../auth/guards.js';
import { success } from '../../http/middleware.js';
import { parseJson, requireFeature } from './body.js';
import { limitPublicRead, consumeSubmissionQuota, limitDraftCreation } from './limits.js';
import { requireIdempotencyKey, withIdempotency } from '../../services/idempotency.js';
import { createDerivativeDraft, derivativeView } from '../../services/derivatives.js';
import { publicComparisons } from '../../services/comparisons.js';
import { referenceRelationships } from '../../services/relationships.js';
import { listCommunity, readableCommunityRecord, reviewCommunity, saveCommunityRecord, withdrawCommunity } from '../../services/community.js';
import { createIndependentVerification, revokeVerification, verificationHistory } from '../../services/verification.js';

export const communityRoutes = new Hono<AppEnv>();
communityRoutes.get('/comparisons', async c => {
  requireFeature('communityNetwork'); await limitPublicRead(c);
  return c.json(success(await publicComparisons(c.req.query()), c.get('requestId')));
});
communityRoutes.get('/verification-policy', async c => {
  requireFeature('independentVerification'); await limitPublicRead(c);
  return c.json(success({ policy_version: INDEPENDENCE_POLICY_VERSION, scope: 'component', criteria: ['Separate human-authorized accepted public reproducible runs, with complete public artifact, runtime, hardware and protocol identity.', 'Reproduction submitter and reviewer must be distinct from the original submitter and project manager/authors.', 'Human operator reviews procedure, external evidence and conflict disclosures; disclosed conflicts block qualification.', 'All comparison dimensions, protocol, counts and outcome must match. Failed claims can be independently reproduced without asserting success.', 'Withdrawal, rejection, quarantine, drift or revocation removes active qualification.'], limitations: ['Author aliases and external affiliations require human review; account IDs alone cannot prove independence.', 'No hosted execution or offline/full-project guarantee.'] }, c.get('requestId')));
});
communityRoutes.get('/projects/:project_id/derivatives', async c => {
  requireFeature('communityNetwork'); await limitPublicRead(c);
  return c.json(success(await derivativeView(c.req.param('project_id'), c.req.query()), c.get('requestId')));
});
communityRoutes.post('/projects/:project_id/derivative-drafts', requireScope('projects:draft'), async c => {
  requireFeature('communityNetwork');
  const body = await parseJson(c, derivativeDraftInputSchema), actor = c.get('actor');
  const id = c.req.param('project_id');
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  await limitDraftCreation(c);
  const result = await withIdempotency({ actor, operation: 'derivative.draft', targetKey: id, key, request: body }, async () => ({ status: 201, body: await createDerivativeDraft(actor, id, body) }));
  return c.json(success(result.body, c.get('requestId')), result.status as 201);
});
for (const [path, kind] of [['collections', 'collection'], ['troubleshooting-notes', 'troubleshooting']] as const) {
  communityRoutes.get(`/${path}`, async c => {
    requireFeature('communityNetwork'); await limitPublicRead(c);
    return c.json(success(await listCommunity(kind, c.req.query()), c.get('requestId')));
  });
  communityRoutes.get(`/${path}/:record_id`, async c => {
    requireFeature('communityNetwork'); await limitPublicRead(c);
    return c.json(success(await readableCommunityRecord(c.get('actor'), c.req.param('record_id')), c.get('requestId')));
  });
  communityRoutes.post(`/${path}`, requireScope('community:write'), async c => {
    requireFeature('communityNetwork');
    const body = kind === 'collection' ? await parseJson(c, collectionInputSchema) : await parseJson(c, troubleshootingInputSchema);
    const actor = c.get('actor');
    const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
    await consumeSubmissionQuota(actor);
    const result = await withIdempotency({ actor, operation: `${kind}.save`, key, request: body }, async () => ({ status: 201, body: await saveCommunityRecord(actor, kind, body) }));
    return c.json(success(result.body, c.get('requestId')), result.status as 201);
  });
  communityRoutes.post(`/${path}/:record_id/withdraw`, requireScope('community:write'), async c => c.json(success(await withdrawCommunity(c.get('actor'), c.req.param('record_id')), c.get('requestId'))));
}
for (const kind of ['model', 'hardware'] as const) {
  communityRoutes.get(`/${kind === 'model' ? 'models' : 'hardware'}/:reference_id/relationships`, async c => {
    requireFeature('communityNetwork'); await limitPublicRead(c);
    return c.json(success(await referenceRelationships(kind, c.req.param('reference_id'), c.req.query()), c.get('requestId')));
  });
}
communityRoutes.get('/test-results/:report_id/verifications', async c => {
  requireFeature('independentVerification'); await limitPublicRead(c);
  return c.json(success(await verificationHistory(c.req.param('report_id')), c.get('requestId')));
});
communityRoutes.post('/admin/independent-verifications', requireOperator(), requireHuman(), async c => {
  requireFeature('independentVerification');
  const body = await parseJson(c, verificationInputSchema);
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'));
  const actor = c.get('actor');
  const result = await withIdempotency({ actor, operation: 'verification.create', key, request: body }, async () => ({ status: 201, body: await createIndependentVerification(actor, body) }));
  return c.json(success(result.body, c.get('requestId')), result.status as 201);
});
const reasonSchema = z.object({ reason: z.string().min(5).max(1000) }).strict();
communityRoutes.post('/admin/independent-verifications/:verification_id/revoke', requireOperator(), requireHuman(), async c => {
  const { reason } = await parseJson(c, reasonSchema);
  return c.json(success(await revokeVerification(c.get('actor'), c.req.param('verification_id'), reason), c.get('requestId')));
});
communityRoutes.post('/admin/community/:record_id/review', requireOperator(), requireHuman(), async c => {
  const body = await parseJson(c, reasonSchema.extend({ decision: z.enum(['accepted', 'rejected']) }).strict());
  return c.json(success(await reviewCommunity(c.get('actor'), c.req.param('record_id'), body.decision, body.reason), c.get('requestId')));
});
