import { cache } from 'react';
import { headers } from 'next/headers';
import { readBrowserData } from './browser-api';
import { sessionSchema } from './browser-schemas';

export interface AccountSession { handle: string | null; authBase: string }

/** The signed-in account for the site header and account pages, or null. Anonymous visitors cost no API call, and a slow or failed lookup shows the signed-out header rather than delaying the page. One lookup per request. */
export const readAccountSession = cache(async (): Promise<AccountSession | null> => {
  const incoming = await headers();
  if (!incoming.get('cookie') && !incoming.get('x-dev-user')) return null;
  try {
    const session = await readBrowserData('/session', sessionSchema, 2_500);
    return session.authenticated ? { handle: session.handle, authBase: session.auth_base_path } : null;
  } catch { return null; }
});
