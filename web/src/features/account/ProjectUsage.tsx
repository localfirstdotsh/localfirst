import Link from 'next/link';
import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { formatCount } from '../../lib/format';
import type { OwnedUsage } from '../../lib/browser-schemas';
import { UsageChart } from './UsageChart';
export function ProjectUsage({ data }: { data: OwnedUsage }) {
  const { project, range, days } = data;
  return <div className="stack gap-24"><p className="small muted"><Link href="/account/projects">My projects</Link> / {project.name}</p>
    <PageHeader title="Usage">Requests for this project. Visible only to you and operators.</PageHeader>
    <section className="card-grid" aria-label="Totals">{[['Specification exports', project.usage.spec_exports], ['Retrieved by agents', project.usage.agent_retrievals]].map(([label, value]) => <div className="panel stack gap-8" key={label}><span>{label}</span><strong className="usage-total">{formatCount(value as number)}</strong><span className="small muted">Lifetime{project.usage.since ? ` since ${project.usage.since}` : ''}</span></div>)}</section>
    <nav className="browser-actions" aria-label="Range">{[30, 90].map((value) => <Link href={`/account/projects/${project.project_id}/usage?days=${value}`} key={value} aria-current={range === value ? 'page' : undefined}>{value} days</Link>)}</nav>
    <section className="card-grid">{(['exports', 'retrievals'] as const).map((kind) => <UsageChart key={kind} id={kind} kind={kind} title={kind === 'exports' ? 'Specification exports' : 'Retrieved by agents'} values={days.map((day) => kind === 'exports' ? day.spec_exports : day.agent_retrievals)} firstDay={days[0]?.day ?? ''} lastDay={days.at(-1)?.day ?? ''} />)}</section>
    <p className="small muted">Two separate charts, so no meaning depends on colour. Days are UTC and your own requests are not counted. Counts are approximate: a hard server crash can lose a few seconds.</p>
    <section className="stack gap-16" aria-labelledby="recent-days"><h2 id="recent-days">Recent days</h2><div className="table-scroll" tabIndex={0} role="region" aria-label="Recent days, scrollable"><table className="data"><caption className="visually-hidden">Requests per day, most recent first</caption><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Exports</th><th scope="col">Agent retrievals</th></tr></thead><tbody>{[...days].reverse().slice(0, 14).map((day) => <tr key={day.day}><th scope="row">{day.day}</th><td>{formatCount(day.spec_exports)}</td><td>{formatCount(day.agent_retrievals)}</td></tr>)}</tbody></table></div></section>
    <StatePanel title="What these numbers are not">They are not people, installs, or builds. One person can export many times, and a crawler can too.</StatePanel><p className="small muted"><Link href="/privacy">How counting works</Link></p>
  </div>;
}
