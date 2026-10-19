import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DiscoveryPage } from '../../components/layout/DiscoveryPage';
import { DiscoveryLoading } from '../../components/composites/DiscoveryFeedback';
import { ModelsCatalog } from '../../features/references/ModelsCatalog';

export const metadata: Metadata = { title: 'Models' };
export const dynamic = 'force-dynamic';

export default function ModelsPage() {
  return (
    <DiscoveryPage title="Models" description="Explore the AI models powering local projects.">
      <Suspense fallback={<DiscoveryLoading label="models" />}><ModelsCatalog /></Suspense>
    </DiscoveryPage>
  );
}
