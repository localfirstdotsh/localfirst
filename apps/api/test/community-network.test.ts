import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML, INDEPENDENCE_POLICY_VERSION, parseProjectDocument, serializeProjectDocument } from '@localfirst/contracts';
import { config, setConfig } from '../src/config.js';
import { db, getPool } from '../src/db/client.js';
import { communityRecords, derivativeRelationships, independentVerifications } from '../src/db/schema/community.js';
import { createApproval, loadOwnedDraft } from '../src/services/drafts.js';
import { createRecordDraft, patchRecordDraft, publishRecordDraft } from '../src/services/contributions.js';
import { publishProjectDraft } from '../src/services/publication.js';
import { comparePublicRuns } from '../src/domain/public-comparison.js';
import { loadPublicRun, publicComparisons } from '../src/services/comparisons.js';
import { listCommunity } from '../src/services/community.js';
import { requestAccountDeletion } from '../src/services/accounts.js';
import { referenceRelationships } from '../src/services/relationships.js';
import { activeVerifications } from '../src/services/verification.js';
import { advertisedScopes } from '../src/auth/scopes.js';
import { request } from './factories.js';
import { eq } from 'drizzle-orm';
import { compatibilityRequestSchema } from '@localfirst/contracts';
import { hardwareDescriptors, projects, projectVersions } from '../src/db/schema/registry.js';
import { summariesForVersion } from '../src/services/evidence.js';
import { assessCompatibility } from '../src/domain/compatibility.js';
import { buildSubject, matchSubject } from '../src/domain/evidence-match.js';
import { acceptedRun, api, buildFor, createAccount, drainWorker, exactEnvironment, resultFor, key, publishEvidenceProject, publishRecords, submitThroughApi } from './evidence-fixtures.js';

afterEach(() => setConfig(null));
const world = async () => {
  const author = await createAccount(), operator = await createAccount({ operator: true });
  return { author, operator, project: await publishEvidenceProject(author) };
};
async function approvalFor(account: Awaited<ReturnType<typeof createAccount>>, draftId: string) {
  const draft = await loadOwnedDraft(account.actor, draftId);
  const { approvalId } = await createApproval({ actor: account.actor, draftId, draftRevision: draft.revision, payloadDigest: draft.payloadDigest, acknowledgedWarningCodes: draft.warningCodes, decision: 'approved', sessionId: 'test-session' });
  return { actor: account.actor, draftId, approvalId: approvalId as string, draftRevision: draft.revision, payloadDigest: draft.payloadDigest };
}
const verificationBody = (a: string, b: string) => ({
  original_report_id: a, reproduction_report_id: b, policy_version: INDEPENDENCE_POLICY_VERSION,
  procedure: 'Independently repeat the public smoke protocol on the disclosed identical environment.',
  evidence_url: 'https://example.org/lab/reproduction',
  independence: { author_independent: true, submitter_independent: true, reviewer_independent: true, conflicts_disclosed: true, conflicts: [] },
  criteria: { authorized_run: true, identity_complete: true, repeat_procedure_followed: true, hardware_software_coverage: true },
});

