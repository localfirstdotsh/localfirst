'use client';
import { useRef, useState } from 'react';
import { PageHeader } from '../../components/composites/PageHeader';
import { EmptyState } from '../../components/composites/EmptyState';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { SecurityNotice } from '../auth';
import { IntegrationCard } from './IntegrationCard';
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
  return <>
    <PageHeader title="Connected applications">Manage which applications can access your Localfirst records.</PageHeader>
    <div ref={status} tabIndex={-1} className="feedback-region"><RequestFeedback feedback={state.feedback} /></div>
    {items.length > 0 && <div className="stack gap-16">{items.map((item) => <IntegrationCard key={item.connection_id} item={item} data={data} busy={busy === item.connection_id} locked={busy !== null} onRevoke={() => revoke(item.connection_id, item.client_name ?? 'Unnamed application')} />)}</div>}
    {items.length === 0 && <EmptyState compact icon={null} title="No applications connected" description="Authorizing an application creates a connection here. Signing in alone does not grant access." />}
    <SecurityNotice />
  </>;
}
