/** Browser mutations always call the website origin; the backend owns validation and authorization. */
export class BrowserRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
export async function browserRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new BrowserRequestError(response.status === 401 ? 'Your session has expired. Sign in again, then refresh this page.' : body?.error?.message ?? 'The request could not be completed.', body?.error?.code);
  return body;
}
export function jsonPost(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}
