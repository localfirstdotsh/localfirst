/** Session-only read models for the Next.js browser UI. No HTML or mutation ownership lives here. */
import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import type { AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { success } from '../../http/middleware.js';
import { resolveSessionActor } from '../../auth/actor.js';
import { requireHuman } from '../../auth/guards.js';
import { PRODUCT_SCOPES } from '../../auth/scopes.js';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { oauthClientTable } from '../../db/schema/auth.js';
import { describeClient, type ClientIdentity } from '../../auth/client-identity.js';
import { projects, projectVersions, publicationApprovals, userProfiles } from '../../db/schema/registry.js';
import { activeApproval, loadOwnedDraft, serializeDraft } from '../../services/drafts.js';
import { loadReviewData } from '../../services/review.js';
import { listConnections } from '../../services/connections.js';
import { creatingConnection } from '../../services/delegation.js';
import { fillDays, getOwnedProjectWithUsage, listOwnedProjectsWithUsage, usageSeries } from '../../services/usage.js';

export const browserRoutes = new Hono<AppEnv>();
browserRoutes.use('*', async (c, next) => {
  // Browser reads accept an actual session only, never an agent/linked-machine credential.
  c.header('Cache-Control', 'no-store');
  c.set('actor', (await resolveSessionActor(c.req.raw.headers)) ?? { kind: 'anonymous' });
  await next();
});

function browserConfig() {
  return {
    auth_base_path: config().authBasePath,
    sign_in_enabled: Boolean(config().github.clientId),
    resource: config().mcpResource,
    scope_descriptions: Object.fromEntries(Object.entries(PRODUCT_SCOPES).map(([scope, value]) => [scope, value.description])),
  };
}
browserRoutes.get('/config', (c) => c.json(success(browserConfig(), c.get('requestId'))));
/** Whether this browser holds a signed-in session, so the site header can show the right control. Nothing else is exposed. */
browserRoutes.get('/session', async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') return c.json(success({ authenticated: false, handle: null, auth_base_path: config().authBasePath }, c.get('requestId')));
  const [profile] = await db().select({ handle: userProfiles.handle }).from(userProfiles).where(eq(userProfiles.userId, actor.userId)).limit(1);
  return c.json(success({ authenticated: true, handle: profile?.handle ?? null, auth_base_path: config().authBasePath }, c.get('requestId')));
});
browserRoutes.get('/consent', async (c) => {
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  // The name and callbacks come from the registered client only. A name in the
  // query string is attacker-controllable and never shown.
  let clientName: string | null = null;
  let app: ClientIdentity | null = null;
  if (clientId && c.get('actor').kind === 'session') {
    const [client] = await db().select({ name: oauthClientTable.name, redirectUris: oauthClientTable.redirectUris }).from(oauthClientTable)
      .where(eq(oauthClientTable.clientId, clientId)).limit(1);
    if (client) {
      clientName = client.name ?? null;
      app = describeClient({ name: client.name ?? null, redirectUris: client.redirectUris });
    }
  }
  return c.json(success({
    ...browserConfig(),
    client_id: clientId,
    client_name: clientName,
    app,
    resource: url.searchParams.get('resource') ?? config().mcpResource,
    scopes: (url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean),
  }, c.get('requestId')));
});

browserRoutes.get('/connections', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden();
  return c.json(success({ ...browserConfig(), items: await listConnections(actor.userId) }, c.get('requestId')));
});
browserRoutes.get('/projects', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden();
  return c.json(success({ items: await listOwnedProjectsWithUsage(actor.userId) }, c.get('requestId')));
});
browserRoutes.get('/projects/:project_id/usage', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden();
  const project = await getOwnedProjectWithUsage(actor.userId, c.req.param('project_id'));
  if (!project) throw ApiError.notFound();
  const range = c.req.query('days') === '90' ? 90 : 30;
  return c.json(success({ project, range, days: fillDays(await usageSeries(project.project_id, range), range) }, c.get('requestId')));
});
browserRoutes.get('/deletion-preview', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden();
  const [profile] = await db().select({ handle: userProfiles.handle }).from(userProfiles).where(eq(userProfiles.userId, actor.userId)).limit(1);
  if (!profile) throw ApiError.notFound();
  const managed = await db().select({ slug: projects.slug }).from(projects).where(eq(projects.managerUserId, actor.userId));
  return c.json(success({ handle: profile.handle, managed_projects: managed }, c.get('requestId')));
});
browserRoutes.get('/drafts/:draft_id/review', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden();
  const draft = await loadOwnedDraft(actor, c.req.param('draft_id'));
  const review = await loadReviewData(draft);
  const approval = await activeApproval(draft.id);
  const matches = approval?.draftRevision === draft.revision && approval?.payloadDigest === draft.payloadDigest;
  const live = Boolean(approval && matches && approval.expiresAt.getTime() > Date.now() && !review.stale);
  const expired = Boolean(approval && matches && approval.expiresAt.getTime() <= Date.now());
  const [latest] = await db().select().from(publicationApprovals).where(eq(publicationApprovals.draftId, draft.id)).orderBy(desc(publicationApprovals.createdAt)).limit(1);
  const denied = latest?.decision === 'denied' && latest.draftRevision === draft.revision && latest.payloadDigest === draft.payloadDigest && c.req.query('review') !== 'again';
  const closed = draft.state === 'published' || draft.state === 'discarded';
  let published: { slug: string; version_number: number } | null = null;
  if (draft.state === 'published' && draft.publishedVersionId) {
    const [version] = await db().select({ slug: projects.slug, version_number: projectVersions.versionNumber }).from(projectVersions).innerJoin(projects, eq(projects.id, projectVersions.projectId)).where(eq(projectVersions.id, draft.publishedVersionId)).limit(1);
    published = version ?? null;
  }
  const status = closed ? draft.state : live ? 'approved' : denied ? 'denied' : expired ? 'expired' : (review.stale || (approval && !matches)) ? 'changed' : 'review';
  return c.json(success({
    draft: serializeDraft(draft, approval),
    review,
    status,
    published,
    blocked: review.stale || review.issues.some((issue) => issue.severity === 'error'),
    decision_allowed: !closed && !live && !denied,
    files: (draft.payload.files ?? []).map((file) => ({ path: file.path, content: file.content })),
    approval_window_seconds: config().ttl.approvalSeconds,
    profiles: { declarative: config().features.agentEnvironments, framework: config().features.frameworkEnvironments },
    creating_connection: await creatingConnection(actor.userId, draft.createdByClientId),
  }, c.get('requestId')));
});
