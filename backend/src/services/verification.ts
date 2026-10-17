import { and, eq, inArray, sql } from 'drizzle-orm';
import { digestOf, INDEPENDENCE_POLICY_VERSION, verificationInputSchema, type VerificationInput } from '@localfirst/contracts';
import { independentVerifications } from '../db/schema/community.js';
import { projects, attributions } from '../db/schema/registry.js';
import { db, type DbOrTx } from '../db/client.js';
import { isOperator, type Actor } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { requireFeature } from '../api/v1/body.js';
import { comparePublicRuns } from '../domain/public-comparison.js';
import { loadPublicRun } from './comparisons.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claimDigest(a: NonNullable<Awaited<ReturnType<typeof loadPublicRun>>>, b: NonNullable<Awaited<ReturnType<typeof loadPublicRun>>>) {
  return digestOf({ policy: INDEPENDENCE_POLICY_VERSION, original: { id: a.reportId, report: a.report, build: a.build }, reproduction: { id: b.reportId, report: b.report, build: b.build } });
}
async function eligiblePair(originalId: string, reproductionId: string, reviewerId: string, conn: DbOrTx, lock = false) {
  // Consistent row lock order, shared with withdrawals and report review.
  const ids = [originalId, reproductionId].sort();
  const runs = new Map<string, NonNullable<Awaited<ReturnType<typeof loadPublicRun>>>>();
  for (const id of ids) { const run = await loadPublicRun(id, conn, lock); if (run) runs.set(id, run); }
  const a = runs.get(originalId), b = runs.get(reproductionId);
  if (!a || !b || a.report.scope !== 'component' || b.report.scope !== 'component') return null;
  const pair = comparePublicRuns(a, b, { varies: 'model', metric: 'case_outcomes' });
  if (!pair.eligible || pair.varies.length || pair.confounders.length || a.report.outcome !== b.report.outcome || digestOf(a.report.counts) !== digestOf(b.report.counts)) return null;
  if (a.submitterId === b.submitterId || [a.submitterId, b.submitterId].includes(reviewerId)) return null;
  const [project] = await conn.select().from(projects).where(eq(projects.id, a.report.project_id));
  if (!project || [b.submitterId, reviewerId].includes(project.managerUserId)) return null;
  const authors = await conn.select({ userId: attributions.userId }).from(attributions).where(and(eq(attributions.projectVersionId, a.report.project_version_id), eq(attributions.role, 'author')));
  if (authors.some(author => author.userId === b.submitterId || author.userId === reviewerId)) return null;
  return { a, b, digest: claimDigest(a, b), projectId: project.id };
}
export async function createIndependentVerification(actor: Actor, body: unknown) {
  requireFeature('independentVerification');
  if (!isOperator(actor) || actor.kind !== 'session') throw ApiError.forbidden('Independent verification requires a human operator session.');
  const parsed = verificationInputSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('Invalid verification criteria/provenance.', { issues: parsed.error.issues });
  const input: VerificationInput = parsed.data;
  if (input.independence.conflicts.length) throw ApiError.forbidden('Disclosed conflicts prevent an independent claim under this policy.');
  return db().transaction(async tx => {
    // Serialize pairs with shared claims; repeat retries find the existing decision.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verification:${input.original_report_id}`}, 0))`);
    const pair = await eligiblePair(input.original_report_id, input.reproduction_report_id, actor.userId, tx, true);
    if (!pair) throw ApiError.conflict('PUBLICATION_BLOCKED', 'Verification needs separate independent accepted runs of the exact complete public protocol, identity and outcome.');
    const [existing] = await tx.select().from(independentVerifications).where(and(eq(independentVerifications.originalReportId, input.original_report_id), eq(independentVerifications.reproductionReportId, input.reproduction_report_id)));
    if (existing) throw ApiError.conflict('DUPLICATE_CONTENT', 'This pair already has a verification decision; revoked decisions cannot be resurrected.');
    const [row] = await tx.insert(independentVerifications).values({ originalReportId: input.original_report_id, reproductionReportId: input.reproduction_report_id, reviewerUserId: actor.userId, policyVersion: input.policy_version, provenance: input, claimDigest: pair.digest }).returning();
    if (!row) throw ApiError.internal();
    await writeAudit(tx, actor, { action: 'verification.accepted', targetKind: 'independent_verification', targetId: row.id, policyVersion: input.policy_version, metadata: { original_report_id: input.original_report_id, reproduction_report_id: input.reproduction_report_id, claim_digest: pair.digest } });
    await emitEvent(tx, { eventType: 'evidence.changed', aggregateKind: 'project', aggregateId: pair.projectId, payload: { cause: 'verification.accepted', verification_id: row.id } });
    return { verification_id: row.id, state: 'active', evidence_level: 'independently_verified', scope: 'component', claim_kind: 'component_case_outcomes', metric_verification: false, policy_version: input.policy_version, claim_digest: pair.digest };
  });
}
/** Live qualification removes withdrawn/rejected/quarantined evidence immediately. */
export async function activeVerifications(reportIds: string[], conn: DbOrTx = db()) {
  if (!reportIds.length) return [];
  const rows = await conn.select().from(independentVerifications).where(and(eq(independentVerifications.state, 'active'), inArray(independentVerifications.originalReportId, reportIds)));
  const qualified = [];
  for (const row of rows) {
    const pair = await eligiblePair(row.originalReportId, row.reproductionReportId, row.reviewerUserId, conn);
    if (pair && pair.digest === row.claimDigest) qualified.push({ ...row, independentContributorId: pair.b.submitterId });
  }
  return qualified;
}
export async function verificationHistory(reportId: string) {
  requireFeature('independentVerification');
  if (!UUID.test(reportId)) throw ApiError.notFound();
  const run = await loadPublicRun(reportId);
  if (!run) throw ApiError.notFound();
  if (run.report.scope === 'workflow') return { report_id: reportId, scope: 'workflow', claim_kind: 'workflow_verification_not_supported', metric_verification: false, distinct_verifiers: 0, items: [] };
  const all = await db().select().from(independentVerifications).where(eq(independentVerifications.originalReportId, reportId));
  const eligible = await activeVerifications([reportId]);
  const active = new Set(eligible.map(v => v.id));
  return { report_id: reportId, scope: 'component', claim_kind: 'component_case_outcomes', metric_verification: false, distinct_verifiers: new Set(eligible.map(v => v.independentContributorId)).size, items: all.map(v => ({ verification_id: v.id, reproduction_report_id: v.reproductionReportId, reviewer_user_id: v.reviewerUserId, policy_version: v.policyVersion, claim_digest: v.claimDigest, provenance: v.provenance, state: v.state === 'revoked' ? 'revoked' : active.has(v.id) ? 'active' : 'ineligible', revoked_reason: v.revokedReason, created_at: v.createdAt.toISOString() })) };
}
export async function revokeVerification(actor: Actor, id: string, reason: string) {
  requireFeature('independentVerification');
  if (!isOperator(actor) || actor.kind !== 'session') throw ApiError.forbidden('Verification revocation requires a human operator.');
  return db().transaction(async tx => {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [row] = await tx.select().from(independentVerifications).where(eq(independentVerifications.id, id)).for('update');
    if (!row) throw ApiError.notFound();
    // A revocation is final: a second one must not rewrite the recorded reason.
    if (row.state === 'revoked') throw ApiError.conflict('VERIFICATION_ALREADY_REVOKED', 'This verification is already revoked.');
    await tx.update(independentVerifications).set({ state: 'revoked', revokedReason: reason }).where(eq(independentVerifications.id, id));
    await writeAudit(tx, actor, { action: 'verification.revoked', targetKind: 'independent_verification', targetId: id, reason, policyVersion: row.policyVersion });
    const run = await loadPublicRun(row.originalReportId, tx);
    if (run) await emitEvent(tx, { eventType: 'evidence.changed', aggregateKind: 'project', aggregateId: run.report.project_id, payload: { cause: 'verification.revoked', verification_id: id } });
    return { verification_id: id, state: 'revoked' };
  });
}
