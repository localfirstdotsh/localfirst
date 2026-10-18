'use server';

import { ApiContractError, ApiRequestError, ApiUnavailableError, checkCompatibility } from '../../lib/api';
import { buildCompatibilityRequest, readFields } from './compat-request';
import type { Assessment } from '../../lib/schemas';

export type CheckState =
  | { status: 'idle' }
  | { status: 'error'; message: string; requestId: string | null }
  | { status: 'done'; assessment: Assessment };

/**
 * Runs the public compatibility check. The version being viewed is pinned in the
 * form, so the result never silently moves to a newer version. Nothing is stored,
 * logged, or placed in a URL.
 */
export async function runCheck(_previous: CheckState, form: FormData): Promise<CheckState> {
  const projectId = form.get('project_id');
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 64) {
    return { status: 'error', message: 'This project could not be identified. Reload the page and try again.', requestId: null };
  }
  const built = buildCompatibilityRequest(readFields(form));
  if (!built.ok) return { status: 'error', message: built.message, requestId: null };

  try {
    const assessment = await checkCompatibility(projectId, built.request);
    return { status: 'done', assessment };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 429) {
        return { status: 'error', message: 'Too many checks right now. Wait a moment and try again.', requestId: error.requestId };
      }
      return { status: 'error', message: error.message, requestId: error.requestId };
    }
    if (error instanceof ApiContractError) {
      return { status: 'error', message: 'The registry sent an unexpected response, so no result is shown.', requestId: null };
    }
    const requestId = error instanceof ApiUnavailableError ? error.requestId : null;
    return { status: 'error', message: 'The registry is unavailable. Try again shortly.', requestId };
  }
}
