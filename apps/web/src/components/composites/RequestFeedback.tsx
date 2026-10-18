'use client';
import { useState } from 'react';

/** Stateful request feedback shared by browser account controls. Each feature still owns its mutation. */
export function useRequestFeedback() {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  return { pending, setPending, feedback, setFeedback };
}
export function RequestFeedback({ feedback }: { feedback: { message: string; error: boolean } | null }) {
  return <p role={feedback?.error ? 'alert' : 'status'} aria-live="polite" className={feedback?.error ? 'field-error' : 'small muted'}>{feedback?.message}</p>;
}
