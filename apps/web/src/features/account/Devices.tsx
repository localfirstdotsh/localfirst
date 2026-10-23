'use client';
import { useRef, useState, type FormEvent } from 'react';
import { z } from '../../lib/validation';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Input } from '../../components/ui/FieldControl';
import { FormField } from '../../components/composites/FormField';
import { PageHeader } from '../../components/composites/PageHeader';
import { SectionHeader } from '../../components/composites/SectionHeader';
import { EmptyState } from '../../components/composites/EmptyState';
import { CopyBlock } from '../../components/composites/CopyBlock';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';
import type { DevicesData } from '../../lib/browser-schemas';
import { SecurityNotice } from '../auth';
import { DeviceList } from './DeviceList';

const LINK_COMMAND = 'localfirstdotsh auth approver-login';
/** Codes are eight letters and digits, shown as XXXX-XXXX. The server ignores case and punctuation, so the form does too. */
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function Devices({ data, code }: { data: DevicesData; code: string }) {
  const [devices, setDevices] = useState(data.devices);
  const [decided, setDecided] = useState(false);
  const [linking, setLinking] = useState(Boolean(code) && !data.link);
  const [entered, setEntered] = useState(code);
  const [checking, setChecking] = useState(false);
  const state = useRequestFeedback();
  const status = useRef<HTMLDivElement>(null);
  const valid = normalizeCode(entered).length === 8;
  const notFound = Boolean(code) && !data.link && normalizeCode(entered) === normalizeCode(code);
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
  function check(event: FormEvent<HTMLFormElement>) {
    if (!valid || checking) { event.preventDefault(); return; }
    setChecking(true);
  }
  const linkButton = <Button size="small" aria-expanded={linking} aria-controls="link-device" onClick={() => setLinking(true)}><Icon name="plus" />Link a device</Button>;
  return <>
    <PageHeader title="Approval devices">Machines you linked so your terminal can record your publication decisions.</PageHeader>
    {data.link && !decided && <section className="panel stack gap-16" aria-labelledby="link-title"><h2 id="link-title" className="section-title">Approve this machine?</h2><p><strong>{data.link.client_label}</strong> asked to record your publication decisions.</p><div className="stack gap-8"><p className="small muted">Check that this code matches the one in your terminal:</p><p className="link-code mono" aria-label="Link code">{`${data.link.user_code.slice(0, 4)}-${data.link.user_code.slice(4)}`}</p></div><p className="small muted">Approving lets that machine read the exact content of your own drafts and record your approval or denial for one. It cannot publish, edit, or use any other part of your account, and it is not an application connection. You can revoke it below at any time. If you did not just run the command, deny.</p><div className="browser-actions"><Button variant="primary" disabled={state.pending} onClick={() => decide('approved')}>Approve this machine</Button><Button disabled={state.pending} onClick={() => decide('denied')}>Deny</Button></div></section>}
    <div tabIndex={-1} ref={status} className="feedback-region"><RequestFeedback feedback={state.feedback} /></div>
    <section className="stack gap-16" aria-labelledby="devices-title">
      <SectionHeader id="devices-title" title="Linked devices" action={devices.length > 0 && !linking ? linkButton : undefined} />
      {devices.length > 0 && <DeviceList devices={devices} disabled={state.pending} onRevoke={(device) => revoke(device.device_id, device.label)} />}
      {devices.length === 0 && <EmptyState compact icon={null} title="No linked devices" description="Link a device to approve publications from your terminal." action={linking ? undefined : linkButton} />}
    </section>
    {linking && !data.link && <section id="link-device" className="panel stack gap-16" aria-labelledby="link-device-title">
      <SectionHeader id="link-device-title" title="Link a device">Browser approval keeps working without a linked device.</SectionHeader>
      <ol className="steps">
        <li><div className="stack gap-8"><p>Run this command in your terminal. It prints a link code.</p><CopyBlock text={LINK_COMMAND} note="Run it on the machine you want to link." /></div></li>
        <li><form action="/account/devices" method="get" onSubmit={check} className="stack gap-12">
          <FormField id="link-code" label="Link code" help="Eight letters and digits, for example ABCD-2345." error={notFound ? 'That code is unknown, already used, or expired. Run the command in your terminal again.' : undefined}>
            <Input id="link-code" name="code" className="code-input mono" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12} value={entered} aria-invalid={notFound || undefined} aria-describedby={`link-code-help${notFound ? ' link-code-error' : ''}`} onChange={(event) => { setEntered(event.target.value); setChecking(false); }} />
          </FormField>
          <div className="browser-actions"><Button type="submit" variant="primary" loading={checking} disabled={!valid}>{checking ? 'Checking code…' : 'Check code'}</Button><Button disabled={checking} onClick={() => { setLinking(false); setEntered(''); }}>Cancel</Button></div>
        </form></li>
      </ol>
    </section>}
    <SecurityNotice />
  </>;
}
