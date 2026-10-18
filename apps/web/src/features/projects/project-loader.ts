import { notFound } from 'next/navigation';
import { ApiRequestError, ApiUnavailableError, getProjectBySlug } from '../../lib/api';
import type { ProjectDetail } from '../../lib/schemas';

/**
 * Shared by the project pages. Missing, hidden, and quarantined all look the same
 * (404) so no private existence is disclosed; an unreachable registry is a
 * distinct "unavailable" state, never an empty page.
 */
export async function loadProject(slug: string): Promise<ProjectDetail | 'unavailable'> {
  try {
    return await getProjectBySlug(slug);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    if (error instanceof ApiUnavailableError || error instanceof ApiRequestError) return 'unavailable';
    throw error;
  }
}
