'use client';
import { useRef, useState } from 'react';
import { z } from '../../lib/validation';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/FieldControl';
import { FormField } from '../../components/composites/FormField';
import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';
import type { DevicesData } from '../../lib/browser-schemas';
import { SecurityNotice } from '../auth';
export function Devices({ data, code }: { data: DevicesData; code: string }) {
  const [devices, setDevices] = useState(data.devices);
  const [decided, setDecided] = useState(false);
  const state = useRequestFeedback();
  const status = useRef<HTMLDivElement>(null);
  async function decide(decision: 'approved' | 'denied') {
    if (state.pending || !data.link) return;
    state.setPending(true);
    try {
      const result = z.object({ data: z.object({ decision: z.literal(decision) }) }).parse(await browserRequest('/api/v1/approver-links/decision', jsonPost({ user_code: data.link.user_code, decision })));
      setDecided(Boolean(result)); state.setFeedback({ message: decision === 'approved' ? 'Approved. Return to your terminal; it will finish on its own.' : 'Denied. Nothing was linked.', error: false }); status.current?.focus();
    } catch (error) { state.setFeedback({ message: error instanceof Error ? error.message : 'We could not record your decision. Try again.', error: true }); }
    finally { state.setPending(false); }
  }
  async function revoke(id: string, label: string) {
    if (state.pending) return;
    state.setPending(true);
    try { await browserRequest(`/api/v1/me/approver-devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); setDevices((items) => items.filter((device) => device.device_id !== id)); state.setFeedback({ message: `${label}: revoked.`, error: false }); status.current?.focus(); }
    catch (error) { state.setFeedback({ message: error instanceof Error ? error.message : 'Revocation could not be confirmed. Refresh before retrying.', error: true }); }
    finally { state.setPending(false); }
  }
  return <div className="stack gap-24"><PageHeader title="Approval devices">Machines you linked so your terminal can record your publication decisions.</PageHeader>
    {code && !data.link && <StatePanel title="Code not found" tone="warning">That code is unknown, already used, or expired. Run the command in your terminal again.</StatePanel>}
    {data.link && !decided && <section className="panel stack gap-16" aria-labelledby="link-title"><h2 id="link-title">Approve this machine?</h2><p><strong>{data.link.client_label}</strong> asked to record your publication decisions.</p><p>Check that this code matches the one in your terminal:</p><p className="mono" aria-label="Link code">{`${data.link.user_code.slice(0, 4)}-${data.link.user_code.slice(4)}`}</p><p className="small muted">Approving lets that machine read the exact content of your own drafts and record your approval or denial for one. It cannot publish, edit, or use any other part of your account, and it is not an application connection. You can revoke it below at any time. If you did not just run the command, deny.</p><div className="browser-actions"><Button disabled={state.pending} onClick={() => decide('approved')}>Approve this machine</Button><Button disabled={state.pending} onClick={() => decide('denied')}>Deny</Button></div></section>}
    <form action="/account/devices" method="get" className="panel stack gap-16"><FormField id="link-code" label="Link code from your terminal"><Input id="link-code" name="code" autoComplete="off" maxLength={12} defaultValue={code} /></FormField><div><Button type="submit">Check code</Button></div></form>
    <div tabIndex={-1} ref={status}><RequestFeedback feedback={state.feedback} /></div>
    {devices.map((device) => <article className="panel stack gap-16 device" key={device.device_id}><h2>{device.label}</h2><p className="small muted">Linked {device.created_at.slice(0, 10)} · Expires {device.expires_at.slice(0, 10)} · {device.last_used_at ? `Last used ${device.last_used_at.slice(0, 16).replace('T', ' ')} UTC` : 'Never used'}</p><details><summary>Revoke</summary><p>This machine will stop being able to record your decisions. Approvals it already recorded stay valid until they expire or are used.</p><Button className="button-danger" disabled={state.pending} onClick={() => revoke(device.device_id, device.label)}>Confirm revocation</Button></details></article>)}
    {devices.length === 0 && <StatePanel title="No linked machines">Run <code>localfirstdotsh auth approver-login</code> in your terminal to link one. Browser approval keeps working without it.</StatePanel>}<SecurityNotice />
  </div>;
}
