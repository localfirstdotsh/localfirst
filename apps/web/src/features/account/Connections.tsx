'use client';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { DetailsList } from '../../components/composites/DetailsList';
import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { ApplicationIdentity, Permissions, SecurityNotice } from '../auth';
import { browserRequest } from '../../lib/browser-request';
import type { ConnectionsData } from '../../lib/browser-schemas';

export function Connections({ data }: { data: ConnectionsData }) {
  const [items, setItems] = useState(data.items);
  const [busy, setBusy] = useState<string | null>(null);
  const state = useRequestFeedback();
  const status = useRef<HTMLDivElement>(null);
  async function revoke(id: string, name: string) {
    if (busy) return;
    setBusy(id);
    try {
      await browserRequest(`/api/v1/me/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setItems((current) => current.filter((item) => item.connection_id !== id));
      state.setFeedback({ message: `${name}: access revoked.`, error: false });
      status.current?.focus();
    } catch (error) { state.setFeedback({ message: error instanceof Error ? error.message : 'Revocation could not be confirmed. Refresh before retrying.', error: true }); }
    finally { setBusy(null); }
  }
  return <div className="stack gap-24"><PageHeader title="Connected applications">Manage which applications can access your Localfirst records.</PageHeader>
    <div ref={status} tabIndex={-1}><RequestFeedback feedback={state.feedback} /></div>
    {items.map((item) => <article className="panel stack gap-16 connection" key={item.connection_id}>
      <ApplicationIdentity name={item.client_name} /><p className="small muted">{item.scopes.length} permissions granted · Connected to {new URL(data.resource).hostname}</p>
      <details><summary>Manage access</summary><div className="stack gap-16 mt-12"><Permissions scopes={item.scopes} descriptions={data.scope_descriptions} />
        <details><summary>Technical details</summary><DetailsList rows={[[ 'Client identifier', item.client_id ], ['Resource', data.resource], ['Authorized', item.created_at], ['Updated', item.updated_at]]} /></details>
        <details><summary>Revoke access</summary><p>This application will lose access to your Localfirst account. Its refresh authorization will be revoked. Published records stay published.</p><Button className="button-danger" loading={busy === item.connection_id} disabled={busy !== null} onClick={() => revoke(item.connection_id, item.client_name ?? 'Unnamed application')}>Confirm revocation</Button></details>
      </div></details>
    </article>)}
    {items.length === 0 && <StatePanel title="No applications connected">Authorizing an application creates a connection here. Signing in alone does not grant access.</StatePanel>}<SecurityNotice />
  </div>;
}
