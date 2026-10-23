'use client';
import { useState, type ReactNode } from 'react';
import { browserRequest, jsonPost } from '../../lib/browser-request';

/** Ends the browser session through the auth service, then returns to the home page. A failure stays on the page and says so. */
export function SignOutButton({ authBase, className, children }: { authBase: string; className?: string; children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await browserRequest(`${authBase}/sign-out`, jsonPost({}));
      window.location.assign('/');
    } catch (failure) { setPending(false); setError(failure instanceof Error ? failure.message : 'Sign out failed. Please retry.'); }
  }
  return <>
    <button type="button" className={className} disabled={pending} aria-busy={pending} onClick={signOut}>{children}</button>
    <span role="alert" className="field-error small sign-out-error">{error}</span>
  </>;
}
