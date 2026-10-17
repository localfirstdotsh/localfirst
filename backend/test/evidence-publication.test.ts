/**
 * Exact-artifact publication, review, and evidence levels for builds and
 * results (BACKEND_PRD sections 9.1, 10.4, 14.2).
 */

import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { buildConfigurations, evidenceReviews, runReports } from '../src/db/schema/evidence.js';
import { publicationApprovals } from '../src/db/schema/registry.js';
import { createAccount, request } from './factories.js';
import {
  api,
  buildFor,
  drainWorker,
  failingResultFor,
  key,
  publishEvidenceProject,
  publishRecords,
  resultFor,
  runId,
  submitThroughApi,
} from './evidence-fixtures.js';

async function createDraft(account: Awaited<ReturnType<typeof createAccount>>, kind: string, recordId: string, selection?: unknown) {
  return api(account, '/api/v1/drafts', {
    method: 'POST',
    body: { kind, record_id: recordId, ...(selection === undefined ? {} : { selection }) },
    key: key('draft'),
  });
}

async function approve(account: Awaited<ReturnType<typeof createAccount>>, draft: { draft_id: string; revision: number; payload_digest: string; warning_codes: string[] }) {
  return api(account, `/api/v1/drafts/${draft.draft_id}/approval`, {
    method: 'POST',
    body: {
      draft_revision: draft.revision,
      payload_digest: draft.payload_digest,
      acknowledged_warning_codes: draft.warning_codes,
      decision: 'approved',
    },
  });
}

async function setup() {
  const project = await publishEvidenceProject(await createAccount());
  const contributor = await createAccount();
  const { buildId, reportId } = await submitThroughApi(contributor, project);
  return { project, contributor, buildId, reportId };
}

describe('build and result drafts', () => {
  it('creates a draft that references your private record and previews the exact projection', async () => {
    const { contributor, buildId } = await setup();
    const created = await createDraft(contributor, 'build', buildId);
    expect(created.status).toBe(201);
    const draft = created.json.data;
    expect(draft.kind).toBe('build');
    expect(draft.record).toMatchObject({ record_id: buildId });
    expect(draft.ready_for_review).toBe(true);
    // The conservative default shares no hardware, and says so.
    expect(draft.warning_codes).toContain('hardware_not_shared');
    expect(draft.manifest.hardware).toBeNull();
    expect(draft.review_url).toContain(`/review/drafts/${draft.draft_id}`);
  });

  it('refuses a draft for a record you do not own, with a 404', async () => {
    const { buildId, reportId } = await setup();
    const stranger = await createAccount();
    expect((await createDraft(stranger, 'build', buildId)).status).toBe(404);
    expect((await createDraft(stranger, 'test_result', reportId)).status).toBe(404);
  });

  it('requires the kind-specific write scope and never accepts read scopes', async () => {
    const { contributor, buildId, reportId } = await setup();
    const asToken = (scopes: string[]) => ({ token: true as const, scopes });
    const noWrite = await api(contributor, '/api/v1/drafts', {
      method: 'POST', body: { kind: 'build', record_id: buildId }, key: key(), ...asToken(['projects:read', 'projects:draft']),
    });
    expect(noWrite.status).toBe(403);
    expect(noWrite.json.error.details.required_scopes).toEqual(['builds:write']);
    const wrongKind = await api(contributor, '/api/v1/drafts', {
      method: 'POST', body: { kind: 'test_result', record_id: reportId }, key: key(), ...asToken(['builds:write']),
    });
    expect(wrongKind.status).toBe(403);
    expect(wrongKind.json.error.details.required_scopes).toEqual(['tests:submit']);
    const ok = await api(contributor, '/api/v1/drafts', {
      method: 'POST', body: { kind: 'build', record_id: buildId }, key: key(), ...asToken(['builds:write']),
    });
    expect(ok.status).toBe(201);
    // A build-only token cannot read a result draft either.
    const resultDraft = await createDraft(contributor, 'test_result', reportId);
    const readOther = await api(contributor, `/api/v1/drafts/${resultDraft.json.data.draft_id}`, {
      token: true,
      scopes: ['builds:write'],
    });
    expect(readOther.status).toBe(403);
    expect(readOther.json.error.details.required_scopes).toEqual(['tests:submit']);
  });

  it('needs the build public before its result can be published', async () => {
    const { contributor, reportId } = await setup();
    const draft = await createDraft(contributor, 'test_result', reportId);
    expect(draft.status).toBe(201);
    expect(draft.json.data.ready_for_review).toBe(false);
    expect(JSON.stringify(draft.json.data.issues)).toContain('build_not_published');
    const approval = await approve(contributor, draft.json.data);
    expect(approval.status).toBe(422);
  });

  it('requires a validated result', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const saved = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    const buildId = saved.json.data.build_id;
    const submitted = await api(contributor, '/api/v1/test-results', {
      method: 'POST', body: { result: resultFor(project, buildId), build_id: buildId }, key: key(),
    });
    // Validation has not run yet.
    const early = await createDraft(contributor, 'test_result', submitted.json.data.report_id);
    expect(JSON.stringify(early.json.data.issues)).toContain('report_not_validated');
    expect(early.json.data.ready_for_review).toBe(false);
  });
});