describe('public comparison protocols', () => {
  it('groups accepted exact protocols, discloses model variation, confounders, and distinct contributors without a score', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const b = buildFor(project); b.model_bindings[0]!.artifact_identity!.digest = `sha256:${'7'.repeat(64)}`;
    b.hardware!.memory_bytes = 32 * 1024 ** 3;
    await acceptedRun(project, operator, { build: b });
    const response = await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}&varies=model`);
    expect(response.status, response.text).toBe(200);
    expect(response.json.data.items).toHaveLength(1);
    const group = response.json.data.items[0];
    expect(group.comparison_ready).toBe(true);
    expect(group.distinct_contributors).toBe(2);
    expect(group.universal_score).toBeNull();
    const varied = group.reports.find((r: any) => r.varies.length);
    expect(varied.varies).toEqual(['model']); expect(varied.confounders).toContain('hardware');
    expect(group.protocol.fixture_digest).toBe(project.definition.fixtureDigest);
  });
  it('excludes unknown timing context, hidden hardware, withdrawn evidence and differing metric methods', async () => {
    const { project, operator } = await world();
    const a = await acceptedRun(project, operator);
    const hidden = await submitThroughApi(await createAccount(), project);
    // Owned record is not public: it must never appear in comparison groups.
    const comparison = await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}&metric=latency_ms`);
    expect(comparison.json.data.items).toEqual([]);
    expect(comparison.json.data.exclusions[0].reasons).toContain('load_state_unknown');
    expect(JSON.stringify(comparison.json)).not.toContain(hidden.reportId);
    const run = (await loadPublicRun(a.reportId))!;
    const other = structuredClone(run); other.report.measurement_context.load_state = 'warm'; other.report.measurement_context.cache_state = 'disabled';
    run.report.measurement_context = other.report.measurement_context;
    other.report.measurements.latency_ms.method = 'different_clock_v1';
    expect(comparePublicRuns(run, other, { varies: 'model', metric: 'latency_ms' }).reasons).toContain('protocol_or_metric_method_differs');
    const privateFixture = structuredClone(run); privateFixture.report.fixture_kind = 'private_local';
    expect(comparePublicRuns(run, privateFixture, { varies: 'model', metric: 'case_outcomes' }).reasons).toContain('private_fixture');
    await api(a.contributor, `/api/v1/test-results/${a.reportId}/withdraw`, { method: 'POST' });
    expect((await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}`)).json.data.items).toEqual([]);
  });
  it('binds paged windows to the protocol query and excludes unreviewed reports', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator); await acceptedRun(project, operator);
    const first = await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}&limit=1`);
    expect(first.json.data.has_more).toBe(true);
    const cursor = encodeURIComponent(first.json.data.next_cursor);
    const second = await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}&limit=1&cursor=${cursor}`);
    expect(second.json.data.items[0].reports[0].report_id).not.toBe(first.json.data.items[0].reports[0].report_id);
    expect((await request(`/api/v1/comparisons?project_version_id=${project.published.projectVersionId}&varies=hardware&cursor=${cursor}`)).status).toBe(400);
  });
  it('requires exact settings, engine, profile, quantization and memory for accepted evidence matching', async () => {
    const { project, operator } = await world(); await acceptedRun(project, operator);
    const path = `/api/v1/projects/${project.published.projectId}/compatibility-checks`;
    expect((await request(path, { method: 'POST', body: exactEnvironment() })).json.data.outcome).toBe('evidence_match');
    for (const change of [{ effective_settings: undefined }, { effective_settings: { ...exactEnvironment().effective_settings, temperature: 1 } }, { hardware: { ...exactEnvironment().hardware, memory_bytes: 32 * 1024 ** 3 } }, { runtime: { ...exactEnvironment().runtime, engine_version: 'different-engine' } }]) {
      expect((await request(path, { method: 'POST', body: exactEnvironment(change) })).json.data.outcome).not.toBe('evidence_match');
    }
  });
  it('never exposes hardware that was excluded from the approved projection', async () => {
    const { project, operator } = await world(); const account = await createAccount();
    const run = await submitThroughApi(account, project);
    await publishRecords(account, run.buildId, run.reportId, { build: { hardware: 'none' } });
    await api(operator, `/api/v1/admin/test-results/${run.reportId}/review`, { method: 'POST', body: { decision: 'accepted', reason_code: 'accepted_as_reported' } }); await drainWorker();
    const summaries = await request(`/api/v1/projects/${project.published.projectId}/compatibility-reports`);
    expect(summaries.json.data.summaries[0].subject.platform).toBeNull();
  });
});

describe('independent reproduction', () => {
  it('links a separate qualified run, scopes the claim, and immediately loses qualification on withdrawal', async () => {
    const { project, operator } = await world();
    const a = await acceptedRun(project, operator), b = await acceptedRun(project, operator);
    const body = verificationBody(a.reportId, b.reportId), idem = key();
    const create = await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body, key: idem });
    expect(create.status, create.text).toBe(201); expect(create.json.data.scope).toBe('component');
    const replay = await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body, key: idem });
    expect(replay.json.data.verification_id).toBe(create.json.data.verification_id);
    await drainWorker();
    const assessment = await request(`/api/v1/projects/${project.published.projectId}/compatibility-checks`, { method: 'POST', body: exactEnvironment() });
    expect(assessment.json.data.evidence_level).toBe('independently_verified'); expect(assessment.json.data.evidence_scope).toBe('component');
    await api(b.contributor, `/api/v1/test-results/${b.reportId}/withdraw`, { method: 'POST' });
    expect(await activeVerifications([a.reportId])).toEqual([]);
    const history = await request(`/api/v1/test-results/${a.reportId}/verifications`);
    expect(history.json.data.items[0].state).toBe('ineligible');
    // No worker drain here: even a stale summary cannot keep independent qualification.
    expect((await request(`/api/v1/projects/${project.published.projectId}/compatibility-checks`, { method: 'POST', body: exactEnvironment() })).json.data.evidence_level).toBe('reproducible_test');
  });
  it('rejects self-report reruns, author/submitter reviewers, conflicts, incomplete criteria and agent authority', async () => {
    const { project, operator, author } = await world();
    const contributor = await createAccount();
    const a = await acceptedRun(project, operator, { contributor }), b = await acceptedRun(project, operator, { contributor, result: buildId => resultFor(project, buildId, { completed_at: '2026-10-12T20:00:00Z' }) });
    const body = verificationBody(a.reportId, b.reportId);
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body, key: key() })).status).toBe(422);
    const c = await acceptedRun(project, operator);
    const valid = verificationBody(a.reportId, c.reportId);
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: valid, token: true, key: key() })).status).toBe(403);
    expect((await api(author, '/api/v1/admin/independent-verifications', { method: 'POST', body: valid, key: key() })).status).toBe(404);
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: { ...valid, criteria: { ...valid.criteria, authorized_run: false } }, key: key() })).status).toBe(400);
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: { ...valid, independence: { ...valid.independence, conflicts: ['The verifier is employed by the author.'] } }, key: key() })).status).toBe(403);
    expect(await db().select().from(independentVerifications)).toEqual([]);
  });
  it('rejects model drift and revokes exact claims without resurrection', async () => {
    const { project, operator } = await world(); const a = await acceptedRun(project, operator);
    const build = buildFor(project); build.model_bindings[0]!.artifact_identity!.digest = `sha256:${'8'.repeat(64)}`;
    const drift = await acceptedRun(project, operator, { build });
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: verificationBody(a.reportId, drift.reportId), key: key() })).status).toBe(422);
    const b = await acceptedRun(project, operator);
    const created = await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: verificationBody(a.reportId, b.reportId), key: key() });
    expect(created.status, created.text).toBe(201);
    const revoke = await api(operator, `/api/v1/admin/independent-verifications/${created.json.data.verification_id}/revoke`, { method: 'POST', body: { reason: 'Evidence source was corrected.' } });
    expect(revoke.status).toBe(200); expect(await activeVerifications([a.reportId])).toEqual([]);
    expect((await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: verificationBody(a.reportId, b.reportId), key: key() })).status).toBe(409);
  });
});

const derivativeBody = (project: Awaited<ReturnType<typeof publishEvidenceProject>>, name: string) => ({
  parent_version_id: project.published.projectVersionId, change_summary: 'Adapt the documentation for another local setup.',
  project_md: EXAMPLE_PROJECT_MD.replace('key: request-labeler', `key: ${name}`), files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML.replace('project_key: request-labeler', `project_key: ${name}`) }],
});
describe('derivative lineage', () => {
  it('publishes an attributed immutable child without parent rights or transferred evidence', async () => {
    const { project, author, operator } = await world(); await acceptedRun(project, operator);
    const childOwner = await createAccount();
    const result = await api(childOwner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body: derivativeBody(project, 'derivative-entry'), key: key() });
    expect(result.status, result.text).toBe(201); expect(result.json.data.ready_for_review).toBe(true);
    const published = await publishProjectDraft(await approvalFor(childOwner, result.json.data.draft_id));
    const lineage = await request(`/api/v1/projects/${project.published.projectId}/derivatives`);
    expect(lineage.json.data.items[0].child_project_id).toBe(published.project_id);
    expect(lineage.json.data.items[0].parent_attribution.authors).toHaveLength(1);
    expect(lineage.json.data.items[0].parent_license.state).toBe('known');
    expect(lineage.json.data.items[0].evidence_inherited).toBe(false);
    expect((await request(`/api/v1/projects/${published.project_id}/compatibility-reports`)).json.data.summaries).toEqual([]);
    expect((await api(childOwner, `/api/v1/projects/${project.published.projectId}/drafts`, { method: 'POST', body: { project_md: EXAMPLE_PROJECT_MD }, key: key() })).status).toBe(403);
    expect(author.userId).not.toBe(childOwner.userId);
    await expect(db().insert(derivativeRelationships).values({ childProjectId: project.published.projectId, childVersionId: project.published.projectVersionId, parentProjectId: published.project_id, parentVersionId: published.project_version_id, changeSummary: 'Illegal back edge.' })).rejects.toThrow();
  });
  it('filters search to remixes or originals with derivative=yes|no', async () => {
    const { project } = await world();
    const childOwner = await createAccount();
    const drafted = await api(childOwner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body: derivativeBody(project, 'search-remix'), key: key() });
    const child = await publishProjectDraft(await approvalFor(childOwner, drafted.json.data.draft_id));
    const ids = async (query: string) => ((await request(`/api/v1/projects?${query}`)).json.data.items as Array<{ project_id: string }>).map((item) => item.project_id);

    expect(await ids('derivative=yes')).toEqual([child.project_id]);
    const originals = await ids('derivative=no');
    expect(originals).toContain(project.published.projectId);
    expect(originals).not.toContain(child.project_id);
    expect(await ids('derivative=yes&q=nothing-matches-this')).toEqual([]);
    expect((await request('/api/v1/projects?derivative=maybe')).status).toBe(400);
    expect((await request('/api/v1/catalog/facets')).json.data.derivative).toEqual(['yes', 'no']);
  });
  it('shows a derivative\'s pinned parent on its detail, and hides the parent\'s slug once it is not public', async () => {
    const { project } = await world();
    const childOwner = await createAccount();
    const drafted = await api(childOwner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body: derivativeBody(project, 'derived-from-child'), key: key() });
    const child = await publishProjectDraft(await approvalFor(childOwner, drafted.json.data.draft_id));

    const parentDetail = await request(`/api/v1/projects/${project.published.projectId}`);
    expect(parentDetail.json.data.current_version.derived_from).toBeNull();
    const detail = await request(`/api/v1/projects/${child.project_id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json.data.current_version.derived_from).toMatchObject({
      project_id: project.published.projectId,
      project_version_id: project.published.projectVersionId,
      project_key: 'request-labeler',
      change_summary: 'Adapt the documentation for another local setup.',
      parent_visible: true,
      slug: parentDetail.json.data.slug,
    });
    expect(detail.json.data.current_version.derived_from.url).toContain(`/api/v1/projects/${project.published.projectId}/versions/${project.published.projectVersionId}`);
    const version = await request(`/api/v1/projects/${child.project_id}/versions/${child.project_version_id}`);
    expect(version.json.data.derived_from.project_id).toBe(project.published.projectId);

    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, project.published.projectId));
    const hidden = (await request(`/api/v1/projects/${child.project_id}`)).json.data.current_version.derived_from;
    expect(hidden).toMatchObject({ project_id: project.published.projectId, parent_visible: false, slug: null, url: null });
  });
  it('rejects a version update that would make a project derive from itself or its own descendant', async () => {
    const { project, author } = await world();
    const childOwner = await createAccount();
    const drafted = await api(childOwner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body: derivativeBody(project, 'cycle-child'), key: key() });
    const child = await publishProjectDraft(await approvalFor(childOwner, drafted.json.data.draft_id));
    const updateDerivingFrom = (lineage: { project_key: string; project_id: string; project_version_id: string }) => {
      const parsed = parseProjectDocument(EXAMPLE_PROJECT_MD);
      (parsed.frontmatter as any).derivative_of = { ...lineage, version: (parsed.frontmatter as any).version, change_summary: 'Point the parent at a project in its own lineage.' };
      return api(author, `/api/v1/projects/${project.published.projectId}/drafts`, { method: 'POST', body: { project_md: serializeProjectDocument(parsed.frontmatter, parsed.markdown), files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] }, key: key() });
    };
    const codes = (response: Awaited<ReturnType<typeof api>>) => (response.json.data.issues ?? []).map((issue: any) => issue.code);
    const self = await updateDerivingFrom({ project_key: 'request-labeler', project_id: project.published.projectId, project_version_id: project.published.projectVersionId });
    expect(self.status, self.text).toBeLessThan(300);
    expect(codes(self)).toContain('DERIVATIVE_CYCLE');
    expect(self.json.data.ready_for_review).toBe(false);
    const back = await updateDerivingFrom({ project_key: 'cycle-child', project_id: child.project_id, project_version_id: child.project_version_id });
    expect(back.status, back.text).toBeLessThan(300);
    expect(codes(back)).toContain('DERIVATIVE_CYCLE');
    expect(back.json.data.ready_for_review).toBe(false);
  });
  it('blocks missing attribution/licenses and does not publish a draft after the parent is quarantined', async () => {
    const { project, operator } = await world(); const owner = await createAccount();
    const body = derivativeBody(project, 'missing-attribution'); body.project_md = body.project_md.replace('Example Author', 'Another Person');
    // Change exact author metadata from the actual source fixture.
    const parsed = parseProjectDocument(body.project_md); (parsed.frontmatter as any).attribution.authors = [{ name: 'Another Person', url: null }];
    body.project_md = serializeProjectDocument(parsed.frontmatter, parsed.markdown);
    const bad = await api(owner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body, key: key() });
    expect(bad.json.data.ready_for_review).toBe(false);
    expect(bad.json.data.issues.some((i: any) => i.code === 'DERIVATIVE_ATTRIBUTION_REQUIRED')).toBe(true);
    const good = await api(owner, `/api/v1/projects/${project.published.projectId}/derivative-drafts`, { method: 'POST', body: derivativeBody(project, 'valid-child'), key: key() });
    const approval = await approvalFor(owner, good.json.data.draft_id);
    await api(operator, `/api/v1/admin/projects/${project.published.projectId}/moderation`, { method: 'POST', body: { action: 'quarantine', reason: 'Parent source is unsafe.' } });
    await expect(publishProjectDraft(approval)).rejects.toThrow();
  });
});

