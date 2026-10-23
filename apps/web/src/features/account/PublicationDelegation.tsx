'use client';
import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/StatusDot';
import { ConfirmationSection } from '../../components/composites/ConfirmationSection';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest } from '../../lib/browser-request';
import { formatDate } from '../../lib/format';
import type { ConnectionsData, DelegatedPublication } from '../../lib/browser-schemas';

type Connection = ConnectionsData['items'][number];

const RECORD_LABEL: Record<string, string> = { build: 'Build', test_result: 'Test result', collection: 'Collection', troubleshooting: 'Troubleshooting note' };
/** The owner's withdrawal route for each record kind a connection can publish. */
const WITHDRAW_PATH: Record<string, string> = { build: 'builds', test_result: 'test-results', collection: 'collections', troubleshooting: 'troubleshooting-notes' };

/**
 * "Publish without asking me" for one connection (FRONTEND_PRD section 12.3):
 * off by default, turned on only after a confirmation that names the client,
 * and the list of what the connection published that way.
 */
export function PublicationDelegation({ item, name }: { item: Connection; name: string }) {
  const id = useId();
  const [delegated, setDelegated] = useState(item.publication_delegated);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = useRequestFeedback();
  const turnOn = useRef<HTMLButtonElement>(null);
  const canPublish = item.scopes.some((scope) => scope.endsWith(':publish'));
  if (!canPublish && !delegated && item.delegated_publications.length === 0) return null;
  async function change(on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await browserRequest(`/api/v1/me/connections/${encodeURIComponent(item.connection_id)}/publication-delegation`, { method: on ? 'PUT' : 'DELETE' });
      setDelegated(on); setConfirming(false);
      state.setFeedback({ message: on ? `${name} can now publish drafts it creates for you without asking.` : `${name} needs your approval for each publication again.`, error: false });
    } catch (error) {
      state.setFeedback({ message: error instanceof Error ? error.message : 'The setting could not be confirmed. Refresh before retrying.', error: true });
    } finally { setBusy(false); }
  }
  return (
    <section className="stack gap-12 integration-detail" aria-labelledby={`${id}-title`}>
      <div className="integration-head">
        <div className="stack gap-4 integration-identity">
          <h3 id={`${id}-title`} className="row-heading">Publish without asking me</h3>
          <StatusDot tone={delegated ? 'caution' : 'neutral'}>{delegated ? 'On' : 'Off'}</StatusDot>
          <p className="small muted">{delegated
            ? `${name} publishes drafts it creates for you without a review page. It still names the exact draft and acknowledges every warning, and each publication is labeled publicly as published without per-version review.`
            : 'Each publication needs your approval of the exact draft on its review page.'}</p>
        </div>
        <div className="integration-actions">
          {delegated
            ? <Button size="small" loading={busy} onClick={() => change(false)}>Turn off</Button>
            : canPublish && <Button ref={turnOn} size="small" aria-expanded={confirming} aria-controls={`${id}-confirm`} disabled={busy} onClick={() => setConfirming(true)}>Turn on</Button>}
        </div>
      </div>
      {confirming && !delegated && <ConfirmationSection id={`${id}-confirm`} level="h3" title={`Let ${name} publish without asking?`}
        actions={<>
          <Button variant="primary" loading={busy} onClick={() => change(true)}>Let it publish without asking</Button>
          <Button disabled={busy} onClick={() => { setConfirming(false); turnOn.current?.focus(); }}>Cancel</Button>
        </>}>
        <ul className="compact-list small">
          <li>Drafts this connection creates in your account can be published publicly without this site asking you first, for every kind it has permission to publish.</li>
          <li>Each publication is labeled as published by {name} without per-version review. The name is reported by the application and is not verified.</li>
          <li>You can turn this off here at any time. What it already published stays published until you unpublish or withdraw it below.</li>
        </ul>
      </ConfirmationSection>}
      <RequestFeedback feedback={state.feedback} />
      {item.delegated_publications.length > 0 && <div className="stack gap-8">
        <h4 className="small">Published without asking</h4>
        <ul className="compact-list">{item.delegated_publications.map((publication) => <PublishedItem key={publication.draft_id} publication={publication} />)}</ul>
      </div>}
    </section>
  );
}

/** One delegated publication, with its link and the owner's way to take it down. */
function PublishedItem({ publication }: { publication: DelegatedPublication }) {
  const id = useId();
  const [visibility, setVisibility] = useState(publication.project?.visibility ?? publication.record_visibility);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = useRequestFeedback();
  const project = publication.project;
  const withdrawPath = WITHDRAW_PATH[publication.kind];
  const live = project ? visibility === 'published' : visibility === 'public';
  const action = project
    ? `/api/v1/projects/${encodeURIComponent(project.project_id)}/${live ? 'unpublish' : 'republish'}`
    : withdrawPath && publication.record_id ? `/api/v1/${withdrawPath}/${encodeURIComponent(publication.record_id)}/withdraw` : null;
  async function run() {
    if (busy || !action) return;
    setBusy(true);
    try {
      await browserRequest(action, { method: 'POST' });
      setVisibility(project ? (live ? 'unpublished' : 'published') : 'withdrawn'); setConfirming(false); state.setFeedback(null);
    } catch (error) {
      state.setFeedback({ message: error instanceof Error ? error.message : 'The change could not be confirmed. Refresh before retrying.', error: true });
    } finally { setBusy(false); }
  }
  const published = publication.published_at ? `Published ${formatDate(publication.published_at)}` : null;
  return (
    <li className="stack gap-4">
      <div className="meta-line">
        {project && publication.project_version_id
          ? <Link href={`/projects/${encodeURIComponent(project.slug)}/versions/${encodeURIComponent(publication.project_version_id)}`}>{project.slug} version {project.version_number}</Link>
          : <span>{RECORD_LABEL[publication.kind] ?? publication.kind} <span className="mono">{publication.record_id}</span></span>}
        {published && <span>{published}</span>}
        {visibility && !live && <span>{visibility === 'withdrawn' ? 'Withdrawn' : visibility === 'unpublished' ? 'Unpublished' : visibility === 'quarantined' ? 'Quarantined' : visibility}</span>}
        {action && visibility !== 'quarantined' && visibility !== 'withdrawn' && (live
          ? <Button size="small" className="button-quiet-danger" aria-expanded={confirming} aria-controls={`${id}-confirm`} disabled={busy} onClick={() => setConfirming(true)}>{project ? 'Unpublish project' : 'Withdraw'}</Button>
          : project && <Button size="small" loading={busy} onClick={run}>Republish project</Button>)}
      </div>
      {confirming && live && <ConfirmationSection id={`${id}-confirm`} level="h3" tone="danger"
        title={project ? `Unpublish ${project.slug}?` : `Withdraw this ${(RECORD_LABEL[publication.kind] ?? publication.kind).toLowerCase()}?`}
        actions={<>
          <Button className="button-danger" loading={busy} onClick={run}>{project ? 'Unpublish project' : 'Withdraw'}</Button>
          <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
        </>}>
        <p className="small">{project
          ? 'The whole project, including versions you approved yourself, is hidden from public pages and search. Its history is kept, and you can republish it.'
          : `It is removed from public pages and search.${publication.kind === 'build' ? ' Test results reported against this build are withdrawn with it.' : ''} Withdrawal cannot be undone.`}</p>
      </ConfirmationSection>}
      <RequestFeedback feedback={state.feedback} />
    </li>
  );
}
