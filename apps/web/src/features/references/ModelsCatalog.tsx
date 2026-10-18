import { PageHeader } from '../../components/composites/PageHeader';

import { PageContainer } from '../../components/layout/PageContainer';
import Link from 'next/link';
import { ReferenceError } from './ReferenceStates';
import { StatePanel } from '../../components/composites/StatePanel';
import { REFERENCE_LIST_LIMIT, listModels } from '../../lib/api';
import { humanize, safeExternalUrl } from '../../lib/format';
import type { ModelReference } from '../../lib/schemas';


export async function ModelsCatalog() {
  let models: ModelReference[] | null = null;
  let failure: unknown = null;
  try {
    models = await listModels();
  } catch (error) {
    failure = error;
  }

  return (
    <PageContainer gap={24} top="standard">
      <PageHeader title="Models">
          Models that projects reference. Each is a pointer taken from a project&apos;s declaration: no weights are hosted
          here, and nothing says a model is installed on your machine or that it fits it.
        </PageHeader>

      {failure !== null && <ReferenceError error={failure} what="Models" />}
      {models !== null && models.length === 0 && (
        <StatePanel title="No models are referenced yet">
          Models appear here once a published project declares one.
        </StatePanel>
      )}
      {models !== null && models.length > 0 && (
        <>
          <p className="small muted" role="status">
            {models.length >= REFERENCE_LIST_LIMIT
              ? `Showing the ${REFERENCE_LIST_LIMIT} most referenced models; the list may be longer.`
              : `${models.length} ${models.length === 1 ? 'model' : 'models'}`}
          </p>
          <ul className="row-list">
            {models.map((model) => {
              const source = safeExternalUrl(model.source_url);
              return (
                <li key={model.model_reference_id}>
                  <div className="row-main">
                    <span className="row-title">{model.display_name ?? model.key}</span>
                    <div className="meta-line">
                      <span className="mono">{model.key}</span>
                      <span>Family: {model.family ? humanize(model.family) : 'Not supplied'}</span>
                      <span>License: {model.license_id ?? humanize(model.license_state)}</span>
                      <span>Identity: {model.identity_scheme ? humanize(model.identity_scheme) : 'Unresolved'}</span>
                    </div>
                    {source && (
                      <p className="small mt-6">
                        <a href={source.href} target="_blank" rel="noopener noreferrer nofollow">
                          Source: {source.host}
                          <span className="visually-hidden"> (opens in a new tab)</span>
                        </a>
                      </p>
                    )}
                  </div>
                  <div className="row-side">
                    <Link href={`/projects?model=${encodeURIComponent(model.key)}`}>
                      {model.project_count} {model.project_count === 1 ? 'project' : 'projects'}
                    </Link>
                    <span className="small muted">Referenced by current published versions</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
