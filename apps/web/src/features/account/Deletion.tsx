'use client';
import { useRef, useState, type FormEvent } from 'react';
import { z } from '../../lib/validation';
import { Button } from '../../components/ui/Button';
import { Checkbox, Input } from '../../components/ui/FieldControl';
import { PageHeader } from '../../components/composites/PageHeader';
import { SectionHeader } from '../../components/composites/SectionHeader';
import { FormField } from '../../components/composites/FormField';
import { ConfirmationSection } from '../../components/composites/ConfirmationSection';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';
import type { DeletionPreview } from '../../lib/browser-schemas';

const EFFECTS = [
  ['Public projects', 'Your managed projects will be withdrawn from public reads and search.'],
  ['Private records', 'Your private drafts, approvals, claims, operations, import jobs, and replay records will be removed.'],
  ['Sessions and access', 'Your sessions, provider credentials, and application grants will be removed. Your account will stop accepting contributions.'],
  ['Data retention', 'Your identity, immutable version history, and audit metadata will remain pending final retention-policy processing. This request does not immediately erase all personal data.'],
  ['Operator review', 'Attribution on projects now managed by someone else requires operator review.'],
] as const;

export function Deletion({ data }: { data: DeletionPreview }) {
  const [done, setDone] = useState(false);
  const [handle, setHandle] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const state = useRequestFeedback();
  const status = useRef<HTMLDivElement>(null);
  // The server compares handles without regard to case; it remains the authority.
  const matches = handle.toLowerCase() === data.handle.toLowerCase();
  const mismatch = handle.length > 0 && !matches;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (state.pending || !matches || !acknowledged) return;
    state.setPending(true);
    try {
      z.object({ data: z.object({ requested_at: z.string() }) }).parse(await browserRequest('/api/v1/me/deletion-requests', jsonPost({ handle, confirm: acknowledged })));
      setDone(true); state.setFeedback({ message: 'Deletion requested. Managed projects are withdrawn, private contribution records and credentials are removed, and account access has stopped. Retained history awaits final policy processing.', error: false }); status.current?.focus();
    } catch (error) { state.setFeedback({ message: error instanceof Error ? error.message : 'The deletion request failed. Please retry.', error: true }); }
    finally { state.setPending(false); }
  }
  return <>
    <PageHeader title="Request account deletion">Review these effects before confirming.</PageHeader>
    <section className="stack gap-12" aria-labelledby="effects-title">
      <SectionHeader id="effects-title" title="What happens when you delete your account" />
      <ul className="list-group effects">{EFFECTS.map(([title, text]) => <li key={title}><h3 className="row-heading">{title}</h3><p>{text}</p></li>)}</ul>
    </section>
    <section className="stack gap-12" aria-labelledby="projects-title">
      <SectionHeader id="projects-title" title={`Affected projects (${data.managed_projects.length})`}>{data.managed_projects.length > 0 ? 'These projects are withdrawn from public reads and search.' : undefined}</SectionHeader>
      {data.managed_projects.length > 0
        ? <ul className="list-group affected-projects" tabIndex={data.managed_projects.length > 6 ? 0 : undefined} aria-label={data.managed_projects.length > 6 ? 'Affected projects, scrollable' : undefined}>{data.managed_projects.map((project) => <li key={project.slug} className="mono">{project.slug}</li>)}</ul>
        : <p className="muted">You manage no projects.</p>}
    </section>
    {!done && <form onSubmit={submit}>
      <ConfirmationSection id="confirm-deletion" tone="danger" title="Confirm deletion"
        actions={<Button type="submit" className="button-danger" loading={state.pending} disabled={!matches || !acknowledged}>Confirm deletion request</Button>}>
        <p className="small muted">Nothing is submitted until you complete both steps and press the button.</p>
        <FormField id="deletion-handle" label={`Type your handle: ${data.handle}`} error={mismatch ? 'This does not match your handle.' : undefined}>
          <Input id="deletion-handle" name="handle" className="code-input mono" required maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} value={handle} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? 'deletion-handle-error' : undefined} onChange={(event) => setHandle(event.target.value)} />
        </FormField>
        <Checkbox name="confirm" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}>I understand these effects and request deletion.</Checkbox>
      </ConfirmationSection>
    </form>}
    <div ref={status} tabIndex={-1} className="feedback-region"><RequestFeedback feedback={state.feedback} /></div>
  </>;
}
