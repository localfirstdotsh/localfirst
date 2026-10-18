'use client';
import { useRef, useState, type FormEvent } from 'react';
import { z } from '../../lib/validation';
import { Button } from '../../components/ui/Button';
import { Checkbox, Input } from '../../components/ui/FieldControl';
import { PageHeader } from '../../components/composites/PageHeader';
import { FormField } from '../../components/composites/FormField';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';
import type { DeletionPreview } from '../../lib/browser-schemas';
export function Deletion({ data }: { data: DeletionPreview }) {
  const [done, setDone] = useState(false);
  const state = useRequestFeedback();
  const status = useRef<HTMLDivElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (state.pending) return;
    const form = new FormData(event.currentTarget); state.setPending(true);
    try {
      z.object({ data: z.object({ requested_at: z.string() }) }).parse(await browserRequest('/api/v1/me/deletion-requests', jsonPost({ handle: form.get('handle'), confirm: form.get('confirm') === 'on' })));
      setDone(true); state.setFeedback({ message: 'Deletion requested. Managed projects are withdrawn, private contribution records and credentials are removed, and account access has stopped. Retained history awaits final policy processing.', error: false }); status.current?.focus();
    } catch (error) { state.setFeedback({ message: error instanceof Error ? error.message : 'The deletion request failed. Please retry.', error: true }); }
    finally { state.setPending(false); }
  }
  return <div className="stack gap-24"><PageHeader title="Request account deletion">Review these effects before confirming.</PageHeader>
    <section className="panel stack gap-16"><ul className="compact-list"><li>Your managed projects will be withdrawn from public reads and search.</li><li>Your private drafts, approvals, claims, operations, import jobs, and replay records will be removed.</li><li>Your sessions, provider credentials, and application grants will be removed. Your account will stop accepting contributions.</li><li>Your identity, immutable version history, and audit metadata will remain pending final retention-policy processing. This request does not immediately erase all personal data.</li><li>Attribution on projects now managed by someone else requires operator review.</li></ul><h2>Managed projects ({data.managed_projects.length})</h2>{data.managed_projects.length ? <ul className="compact-list">{data.managed_projects.map((project) => <li key={project.slug}>{project.slug}</li>)}</ul> : <p>You manage no projects.</p>}</section>
    {!done && <form onSubmit={submit} className="panel stack gap-16"><FormField id="deletion-handle" label={`Type your handle: ${data.handle}`}><Input id="deletion-handle" name="handle" required maxLength={64} autoComplete="off" /></FormField><Checkbox name="confirm" required>I understand these effects and request deletion.</Checkbox><div><Button type="submit" className="button-danger" loading={state.pending}>Confirm deletion request</Button></div></form>}
    <div ref={status} tabIndex={-1}><RequestFeedback feedback={state.feedback} /></div>
  </div>;
}
