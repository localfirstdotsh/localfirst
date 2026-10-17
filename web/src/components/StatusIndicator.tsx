import { EVIDENCE, evidenceLabel } from '../lib/format';

/**
 * Restrained evidence marker: a filled dot only for levels established by a run, a hollow one
 * for claims and reports, always with the label and an explanation (never color alone).
 */
export function StatusIndicator({ level }: { level: string }) {
  const established = level === 'reproducible_test' || level === 'independently_verified';
  return (
    <span className="status" title={EVIDENCE[level]?.description}>
      <span className="status-dot" data-established={established} aria-hidden="true" />
      {evidenceLabel(level)}
    </span>
  );
}
