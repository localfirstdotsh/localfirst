'use client';
import { z } from '../../lib/validation';
import { Button } from '../../components/ui/Button';
import { RequestFeedback, useRequestFeedback } from '../../components/composites/RequestFeedback';
import { browserRequest, jsonPost } from '../../lib/browser-request';

export function SignIn({ next, authBase }: { next: string; authBase: string }) {
  const state = useRequestFeedback();
  async function signIn() {
    if (state.pending) return;
    state.setPending(true); state.setFeedback({ message: 'Opening GitHub to verify your identity.', error: false });
    try {
      const body = await browserRequest(`${authBase}/sign-in/social`, jsonPost({ provider: 'github', callbackURL: `${window.location.origin}${next}`, errorCallbackURL: `${window.location.origin}/sign-in?next=${encodeURIComponent(next)}` }));
      const { url } = z.object({ url: z.string().min(1) }).parse(body);
      window.location.assign(url);
    } catch (error) { state.setPending(false); state.setFeedback({ message: error instanceof Error ? error.message : 'GitHub sign-in could not be started. Please retry.', error: true }); }
  }
  return <div className="stack gap-16"><div><Button variant="primary" loading={state.pending} onClick={signIn}>{state.pending ? 'Connecting to GitHub…' : state.feedback?.error ? 'Retry GitHub sign-in' : 'Continue with GitHub'}</Button></div><RequestFeedback feedback={state.feedback} /></div>;
}
