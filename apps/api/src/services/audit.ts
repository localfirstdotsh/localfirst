/**
 * Minimal actor/target history (BACKEND_PRD sections 16.1, 17.4).
 *
 * Audit rows carry safe identifiers, digests, reasons, and policy versions.
 * They never carry manifests, bodies, credentials, or private content.
 */

import { auditEvents } from '../db/schema/registry.js';
import type { DbOrTx } from '../db/client.js';
import type { Actor } from '../http/context.js';
import { actorClientId, actorUserId } from '../http/context.js';

export interface AuditInput {
  action: string;
  targetKind: string;
  targetId: string;
  reason?: string | null;
  policyVersion?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function writeAudit(tx: DbOrTx, actor: Actor, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    actorKind: actor.kind,
    actorUserId: actorUserId(actor),
    actorClientId: actorClientId(actor),
    action: input.action,
    targetKind: input.targetKind,
    targetId: input.targetId,
    reason: input.reason ?? null,
    policyVersion: input.policyVersion ?? null,
    metadata: input.metadata ?? {},
  });
}
