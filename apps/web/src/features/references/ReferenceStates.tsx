import { ApiRequestError, ApiUnavailableError } from '../../lib/api';
import { DiscoveryError } from '../../components/composites/DiscoveryFeedback';

/** Copy belongs to the reference feature; presentation and recovery are shared with discovery. */
export function ReferenceError({ error, what }: { error: unknown; what: 'Models' | 'Hardware' }) {
  const requestId = error instanceof ApiUnavailableError || error instanceof ApiRequestError ? error.requestId : null;
  return (
    <DiscoveryError title={`${what} could not be loaded`}
      description={error instanceof ApiRequestError && error.status === 429 ? 'Please wait a moment, then try again.' : 'Please try again in a moment.'}
      retryHref={`/${what.toLowerCase()}`} requestId={requestId} />
  );
}