describe('exact-artifact approval and publication', () => {
  it('publishes the approved projection once, leaving it public but pending with no evidence level', async () => {
    const { contributor, buildId, project } = await setup();
    const created = await createDraft(contributor, 'build', buildId, { hardware: 'coarse' });
    const draft = created.json.data;
    expect(draft.manifest.hardware.memory_bytes).toBe(17179869184);
    const approved = await approve(contributor, draft);
    expect(approved.status).toBe(201);

    const published = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST',
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
      key: key(),
    });
    expect(published.status).toBe(201);
    expect(published.json.data).toMatchObject({ kind: 'build', visibility: 'public', review_state: 'pending', evidence_level: null });

    const anonymous = await request(`/api/v1/builds/${buildId}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.json.data.visibility).toBe('public');
    expect(anonymous.json.data.public_projection_digest).toBe(draft.payload_digest);
    expect(anonymous.json.data.submitted_by.handle).toBe(contributor.handle);
    // The public view is the approved projection only.
    expect(anonymous.json.data.build).toBeUndefined();
    expect(JSON.stringify(anonymous.json.data)).not.toContain('Example chip');

    const listing = await request(`/api/v1/projects/${project.published.projectId}/builds`);
    expect(listing.json.data.items.map((item: { build_id: string }) => item.build_id)).toEqual([buildId]);

    // The approval is single use.
    const replay = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST',
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
      key: key(),
    });
    expect(replay.status).toBe(409);
  });

  it('invalidates the approval when the selection, and so the projection, changes', async () => {
    const { contributor, buildId } = await setup();
    const created = await createDraft(contributor, 'build', buildId, { hardware: 'none' });
    const draft = created.json.data;
    const approved = await approve(contributor, draft);
    expect(approved.status).toBe(201);

    const patched = await api(contributor, `/api/v1/drafts/${draft.draft_id}`, {
      method: 'PATCH',
      body: { selection: { hardware: 'coarse' } },
      headers: { 'if-match': draft.etag },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.data.revision).toBe(draft.revision + 1);
    expect(patched.json.data.payload_digest).not.toBe(draft.payload_digest);
    expect(patched.json.data.approval).toBeNull();

    const stale = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST',
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
      key: key(),
    });
    expect(stale.status).toBe(409);
    const [build] = await db().select().from(buildConfigurations).where(eq(buildConfigurations.id, buildId));
    expect(build?.visibility).toBe('private');
  });

  it('each distinct selection yields a distinct digest, including redaction and hardware detail', async () => {
    const { contributor, buildId } = await setup();
    const digests = new Set<string>();
    for (const selection of [
      {},
      { hardware: 'coarse' },
      { model_source_url: false },
      { model_alias: false },
      { manual_report: false },
    ]) {
      const created = await createDraft(contributor, 'build', buildId, selection);
      expect(created.status).toBe(201);
      digests.add(created.json.data.payload_digest);
    }
    expect(digests.size).toBe(5);
    const bad = await createDraft(contributor, 'build', buildId, { hardware: 'everything' });
    expect(bad.json.data.ready_for_review).toBe(false);
  });

  it('requires every warning to be acknowledged and a human session to approve', async () => {
    const { contributor, buildId } = await setup();
    const draft = (await createDraft(contributor, 'build', buildId)).json.data;
    const unacknowledged = await api(contributor, `/api/v1/drafts/${draft.draft_id}/approval`, {
      method: 'POST',
      body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: [], decision: 'approved' },
    });
    expect(unacknowledged.status).toBe(409);
    const asToken = await api(contributor, `/api/v1/drafts/${draft.draft_id}/approval`, {
      method: 'POST',
      token: true,
      body: { draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes, decision: 'approved' },
    });
    expect(asToken.status).toBe(403);
  });

  it('publishes a result only after its build, and rechecks everything inside the transaction', async () => {
    const { contributor, buildId, reportId } = await setup();
    await publishRecords(contributor, buildId, reportId);
    const [build] = await db().select().from(buildConfigurations).where(eq(buildConfigurations.id, buildId));
    const [report] = await db().select().from(runReports).where(eq(runReports.id, reportId));
    expect(build?.visibility).toBe('public');
    expect(report).toMatchObject({ visibility: 'public', reviewState: 'pending', evidenceLevel: null });

    const view = await request(`/api/v1/test-results/${reportId}`);
    expect(view.json.data).toMatchObject({ review_state: 'pending', evidence_level: null, visibility: 'public' });
    expect(view.json.data.evidence_note).toContain('Pending review');
    // The default listing is accepted-only, so a pending report is not shown...
    const accepted = await request(`/api/v1/projects/${report!.projectId}/test-results`);
    expect(accepted.json.data.items).toEqual([]);
    // ...but it can be requested with its state labelled.
    const pending = await request(`/api/v1/projects/${report!.projectId}/test-results?review_state=pending`);
    expect(pending.json.data.items).toHaveLength(1);
    expect(pending.json.data.items[0].review_state).toBe('pending');
  });

  it('shares only counts when the owner declines per-case results', async () => {
    const { contributor, buildId, reportId } = await setup();
    await publishRecords(contributor, buildId, reportId, { result: { case_results: 'counts_only' } });
    const view = await request(`/api/v1/test-results/${reportId}`);
    expect(view.json.data.case_results).toBeNull();
    expect(view.json.data.counts.defined).toBe(1);
    expect(JSON.stringify(view.json.data)).not.toContain('billing-001');
  });

  it('consumes an approval exactly once under concurrent publication', async () => {
    const { contributor, buildId } = await setup();
    const draft = (await createDraft(contributor, 'build', buildId)).json.data;
    const approved = await approve(contributor, draft);
    const body = { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, { method: 'POST', body, key: key('pub') }),
      ),
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(1);
    for (const response of results.filter((entry) => entry.status !== 201)) expect(response.status).toBe(409);
    const consumed = await db()
      .select()
      .from(publicationApprovals)
      .where(and(eq(publicationApprovals.draftId, draft.draft_id), isNull(publicationApprovals.consumedAt)));
    expect(consumed).toHaveLength(0);
  });

  it('blocks publication when the record is withdrawn after approval', async () => {
    const { contributor, buildId } = await setup();
    const draft = (await createDraft(contributor, 'build', buildId)).json.data;
    const approved = await approve(contributor, draft);
    await api(contributor, `/api/v1/builds/${buildId}/withdraw`, { method: 'POST' });
    const response = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST',
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
      key: key(),
    });
    expect(response.status).toBe(422);
    expect(response.json.error.code).toBe('PUBLICATION_BLOCKED');
  });

  it('needs the publish scope for the kind', async () => {
    const { contributor, buildId } = await setup();
    const draft = (await createDraft(contributor, 'build', buildId)).json.data;
    const approved = await approve(contributor, draft);
    const response = await api(contributor, `/api/v1/drafts/${draft.draft_id}/publish`, {
      method: 'POST',
      token: true,
      scopes: ['builds:write', 'projects:publish', 'tests:publish'],
      body: { approval_id: approved.json.data.approval_id, draft_revision: draft.revision, payload_digest: draft.payload_digest },
      key: key(),
    });
    expect(response.status).toBe(403);
    expect(response.json.error.details.required_scopes).toEqual(['builds:publish']);
  });
});

describe('operator review and evidence levels', () => {
  async function published(options: { failing?: boolean; weak?: boolean; operator?: boolean } = {}) {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount({ operator: options.operator === true });
    const build = buildFor(project);
    if (options.weak) build.model_bindings[0]!.artifact_identity = null;
    const { buildId, reportId } = await submitThroughApi(contributor, project, {
      build,
      result: (id) => (options.failing ? failingResultFor(project, id) : resultFor(project, id)),
    });
    await publishRecords(contributor, buildId, reportId);
    return { project, contributor, buildId, reportId };
  }

  const review = (operator: Awaited<ReturnType<typeof createAccount>>, reportId: string, body: object) =>
    api(operator, `/api/v1/admin/test-results/${reportId}/review`, { method: 'POST', body });

  it('is operator-only, hidden from everyone else', async () => {
    const { contributor, reportId } = await published();
    const body = { decision: 'accepted', reason_code: 'accepted_as_reported' };
    expect((await review(contributor, reportId, body)).status).toBe(404);
    expect((await request(`/api/v1/admin/test-results/${reportId}/review`, { method: 'POST', body })).status).toBeGreaterThanOrEqual(401);
  });

  it('assigns reproducible_test only after acceptance and passing server checks', async () => {
    const { reportId } = await published();
    const operator = await createAccount({ operator: true });
    const accepted = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_as_reported', note: 'looks right' });
    expect(accepted.status).toBe(200);
    expect(accepted.json.data).toMatchObject({ review_state: 'accepted', evidence_level: 'reproducible_test' });
    const [reviews] = await db().select().from(evidenceReviews);
    expect(reviews).toMatchObject({ decision: 'accepted', evidenceLevel: 'reproducible_test', policyVersion: 'localfirst/evidence-policy/v0.1' });
  });

  it('caps a result with failing eligibility checks at community_reported', async () => {
    const { reportId } = await published({ weak: true });
    const operator = await createAccount({ operator: true });
    const accepted = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_checks_incomplete' });
    expect(accepted.json.data.evidence_level).toBe('community_reported');
  });

  it('cannot be told to assign a level, including independently_verified', async () => {
    const { reportId } = await published();
    const operator = await createAccount({ operator: true });
    for (const extra of [{ evidence_level: 'independently_verified' }, { evidence_level: 'reproducible_test' }, { verified: true }]) {
      const response = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_as_reported', ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId));
    expect(row?.reviewState).toBe('pending');
    expect(row?.evidenceLevel).toBeNull();
  });

  it('rejects, can be re-decided, and forbids reviewing your own report', async () => {
    const { reportId } = await published();
    const operator = await createAccount({ operator: true });
    const rejected = await review(operator, reportId, { decision: 'rejected', reason_code: 'rejected_unverifiable' });
    expect(rejected.json.data).toMatchObject({ review_state: 'rejected', evidence_level: null });
    const reaccepted = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_as_reported' });
    expect(reaccepted.json.data.review_state).toBe('accepted');
    expect(await db().select().from(evidenceReviews)).toHaveLength(2);

    // An operator who submitted the report cannot review it.
    const { contributor, reportId: ownReport } = await published({ operator: true });
    const own = await review(contributor, ownReport, { decision: 'accepted', reason_code: 'accepted_as_reported' });
    expect(own.status).toBe(403);
  });

  it('refuses to review a private report or to accept an invalid one', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project);
    const operator = await createAccount({ operator: true });
    const priv = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_as_reported' });
    expect(priv.status).toBe(409);
    expect(priv.json.error.code).toBe('INVALID_LIFECYCLE');

    await db().update(runReports).set({ visibility: 'public', publicProjection: {}, publishedAt: new Date(), validationState: 'invalid' }).where(eq(runReports.id, reportId));
    const invalid = await review(operator, reportId, { decision: 'accepted', reason_code: 'accepted_as_reported' });
    expect(invalid.status).toBe(409);
    const rejectInvalid = await review(operator, reportId, { decision: 'rejected', reason_code: 'rejected_inconsistent' });
    expect(rejectInvalid.status).toBe(200);
  });

  it('caps an accepted manual build report at community_reported, in the service and in the database', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const saved = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      key: key(),
      body: buildFor(project, {
        manual_report: {
          schema: 'localfirst/build-report/v0.1',
          client_run_id: runId('manual'),
          outcome: 'reported_success',
          method: 'Followed the setup by hand and it worked.',
          changes: null,
          checks: [],
          diagnostic_codes: [],
          completed_at: '2026-10-11T20:30:00Z',
        },
      }),
    });
    const buildId = saved.json.data.build_id;
    const manualId = saved.json.data.manual_report.report_id;
    await drainWorker();
    await publishRecords(contributor, buildId, null, { build: { manual_report: true } });

    const operator = await createAccount({ operator: true });
    const accepted = await api(operator, `/api/v1/admin/builds/${buildId}/report-review`, {
      method: 'POST',
      body: { decision: 'accepted', reason_code: 'accepted_as_reported' },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.data).toMatchObject({ review_state: 'accepted', evidence_level: 'community_reported' });

    // The database refuses anything stronger, whatever the service does.
    await expect(
      db().update(runReports).set({ evidenceLevel: 'reproducible_test' }).where(eq(runReports.id, manualId)),
    ).rejects.toThrow();
    await expect(
      db().update(runReports).set({ evidenceLevel: 'independently_verified' }).where(eq(runReports.id, manualId)),
    ).rejects.toThrow();
  });
});
