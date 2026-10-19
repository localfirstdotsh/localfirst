import type { Metadata } from 'next';
import Link from 'next/link';
import { DiscoveryPage, DiscoveryState } from '../../components/layout/DiscoveryPage';
import { EmptyState } from '../../components/composites/EmptyState';
import { buttonClassName } from '../../components/ui/Button';

export const metadata: Metadata = { title: 'Builds' };

export default function BuildsPage() {
  return (
    <DiscoveryPage title="Builds" description="Explore how local AI projects are configured and run.">
      <DiscoveryState>
        <EmptyState title="Build discovery is coming soon"
          description="Explore projects in the meantime to discover what's being built."
          action={<Link href="/projects" className={buttonClassName()}>Browse projects</Link>} />
      </DiscoveryState>
    </DiscoveryPage>
  );
}
