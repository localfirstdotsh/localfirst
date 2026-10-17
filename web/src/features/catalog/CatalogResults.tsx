import Link from 'next/link';
import {
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  listProjects,
} from '../../lib/api';
import { selectedFilterCount, toPagePath, withoutSearchText, type CatalogQuery } from '../../lib/catalog-query';
import { ProjectResult } from './ProjectResult';
import { StatePanel } from '../../components/composites/StatePanel';

/** Fetches one page and renders list, empty, or error state. Keeps the query visible on failure. */
export async function CatalogResults({ query, preview = false }: { query: CatalogQuery; preview?: boolean }) {
  try {
    const page = await listProjects(query, preview ? 4 : undefined);

    if (page.items.length === 0) {
      const filters = selectedFilterCount(query) > 0;
      if (filters) {
        return (
          <StatePanel title="No projects match these filters">
            Nothing fits the selected filters{query.q ? ' and search' : ''}. <Link href="/projects">Clear filters</Link>
          </StatePanel>
        );
      }
      if (query.q) {
        return (
          <StatePanel title="No projects match this search">
            Nothing matched “{query.q}”. Check the spelling or try fewer words.{' '}
            <Link href={toPagePath(withoutSearchText(query))}>Clear search</Link>
          </StatePanel>
        );
      }
      return (
        <StatePanel title="No published projects yet">
          The registry has no published records in this environment.
        </StatePanel>
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
        <StatePanel title="This search was not accepted" tone="warning" requestId={error.requestId}>
          {error.message} <Link href="/projects">Clear filters</Link>
        </StatePanel>
      );
    }
    if (error instanceof ApiContractError) {
      return (
        <StatePanel title="The registry sent an unexpected response" tone="warning">
          Nothing is shown rather than guessing. <a href={toPagePath(query, { keepCursor: true })}>Try again</a>
        </StatePanel>
      );
    }
    const requestId = error instanceof ApiUnavailableError ? error.requestId : null;
    return (
      <StatePanel title="The registry is unavailable" tone="warning" requestId={requestId}>
        Projects could not be loaded. <a href={toPagePath(query, { keepCursor: true })}>Try again</a>
      </StatePanel>
    );
  }
}
