import { ApiContractError, ApiRequestError, ApiUnavailableError } from '../../lib/api';
import { StatePanel } from '../../components/composites/StatePanel';

/** Error and empty states shared by the reference pages (FRONTEND_PRD section 15). */
export function ReferenceError({ error, what }: { error: unknown; what: string }) {
  if (error instanceof ApiContractError) {
    return (
      <StatePanel title={`The registry sent an unexpected ${what} response`} tone="warning">
        Nothing is shown rather than guessing. Try again shortly.
      </StatePanel>
    );
  }
  const requestId = error instanceof ApiUnavailableError || error instanceof ApiRequestError ? error.requestId : null;
  return (
    <StatePanel title={`${what} could not be loaded`} tone="warning" requestId={requestId}>
      The registry is unavailable. Try again in a moment.
    </StatePanel>
  );
}
