import { PageContainer } from '../../../components/layout/PageContainer';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckRequirements } from '../../../features/projects/CheckRequirements';
import { EvidenceBadge } from '../../../features/projects/EvidenceBadge';
import { StatePanel } from '../../../components/composites/StatePanel';
import { publicApiUrl } from '../../../lib/api';
import {
  EVIDENCE,
  formatCount,
  formatDate,
  humanize,
  listOrUnknown,
  testSupportSummary,
} from '../../../lib/format';
import { loadProject } from '../../../features/projects/project-loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const project = await loadProject(slug).catch(() => 'unavailable' as const);
  if (project === 'unavailable') return { title: 'Project' };
  return {
    title: project.name,
    description: project.summary,
    alternates: { canonical: `/projects/${encodeURIComponent(project.slug)}` },
  };
}

export default async function ProjectPage({ params }: { params: Params }) {
  const { slug } = await params;
  const project = await loadProject(slug);

  if (project === 'unavailable') {
    return (
      <PageContainer top="standard">
        <StatePanel title="This project could not be loaded" tone="warning" level="h1">
          The registry is unavailable. <Link href="/docs">Read the docs</Link>
        </StatePanel>
      </PageContainer>
    );
  }

  const evidence = EVIDENCE[project.evidence_level];
  const current = project.current_version;
  const exportUrl = `${publicApiUrl()}/api/v1/projects/${encodeURIComponent(project.project_id)}/export?version=${encodeURIComponent(current.project_version_id)}`;
  const base = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <PageContainer gap={32} top="detail">
      <nav aria-label="Breadcrumb" className="small muted">
        <Link href="/">Home</Link> / <span>{project.name}</span> /{' '}
        <span className="mono">v{current.spec_version}</span>
      </nav>

      <section className="spread project-heading">
        <div className="stack gap-8 project-description">
          <h1>{project.name}</h1>
          <p>{project.summary}</p>
          <div className="meta-line">
            <span>Type: {humanize(project.type)}</span>
            <span>{project.listing_origin === 'curated_from_upstream' ? 'Curated listing' : 'Creator submitted'}</span>
            {project.manager.handle && <span>Submitted by {project.manager.handle}</span>}
            <span>Updated {formatDate(project.updated_at)}</span>
          </div>
          <p className="small">
            Viewing <span className="mono">v{current.spec_version}</span> (current) ·{' '}
            <Link href={`${base}/versions`}>All versions</Link> ·{' '}
            <Link href={`${base}/versions/${encodeURIComponent(current.project_version_id)}`}>View specification</Link>
          </p>
        </div>
        <div className="stack gap-8 project-export">
          <a href={exportUrl} className="button button-primary" download>
            Export PROJECT.md
          </a>
          <p className="small muted">Exports the canonical specification for this version. No code is cloned and no model is installed.</p>
        </div>
      </section>

      <section aria-labelledby="evidence" className="stack gap-8">
        <h2 id="evidence">Evidence</h2>
        <div className="panel stack gap-8">
          <div>
            <EvidenceBadge level={project.evidence_level} />
          </div>
          {evidence && <p className="muted">{evidence.description}</p>}
        </div>
      </section>

      <section aria-labelledby="declared" className="stack gap-8">
        <h2 id="declared">Declared requirements</h2>
        <p className="small muted">Creator declarations. Not measured on any machine.</p>
        <dl className="definition-list">
          <div>
            <dt>Runtimes</dt>
            <dd>{listOrUnknown(project.runtime_families)}</dd>
          </div>
          <div>
            <dt>Architectures</dt>
            <dd>{listOrUnknown(project.architectures, 'Unknown')}</dd>
          </div>
          <div>
            <dt>Operating systems</dt>
            <dd>{listOrUnknown(project.operating_systems, 'Unknown')}</dd>
          </div>
          <div>
            <dt>Required model capabilities</dt>
            <dd>{listOrUnknown(project.required_capabilities, 'Not applicable')}</dd>
          </div>
          <div>
            <dt>License</dt>
            <dd>{project.license.id ?? humanize(project.license.state)}</dd>
          </div>
          <div>
            <dt>Offline</dt>
            <dd>{project.offline_declared === 'unknown' ? 'Offline status unknown' : `Declared: ${humanize(project.offline_declared)}`}</dd>
          </div>
          <div>
            <dt>Sources pinned</dt>
            <dd>{project.sources_pinned ? 'Yes' : 'No — source content is not pinned to a digest'}</dd>
          </div>
          <div>
            <dt>Test support</dt>
            <dd>{testSupportSummary(project.test_support)}</dd>
          </div>
        </dl>
      </section>

      <CheckRequirements projectId={project.project_id} versionId={current.project_version_id} />

      {project.usage && (
        <section aria-labelledby="usage" className="stack gap-8">
          <h2 id="usage">Usage</h2>
          <dl className="definition-list">
            <div>
              <dt>Specification exports</dt>
              <dd>{formatCount(project.usage.spec_exports)}</dd>
            </div>
            <div>
              <dt>Retrieved by agents</dt>
              <dd>{formatCount(project.usage.agent_retrievals)}</dd>
            </div>
          </dl>
          <p className="small muted">
            Request counts{project.usage.since ? ` since ${project.usage.since}` : ''}. They do not show a project was
            built or run.
          </p>
        </section>
      )}
    </PageContainer>
  );
}
