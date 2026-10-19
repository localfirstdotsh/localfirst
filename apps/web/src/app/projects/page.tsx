import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ActiveFilters, CatalogControls } from '../../features/catalog/CatalogFilters';
import { CatalogResults } from '../../features/catalog/CatalogResults';
import { ResultsSkeleton } from '../../features/catalog/ResultsSkeleton';
import { StatePanel } from '../../components/composites/StatePanel';
import { parseCatalogQuery, toPagePath, type RawSearchParams } from '../../lib/catalog-query';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const { query, rejected } = parseCatalogQuery(await searchParams);

  return (
    <div className="container stack gap-24 page-top catalog-page">
      <header className="stack gap-8">
        <h1>Projects</h1>
        <p className="muted">Discover local AI applications, workflows, and builds.</p>
      </header>
      <CatalogControls query={query} />
      {rejected.length > 0 && (
        <StatePanel title="Some filters were ignored" tone="warning">
          These are not supported and were not applied: <span className="mono">{rejected.join(', ')}</span>
        </StatePanel>
      )}
      <ActiveFilters query={query} />
      <section className="catalog-content" aria-labelledby="project-results">
        <h2 id="project-results" className="visually-hidden">Results</h2>
        <Suspense key={toPagePath(query, { keepCursor: true })} fallback={<ResultsSkeleton rows={2} />}>
          <CatalogResults query={query} />
        </Suspense>
      </section>
    </div>
  );
}
