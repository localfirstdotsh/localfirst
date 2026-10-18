'use client';
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
export function ArtifactInspector({ content, label }: { content: string; label: string }) {
  const [wrap, setWrap] = useState(true), [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(content); setMessage('Exact content copied.'); }
    catch {
      if (ref.current) { const range = document.createRange(); range.selectNodeContents(ref.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); ref.current.focus(); }
      setMessage('Content selected. Use your browser’s Copy command.');
    }
  }
  return <details className="artifact-inspector"><summary>{label}</summary><div className="stack gap-16 mt-12"><p className="small muted">This is the exact artifact under review. The summary above is a reading aid.</p>
    <div className="browser-actions"><Button onClick={copy}>Copy exact content</Button><Button onClick={() => setWrap(!wrap)} aria-pressed={wrap}>Wrap lines</Button><Button onClick={() => setExpanded(!expanded)} aria-pressed={expanded}>{expanded ? 'Collapse preview' : 'Expand preview'}</Button></div>
    <p className="small muted" role="status">{message}</p><pre className={`artifact-content panel mono small${wrap ? '' : ' artifact-unwrapped'}${expanded ? ' artifact-expanded' : ''}`} ref={ref} tabIndex={0} role="region" aria-label={label}>{content}</pre>
  </div></details>;
}
