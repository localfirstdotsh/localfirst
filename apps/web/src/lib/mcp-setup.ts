import { apiBaseUrl, publicApiUrl } from './api';

/** Read the registry's advertised resource, including split private/public API origins.
 * Invalid or unavailable discovery produces no config rather than a guessed endpoint.
 */
export async function discoverMcpEndpoint(): Promise<string | null> {
  try {
    const response = await fetch(`${apiBaseUrl()}/.well-known/oauth-protected-resource/mcp`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('resource' in body) || typeof body.resource !== 'string') return null;
    const resource = new URL(body.resource);
    if (resource.origin !== publicApiUrl() || resource.username || resource.password || resource.search || resource.hash) return null;
    return resource.href;
  } catch {
    return null;
  }
}

export type ConfigClient = 'cursor' | 'vscode' | 'opencode' | 'github-copilot' | 'windsurf' | 'cline';

/** Vendor-native config formats; merge only the localfirst entry into existing files. */
export function mcpConfig(client: ConfigClient, endpoint: string): string {
  const entries = {
    cursor: { url: endpoint },
    vscode: { type: 'http', url: endpoint },
    opencode: { type: 'remote', url: endpoint, enabled: true },
    'github-copilot': { type: 'http', url: endpoint, tools: ['*'] },
    windsurf: { serverUrl: endpoint },
    cline: { type: 'streamableHttp', url: endpoint, disabled: false, autoApprove: [] },
  };
  const server = { localfirst: entries[client] };
  return JSON.stringify(client === 'opencode' ? { mcp: server } : client === 'vscode' ? { servers: server } : { mcpServers: server }, null, 2);
}

/**
 * One-click install links for editors that support them. The server name is the
 * fixed `localfirst`, and the link carries only the discovered URL: no token,
 * header, or credential. Opening one asks the editor to add the server; the
 * editor shows what it will add and the person confirms there.
 */
export function cursorInstallUrl(endpoint: string): string {
  const config = Buffer.from(JSON.stringify({ url: endpoint }), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=localfirst&config=${encodeURIComponent(config)}`;
}

export function vscodeInstallUrl(endpoint: string): string {
  return `https://vscode.dev/redirect/mcp/install?name=localfirst&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: endpoint }))}`;
}
