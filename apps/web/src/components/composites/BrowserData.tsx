import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { readBrowserData } from '../../lib/browser-api';
import { ApiRequestError } from '../../lib/api';
import { StatePanel } from './StatePanel';

/** Page-level recovery only; the backend enforces authentication and ownership before returning any data. */
export async function BrowserData<S extends z.ZodType>({ path, returnTo, schema, children, level = 'h1' }: {
  level?: 'h1' | 'h2';
  path: string;
  returnTo: string;
  schema: S;
  children: (data: z.infer<S>) => ReactNode;
}) {
  let data: z.infer<S>;
  try { data = await readBrowserData(path, schema); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    return <StatePanel title={error instanceof ApiRequestError && error.status === 403 ? 'A browser session is required' : 'This page could not be loaded'} tone="warning" level={level} requestId={error instanceof ApiRequestError ? error.requestId : undefined}>
      {error instanceof ApiRequestError ? error.message : 'The registry is unavailable. Try again in a moment.'} <a href={returnTo}>Retry page</a>
    </StatePanel>;
  }
  return children(data);
}
