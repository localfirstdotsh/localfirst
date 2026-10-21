import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { catalogPreviewEnabled } from '../../lib/catalog-preview';
import { Suspense } from 'react';
import { DiscoveryPage } from '../../components/layout/DiscoveryPage';
import { DiscoveryLoading } from '../../components/composites/DiscoveryFeedback';
import { ModelsCatalog } from '../../features/references/ModelsCatalog';

export const metadata: Metadata = { title: 'Models', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function ModelsPage() {
  if (!catalogPreviewEnabled()) redirect('/docs');
  return (
    <DiscoveryPage title="Models" description="Explore the AI models powering local projects.">
      <Suspense fallback={<DiscoveryLoading label="models" />}><ModelsCatalog /></Suspense>
    </DiscoveryPage>
  );
}