describe('curated collections and troubleshooting', () => {
  it('requires owner approval and independent operator review, renders safely, and hides withdrawn references', async () => {
    const { project, operator, author } = await world(); const owner = await createAccount();
    const body = { schema: 'localfirst/community/v0.1', title: '<script>alert(1)</script>', description: 'Projects curated for local experimentation.', entries: [{ project_id: project.published.projectId, project_version_id: project.published.projectVersionId }], license: 'CC-BY-4.0' };
    const save = await api(owner, '/api/v1/collections', { method: 'POST', body, key: key() }); expect(save.status, save.text).toBe(201);
    const id = save.json.data.record_id;
    expect((await request(`/api/v1/collections/${id}`)).status).toBe(404);
    const { draftRow } = await createRecordDraft({ actor: owner.actor, kind: 'collection', recordId: id });
    const approve = await approvalFor(owner, draftRow.id);
    const review = await api(owner, `/api/browser/drafts/${draftRow.id}/review`);
    expect(review.json.data.review.projection.payload.title).toBe('<script>alert(1)</script>');
    await publishRecordDraft(approve);
    expect((await request('/api/v1/collections')).json.data.items).toEqual([]);
    const accepted = await api(operator, `/api/v1/admin/community/${id}/review`, { method: 'POST', body: { decision: 'accepted', reason: 'Attribution and entries checked.' } }); expect(accepted.status, accepted.text).toBe(200);
    const publicView = await request(`/api/v1/collections/${id}`); expect(publicView.json.data.author_endorsement).toBe(false); expect(publicView.json.data.attribution.handle).toBe(owner.handle);
    await api(author, `/api/v1/projects/${project.published.projectId}/unpublish`, { method: 'POST' });
    expect((await request('/api/v1/collections')).json.data.items).toEqual([]);
    expect((await request(`/api/v1/collections/${id}`)).status).toBe(404);
  });
  it('withdraws a deleted account\'s public records, removes its private ones, and leaves others and quarantine alone', async () => {
    const { project, operator } = await world(); const owner = await createAccount(); const other = await createAccount();
    const body = (title: string) => ({ schema: 'localfirst/community/v0.1', title, description: 'Projects curated for local experimentation.', entries: [{ project_id: project.published.projectId, project_version_id: project.published.projectVersionId }], license: 'CC-BY-4.0' });
    const publishAccepted = async (account: typeof owner, title: string) => {
      const id = (await api(account, '/api/v1/collections', { method: 'POST', body: body(title), key: key() })).json.data.record_id as string;
      const { draftRow } = await createRecordDraft({ actor: account.actor, kind: 'collection', recordId: id });
      await publishRecordDraft(await approvalFor(account, draftRow.id));
      expect((await api(operator, `/api/v1/admin/community/${id}/review`, { method: 'POST', body: { decision: 'accepted', reason: 'Checked.' } })).status).toBe(200);
      return id;
    };
    const publicId = await publishAccepted(owner, 'Mine, public');
    const quarantinedId = await publishAccepted(owner, 'Mine, quarantined');
    const keptId = await publishAccepted(other, 'Someone else');
    const privateId = (await api(owner, '/api/v1/collections', { method: 'POST', body: body('Mine, private'), key: key() })).json.data.record_id as string;
    await db().update(communityRecords).set({ visibility: 'quarantined' }).where(eq(communityRecords.id, quarantinedId));
    expect((await request(`/api/v1/collections/${publicId}`)).status).toBe(200);
    const result = await requestAccountDeletion(owner.actor, owner.handle);
    expect(result.effects.public_community_records).toEqual({ handling: 'withdrawn', withdrawn_records: 1 });
    expect((await request(`/api/v1/collections/${publicId}`)).status).toBe(404);
    expect((await request('/api/v1/collections')).json.data.items.map((item: { record_id: string }) => item.record_id)).toEqual([keptId]);
    const rows = await db().select().from(communityRecords).where(eq(communityRecords.ownerUserId, owner.userId));
    expect(rows.map(row => [row.id, row.visibility]).sort()).toEqual([[publicId, 'withdrawn'], [quarantinedId, 'quarantined']].sort());
    expect(rows.some(row => row.id === privateId)).toBe(false);
  });
  it('publishes attributed troubleshooting corrections as new records and invalidates changed approvals', async () => {
    const { project, operator } = await world(); const owner = await createAccount();
    const note = { schema: 'localfirst/community/v0.1', project_id: project.published.projectId, project_version_id: project.published.projectVersionId, title: 'Local memory pressure', symptom: 'Runtime rejects a large context window.', resolution: 'Review and lower the chosen context manually.', limitations: 'This is an attributed suggestion, not verified evidence.', sources: [{ name: 'Runtime reference', url: 'https://example.org/runtime' }], license: 'CC-BY-4.0' };
    const saved = await api(owner, '/api/v1/troubleshooting-notes', { method: 'POST', body: note, key: key() }); const id = saved.json.data.record_id;
    const { draftRow } = await createRecordDraft({ actor: owner.actor, kind: 'troubleshooting', recordId: id }); const stale = await approvalFor(owner, draftRow.id);
    await patchRecordDraft({ actor: owner.actor, draftId: draftRow.id, expectedRevision: 1, selection: {} });
    await expect(publishRecordDraft(stale)).rejects.toThrow();
    await publishRecordDraft(await approvalFor(owner, draftRow.id));
    await api(operator, `/api/v1/admin/community/${id}/review`, { method: 'POST', body: { decision: 'accepted', reason: 'Sources and limitations checked.' } });
    const correction = await api(owner, '/api/v1/troubleshooting-notes', { method: 'POST', body: { ...note, supersedes_id: id, resolution: 'Choose a supported lower context after checking the provider settings.' }, key: key() });
    expect(correction.status).toBe(201); expect(correction.json.data.record_id).not.toBe(id);
    await api(owner, `/api/v1/troubleshooting-notes/${id}/withdraw`, { method: 'POST' });
    expect((await request('/api/v1/troubleshooting-notes')).json.data.items).toEqual([]);
  });
  it('gates community schemas, scopes and direct calls without enabling custom execution', async () => {
    const current = config(); setConfig({ ...current, features: { ...current.features, communityNetwork: false } });
    expect(advertisedScopes(config())).not.toContain('community:write');
    expect((await request('/api/v1/collections')).json.error.code).toBe('PHASE_UNAVAILABLE');
    expect((await request('/api/v1/comparisons')).json.error.code).toBe('PHASE_UNAVAILABLE');
    expect((await request('/api/v1/verification-policy')).json.error.code).toBe('PHASE_UNAVAILABLE');
    const spec = await request('/openapi.json'); expect(Object.keys(spec.json.paths)).not.toContain('/api/v1/comparisons');
    setConfig(null);
    const facets = await request('/api/v1/catalog/facets');
    expect(facets.json.data.phase_support.custom_harnesses).toBe(false); expect(facets.json.data.phase_support.multi_agent_execution).toBe(false);
  });
});

