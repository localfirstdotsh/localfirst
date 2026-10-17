import { DetailsList } from '../../components/composites/DetailsList';
import type { DraftReview } from '../../lib/browser-schemas';

export function ReviewSummary({ data }: { data: DraftReview }) {
  const { spec, source, projection, environments } = data.review;
  const kind = data.draft.kind;
  if (kind !== 'project') {
    const payload = projection?.payload as Record<string, unknown> | undefined;
    const title = kind === 'collection' ? 'Collection' : kind === 'troubleshooting' ? 'Troubleshooting note' : kind === 'build' ? 'Build contribution' : 'Test report contribution';
    const rows: Array<[string, string]> = [['Artifact', title], ['Source project', source?.project.name ?? 'Project context unavailable'], ['Source version', source?.project.version ?? 'Not available'], ['Publication', 'Only the selected fields become public'], ['Evidence', 'Not verified by publication']];
    if (kind === 'collection' || kind === 'troubleshooting') rows.push(['Title', String(payload?.title ?? 'Not supplied')], ['Attribution', 'Your contribution, with cited sources and license'], ['Review', 'Pending operator review after publication'], ['Endorsement', 'No upstream author endorsement or verification implied']);
    else if (projection && kind === 'build') {
      const bindings = Array.isArray(projection.model_bindings) ? projection.model_bindings as Array<Record<string, unknown>> : [];
      rows.push(['Models', bindings.map((binding) => String(binding.runtime_model_id ?? 'Name not included in this projection')).join(', ') || 'No model bindings included']);
      const runtime = projection.runtime as Record<string, unknown> | undefined;
      if (runtime) rows.push(['Runtime', [runtime.family, runtime.application_version].filter(Boolean).join(' ')]);
      rows.push(['Hardware', projection.hardware ? 'Coarse details included in the projection' : 'Not included in the public projection']);
    } else if (projection) rows.push(['Reported outcome', String(projection.outcome ?? 'Not supplied')], ['Test', String(projection.test_key ?? 'Not supplied')], ['Test scope', String(projection.scope ?? 'Not supplied')]);
    return <section className="stack gap-16"><h2>{title}</h2>{source && <p>{source.project.summary}</p>}<p className="small muted">This summary is a reading aid. Inspect the exact public projection below. Publication leaves this contribution pending review.</p><DetailsList rows={rows} /></section>;
  }
  if (!spec) return <section className="stack gap-8"><h2>Project documentation</h2><p className="muted">A summary is unavailable until this document passes validation. Inspect the exact artifact below.</p></section>;
  return <div className="stack gap-24"><section className="stack gap-16"><h2>{spec.project.name}</h2><p>{spec.project.summary}</p><DetailsList rows={[
    ['Artifact', `${spec.project.type} · Version ${spec.project.version}`], ['Publication', 'Public registry entry after your agent publishes'], ['License', spec.project.license.state === 'known' ? spec.project.license.id : spec.project.license.state], ['Attribution', spec.attribution.authors.map((author) => author.name).join(', ')], ['Models', spec.models.state === 'unknown' ? 'Requirements unknown' : `${spec.models.state} · ${spec.models.roles.map((role) => role.key).join(', ') || 'No roles declared'}`], ['Runtimes', `${spec.runtimes.state} · ${spec.runtimes.supported.map((runtime) => runtime.family).join(', ') || 'None declared'}`],
  ]} /></section>
    {(environments ?? []).map((environment) => <section className="stack gap-16" key={environment.key}><h2>Agent environment: {environment.key}</h2><DetailsList rows={[
      ['Agent roles', environment.model_roles.map((role) => role.key).join(', ')], ['Workflow steps', environment.nodes.map((node) => node.id).join(' → ')], ['Model selection', 'One installed local model shared by these roles; selected and checked locally'], ['Local profile', data.profiles.declarative && (!environment.framework || data.profiles.framework) ? 'Supported profile; prepare and approve execution in your local runner' : 'Documentation available; local handoff disabled in this deployment'], ['Project code', environment.framework ? 'Pinned creator module in an isolated container; separate dependency setup and execution approvals' : 'No project code; trusted declarative coordinator'], ['Test scope', 'Workflow fixture outcomes; excludes inbox, booking, payment and POS integrations'],
    ]} /></section>)}
  </div>;
}
