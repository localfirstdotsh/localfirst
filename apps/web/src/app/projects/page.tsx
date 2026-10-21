import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { catalogPreviewEnabled } from '../../lib/catalog-preview';
import { Suspense } from 'react';
import { ActiveFilters, CatalogControls } from '../../features/catalog/CatalogFilters';
import { CatalogResults } from '../../features/catalog/CatalogResults';
import { ResultsSkeleton } from '../../features/catalog/ResultsSkeleton';
import { StatePanel } from '../../components/composites/StatePanel';
import { DiscoveryPage } from '../../components/layout/DiscoveryPage';
import { parseCatalogQuery, toPagePath, type RawSearchParams } from '../../lib/catalog-query';

export const metadata: Metadata = { title: 'Projects', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  if (!catalogPreviewEnabled()) redirect('/docs');
  const { query, rejected } = parseCatalogQuery(await searchParams);

  return (
    <DiscoveryPage title="Projects" description="Discover local AI applications, workflows, and builds." controls={
      <>
        <CatalogControls query={query} />
        {rejected.length > 0 && (
          <StatePanel title="Some filters were ignored" tone="warning">
            These are not supported and were not applied: <span className="mono">{rejected.join(', ')}</span>
          </StatePanel>
        )}
        <ActiveFilters query={query} />
      </>
    }>
      <Suspense key={toPagePath(query, { keepCursor: true })} fallback={<ResultsSkeleton rows={2} />}>
        <CatalogResults query={query} />
      </Suspense>
    </DiscoveryPage>
  );
}
