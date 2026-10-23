'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/FieldControl';
import { StatePanel } from '../../components/composites/StatePanel';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, BrowserRequestError, jsonPost } from '../../lib/browser-request';
import type { DraftReview } from '../../lib/browser-schemas';
import { decisionResponse } from '../../lib/approval-response';
import { WARNING_DESCRIPTION, WARNING_TITLES } from './warnings';

export function ApprovalDecision({ data }: { data: DraftReview }) {
  const [status, setStatus] = useState(data.status);
  const [checked, setChecked] = useState<string[]>([]);
  const [expires, setExpires] = useState(data.status === 'approved' ? data.draft.approval?.expires_at : undefined);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [delegatedNow, setDelegatedNow] = useState(false);
  const state = useRequestFeedback();
  const feedback = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const required = data.review.warningCodes;
  const missing = required.filter((code) => !checked.includes(code));
  const endpoint = `/api/v1/drafts/${encodeURIComponent(data.draft.draft_id)}/approval`;
  // Offered only for a draft a still-authorized connection created and is not yet delegated (FRONTEND_PRD section 11.4).
  const connection = data.creating_connection;
  const client = connection?.client_name ?? 'this application';
  useEffect(() => {
    if (!expires) return;
    let timer: ReturnType<typeof setTimeout>;
    function checkExpiry() {
      const remaining = new Date(expires!).getTime() - Date.now();
      if (remaining <= 0) { setStatus('expired'); setRefreshRequired(true); }
      else timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    }
    checkExpiry();
    return () => clearTimeout(timer);
  }, [expires]);
  async function decide(decision: 'approved' | 'denied', delegate = false) {
    if (lock.current || refreshRequired || (decision === 'approved' && (data.blocked || missing.length))) return;
    lock.current = true; state.setPending(true); state.setFeedback({ message: 'Recording your decision…', error: false });
    try {
      const result = decisionResponse.parse(await browserRequest(endpoint, jsonPost({ draft_revision: data.draft.revision, payload_digest: data.draft.payload_digest, acknowledged_warning_codes: checked, decision, ...(delegate ? { delegate_connection: true } : {}) }))).data;
      if (result.decision !== decision) throw new Error('The server response could not confirm your decision. Refresh to check its status.');
      if (decision === 'approved' && !result.draft.approval) throw new Error('Refresh to check the current approval. Publication is not confirmed.');
      setStatus(decision); setExpires(result.draft.approval?.expires_at); setDelegatedNow(delegate); state.setFeedback(null);
      if (new URLSearchParams(window.location.search).get('review') === 'again') window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
      state.setFeedback({ message: `${error instanceof Error ? error.message : 'The request failed.'} Refresh to check the current status before retrying.`, error: true });
      if (error instanceof BrowserRequestError && ['APPROVAL_STALE', 'REVISION_PRECONDITION_FAILED', 'INVALID_LIFECYCLE'].includes(error.code ?? '')) setRefreshRequired(true);
    } finally { lock.current = false; state.setPending(false); feedback.current?.focus(); }
  }
  async function revoke() {
    if (lock.current) return;
    lock.current = true; state.setPending(true);
    try { await browserRequest(endpoint, { method: 'DELETE' }); window.location.reload(); }
    catch (error) { lock.current = false; state.setPending(false); state.setFeedback({ message: error instanceof Error ? error.message : 'Revocation could not be confirmed. Refresh to check the approval.', error: true }); }
  }
  const canDecide = data.decision_allowed && !['approved', 'denied', 'published', 'discarded'].includes(status) && !refreshRequired;
  return <aside className="panel stack gap-16 review-decision" aria-label="Publication decision">
    <div ref={feedback} tabIndex={-1} aria-live="polite">
      {status === 'published' && <StatePanel title="This draft was published">It was published{data.published ? ` as ${data.published.slug} version ${data.published.version_number}` : ''}. The approval was used, and there is nothing left to approve. To change the entry, start a new draft.</StatePanel>}
      {status === 'discarded' && <StatePanel title="This draft was discarded">Nothing from it was published. There is nothing left to approve.</StatePanel>}
      {status === 'approved' && <StatePanel title="Publication approved">Your agent can now publish this exact artifact once. <strong>Status: Awaiting publication</strong>.<p className="small muted mt-8">Approval expires <time dateTime={expires}>{expires}</time>.</p>{delegatedNow && <p className="small mt-8">{client} can now publish drafts it creates for you without this page. <a href="/account/connections">Turn this off in Connections</a>.</p>}<div className="browser-actions mt-12"><a href="">Refresh publication status</a><Button loading={state.pending} onClick={revoke}>Revoke approval</Button></div></StatePanel>}
      {status === 'denied' && <StatePanel title="Publication not approved">Your previous denial was recorded. No publication is authorized by that decision. <a href="?review=again">Review again</a></StatePanel>}
      {status === 'expired' && <StatePanel title="Approval expired" tone="warning">The approval window has ended. Review the current artifact and acknowledge its limitations again. {refreshRequired && <a href="">Refresh review</a>}</StatePanel>}
      {status === 'changed' && <StatePanel title="Artifact changed" tone="warning">The current artifact no longer matches its approval. Ask your agent to validate it again before reviewing.</StatePanel>}
      <RequestFeedback feedback={state.feedback} />{state.feedback?.error && <a href="">Refresh review</a>}
    </div>
    {canDecide && <>
      <section className="stack gap-16" id="review-acknowledgements"><h2>Required acknowledgements</h2><p className="small muted">{required.length ? 'Read each limitation and acknowledge it before approving this artifact.' : 'No additional acknowledgements are required.'}</p>
        {required.map((code) => {
          const message = [...new Set(data.review.issues.filter((issue) => issue.code === code).map((issue) => issue.message))].join(' ') || code;
          return <Checkbox key={code} value={code} className="review-ack" disabled={state.pending} checked={checked.includes(code)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, code] : current.filter((value) => value !== code))}><span><strong>{WARNING_TITLES[code] ?? message}</strong>{WARNING_TITLES[code] && <span className="review-warning-detail small muted">{WARNING_DESCRIPTION[code] ?? message}</span>}</span></Checkbox>;
        })}
        {required.length > 0 && <details><summary>Warning reference codes</summary><ul className="compact-list">{required.map((code) => <li key={code}><code>{code}</code> — {data.review.issues.filter((issue) => issue.code === code).map((issue) => issue.message).join(' ')}</li>)}</ul></details>}
      </section>
      <div id="decision-area" className="stack gap-16"><p className="small muted" id="decision-help">{data.blocked ? 'Blocking issues must be resolved before approving this artifact.' : missing.length ? `Acknowledge ${missing.length} remaining limitation${missing.length === 1 ? '' : 's'} before approving.` : 'Approval lets your agent publish this exact version once. It does not publish it now.'}</p><div className="browser-actions"><Button id="approve" variant="primary" disabled={data.blocked || missing.length > 0 || state.pending} aria-describedby="decision-help" onClick={() => decide('approved')}>Approve this exact artifact</Button><Button id="deny" disabled={state.pending} onClick={() => decide('denied')}>Do not publish</Button></div>
        {connection && !connection.publication_delegated && <div className="stack gap-8 review-delegate">
          <p className="small muted" id="delegate-help">Approves this artifact and also lets <strong>{client}</strong> publish future drafts it creates for you without this page, labeled publicly as published without per-version review. The name is reported by the application and is not verified. You can turn it off in <a href="/account/connections">Connections</a>.</p>
          <div className="browser-actions"><Button id="approve-and-delegate" disabled={data.blocked || missing.length > 0 || state.pending} aria-describedby="delegate-help" onClick={() => decide('approved', true)}>Approve and let {client} publish without asking</Button></div>
        </div>}</div>
    </>}
    <p className="small muted">Any edit invalidates approval. Only the server can confirm publication. Refresh this page to check the current state.</p>
  </aside>;
}
