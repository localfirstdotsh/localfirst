/**
 * Local publication approval (BACKEND_PRD section 10.4).
 *
 * A machine becomes an approver in three steps: it asks for a link (a short
 * code and a secret only it holds), a signed-in browser session approves the
 * code, and the machine redeems the secret once for a credential. The
 * credential can record or read a publication decision for its owner and do
 * nothing else; OAuth and MCP consent can never grant it. Secrets are stored
 * as hashes and shown once.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { approverCredentials, approverLinks } from '../db/schema/registry.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { writeAudit } from './audit.js';

export const APPROVER_SECRET_PREFIX = 'lfh_';
export const LINK_TTL_SECONDS = 600;
export const LINK_POLL_INTERVAL_SECONDS = 3;
export const CREDENTIAL_TTL_SECONDS = 30 * 24 * 3600;
export const MAX_CREDENTIALS_PER_USER = 10;
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const LAST_USED_GRANULARITY_MS = 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = (bytes: number) => randomBytes(bytes).toString('base64url');

/** Eight unambiguous characters, shown as `XXXX-XXXX`. */
function newUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
export const normalizeUserCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface StartedLink {
  linkId: string;
  userCode: string;
  pollSecret: string;
  expiresAt: Date;
}

export async function startLink(clientLabel: string): Promise<StartedLink> {
  const label = clientLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || 'unnamed machine';
  const pollSecret = token(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const userCode = newUserCode();
    const rows = await db()
      .insert(approverLinks)
      .values({ userCode, pollHash: sha256(pollSecret), clientLabel: label, expiresAt })
      .onConflictDoNothing()
      .returning({ id: approverLinks.id });
    if (rows[0]) return { linkId: rows[0].id, userCode, pollSecret, expiresAt };
  }
  throw ApiError.internal('A link code could not be allocated. Try again.');
}

export interface PendingLink {
  clientLabel: string;
  userCode: string;
  createdAt: Date;
  expiresAt: Date;
}

