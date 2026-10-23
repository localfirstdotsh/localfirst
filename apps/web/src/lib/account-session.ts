import { headers } from 'next/headers';
import { readBrowserData } from './browser-api';
import { sessionSchema } from './browser-schemas';

/** The signed-in account for the site header, or null. Anonymous visitors cost no API call, and a slow or failed lookup shows the signed-out header rather than delaying the page. */
export async function readAccountSession(): Promise<{ handle: string | null } | null> {
  const incoming = await headers();
  if (!incoming.get('cookie') && !incoming.get('x-dev-user')) return null;
  try {
    const session = await readBrowserData('/session', sessionSchema, 2_500);
    return session.authenticated ? { handle: session.handle } : null;
  } catch { return null; }
}
