import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorInstallUrl, discoverMcpEndpoint, mcpConfig, vscodeInstallUrl } from './mcp-setup';

vi.mock('./api', () => ({ apiBaseUrl: () => 'http://api.internal:8787', publicApiUrl: () => 'https://registry.example.test' }));
afterEach(() => vi.unstubAllGlobals());

describe('MCP config discovery', () => {
  it('uses the advertised resource and public origin rather than guessing /mcp', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ resource: 'https://registry.example.test/agent-tools' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await discoverMcpEndpoint()).toBe('https://registry.example.test/agent-tools');
    expect(fetcher.mock.calls[0]![0]).toBe('http://api.internal:8787/.well-known/oauth-protected-resource/mcp');
  });

  it.each([
    {}, { resource: 123 }, { resource: 'not-a-url' },
    { resource: 'https://other.example.test/mcp' },
    { resource: 'https://user:password@registry.example.test/mcp' },
    { resource: 'https://registry.example.test/mcp?token=secret' },
    { resource: 'https://registry.example.test/mcp#section' },
  ])('does not render an unsafe or malformed resource: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    expect(await discoverMcpEndpoint()).toBeNull();
  });

  it('handles outages and non-JSON responses without breaking the connection guide', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await discoverMcpEndpoint()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    expect(await discoverMcpEndpoint()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));
    expect(await discoverMcpEndpoint()).toBeNull();
  });

  it('provides the native Cursor and OpenCode formats without tokens or guessed credentials', () => {
    const endpoint = 'https://registry.example.test/agent-tools';
    expect(JSON.parse(mcpConfig('cursor', endpoint))).toEqual({ mcpServers: { localfirst: { url: endpoint } } });
    expect(JSON.parse(mcpConfig('opencode', endpoint))).toEqual({ mcp: { localfirst: { type: 'remote', url: endpoint, enabled: true } } });
  });
  it('uses the VS Code servers key with an explicit http type', () => {
    expect(JSON.parse(mcpConfig('vscode', 'https://registry.example.test/agent-tools'))).toEqual({
      servers: { localfirst: { type: 'http', url: 'https://registry.example.test/agent-tools' } },
    });
  });
  it('uses Copilot HTTP, Cascade serverUrl, and Cline Streamable HTTP without auto-approval', () => {
    const endpoint = 'https://registry.example.test/agent-tools';
    expect(JSON.parse(mcpConfig('github-copilot', endpoint))).toEqual({ mcpServers: { localfirst: { type: 'http', url: endpoint, tools: ['*'] } } });
    expect(JSON.parse(mcpConfig('windsurf', endpoint))).toEqual({ mcpServers: { localfirst: { serverUrl: endpoint } } });
    expect(JSON.parse(mcpConfig('cline', endpoint))).toEqual({ mcpServers: { localfirst: { type: 'streamableHttp', url: endpoint, disabled: false, autoApprove: [] } } });
  });


  it('builds the same install links Stripe publishes, apart from the server name', () => {
    // https://docs.stripe.com/mcp, with name=stripe and its URL.
    expect(cursorInstallUrl('https://mcp.stripe.com').replace('name=localfirst', 'name=stripe')).toBe(
      'cursor://anysphere.cursor-deeplink/mcp/install?name=stripe&config=eyJ1cmwiOiJodHRwczovL21jcC5zdHJpcGUuY29tIn0%3D',
    );
    expect(vscodeInstallUrl('https://mcp.stripe.com').replace('name=localfirst', 'name=stripe')).toBe(
      'https://vscode.dev/redirect/mcp/install?name=stripe&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.stripe.com%22%7D',
    );
  });

  it('carries only the endpoint, never a token or header', () => {
    const endpoint = 'https://registry.example.test/agent-tools';
    const cursor = new URL(cursorInstallUrl(endpoint));
    expect(JSON.parse(Buffer.from(cursor.searchParams.get('config')!, 'base64').toString())).toEqual({ url: endpoint });
    const vscode = new URL(vscodeInstallUrl(endpoint));
    expect(JSON.parse(vscode.searchParams.get('config')!)).toEqual({ type: 'http', url: endpoint });
  });
});
