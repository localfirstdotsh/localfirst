import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { catalogPreviewEnabled } from '../../lib/catalog-preview';
import Link from 'next/link';
import { DiscoveryPage, DiscoveryState } from '../../components/layout/DiscoveryPage';
import { EmptyState } from '../../components/composites/EmptyState';
import { buttonClassName } from '../../components/ui/Button';

export const metadata: Metadata = { title: 'Builds', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function BuildsPage() {
  if (!catalogPreviewEnabled()) redirect('/docs');
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
