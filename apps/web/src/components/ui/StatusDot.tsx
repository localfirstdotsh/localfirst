type Tone = 'positive' | 'neutral' | 'caution';

/** A small status marker. The label always carries the meaning, so the dot is never the only signal. */
export function StatusDot({ tone = 'neutral', children }: { tone?: Tone; children: string }) {
  return <span className="status-dot-label" data-tone={tone}><span className="status-mark" aria-hidden="true" />{children}</span>;
}
