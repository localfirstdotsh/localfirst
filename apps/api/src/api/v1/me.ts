/**
 * Account routes (BACKEND_PRD section 12.3).
 *
 * Grants are summarized without token bodies, revocation uses the auth
 * provider's own lifecycle, and deletion requests state their effects before
 * anything is removed.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { success } from '../../http/middleware.js';
import { requireHuman, requireScope } from '../../auth/guards.js';
import { db } from '../../db/client.js';
import {
  oauthConsentTable,
  oauthRefreshTokenTable,
} from '../../db/schema/auth.js';
import { operatorRoles, projects, userProfiles } from '../../db/schema/registry.js';
import { writeAudit } from '../../services/audit.js';
import { requestAccountDeletion } from '../../services/accounts.js';
import { advertisedScopes, PRODUCT_SCOPES } from '../../auth/scopes.js';
import { config } from '../../config.js';
import { listConnections } from '../../services/connections.js';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', requireScope('profile:read'), async (c) => {
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const [profile] = await db()
    .select({
      handle: userProfiles.handle,
      displayName: userProfiles.displayName,
      externalIdentities: userProfiles.externalIdentities,
      suspendedAt: userProfiles.suspendedAt,
      deletionRequestedAt: userProfiles.deletionRequestedAt,
      createdAt: userProfiles.createdAt,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, actor.userId))
    .limit(1);
  if (!profile) throw ApiError.notFound();
  const managed = await db()
    .select({ project_id: projects.id, slug: projects.slug, visibility: projects.visibility })
    .from(projects)
    .where(eq(projects.managerUserId, actor.userId))
    .orderBy(desc(projects.updatedAt))
    .limit(50);
  const roles = await db()
    .select({ role: operatorRoles.role })
    .from(operatorRoles)
    .where(and(eq(operatorRoles.userId, actor.userId), isNull(operatorRoles.revokedAt)));

  return c.json(
    success(
      {
        handle: profile.handle,
        display_name: profile.displayName,
        external_identities: profile.externalIdentities,
        account_state: profile.suspendedAt ? 'suspended' : 'active',
        deletion_requested_at: profile.deletionRequestedAt?.toISOString() ?? null,
        created_at: profile.createdAt.toISOString(),
        operator_roles: roles.map((row) => row.role),
        /** Scopes present on this credential, not everything the account could grant. */
        granted_scopes: [...actor.scopes].filter((scope) => scope in PRODUCT_SCOPES),
        actor_kind: actor.kind,
        managed_projects: managed,
      },
      c.get('requestId'),
    ),
  );
});

meRoutes.get('/connections', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const items = await listConnections(actor.userId);

  return c.json(
    success(
      {
        items,
        has_more: false,
        next_cursor: null,
      },
      c.get('requestId'),
      {
        note: 'A connection grants recurring capabilities. It never approves a future artifact or local test.',
      },
    ),
  );
});

meRoutes.delete('/connections/:connection_id', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const connectionId = c.req.param('connection_id');
  const [consent] = await db()
    .select({ id: oauthConsentTable.id, clientId: oauthConsentTable.clientId })
    .from(oauthConsentTable)
    .where(and(eq(oauthConsentTable.id, connectionId), eq(oauthConsentTable.userId, actor.userId)))
    .limit(1);
  if (!consent) throw ApiError.notFound();

  await db().transaction(async (tx) => {
    // Revoke the grant and its refresh authorizations through the auth tables
    // the provider owns.
    await tx.delete(oauthConsentTable).where(eq(oauthConsentTable.id, connectionId));
    await tx
      .update(oauthRefreshTokenTable)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(oauthRefreshTokenTable.userId, actor.userId),
          eq(oauthRefreshTokenTable.clientId, consent.clientId),
        ),
      );
    await writeAudit(tx, actor, {
      action: 'connection.revoked',
      targetKind: 'oauth_client',
      targetId: consent.clientId,
      metadata: { connection_id: connectionId },
    });
  });
  return c.body(null, 204);
});

const deletionSchema = z
  .object({
    confirm: z.literal(true),
    /** The person must restate their handle, so this is never an accident. */
    handle: z.string().min(1).max(64),
  })
  .strict();

meRoutes.post('/deletion-requests', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const body = await c.req.json().catch(() => null);
  const parsed = deletionSchema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(
      'Confirm deletion with `{"confirm": true, "handle": "<your handle>"}`.',
    );
  }
  const result = await requestAccountDeletion(actor, parsed.data.handle);
  return c.json(success(result, c.get('requestId')), 202);
});

/** Advertised scopes for this deployment, for client registration and docs. */
meRoutes.get('/scopes', async (c) => {
  const scopes = advertisedScopes(config());
  return c.json(
    success(
      {
        items: scopes.map((scope) => ({
          scope,
          phase: PRODUCT_SCOPES[scope].phase,
          description: PRODUCT_SCOPES[scope].description,
        })),
        protocol_scopes: ['openid', 'profile', 'email', 'offline_access'],
        note: 'Read scopes never grant execution. There is no hosted execution scope.',
      },
      c.get('requestId'),
    ),
  );
});