describe('review regressions', () => {
  const GIB = 1024 ** 3;
  it('matches evidence from a machine whose memory is not a power of two', async () => {
    const { project, operator } = await world();
    const build = buildFor(project); build.hardware!.memory_bytes = 24 * GIB;
    await acceptedRun(project, operator, { build });
    const path = `/api/v1/projects/${project.published.projectId}/compatibility-checks`;
    const same = exactEnvironment({ hardware: { ...exactEnvironment().hardware, memory_bytes: 24 * GIB } });
    expect((await request(path, { method: 'POST', body: same })).json.data.outcome).toBe('evidence_match');
  });
  it('treats an omitted quantization like an explicit null', async () => {
    const { project } = await world();
    const build = buildFor(project); build.model_bindings[0]!.quantization = null;
    const subject = buildSubject(build);
    const env = exactEnvironment(); const { quantization: _q, ...model } = env.selected_models[0]!; void _q;
    const omitted = matchSubject(subject, compatibilityRequestSchema.parse({ ...env, selected_models: [model] }));
    const explicit = matchSubject(subject, compatibilityRequestSchema.parse({ ...env, selected_models: [{ ...model, quantization: null }] }));
    expect(omitted.unmatched).toEqual(explicit.unmatched);
    expect(omitted.unmatched.some((code) => code.startsWith('model_quantization'))).toBe(false);
  });
  it('raises an evidence match to independently_verified only from a supporting group', async () => {
    const { project, operator } = await world(); await acceptedRun(project, operator);
    const [summary] = await summariesForVersion(project.published.projectVersionId);
    const [version] = await db().select().from(projectVersions).where(eq(projectVersions.id, project.published.projectVersionId));
    const entry = (id: string, evidenceLevel: 'reproducible_test' | 'independently_verified', counts: { reports: number; successes: number; failures: number; partial: number }) => ({
      id, configurationKey: summary!.configurationKey, subject: summary!.subject, testDefinitionId: summary!.testDefinitionId, scope: summary!.scope,
      evidenceLevel, counts, distinctContributors: 1, conflict: false, evidenceIds: [id],
    });
    const result = assessCompatibility({
      projectId: project.published.projectId, projectVersionId: project.published.projectVersionId, spec: version!.manifest as any, sourcesPinned: false,
      request: compatibilityRequestSchema.parse(exactEnvironment()), runnerAvailable: true,
      evidence: [
        entry('supporting', 'reproducible_test', { reports: 3, successes: 3, failures: 0, partial: 0 }),
        entry('partial-only', 'independently_verified', { reports: 1, successes: 0, failures: 0, partial: 1 }),
      ],
    });
    expect(result.outcome).toBe('evidence_match');
    expect(result.evidence_level).toBe('reproducible_test');
  });
  it('keeps an unpinned derivative_of a valid declaration, even with the community network off', async () => {
    const author = await createAccount();
    const parsed = parseProjectDocument(EXAMPLE_PROJECT_MD.replace('key: request-labeler', 'key: unpinned-lineage'));
    (parsed.frontmatter as any).derivative_of = { project_key: 'upstream-project', change_summary: 'Adapted from an upstream project outside the registry.' };
    const body = { kind: 'project', project_md: serializeProjectDocument(parsed.frontmatter, parsed.markdown), files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML.replace('project_key: request-labeler', 'project_key: unpinned-lineage') }] };
    // The pre-P2 DERIVATIVE_NO_INHERITED_EVIDENCE warning stays; nothing may block.
    const codes = (response: Awaited<ReturnType<typeof api>>) => (response.json.data.issues ?? []).filter((issue: any) => issue.severity === 'error').map((issue: any) => issue.code);
    const on = await api(author, '/api/v1/drafts', { method: 'POST', body, key: key() });
    expect(on.status, on.text).toBe(201);
    expect(codes(on).filter((code: string) => code.startsWith('DERIVATIVE_'))).toEqual([]);
    const current = config(); setConfig({ ...current, features: { ...current.features, communityNetwork: false } });
    const off = await api(author, '/api/v1/drafts', { method: 'POST', body, key: key() });
    expect(off.status, off.text).toBe(201);
    expect(codes(off).filter((code: string) => code.startsWith('DERIVATIVE_'))).toEqual([]);
  });
  it('answers 404, not 500, for malformed record IDs', async () => {
    const operator = await createAccount({ operator: true });
    for (const path of ['/api/v1/collections/abc', '/api/v1/troubleshooting-notes/abc', '/api/v1/projects/not-a-uuid/derivatives', '/api/v1/test-results/abc/verifications']) {
      expect((await request(path)).status, path).toBe(404);
    }
    expect((await api(operator, '/api/v1/collections/abc/withdraw', { method: 'POST' })).status).toBe(404);
    expect((await api(operator, '/api/v1/admin/community/abc/review', { method: 'POST', body: { decision: 'accepted', reason: 'Checked the record.' } })).status).toBe(404);
    expect((await api(operator, '/api/v1/admin/independent-verifications/abc/revoke', { method: 'POST', body: { reason: 'Checked the claim.' } })).status).toBe(404);
  });
  it('refuses a second revocation so the recorded reason cannot be rewritten', async () => {
    const { project, operator } = await world();
    const a = await acceptedRun(project, operator), b = await acceptedRun(project, operator);
    const created = await api(operator, '/api/v1/admin/independent-verifications', { method: 'POST', body: verificationBody(a.reportId, b.reportId), key: key() });
    const id = created.json.data.verification_id;
    const first = await api(operator, `/api/v1/admin/independent-verifications/${id}/revoke`, { method: 'POST', body: { reason: 'Reviewer conflict found.' } });
    expect(first.status, first.text).toBe(200);
    const second = await api(operator, `/api/v1/admin/independent-verifications/${id}/revoke`, { method: 'POST', body: { reason: 'A different reason.' } });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('VERIFICATION_ALREADY_REVOKED');
    const [row] = await db().select().from(independentVerifications).where(eq(independentVerifications.id, id));
    expect(row!.revokedReason).toBe('Reviewer conflict found.');
  });
});

