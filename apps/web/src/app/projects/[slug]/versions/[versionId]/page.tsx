import { VersionDocumentation } from '../../../../../features/projects/VersionDocumentation';
import { VersionSources } from '../../../../../features/projects/VersionSources';

import { PageContainer } from '../../../../../components/layout/PageContainer';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DigestValue } from '../../../../../features/projects/DigestValue';
import { StatePanel } from '../../../../../components/composites/StatePanel';
import { ApiRequestError, getVersion, publicApiUrl } from '../../../../../lib/api';
import { formatDate } from '../../../../../lib/format';
import { loadProject } from '../../../../../features/projects/project-loader';
import type { VersionDetail } from '../../../../../lib/schemas';

/** An exact version is its own page: its canonical URL is itself, never the current version. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, versionId } = await params;
  return {
    title: 'Version',
    alternates: { canonical: `/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionId)}` },
  };
}
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string; versionId: string }>;

async function loadExact(projectId: string, versionId: string): Promise<VersionDetail | 'unavailable'> {
  try {
    return await getVersion(projectId, versionId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    return 'unavailable';
  }
}

export default async function VersionPage({ params }: { params: Params }) {
  const { slug, versionId } = await params;
  const project = await loadProject(slug);
  if (project === 'unavailable') {
    return (
      <PageContainer top="standard">
        <StatePanel title="This version could not be loaded" tone="warning" level="h1">
          The registry is unavailable. <Link href="/docs">Read the docs</Link>
        </StatePanel>
      </PageContainer>
    );
  }

  const version = await loadExact(project.project_id, versionId);
  const base = `/projects/${encodeURIComponent(project.slug)}`;
  if (version === 'unavailable') {
    return (
      <PageContainer top="standard">
        <StatePanel title="This version could not be loaded" tone="warning" level="h1">
          Try again in a moment. <Link href={`${base}/versions`}>All versions</Link>
        </StatePanel>
      </PageContainer>
    );
  }

  // The version in the URL is the one shown. A newer one is announced, never swapped in.
  const isCurrent = version.project_version_id === project.current_version.project_version_id;
  const exportUrl = `${publicApiUrl()}/api/v1/projects/${encodeURIComponent(project.project_id)}/export?version=${encodeURIComponent(version.project_version_id)}`;

  return (
    <PageContainer gap={32} top="detail">
      <nav aria-label="Breadcrumb" className="small muted">
        <Link href="/">Home</Link> / <Link href={base}>{project.name}</Link> /{' '}
        <Link href={`${base}/versions`}>Versions</Link> / <span className="mono">v{version.spec_version}</span>
      </nav>

      <section className="stack gap-8">
        <h1>
          {project.name} <span className="mono muted">v{version.spec_version}</span>
        </h1>
        <p className="muted">
          {isCurrent ? 'This is the current version.' : 'This is a historical version. Its content is unchanged.'}
          {' '}Published {formatDate(version.published_at)}.
        </p>
        {!isCurrent && (
          <div className="notice" role="note">
            <h2>A newer version is available</h2>
            <p>
              The current version is <span className="mono">v{project.current_version.spec_version}</span>.{' '}
              <Link href={`${base}/versions/${encodeURIComponent(project.current_version.project_version_id)}`}>
                View the current version
              </Link>
              . What you are reading will not change.
            </p>
          </div>
        )}
        <div>
          <a href={exportUrl} className="button button-primary" download>
            Export PROJECT.md
          </a>
        </div>
      </section>

      <section aria-labelledby="identity" className="stack gap-8">
        <h2 id="identity">Identity</h2>
        <dl className="definition-list">
          <div>
            <dt>Version ID</dt>
            <dd className="mono break-all">{version.project_version_id}</dd>
          </div>
          <div>
            <dt>Content digest</dt>
            <dd>
              <DigestValue value={version.content_digest} />
            </dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd className="mono">{version.schema}</dd>
          </div>
          <div>
            <dt>Listing</dt>
            <dd>
              {version.attribution.listing_origin === 'curated_from_upstream' ? 'Curated listing' : 'Creator submitted'}
              {version.attribution.submitted_by?.handle ? `, submitted by ${version.attribution.submitted_by.handle}` : ''}
            </dd>
          </div>
        </dl>
      </section>

      <VersionSources version={version} />

      {version.acknowledged_warning_codes.length > 0 && (
        <section aria-labelledby="ack" className="stack gap-8">
          <h2 id="ack">Warnings acknowledged at publication</h2>
          <ul className="compact-list">
            {version.acknowledged_warning_codes.map((code) => (
              <li key={code} className="mono">{code}</li>
            ))}
          </ul>
        </section>
      )}

      <VersionDocumentation markdown={version.markdown} />
    </PageContainer>
  );
}
