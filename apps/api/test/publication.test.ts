/**
 * P0 acceptance checks for publication and authorization
 * (BACKEND_PRD section 20.1).
 */

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { auditEvents, drafts, projects, projectVersions, publicationApprovals } from '../src/db/schema/registry.js';
import {
  createAccount,
  projectDocument,
  publishProject,
  request,
  type TestAccount,
} from './factories.js';
import {
  createApproval,
  createDirectProjectDraft,
  revalidateDraft,
} from '../src/services/drafts.js';
import { publishProjectDraft } from '../src/services/publication.js';
import { moderateProject } from '../src/services/moderation.js';
import { reindexProject } from '../src/services/search.js';

async function draftFor(account: TestAccount, document = projectDocument()) {
  const { draft } = await createDirectProjectDraft({
    actor: account.actor,
    ownerUserId: account.userId,
    projectId: null,
    payload: { project_md: document, files: [] },
  });
  const { draft: validated, validation } = await revalidateDraft(account.actor, draft.id);
  return { draft: validated, validation };
}

describe('publication through the REST adapter', () => {
  it('allows denial without assent while retaining approval and publication gates', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account);
    expect(validation.warning_codes.length).toBeGreaterThan(0);
    const decision = {
      draft_revision: draft.revision,
      payload_digest: draft.payloadDigest,
      acknowledged_warning_codes: [],
    };
    const denied = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST', user: account.userId,
      body: { ...decision, decision: 'denied' },
    });
    expect(denied.status).toBe(200);
    expect(denied.json.data.approval_id).toBeNull();
    expect(denied.json.data.decision).toBe('denied');
    const [record] = await db().select().from(publicationApprovals)
      .where(eq(publicationApprovals.draftId, draft.id));
    expect(record?.decision).toBe('denied');
    expect(record?.acknowledgedWarningCodes).toEqual([]);
    expect(record?.revokedAt).not.toBeNull();
    const unacknowledged = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST', user: account.userId,
      body: { ...decision, decision: 'approved' },
    });
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.json.error.code).toBe('APPROVAL_WARNINGS_UNACKNOWLEDGED');
    const published = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST', user: account.userId, idempotencyKey: 'denial-is-not-approval',
      body: { approval_id: record!.id, draft_revision: draft.revision, payload_digest: draft.payloadDigest },
    });
    expect(published.status).toBe(409);
    expect(published.json.error.code).toBe('APPROVAL_REQUIRED');
    const audit = await db().select().from(auditEvents)
      .where(and(eq(auditEvents.targetId, draft.id), eq(auditEvents.action, 'draft.approval_denied')));
    expect(audit).toHaveLength(1);
  });

  it('creates, validates, approves, and publishes an immutable version', async () => {
    const account = await createAccount();
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'key-1',
      body: { kind: 'project', project_md: projectDocument({ key: 'rest-flow' }) },
    });
    expect(created.status).toBe(201);
    expect(created.json.data.state).toBe('ready_for_review');
    expect(created.headers.get('etag')).toBe('W/"rev-1"');
    const draftId = created.json.data.draft_id;
    const digest = created.json.data.payload_digest;
    const warnings = created.json.data.warning_codes;

    const approved = await request(`/api/v1/drafts/${draftId}/approval`, {
      method: 'POST',
      user: account.userId,
      body: {
        draft_revision: 1,
        payload_digest: digest,
        acknowledged_warning_codes: warnings,
      },
    });
    expect(approved.status).toBe(201);

    const published = await request(`/api/v1/drafts/${draftId}/publish`, {
      method: 'POST',
      user: account.userId,
      actorKind: 'token',
      scopes: ['projects:publish'],
      idempotencyKey: 'publish-1',
      body: {
        approval_id: approved.json.data.approval_id,
        draft_revision: 1,
        payload_digest: digest,
      },
    });
    expect(published.status).toBe(201);
    expect(published.json.data.visibility).toBe('published');
    // Publication never creates run evidence.
    expect(published.json.data.evidence_level).toBe('claimed');
    expect(published.json.data.review_state).toBe('not_applicable');

    const detail = await request(`/api/v1/projects/${published.json.data.project_id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.data.test_support).toEqual({
      declared_kind: 'none',
      runner_available: false,
    });
  });

  it('replays an idempotent publish instead of creating a second version', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account, projectDocument({ key: 'replay' }));
    const { approvalId } = await createApproval({
      actor: account.actor,
      draftId: draft.id,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: 'test',
    });
    const body = {
      approval_id: approvalId,
      draft_revision: draft.revision,
      payload_digest: draft.payloadDigest,
    };
    const first = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'same-key',
      body,
    });
    const second = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'same-key',
      body,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.meta.replayed).toBe(true);
    expect(second.json.data.project_version_id).toBe(first.json.data.project_version_id);

    const versions = await db()
      .select()
      .from(projectVersions)
      .where(eq(projectVersions.projectId, first.json.data.project_id));
    expect(versions).toHaveLength(1);
  });

  it('refuses a second publish of a consumed approval', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account, projectDocument({ key: 'single-use' }));
    const { approvalId } = await createApproval({
      actor: account.actor,
      draftId: draft.id,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: 'test',
    });
    const body = {
      approval_id: approvalId,
      draft_revision: draft.revision,
      payload_digest: draft.payloadDigest,
    };
    const first = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'use-1',
      body,
    });
    expect(first.status).toBe(201);
    const second = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'use-2',
      body,
    });
    expect(second.status).toBe(409);
    expect(['APPROVAL_REQUIRED', 'INVALID_LIFECYCLE']).toContain(second.json.error.code);
  });

  it('invalidates an approval when the draft content changes', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account, projectDocument({ key: 'edit-invalidates' }));
    const { approvalId } = await createApproval({
      actor: account.actor,
      draftId: draft.id,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: 'test',
    });

    const edited = await request(`/api/v1/drafts/${draft.id}`, {
      method: 'PATCH',
      user: account.userId,
      ifMatch: `W/"rev-${draft.revision}"`,
      body: { project_md: projectDocument({ key: 'edit-invalidates', name: 'Edited Name' }) },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.data.revision).toBe(draft.revision + 1);

    const stale = await request(`/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'stale-publish',
      body: {
        approval_id: approvalId,
        draft_revision: draft.revision,
        payload_digest: draft.payloadDigest,
      },
    });
    expect(stale.status).toBe(409);
    const approvals = await db()
      .select()
      .from(publicationApprovals)
      .where(eq(publicationApprovals.draftId, draft.id));
    expect(approvals[0]?.revokedAt).not.toBeNull();
  });

  it('requires an If-Match revision to edit a draft', async () => {
    const account = await createAccount();
    const { draft } = await draftFor(account, projectDocument({ key: 'precondition' }));
    const missing = await request(`/api/v1/drafts/${draft.id}`, {
      method: 'PATCH',
      user: account.userId,
      body: { project_md: projectDocument({ key: 'precondition', name: 'Other' }) },
    });
    expect(missing.status).toBe(428);
    expect(missing.json.error.code).toBe('REVISION_PRECONDITION_REQUIRED');

    const wrong = await request(`/api/v1/drafts/${draft.id}`, {
      method: 'PATCH',
      user: account.userId,
      ifMatch: 'W/"rev-99"',
      body: { project_md: projectDocument({ key: 'precondition', name: 'Other' }) },
    });
    expect(wrong.status).toBe(412);
  });

  it('rejects an approval that does not name the current revision and digest', async () => {
    const account = await createAccount();
    const { draft } = await draftFor(account, projectDocument({ key: 'exact-artifact' }));
    const spoofed = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST',
      user: account.userId,
      body: {
        draft_revision: draft.revision,
        payload_digest: `sha256:${'0'.repeat(64)}`,
        acknowledged_warning_codes: [],
      },
    });
    expect(spoofed.status).toBe(409);
    expect(spoofed.json.error.code).toBe('APPROVAL_STALE');
  });

  it('refuses an agent token at the human approval boundary', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account, projectDocument({ key: 'human-only' }));
    const denied = await request(`/api/v1/drafts/${draft.id}/approval`, {
      method: 'POST',
      user: account.userId,
      actorKind: 'token',
      body: {
        draft_revision: draft.revision,
        payload_digest: draft.payloadDigest,
        acknowledged_warning_codes: validation.warning_codes,
      },
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('FORBIDDEN');
    expect(denied.json.error.message).toMatch(/browser session/i);
  });

  it('keeps published content immutable and refuses duplicate content', async () => {
    const account = await createAccount();
    const document = projectDocument({ key: 'immutable' });
    const published = await publishProject(account, document);

    // A version update draft with identical content is a validation error.
    const update = await request(`/api/v1/projects/${published.projectId}/drafts`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'dup-content',
      body: { project_md: document },
    });
    expect(update.status).toBe(201);
    const issues = update.json.data.issues as Array<{ code: string }>;
    expect(issues.some((issue) => issue.code === 'VERSION_CONTENT_UNCHANGED')).toBe(true);
    expect(update.json.data.state).toBe('editable');
  });

  it('creates a second immutable version for changed content', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'versioned' }));
    const updatedDocument = projectDocument({ key: 'versioned', name: 'Versioned Project v2' });

    const created = await request(`/api/v1/projects/${published.projectId}/drafts`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'v2-draft',
      body: { project_md: updatedDocument },
    });
    expect(created.json.data.state).toBe('ready_for_review');

    const approved = await request(`/api/v1/drafts/${created.json.data.draft_id}/approval`, {
      method: 'POST',
      user: account.userId,
      body: {
        draft_revision: created.json.data.revision,
        payload_digest: created.json.data.payload_digest,
        acknowledged_warning_codes: created.json.data.warning_codes,
      },
    });
    const publishedV2 = await request(`/api/v1/drafts/${created.json.data.draft_id}/publish`, {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'v2-publish',
      body: {
        approval_id: approved.json.data.approval_id,
        draft_revision: created.json.data.revision,
        payload_digest: created.json.data.payload_digest,
      },
    });
    expect(publishedV2.status).toBe(201);
    expect(publishedV2.json.data.version_number).toBe(2);
    expect(publishedV2.json.data.project_id).toBe(published.projectId);

    const history = await request(`/api/v1/projects/${published.projectId}/versions`);
    expect(history.json.data.items).toHaveLength(2);
    const current = history.json.data.items.find((item: { is_current: boolean }) => item.is_current);
    expect(current.version_number).toBe(2);

    // The first version's content is still exactly what was published.
    const original = await request(
      `/api/v1/projects/${published.projectId}/versions/${published.projectVersionId}`,
    );
    expect(original.json.data.content_digest).toBe(published.contentDigest);
  });

  it('publishes a documentation-only project with no repository or commit', async () => {
    const account = await createAccount();
    const published = await publishProject(
      account,
      projectDocument({ key: 'docs-only', type: 'hardware_build' }),
    );
    const detail = await request(`/api/v1/projects/${published.projectId}`);
    const sources = detail.json.data.current_version.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe('authored_specification');
    expect(sources[0]?.url).toBeNull();
    expect(sources[0]?.revision).toBeNull();
    // Its pinning limits are visible rather than implied.
    expect(sources[0]?.pinned).toBe(false);
    expect(detail.json.data.sources_pinned).toBe(false);
    expect(detail.json.data.evidence_level).toBe('claimed');
  });

  it('records attribution separately from the submitting account', async () => {
    const account = await createAccount({ handle: 'curator-account' });
    const published = await publishProject(
      account,
      projectDocument({
        key: 'attributed',
        sources: `  - key: upstream
    kind: documentation
    url: https://example.org/upstream-guide
    revision: null
    content_digest: null
    license: {state: unknown, id: null, reference: null}`,
      }).replace('relationship: original_author_claimed', 'relationship: curator_submitted'),
    );
    const detail = await request(`/api/v1/projects/${published.projectId}`);
    const attribution = detail.json.data.current_version.attribution;
    expect(attribution.authors[0].name).toBe('Test Author');
    expect(attribution.submitted_by.handle).toBe('curator-account');
    expect(attribution.submitted_by.role).toBe('curator');
    expect(attribution.listing_origin).toBe('curated_from_upstream');
    expect(detail.json.data.listing_origin).toBe('curated_from_upstream');
  });

  it('blocks publication of content that is quarantined elsewhere', async () => {
    const operator = await createAccount({ operator: true });
    const author = await createAccount();
    const document = projectDocument({ key: 'prohibited' });
    const published = await publishProject(author, document);
    await moderateProject({
      actor: operator.actor,
      projectId: published.projectId,
      action: 'quarantine',
      reason: 'Prohibited content for the test suite.',
    });

    // A fresh draft of the same content from another account is refused.
    const other = await createAccount();
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: other.userId,
      idempotencyKey: 'quarantine-bypass',
      body: { kind: 'project', project_md: document },
    });
    const issues = created.json.data.issues as Array<{ code: string }>;
    expect(issues.some((issue) => issue.code === 'QUARANTINED_CONTENT')).toBe(true);
    expect(created.json.data.state).toBe('editable');
  });

  it('hides a quarantined project from reads and search', async () => {
    const operator = await createAccount({ operator: true });
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'to-quarantine' }));
    await reindexProject(published.projectId);

    await moderateProject({
      actor: operator.actor,
      projectId: published.projectId,
      action: 'quarantine',
      reason: 'Quarantined by the test suite.',
    });

    const anonymous = await request(`/api/v1/projects/${published.projectId}`);
    expect(anonymous.status).toBe(404);

    const asOperator = await request(`/api/v1/projects/${published.projectId}`, {
      user: operator.userId,
    });
    expect(asOperator.status).toBe(200);
    expect(asOperator.json.data.visibility).toBe('quarantined');

    const search = await request('/api/v1/projects?q=registry');
    const slugs = (search.json.data.items as Array<{ slug: string }>).map((item) => item.slug);
    expect(slugs).not.toContain(published.slug);

    // The owner cannot republish around quarantine.
    const republish = await request(`/api/v1/projects/${published.projectId}/republish`, {
      method: 'POST',
      user: author.userId,
    });
    expect(republish.status).toBe(409);
    expect(republish.json.error.code).toBe('QUARANTINED');

    // Nor can they create a new version of it.
    const update = await request(`/api/v1/projects/${published.projectId}/drafts`, {
      method: 'POST',
      user: author.userId,
      idempotencyKey: 'quarantined-update',
      body: { project_md: projectDocument({ key: 'to-quarantine', name: 'Changed' }) },
    });
    expect(update.status).toBe(409);
  });

  it('lets an owner unpublish and republish their own project', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'visibility' }));

    const unpublished = await request(`/api/v1/projects/${published.projectId}/unpublish`, {
      method: 'POST',
      user: account.userId,
    });
    expect(unpublished.json.data.visibility).toBe('unpublished');
    expect((await request(`/api/v1/projects/${published.projectId}`)).status).toBe(404);
    expect(
      (await request(`/api/v1/projects/${published.projectId}`, { user: account.userId })).status,
    ).toBe(200);

    const republished = await request(`/api/v1/projects/${published.projectId}/republish`, {
      method: 'POST',
      user: account.userId,
    });
    expect(republished.json.data.visibility).toBe('published');
    expect((await request(`/api/v1/projects/${published.projectId}`)).status).toBe(200);
  });

  it('writes one audit trail and outbox event per publication', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'audited' }));
    const events = await db()
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'project.published'), eq(auditEvents.targetId, published.projectVersionId)),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ content_digest: published.contentDigest });
  });

  it('refuses a draft whose project key the account already manages', async () => {
    const account = await createAccount();
    await publishProject(account, projectDocument({ key: 'duplicate-key' }));
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'dup-key',
      body: { kind: 'project', project_md: projectDocument({ key: 'duplicate-key' }) },
    });
    const issues = created.json.data.issues as Array<{ code: string }>;
    expect(issues.some((issue) => issue.code === 'PROJECT_KEY_ALREADY_MANAGED')).toBe(true);
  });

  it('keeps drafts private to their owner', async () => {
    const owner = await createAccount();
    const stranger = await createAccount();
    const { draft } = await draftFor(owner, projectDocument({ key: 'private-draft' }));

    const asStranger = await request(`/api/v1/drafts/${draft.id}`, { user: stranger.userId });
    expect(asStranger.status).toBe(404);
    const asOwner = await request(`/api/v1/drafts/${draft.id}`, { user: owner.userId });
    expect(asOwner.status).toBe(200);
  });

  it('cannot publish another account’s draft even with an approval', async () => {
    const owner = await createAccount();
    const attacker = await createAccount();
    const { draft, validation } = await draftFor(owner, projectDocument({ key: 'cross-account' }));
    const { approvalId } = await createApproval({
      actor: owner.actor,
      draftId: draft.id,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: 'test',
    });
    await expect(
      publishProjectDraft({
        actor: attacker.actor,
        draftId: draft.id,
        approvalId: approvalId as string,
        draftRevision: draft.revision,
        payloadDigest: draft.payloadDigest,
      }),
    ).rejects.toThrow();
  });

  it('discards a draft and revokes its approval', async () => {
    const account = await createAccount();
    const { draft, validation } = await draftFor(account, projectDocument({ key: 'discarded' }));
    await createApproval({
      actor: account.actor,
      draftId: draft.id,
      draftRevision: draft.revision,
      payloadDigest: draft.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: 'test',
    });
    const discarded = await request(`/api/v1/drafts/${draft.id}`, {
      method: 'DELETE',
      user: account.userId,
    });
    expect(discarded.status).toBe(204);
    const [row] = await db().select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row?.state).toBe('discarded');
    const [approval] = await db()
      .select()
      .from(publicationApprovals)
      .where(eq(publicationApprovals.draftId, draft.id));
    expect(approval?.revokedAt).not.toBeNull();
  });

  it('rejects unsafe content before it can be published', async () => {
    const account = await createAccount();
    const withSecret = projectDocument({ key: 'unsafe' }).replace(
      '## Purpose',
      '## Purpose\n\nexport TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    const created = await request('/api/v1/drafts', {
      method: 'POST',
      user: account.userId,
      idempotencyKey: 'unsafe-1',
      body: { kind: 'project', project_md: withSecret },
    });
    const issues = created.json.data.issues as Array<{ code: string }>;
    expect(issues.some((issue) => issue.code === 'SECRET_GITHUB_TOKEN')).toBe(true);

    const approval = await request(`/api/v1/drafts/${created.json.data.draft_id}/approval`, {
      method: 'POST',
      user: account.userId,
      body: {
        draft_revision: created.json.data.revision,
        payload_digest: created.json.data.payload_digest,
        acknowledged_warning_codes: [],
      },
    });
    expect(approval.status).toBe(422);
    expect(approval.json.error.code).toBe('VALIDATION_FAILED');
  });

  it('assigns a distinct slug when names collide', async () => {
    const first = await createAccount();
    const second = await createAccount();
    const a = await publishProject(first, projectDocument({ key: 'collide', name: 'Shared Name' }));
    const b = await publishProject(second, projectDocument({ key: 'collide', name: 'Shared Name' }));
    expect(a.slug).not.toBe(b.slug);
    const rows = await db().select({ slug: projects.slug }).from(projects);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
  });
});
