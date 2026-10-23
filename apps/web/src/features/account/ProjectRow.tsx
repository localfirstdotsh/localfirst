import Link from 'next/link';
import { Icon } from '../../components/ui/Icon';
import { StatusDot } from '../../components/ui/StatusDot';
import { formatCount } from '../../lib/format';
import type { OwnedProject } from '../../lib/browser-schemas';

const STATUS = {
  published: { tone: 'positive', label: 'Published' },
  unpublished: { tone: 'neutral', label: 'Unpublished' },
  quarantined: { tone: 'caution', label: 'Under review' },
} as const;

/** Identity, status, usage and actions in one scannable line that stacks on narrow screens. */
export function ProjectRow({ project }: { project: OwnedProject }) {
  const status = STATUS[project.visibility as keyof typeof STATUS] ?? { tone: 'neutral', label: project.visibility };
  const usage = `/account/projects/${project.project_id}/usage`;
  return (
    <li className="project-row">
      <div className="project-identity">
        <h2 className="row-heading"><Link href={usage}>{project.name}</Link></h2>
        <p className="small muted"><span className="mono project-slug">{project.slug}</span></p>
        <StatusDot tone={status.tone}>{status.label}</StatusDot>
      </div>
      <div className="project-stats">
        <dl className="project-metrics">
          <div><dt className="small muted">Specification exports</dt><dd>{formatCount(project.usage.spec_exports)}</dd></div>
          <div><dt className="small muted">Agent retrievals</dt><dd>{formatCount(project.usage.agent_retrievals)}</dd></div>
        </dl>
        {project.usage.since && <p className="small muted project-since">Counting since {project.usage.since}</p>}
      </div>
      <div className="project-actions">
        <Link href={usage} className="row-action"><Icon name="chart" />Requests per day</Link>
        {project.visibility === 'published' && <Link href={`/projects/${encodeURIComponent(project.slug)}`} className="row-action"><Icon name="external" />View public page</Link>}
      </div>
    </li>
  );
}