describe('list query cost', () => {
  /** Queries sent through the pool while `fn` runs; transactions are not used by these reads. */
  async function countQueries(fn: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(getPool(), 'query');
    try { await fn(); return spy.mock.calls.length; } finally { spy.mockRestore(); }
  }
  async function acceptedCollections(count: number, project: Awaited<ReturnType<typeof publishEvidenceProject>>, operator: Awaited<ReturnType<typeof createAccount>>) {
    for (let i = 0; i < count; i += 1) {
      const owner = await createAccount();
      await db().insert(communityRecords).values({
        kind: 'collection', ownerUserId: owner.userId, contentDigest: `sha256:${String(i).repeat(64).slice(0, 64)}`,
        payload: { schema: 'localfirst/community/v0.1', title: `Collection ${i}`, description: 'Projects curated for local experimentation.', entries: [{ project_id: project.published.projectId, project_version_id: project.published.projectVersionId }], license: 'CC-BY-4.0' },
        visibility: 'public', reviewState: 'accepted', reviewedByUserId: operator.userId, reviewReason: 'Checked.', publishedAt: new Date(),
      });
    }
  }

  it('lists community records in a fixed number of queries, whatever the page size', async () => {
    const { project, operator } = await world();
    await acceptedCollections(2, project, operator);
    const small = await countQueries(() => listCommunity('collection', { limit: '100' }));
    await acceptedCollections(6, project, operator);
    let listed: Awaited<ReturnType<typeof listCommunity>> | undefined;
    const large = await countQueries(async () => { listed = await listCommunity('collection', { limit: '100' }); });
    expect(listed!.items).toHaveLength(8);
    expect(listed!.items.every((item) => item.attribution.handle)).toBe(true);
    expect(large).toBe(small);
  });

  it('builds comparison groups in a fixed number of queries, whatever the page size', async () => {
    const { project, operator } = await world();
    const query = { project_version_id: project.published.projectVersionId, varies: 'model' };
    await acceptedRun(project, operator); await acceptedRun(project, operator);
    const small = await countQueries(() => publicComparisons(query));
    await acceptedRun(project, operator); await acceptedRun(project, operator);
    let result: Awaited<ReturnType<typeof publicComparisons>> | undefined;
    const large = await countQueries(async () => { result = await publicComparisons(query); });
    expect(result!.items[0]!.reports).toHaveLength(4);
    expect(large).toBe(small);
  });

  it('reads relationship evidence in a fixed number of queries, whatever the page size', async () => {
    const author = await createAccount();
    const declaring = (key: string) => EXAMPLE_PROJECT_MD.replace('key: request-labeler', `key: ${key}`).replace('  accelerator: optional\n', '  accelerator: optional\n  devices: ["Relationship Cost Board"]\n');
    const publishDeclaring = async (key: string) => publishEvidenceProject(author, EXAMPLE_TEST_YAML.replace('project_key: request-labeler', `project_key: ${key}`), declaring(key));
    await publishDeclaring('relationship-cost-a'); await publishDeclaring('relationship-cost-b');
    const [board] = await db().select({ id: hardwareDescriptors.id }).from(hardwareDescriptors).where(eq(hardwareDescriptors.key, 'relationship-cost-board'));
    const small = await countQueries(() => referenceRelationships('hardware', board!.id));
    await publishDeclaring('relationship-cost-c'); await publishDeclaring('relationship-cost-d'); await publishDeclaring('relationship-cost-e');
    let result: Awaited<ReturnType<typeof referenceRelationships>> | undefined;
    const large = await countQueries(async () => { result = await referenceRelationships('hardware', board!.id); });
    expect(result!.items).toHaveLength(5);
    expect(large).toBe(small);
  });
});
