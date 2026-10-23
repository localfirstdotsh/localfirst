import type { Publication } from '../../lib/schemas';

/**
 * The public statement on a version published under delegation (FRONTEND_PRD
 * section 6.5). Null for a version a person approved exactly.
 */
export function delegationLabel(publication: Publication | undefined, ownerHandle: string | null): string | null {
  if (publication?.authorization !== 'delegated') return null;
  const client = publication.via_client_name?.trim() || 'an application';
  const owner = ownerHandle ? `@${ownerHandle}` : 'the owner';
  const unverified = publication.via_client_name && publication.via_client_name_is_unverified ? ' (name reported by the application, not verified)' : '';
  return `Published by ${client}${unverified} for ${owner} without per-version review.`;
}
