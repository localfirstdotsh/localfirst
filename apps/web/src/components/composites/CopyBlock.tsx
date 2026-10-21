'use client';

import { useEffect, useRef, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'manual';

/** Exact clipboard text, visible feedback, and a selectable fallback for commands and configs. */
export function CopyBlock({ text, note, format = 'command' }: { text: string; note: string; format?: 'command' | 'json' | 'url' }) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const codeRef = useRef<HTMLElement>(null);

  function selectText() {
    const node = codeRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopy('idle'), 2500);
    } catch {
      selectText();
      setCopy('manual');
    }
  }

  return (
    <div className="command-panel">
      <div className={format === 'json' ? 'copy-snippet' : 'command-line'}>
        {format === 'json' ? <pre tabIndex={0} aria-label="MCP configuration"><code ref={codeRef}>{text}</code></pre> : <>
          {format === 'command' && <span className="command-prompt" aria-hidden="true">$</span>}
          <code ref={codeRef}>{text.split(/(\s+)/).map((part, index) => /\s/.test(part) ? part : <span className="command-word" key={index}>{part}</span>)}</code>
        </>}
        <button type="button" className="button button-small" onClick={onCopy}>
          {format === 'json' ? 'Copy config' : format === 'url' ? 'Copy URL' : 'Copy'}
        </button>
      </div>
      <p className="small muted command-feedback" role="status" aria-live="polite">
        {copy === 'copied' && (format === 'json' ? 'Copied. Merge this entry into your client configuration, then sign in.' : format === 'url' ? 'Copied. Paste this URL into your client’s MCP settings, then sign in.' : 'Copied. Run it in your terminal, then review permissions.')}
        {copy === 'manual' && 'Select and copy manually. The text is selected above.'}
        {copy === 'idle' && note}
      </p>
    </div>
  );
}
