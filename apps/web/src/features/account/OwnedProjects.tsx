import Link from 'next/link';
import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { formatCount, humanize } from '../../lib/format';
import type { OwnedProject } from '../../lib/browser-schemas';
export function OwnedProjects({ items }: { items: OwnedProject[] }) {
  return <div className="stack gap-24"><PageHeader title="My projects">Projects you manage, with how often each has been requested.</PageHeader>
    {items.map((item) => <article className="panel stack gap-8" key={item.project_id}>
      <h2><Link href={`/account/projects/${item.project_id}/usage`}>{item.name}</Link> <Badge>{item.visibility === 'quarantined' ? 'Under review' : humanize(item.visibility)}</Badge></h2>
      <p className="small muted">{item.slug}{item.visibility === 'published' && <> · <Link href={`/projects/${encodeURIComponent(item.slug)}`}>View public page</Link></>}</p>
      <p>{formatCount(item.usage.spec_exports)} specification {item.usage.spec_exports === 1 ? 'export' : 'exports'} · {formatCount(item.usage.agent_retrievals)} agent {item.usage.agent_retrievals === 1 ? 'retrieval' : 'retrievals'}{item.usage.since && <span className="muted"> since {item.usage.since}</span>}</p>
      <p><Link href={`/account/projects/${item.project_id}/usage`}>See requests per day</Link></p>
    </article>)}
    {items.length === 0 && <StatePanel title="No projects yet">Projects you publish through your connected agent appear here.</StatePanel>}
    <p className="small muted">Counts are requests, not people, installs, builds, or runs. <Link href="/privacy">How counting works</Link>.</p>
  </div>;
}
