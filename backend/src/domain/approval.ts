/**
 * Exact-artifact approval rules (BACKEND_PRD section 10.4).
 *
 * Approval binds actor, draft kind and ID, revision, canonical payload digest,
 * warning acknowledgements, policy version, expiry, and one-use consumption.
 * Any content, redaction, model-binding, source, or test reference edit
 * invalidates it. MCP cannot mint an approval by claiming `user_approved`.
 */

import { ERROR_CODES } from '@localfirst/contracts';
import { ApiError } from '../http/errors.js';
import { APPROVAL_POLICY_VERSION } from './policy.js';

export interface ApprovalRecordLike {
  id: string;
  draftId: string;
  kind: string;
  actorUserId: string;
  draftRevision: number;
  payloadDigest: string;
  acknowledgedWarningCodes: unknown;
  policyVersion: string;
  decision: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApprovalTarget {
  draftId: string;
  kind: string;
  revision: number;
  payloadDigest: string;
  warningCodes: string[];
}

export interface ApprovalClaim {
  approvalId: string;
  draftRevision: number;
  payloadDigest: string;
}

/** Warning codes the approver must acknowledge for this exact artifact. */
export function unacknowledgedWarnings(
  warningCodes: string[],
  acknowledged: unknown,
): string[] {
  const ack = new Set(
    Array.isArray(acknowledged)
      ? acknowledged.filter((code): code is string => typeof code === 'string')
      : [],
  );
  return warningCodes.filter((code) => !ack.has(code));
}

export function assertWarningsAcknowledged(
  warningCodes: string[],
  acknowledged: unknown,
): void {
  const missing = unacknowledgedWarnings(warningCodes, acknowledged);
  if (missing.length > 0) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_WARNINGS_UNACKNOWLEDGED,
      message: 'Every warning on this exact artifact must be acknowledged before approval.',
      details: { unacknowledged_warning_codes: missing },
    });
  }
}

/**
 * Validate a claimed approval against the live draft state. Every mismatch is
 * an explicit conflict rather than a silent publication.
 */
export function assertApprovalUsable(
  approval: ApprovalRecordLike | undefined,
  target: ApprovalTarget,
  claim: ApprovalClaim,
  actorUserId: string,
  now = new Date(),
): void {
  if (!approval) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'A human approval of this exact artifact is required before publication.',
      details: { draft_id: target.draftId },
    });
  }
  if (approval.draftId !== target.draftId || approval.id !== claim.approvalId) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'The approval does not belong to this draft.',
    });
  }
  if (approval.decision !== 'approved') {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'This artifact was not approved.',
    });
  }
  if (approval.actorUserId !== actorUserId) {
    throw ApiError.forbidden('Only the approving account may publish this artifact.');
  }
  if (approval.revokedAt) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'This approval was revoked.',
    });
  }
  if (approval.consumedAt) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'This approval was already used.',
    });
  }
  if (approval.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_EXPIRED,
      message: 'This approval expired; review the exact artifact again.',
    });
  }
  if (approval.kind !== target.kind) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'The approval was issued for a different contribution kind.',
    });
  }
  if (
    approval.draftRevision !== target.revision ||
    claim.draftRevision !== target.revision ||
    approval.payloadDigest !== target.payloadDigest ||
    claim.payloadDigest !== target.payloadDigest
  ) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_STALE,
      message:
        'The draft changed after it was approved. Review and approve the exact current artifact.',
      details: {
        approved_revision: approval.draftRevision,
        current_revision: target.revision,
        approved_payload_digest: approval.payloadDigest,
        current_payload_digest: target.payloadDigest,
      },
    });
  }
  if (approval.policyVersion !== APPROVAL_POLICY_VERSION) {
    throw new ApiError({
      code: ERROR_CODES.APPROVAL_REQUIRED,
      message: 'This approval was recorded under a superseded approval policy.',
      details: { required_policy_version: APPROVAL_POLICY_VERSION },
    });
  }
  assertWarningsAcknowledged(target.warningCodes, approval.acknowledgedWarningCodes);
}
