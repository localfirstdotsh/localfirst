import Link from 'next/link';
import {
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  listProjects,
} from '../../lib/api';
import { emptyQuery, selectedFilterCount, toPagePath, type CatalogQuery } from '../../lib/catalog-query';
import { ProjectResult } from './ProjectResult';
import { StatePanel } from '../../components/composites/StatePanel';
import { EmptyState } from '../../components/composites/EmptyState';
import { buttonClassName } from '../../components/ui/Button';
import { catalogEmptyState } from './empty-state';

function CatalogError({ title, description, query, requestId }: {
  title: string;
  description: string;
  query: CatalogQuery;
  requestId?: string | null;
}) {
  return (
    <div className="catalog-state">
      <div className="catalog-error">
        <StatePanel title={title} tone="warning" requestId={requestId}>
          <p>{description}</p>
          <p className="mt-12"><a href={toPagePath(query, { keepCursor: true })} className={buttonClassName()}>Try again</a></p>
        </StatePanel>
      </div>
    </div>
  );
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
        <div className="catalog-state">
          <EmptyState
            title={state.title}
            description={state.description}
            action={state.action && <Link href={state.action.href} className={buttonClassName()}>{state.action.label}</Link>}
          />
        </div>
      );
    }

    const nextHref =
      page.has_more && page.next_cursor
        ? toPagePath({ ...query, cursor: page.next_cursor }, { keepCursor: true })
        : null;

    return (
      <div className="catalog-results">
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
        <CatalogError title="The registry sent an unexpected response" description="Projects could not be loaded." query={query} />
      );
    }
    const requestId = error instanceof ApiUnavailableError ? error.requestId : null;
    return (
      <CatalogError title="The registry is unavailable" description="Projects could not be loaded." query={query} requestId={requestId} />
    );
  }
}