/** What the browser shows so the person can compare it with the machine's terminal. */
export async function pendingLinkByCode(userCode: string): Promise<PendingLink | null> {
  const [row] = await db()
    .select()
    .from(approverLinks)
    .where(
      and(
        eq(approverLinks.userCode, normalizeUserCode(userCode)),
        eq(approverLinks.state, 'pending'),
        gt(approverLinks.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row
    ? { clientLabel: row.clientLabel, userCode: row.userCode, createdAt: row.createdAt, expiresAt: row.expiresAt }
    : null;
}

/** A signed-in browser session decides one pending code. */
export async function decideLink(
  actor: Actor,
  userCode: string,
  decision: 'approved' | 'denied',
): Promise<void> {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const updated = await db().transaction(async (tx) => {
    const rows = await tx
      .update(approverLinks)
      .set({ state: decision, userId: actor.userId, decidedAt: new Date() })
      .where(
        and(
          eq(approverLinks.userCode, normalizeUserCode(userCode)),
          eq(approverLinks.state, 'pending'),
          gt(approverLinks.expiresAt, new Date()),
        ),
      )
      .returning({ id: approverLinks.id, label: approverLinks.clientLabel });
    const row = rows[0];
    if (row) {
      await writeAudit(tx, actor, {
        action: decision === 'approved' ? 'approver.link_approved' : 'approver.link_denied',
        targetKind: 'approver_link',
        targetId: row.id,
        metadata: { client_label: row.label },
      });
    }
    return row;
  });
  if (!updated) throw ApiError.notFound();
}

export type Redemption =
  | { status: 'pending' }
  | { status: 'gone'; reason: 'denied' | 'expired' | 'redeemed' | 'unknown' }
  | { status: 'issued'; credential: string; credentialId: string; expiresAt: Date; label: string };

/** The machine trades its poll secret for a credential, once. */
export async function redeemLink(linkId: string, pollSecret: string): Promise<Redemption> {
  return db().transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(approverLinks)
      .where(and(eq(approverLinks.id, linkId), eq(approverLinks.pollHash, sha256(pollSecret))))
      .for('update')
      .limit(1);
    if (!link) return { status: 'gone', reason: 'unknown' };
    if (link.state === 'denied') return { status: 'gone', reason: 'denied' };
    if (link.state === 'redeemed') return { status: 'gone', reason: 'redeemed' };
    if (link.expiresAt.getTime() <= Date.now()) return { status: 'gone', reason: 'expired' };
    if (link.state === 'pending' || !link.userId) return { status: 'pending' };

    const [{ live }] = (await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(approverCredentials)
      .where(
        and(
          eq(approverCredentials.userId, link.userId),
          isNull(approverCredentials.revokedAt),
          gt(approverCredentials.expiresAt, new Date()),
        ),
      )) as [{ live: number }];
    if (live >= MAX_CREDENTIALS_PER_USER) {
      throw new ApiError({
        code: 'CONFLICT',
        message: `This account already has ${MAX_CREDENTIALS_PER_USER} approval devices. Revoke one first.`,
      });
    }

    const secret = APPROVER_SECRET_PREFIX + token(32);
    const expiresAt = new Date(Date.now() + CREDENTIAL_TTL_SECONDS * 1000);
    const [credential] = await tx
      .insert(approverCredentials)
      .values({ userId: link.userId, secretHash: sha256(secret), label: link.clientLabel, expiresAt })
      .returning({ id: approverCredentials.id });
    await tx.update(approverLinks).set({ state: 'redeemed' }).where(eq(approverLinks.id, link.id));
    await writeAudit(tx, { kind: 'anonymous' }, {
      action: 'approver.credential_issued',
      targetKind: 'approver_credential',
      targetId: credential!.id,
      metadata: { client_label: link.clientLabel, user_id: link.userId },
    });
    return { status: 'issued', credential: secret, credentialId: credential!.id, expiresAt, label: link.clientLabel };
  });
}

/** Resolve a presented credential, or null. Touches `last_used_at` at most once a minute. */
export async function resolveApproverCredential(
  secret: string,
): Promise<{ credentialId: string; userId: string } | null> {
  if (!secret.startsWith(APPROVER_SECRET_PREFIX)) return null;
  const [row] = await db()
    .select()
    .from(approverCredentials)
    .where(
      and(
        eq(approverCredentials.secretHash, sha256(secret)),
        isNull(approverCredentials.revokedAt),
        gt(approverCredentials.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
    await db().update(approverCredentials).set({ lastUsedAt: new Date() }).where(eq(approverCredentials.id, row.id));
  }
  return { credentialId: row.id, userId: row.userId };
}

export interface ApproverDevice {
  id: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

export async function listApproverDevices(userId: string): Promise<ApproverDevice[]> {
  return db()
    .select({
      id: approverCredentials.id,
      label: approverCredentials.label,
      createdAt: approverCredentials.createdAt,
      expiresAt: approverCredentials.expiresAt,
      lastUsedAt: approverCredentials.lastUsedAt,
    })
    .from(approverCredentials)
    .where(
      and(
        eq(approverCredentials.userId, userId),
        isNull(approverCredentials.revokedAt),
        gt(approverCredentials.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(approverCredentials.createdAt));
}

export async function revokeApproverDevice(actor: Actor, id: string): Promise<void> {
  if (actor.kind !== 'session') throw ApiError.forbidden('A browser session is required.');
  const revoked = await db().transaction(async (tx) => {
    const rows = await tx
      .update(approverCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(approverCredentials.id, id),
          eq(approverCredentials.userId, actor.userId),
          isNull(approverCredentials.revokedAt),
        ),
      )
      .returning({ id: approverCredentials.id });
    if (rows[0]) {
      await writeAudit(tx, actor, {
        action: 'approver.credential_revoked',
        targetKind: 'approver_credential',
        targetId: id,
      });
    }
    return rows[0];
  });
  if (!revoked) throw ApiError.notFound();
}

/** Retention: links and credentials past their window. */
export async function pruneApprovers(): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const links = await db().delete(approverLinks).where(lt(approverLinks.expiresAt, new Date())).returning({ id: approverLinks.id });
  const credentials = await db()
    .delete(approverCredentials)
    .where(or(lt(approverCredentials.expiresAt, weekAgo), lt(approverCredentials.revokedAt, weekAgo)))
    .returning({ id: approverCredentials.id });
  return links.length + credentials.length;
}
