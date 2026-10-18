import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { apiBaseUrl } from './api';
import { visitorIp } from './client-ip';
import { siteUrl } from './site';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/** Fixed private destination, public authority, unchanged status/cookies/redirects and streamed bodies. */
export async function proxyBackendRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const publicUrl = new URL(siteUrl());
  const publicHost = publicUrl.host;
  const incomingHost = request.headers.get('host') ?? url.host;
  const origin = request.headers.get('origin');
  // Protect cookie-authenticated browser decisions. Cookie-free API/OAuth clients retain
  // the backend's existing explicit CORS, token and protocol-origin policies.
  if ((!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.has('cookie') && origin && origin !== publicUrl.origin) || (url.pathname.startsWith('/mcp') && incomingHost !== publicHost)) {
    return Response.json({ error: { message: 'This browser origin or host is not accepted.' } }, { status: 403 });
  }
  const headers = new Headers(request.headers);
  for (const key of [...HOP_HEADERS, 'host', 'content-length', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) headers.delete(key);
  // Node fetch overrides Host with its destination. The native HTTP client preserves the configured
  // public authority over the private hop, which OAuth and MCP's DNS-rebinding checks require.
  headers.set('host', publicHost);
  const visitor = await visitorIp();
  if (visitor) headers.set('x-forwarded-for', visitor);
  try {
    const destination = new URL(`${apiBaseUrl()}${url.pathname}${url.search}`);
    if (!['http:', 'https:'].includes(destination.protocol) || (destination.origin === publicUrl.origin || destination.origin === url.origin)) throw new Error('Invalid private API destination.');
    return await new Promise<Response>((resolve, reject) => {
      const upstream = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, {
        method: request.method,
        headers: Object.fromEntries(headers),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (!value || HOP_HEADERS.includes(key)) continue;
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
        }
        responseHeaders.set('cache-control', 'no-store');
        const status = incoming.statusCode ?? 502;
        resolve(new Response(request.method === 'HEAD' || [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
        if (request.method === 'HEAD' || [204, 205, 304].includes(status)) incoming.resume();
      });
      upstream.on('error', reject);
      if (request.body && !['GET', 'HEAD'].includes(request.method)) {
        const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
        body.on('error', (error) => upstream.destroy(error));
        body.pipe(upstream);
      } else upstream.end();
    });
  } catch {
    return Response.json({ error: { message: 'The registry could not be reached.' } }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
