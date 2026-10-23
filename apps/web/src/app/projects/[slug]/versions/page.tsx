import { PageContainer } from '../../../../components/layout/PageContainer';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DigestValue } from '../../../../features/projects/DigestValue';
import { StatePanel } from '../../../../components/composites/StatePanel';
import { ApiRequestError, listVersions } from '../../../../lib/api';
import { formatDate } from '../../../../lib/format';
import { loadProject } from '../../../../features/projects/project-loader';
import type { VersionList } from '../../../../lib/schemas';

export const metadata: Metadata = { title: 'Versions' };
export const dynamic = 'force-dynamic';

export default async function VersionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await loadProject(slug);
  if (project === 'unavailable') {
    return (
      <PageContainer top="standard">
        <StatePanel title="Versions could not be loaded" tone="warning" level="h1">
          The registry is unavailable. <Link href="/docs">Read the docs</Link>
        </StatePanel>
      </PageContainer>
    );
  }

  let versions: VersionList;
  try {
    versions = await listVersions(project.project_id);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    return (
      <PageContainer top="standard">
        <StatePanel title="Versions could not be loaded" tone="warning" level="h1">
          Try again in a moment. <Link href={`/projects/${encodeURIComponent(project.slug)}`}>Back to {project.name}</Link>
        </StatePanel>
      </PageContainer>
    );
  }

  const base = `/projects/${encodeURIComponent(project.slug)}`;
  const items = [...versions.items].sort((a, b) => b.version_number - a.version_number);

  return (
    <PageContainer gap={24} top="detail">
      <nav aria-label="Breadcrumb" className="small muted">
        <Link href="/">Home</Link> / <Link href={base}>{project.name}</Link> / <span>Versions</span>
      </nav>
      <div className="stack gap-8">
        <h1>Versions</h1>
        <p className="muted version-description">
          Every published version is immutable. A link to a version always shows that exact content, even after a newer
          version is published.
        </p>
      </div>
      <ul className="row-list">
        {items.map((version) => (
          <li key={version.project_version_id}>
            <div className="row-main">
              <Link
                href={`${base}/versions/${encodeURIComponent(version.project_version_id)}`}
                className="row-title mono"
              >
                v{version.spec_version}
              </Link>
              <div className="meta-line">
                <span>{version.is_current ? 'Current version' : 'Historical version'}</span>
                <span>Registry version {version.version_number}</span>
                <span>Published {formatDate(version.published_at)}</span>
                {version.publication?.authorization === 'delegated' && <span>Published without per-version review</span>}
              </div>
            </div>
            <div className="row-side">
              <span className="small muted">Content digest</span>
              <DigestValue value={version.content_digest} />
            </div>
          </li>
        ))}
      </ul>
    </PageContainer>
  );
}
