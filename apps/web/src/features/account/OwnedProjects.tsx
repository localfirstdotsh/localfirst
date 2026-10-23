import Link from 'next/link';
import { PageHeader } from '../../components/composites/PageHeader';
import { EmptyState } from '../../components/composites/EmptyState';
import { ProjectRow } from './ProjectRow';
import type { OwnedProject } from '../../lib/browser-schemas';

export function OwnedProjects({ items }: { items: OwnedProject[] }) {
  return <>
    <PageHeader title="My projects">Projects you manage, with how often each has been requested.</PageHeader>
    {items.length > 0 && <section className="stack gap-12" aria-label="Projects">
      <ul className="list-group">{items.map((item) => <ProjectRow key={item.project_id} project={item} />)}</ul>
      <details className="inline-help"><summary>About these counts</summary><p className="small muted">Counts are requests, not people, installs, builds, or runs. <Link href="/privacy">How counting works</Link>.</p></details>
    </section>}
    {items.length === 0 && <EmptyState compact icon={null} title="No projects yet" description="Projects you publish through your connected agent appear here." />}
  </>;
}
