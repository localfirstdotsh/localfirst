import Link from 'next/link';
import { PageHeader } from '../../components/composites/PageHeader';
import { SectionHeader } from '../../components/composites/SectionHeader';
import { formatCount } from '../../lib/format';
import type { OwnedUsage } from '../../lib/browser-schemas';
import { UsageChart } from './UsageChart';
export function ProjectUsage({ data }: { data: OwnedUsage }) {
  const { project, range, days } = data;
  return <><nav aria-label="Breadcrumb" className="breadcrumb small muted"><Link href="/account/projects">My projects</Link><span aria-hidden="true">/</span><span aria-current="page">{project.name}</span></nav>
    <PageHeader title="Usage">Requests for this project. Visible only to you and operators.</PageHeader>
    <section className="usage-totals" aria-label="Totals">{[['Specification exports', project.usage.spec_exports], ['Retrieved by agents', project.usage.agent_retrievals]].map(([label, value]) => <div className="panel stack gap-4" key={label}><span className="small muted">{label}</span><strong className="usage-total">{formatCount(value as number)}</strong><span className="small muted">Lifetime{project.usage.since ? ` since ${project.usage.since}` : ''}</span></div>)}</section>
    <nav className="range-switch" aria-label="Range">{[30, 90].map((value) => <Link href={`/account/projects/${project.project_id}/usage?days=${value}`} key={value} aria-current={range === value ? 'page' : undefined}>{value} days</Link>)}</nav>
    <section className="usage-charts">{(['exports', 'retrievals'] as const).map((kind) => <UsageChart key={kind} id={kind} kind={kind} title={kind === 'exports' ? 'Specification exports' : 'Retrieved by agents'} values={days.map((day) => kind === 'exports' ? day.spec_exports : day.agent_retrievals)} firstDay={days[0]?.day ?? ''} lastDay={days.at(-1)?.day ?? ''} />)}</section>
        <section className="stack gap-12" aria-labelledby="recent-days"><SectionHeader id="recent-days" title="Recent days" /><div className="table-scroll" tabIndex={0} role="region" aria-label="Recent days, scrollable"><table className="data"><caption className="visually-hidden">Requests per day, most recent first</caption><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Exports</th><th scope="col">Agent retrievals</th></tr></thead><tbody>{[...days].reverse().slice(0, 14).map((day) => <tr key={day.day}><th scope="row">{day.day}</th><td>{formatCount(day.spec_exports)}</td><td>{formatCount(day.agent_retrievals)}</td></tr>)}</tbody></table></div></section>
    <details className="inline-help"><summary>About these numbers</summary><div className="stack gap-8"><p className="small muted">They are not people, installs, or builds. One person can export many times, and a crawler can too. <Link href="/privacy">How counting works</Link>.</p><p className="small muted">Two separate charts, so no meaning depends on colour. Days are UTC and your own requests are not counted. Counts are approximate: a hard server crash can lose a few seconds.</p></div></details>
  </>;
}
