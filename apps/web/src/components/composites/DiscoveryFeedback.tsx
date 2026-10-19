import { DiscoveryState } from '../layout/DiscoveryPage';
import { buttonClassName } from '../ui/Button';

export function DiscoveryLoading({ label }: { label: string }) {
  return (
    <DiscoveryState>
      <p className="muted" role="status" aria-busy="true" aria-label={`Loading ${label}`}>
        Loading {label}…
      </p>
    </DiscoveryState>
  );
}

/** A failure is announced separately from a successful empty result. A native link retries the request. */
export function DiscoveryError({ title, description, retryHref, requestId }: {
  title: string;
  description: string;
  retryHref: string;
  requestId?: string | null;
}) {
  return (
    <DiscoveryState>
      <div className="discovery-error" role="alert">
        <div className="stack gap-8">
          <h2>{title}</h2>
          <p className="muted">{description}</p>
        </div>
        <a href={retryHref} className={buttonClassName()}>Try again</a>
        {requestId && <p className="small muted mono">Request ID: {requestId}</p>}
      </div>
    </DiscoveryState>
  );
}
