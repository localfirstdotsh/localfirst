'use client';
import { z } from '../../lib/validation';
import Link from 'next/link';
import { Button } from '../../components/ui/Button';
import { DetailsList } from '../../components/composites/DetailsList';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';
import type { ConsentData } from '../../lib/browser-schemas';
import { ApplicationIdentity, Permissions, SecurityNotice, elevatedScopes } from './Permissions';

export function Consent({ data, query }: { data: ConsentData; query: string }) {
  const state = useRequestFeedback();
  async function decide(accept: boolean) {
    if (state.pending) return;
    state.setPending(true); state.setFeedback({ message: accept ? 'Authorizing access…' : 'Recording denial…', error: false });
    try {
      const body = z.object({ url: z.string().optional(), redirect_uri: z.string().optional() }).parse(await browserRequest(`${data.auth_base_path}/oauth2/consent`, jsonPost({ accept, oauth_query: query })));
      const target = body.url || body.redirect_uri;
      if (!target) throw new Error('The authorization response did not include a return destination. Refresh the request before retrying.');
      window.location.assign(target);
    } catch (error) { state.setPending(false); state.setFeedback({ message: error instanceof Error ? error.message : 'We could not confirm the decision. Refresh this request before retrying.', error: true }); }
  }
  const elevated = elevatedScopes(data.scopes, data.scope_descriptions);
  return <div className="panel stack gap-24">
    <ApplicationIdentity name={data.client_name} app={data.app} />
    <section className="stack gap-16"><h2>Requested access</h2>
      {data.app?.kind === 'unrecognized' && elevated.length > 0 && <div className="notice" role="alert"><h3>This unrecognized application wants to do more than read</h3><p>It asks to change or publish on your behalf ({elevated.length} permission{elevated.length === 1 ? '' : 's'}). Reading the catalog is usually enough to look around, so deny this unless you know and trust the application.</p></div>}
      <Permissions scopes={data.scopes} descriptions={data.scope_descriptions} /></section>
    <details><summary>Technical details</summary><DetailsList rows={[[ 'Client identifier', data.client_id ], ['Resource', data.resource]]} /></details>
    <SecurityNotice /><p className="small muted">You can revoke access later from <Link href="/account/connections">Connections</Link>.</p>
    <div className="browser-actions"><Button disabled={state.pending} onClick={() => decide(false)}>Deny</Button><Button variant="primary" disabled={state.pending} onClick={() => decide(true)}>Allow access</Button></div>
    <RequestFeedback feedback={state.feedback} />
  </div>;
}
