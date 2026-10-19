import Link from 'next/link';
import {
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  listProjects,
} from '../../lib/api';
import { emptyQuery, selectedFilterCount, toPagePath, type CatalogQuery } from '../../lib/catalog-query';
import { ProjectResult } from './ProjectResult';
import { EmptyState } from '../../components/composites/EmptyState';
import { DiscoveryError } from '../../components/composites/DiscoveryFeedback';
import { DiscoveryState } from '../../components/layout/DiscoveryPage';
import { buttonClassName } from '../../components/ui/Button';
import { catalogEmptyState } from './empty-state';

function CatalogError({ title, description, query, requestId }: {
  title: string;
  description: string;
  query: CatalogQuery;
  requestId?: string | null;
}) {
  return <DiscoveryError title={title} description={description} retryHref={toPagePath(query, { keepCursor: true })} requestId={requestId} />;
}

/** Fetches one page and renders list, empty, or error state. Keeps the query visible on failure. */
export async function CatalogResults({ query, preview = false }: { query: CatalogQuery; preview?: boolean }) {
  try {
    const page = await listProjects(query, preview ? 4 : undefined);

    if (page.items.length === 0) {
      // A filtered empty response cannot tell us whether the registry itself is empty.
      // Probe only in that case, with the smallest supported page, and let failures reach
      // the error state. Populated pages keep their single request.
      const narrowed = Boolean(query.q || query.cursor || selectedFilterCount(query));
      const hasProjects = narrowed && (await listProjects(emptyQuery(), 1)).items.length > 0;
      const state = catalogEmptyState(query, hasProjects);
      return (
        <DiscoveryState>
          <EmptyState
            title={state.title}
            description={state.description}
            action={state.action && <Link href={state.action.href} className={buttonClassName()}>{state.action.label}</Link>}
          />
        </DiscoveryState>
      );
    }

    const nextHref =
      page.has_more && page.next_cursor
        ? toPagePath({ ...query, cursor: page.next_cursor }, { keepCursor: true })
        : null;

    return (
      <div className="catalog-results discovery-list">
        {!preview && <p className="small muted result-count" role="status">
          {`${page.items.length} ${page.items.length === 1 ? 'project' : 'projects'}${query.cursor ? ' on this page' : ''}`}
        </p>}
        <ul className="result-list">
          {page.items.map((project) => (
            <ProjectResult key={project.project_id} project={project} />
          ))}
        </ul>
        {!preview && nextHref && (
          <div className="catalog-pagination">
            <Link href={nextHref} className="button" rel="next">
              Next page
            </Link>
          </div>
        )}
      </div>
    );
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return (
        <CatalogError title="This search was not accepted" description={error.message} query={query} requestId={error.requestId} />
      );
    }
    if (error instanceof ApiContractError) {
      return (
        <CatalogError title="Projects could not be loaded" description="Please try again in a moment." query={query} />
      );
    }
    const requestId = error instanceof ApiUnavailableError ? error.requestId : null;
    return (
      <CatalogError title="Projects could not be loaded" description="Please try again in a moment." query={query} requestId={requestId} />
    );
  }
}
