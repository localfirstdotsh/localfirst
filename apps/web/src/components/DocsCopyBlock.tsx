'use client';

import { useRef, useState } from 'react';

/** Copying a guide's text never runs its commands or connects an AI client. */
export function DocsCopyBlock({ text, label = 'Copy instructions for my AI' }: { text: string; label?: string }) {
  const code = useRef<HTMLElement>(null);
  const [status, setStatus] = useState('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied. Paste into your chosen client. Nothing has been run or connected.');
    } catch {
      const selection = window.getSelection();
      if (code.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setStatus('Select and copy the text manually.');
    }
  }

  return (
    <div className="stack gap-8">
      <pre tabIndex={0}><code ref={code}>{text}</code></pre>
      <div><button type="button" className="button" onClick={copy}>{label}</button></div>
      <p className="small muted" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
