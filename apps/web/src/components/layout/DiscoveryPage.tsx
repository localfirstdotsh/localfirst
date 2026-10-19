import type { ReactNode } from 'react';
import { PageHeader } from '../composites/PageHeader';

/** One shell for public discovery, with controls above a flexible results region. */
export function DiscoveryPage({ title, description, controls, children }: {
  title: string;
  description: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="container stack gap-24 page-top-standard discovery-page">
      <PageHeader title={title}>{description}</PageHeader>
      {controls}
      <section className="discovery-results" aria-labelledby="discovery-results-heading">
        <h2 id="discovery-results-heading" className="visually-hidden">Results</h2>
        {children}
      </section>
    </div>
  );
}

/** Empty, loading, and failed results share the available space without adding a card. */
export function DiscoveryState({ children }: { children: ReactNode }) {
  return <div className="discovery-state">{children}</div>;
}
