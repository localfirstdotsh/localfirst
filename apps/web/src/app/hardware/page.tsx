import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DiscoveryPage } from '../../components/layout/DiscoveryPage';
import { DiscoveryLoading } from '../../components/composites/DiscoveryFeedback';
import { HardwareCatalog } from '../../features/references/HardwareCatalog';

export const metadata: Metadata = { title: 'Hardware' };
export const dynamic = 'force-dynamic';

export default function HardwarePage() {
  return (
    <DiscoveryPage title="Hardware" description="Discover the devices and hardware used to run local AI.">
      <Suspense fallback={<DiscoveryLoading label="hardware" />}><HardwareCatalog /></Suspense>
    </DiscoveryPage>
  );
}
