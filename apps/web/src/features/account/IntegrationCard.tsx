'use client';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { StatusDot } from '../../components/ui/StatusDot';
import { ConfirmationSection } from '../../components/composites/ConfirmationSection';
import { DetailsList } from '../../components/composites/DetailsList';
import { PermissionGroup, PermissionSummary, groupScopes } from '../auth';
import type { ConnectionsData } from '../../lib/browser-schemas';

type Connection = ConnectionsData['items'][number];

/** One connected application: who it says it is, what it can do in a line each, and the controls to inspect or end it. */
export function IntegrationCard({ item, data, busy, locked, onRevoke }: {
  item: Connection;
  data: ConnectionsData;
  /** This connection is being revoked. */
  busy: boolean;
  /** Another connection is being revoked. */
  locked: boolean;
  onRevoke: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const name = item.client_name?.trim() || 'Unnamed application';
  const groups = groupScopes(item.scopes, data.scope_descriptions);
  const details = [item.created_at && `Connected ${item.created_at.slice(0, 10)}`, `${item.scopes.length} ${item.scopes.length === 1 ? 'permission' : 'permissions'}`, new URL(data.resource).hostname].filter(Boolean).join(' · ');
  return (
    <article className="panel integration-card" aria-labelledby={`${id}-name`}>
      <header className="integration-head">
        <div className="stack gap-4 integration-identity">
          <h2 id={`${id}-name`} className="row-heading">{name}</h2>
          <StatusDot tone="caution">Identity not verified</StatusDot>
          <p className="small muted">{item.client_name ? 'Application name is self-reported, unverified.' : 'The application did not provide a display name.'}</p>
        </div>
        <div className="integration-actions">
          <Button size="small" aria-expanded={open} aria-controls={`${id}-access`} onClick={() => setOpen(!open)}>Manage access<Icon name="chevron" className="disclosure-chevron" /></Button>
          <Button ref={revokeButton} size="small" className="button-quiet-danger" aria-expanded={confirming} aria-controls={`${id}-revoke`} disabled={locked || busy} onClick={() => setConfirming(true)}>Revoke access</Button>
        </div>
      </header>
      <p className="small muted">{details}</p>
      <PermissionSummary groups={groups} />
      {open && <div id={`${id}-access`} className="stack gap-16 integration-detail">
        {groups.map((group) => <PermissionGroup key={group.level} group={group} descriptions={data.scope_descriptions} />)}
        <details className="inline-help"><summary>Technical details</summary><DetailsList rows={[['Client identifier', item.client_id], ['Resource', data.resource], ['Authorized', item.created_at], ['Updated', item.updated_at]]} /></details>
      </div>}
      {confirming && <ConfirmationSection id={`${id}-revoke`} level="h3" tone="danger" title={`Revoke access for ${name}?`}
        actions={<>
          <Button className="button-danger" loading={busy} disabled={locked} onClick={onRevoke}>Confirm revocation</Button>
          <Button disabled={busy} onClick={() => { setConfirming(false); revokeButton.current?.focus(); }}>Cancel</Button>
        </>}>
        <p className="small">This application will lose access to your Localfirst account. Its refresh authorization will be revoked. Published records stay published.</p>
      </ConfirmationSection>}
    </article>
  );
}
