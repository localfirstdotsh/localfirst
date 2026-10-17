import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { DetailsList } from '../../components/composites/DetailsList';
import { ArtifactInspector } from '../../components/composites/ArtifactInspector';
import type { DraftReview } from '../../lib/browser-schemas';
import { ApprovalDecision } from './ApprovalDecision';
import { ReviewSummary } from './ReviewSummary';
export function PublicationReview({ data }: { data: DraftReview }) {
  const errors = data.review.issues.filter((issue) => issue.severity === 'error');
  const record = data.draft.kind !== 'project';
  return <div className="stack gap-24"><PageHeader title="Review publication">Approve one exact artifact version. Approval lets your agent publish it once; it does not publish it now.</PageHeader>
    <div className="review-grid"><div className="stack gap-24 review-content"><ReviewSummary data={data} />
      {errors.length > 0 && !['published', 'discarded'].includes(data.status) && <StatePanel title="Resolve blocking issues first" tone="warning">Ask your agent to correct these issues and validate the draft again.<ul className="compact-list">{errors.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></StatePanel>}
      <section className="stack gap-16"><h2>What will become public</h2><p className="muted">{record ? 'The selected fields in this projection, exactly as shown.' : 'This project documentation and its bundled files, exactly as shown.'}</p><ArtifactInspector content={data.review.content} label={data.review.contentLabel} />{data.files.map((file) => <ArtifactInspector key={file.path} content={file.content} label={`Bundled file: ${file.path}`} />)}</section>
      <details><summary>Technical details</summary><DetailsList rows={[[ 'Draft', data.draft.draft_id ], ['Kind', data.draft.kind], ['State when loaded', data.draft.state], ['Revision', data.draft.revision], ['Payload digest', <code className="break-all" key="digest">{data.draft.payload_digest}</code>], ['Content digest', <code className="break-all" key="content">{data.review.contentDigest ?? 'Not computable or not applicable'}</code>], ['Public slug', data.review.slug ?? 'Assigned at publication'], ['Approval window', `${Math.round(data.approval_window_seconds / 60)} minutes after approval`]]} /></details>
      <details><summary>Publication limitations</summary><p className="small muted">{record ? 'Publication does not verify this record. Operator acceptance determines its evidence level. Prompts, model outputs, local file paths, and machine identifiers are excluded from the public projection.' : 'Publication records no test evidence. Nothing here has been run by Localfirst. A declared harness does not imply a supported runner. Hardware and model facts stay attributed to their author.'}</p></details>
    </div><ApprovalDecision data={data} /></div>
  </div>;
}
