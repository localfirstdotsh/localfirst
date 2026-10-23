import { headers } from 'next/headers';
import type { z } from 'zod';
import { apiBaseUrl, ApiRequestError, ApiUnavailableError, ApiContractError } from './api';
import { visitorIp } from './client-ip';

/** Private reads are separate from public cached fetches. Forward only authentication and supported dev/test headers. */
export async function readBrowserData<S extends z.ZodType>(path: string, schema: S, timeoutMs = 15_000): Promise<z.infer<S>> {
  const incoming = await headers();
  const forwarded = new Headers({ accept: 'application/json' });
  for (const key of ['cookie', 'x-dev-user', 'x-dev-actor', 'x-dev-scopes']) {
    const value = incoming.get(key);
    if (value) forwarded.set(key, value);
  }
  const visitor = await visitorIp();
  if (visitor) forwarded.set('x-forwarded-for', visitor);
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/api/browser${path}`, { headers: forwarded, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new ApiUnavailableError('The registry could not be reached.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiRequestError(body?.error?.message ?? 'This page could not be loaded.', response.status, body?.error?.code ?? 'UNKNOWN', body?.meta?.request_id ?? null);
  const parsed = schema.safeParse(body?.data);
  if (!parsed.success) throw new ApiContractError('The registry sent an unexpected response.');
  return parsed.data;
}
