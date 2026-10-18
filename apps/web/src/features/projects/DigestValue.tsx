import { shortDigest } from '../../lib/format';

/** Readable short form with the full value one click away, selectable in one click (FRONTEND_PRD section 6.2). */
export function DigestValue({ value }: { value: string }) {
  return (
    <details>
      <summary className="mono digest-summary">
        {shortDigest(value)}
      </summary>
      <code className="mono small digest-value">
        {value}
      </code>
    </details>
  );
}
