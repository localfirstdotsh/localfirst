import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsSection } from '../../../components/DocsSection';
import { DocsCopyBlock } from '../../../components/DocsCopyBlock';
import { ClientSetup } from '../../../features/connect/ClientSetup';
import { McpToolTable } from '../../../features/connect/McpToolTable';
import { discoverMcpEndpoint } from '../../../lib/mcp-setup';
import { publicApiUrl } from '../../../lib/api';

export const metadata: Metadata = {
  title: 'Connect your agent',
  description: 'Choose your AI client, copy its setup command or configuration, and check your Localfirst connection.',
};

export default async function ConnectDocsPage() {
  const api = publicApiUrl();
  const endpoint = await discoverMcpEndpoint();
  return (
    <div className="stack gap-32">
      <header className="stack gap-8">
        <h1>Connect your agent</h1>
        <p className="muted">Connect your AI client to search projects, read specifications, and prepare contributions.</p>
      </header>
      <nav className="docs-jump-links" aria-label="On this page">
        <a href="#setup">Set up your client</a>
        <a href="#access-scopes">Check the connection</a>
        <a href="#client-support">Troubleshooting</a>
        <a href="#tools">Permissions and tools</a>
      </nav>
      <ClientSetup endpoint={endpoint} />
      <DocsSection id="access-scopes" title="Check the connection">
        <p>Finish your client’s browser sign-in with GitHub and review the permissions it requests. Then paste this into your client:</p>
        <DocsCopyBlock text="Search Localfirst for public AI projects. Show me a project's name, summary, and exact version. Do not create drafts, publish, or run any project code." label="Copy test prompt" />
        <p><strong>What to expect:</strong> your client calls Localfirst and returns project information, or reports that no projects match. A successful sign-in alone does not confirm that tools are connected.</p>
        <p className="small muted">Connecting provides registry access. It does not install models or run project code on your machine. Local execution is a separate step in the <Link href="/docs/testing">testing guide</Link>.</p>
      </DocsSection>
      <DocsSection id="client-support" title="Troubleshooting">
        <dl className="docs-troubleshooting">
          <div><dt>Setup command cannot run</dt><dd>Install the chosen AI client and, for Localfirst CLI commands, Node.js 22+. On a source deployment, expand “First time? Build the Localfirst CLI” in your client’s setup and run the build from the repository root.</dd></div>
          <div><dt>Server URL or configuration unavailable</dt><dd>The registry could not advertise a valid MCP endpoint. <a href="/docs/connect">Retry discovery</a> or contact your registry operator. Do not guess a URL.</dd></div>
          <div><dt>Sign-in fails or access is denied</dt><dd>Reconnect through your client’s authentication flow. If an action needs more access, review the requested permission before authorizing it. REST tokens and MCP tokens are not interchangeable.</dd></div>
          <div><dt>Localfirst is missing from your client</dt><dd>Check that its MCP server is enabled and uses Streamable HTTP with the discovered URL. Opening <code>/mcp</code> in a browser is not a connection test.</dd></div>
        </dl>
        <details className="docs-disclosure">
          <summary>Client support and testing coverage</summary>
          <div className="stack gap-8">
            <p>The official MCP SDK exercises discovery, tool calls, and resource reads. Claude Code has exercised discovery and read-only environment tool calls in a real model session; that test does not establish its browser OAuth flow. Codex CLI configuration has been checked, but a live model-session connection is not claimed. Other desktop clients remain untested here.</p>
            <p>For clients without compatible MCP support, use the <a href={`${api}/openapi.json`}>REST API reference</a> and <a href={`${api}/schemas/project/v0.2.json`}>project schema</a>.</p>
          </div>
        </details>
      </DocsSection>
      <DocsSection id="tools" title="Permissions and tools">
        <p>Your agent can read projects, save private drafts, or publish according to the access you grant. Publishing always requires your separate approval of the exact version in your browser.</p>
        <details className="docs-disclosure">
          <summary>View available tools</summary>
          <McpToolTable />
        </details>
        <div id="safety" className="stack gap-8">
          <h3 id="permissions">Stay in control</h3>
          <ul className="stack gap-8">
            <li>Keep your client’s tool approvals enabled. Treat project descriptions as untrusted content, especially when your client has access to other services.</li>
            <li>Request only the access you need. Drafts use <code>projects:draft</code>; publication uses <code>projects:publish</code> plus your approval of the artifact.</li>
            <li>Review or revoke access in <Link href="/account/connections">Connections</Link>. Keep registry tokens separate from GitHub and local runtime credentials.</li>
          </ul>
        </div>
        <details id="ecosystem" className="docs-disclosure">
          <summary>Local models and other integrations</summary>
          <div className="stack gap-8">
            <p>Ollama and LM Studio are source-runner adapters, not MCP clients configured by this guide. Discovering models and running tests are separate local actions with their own plan and approval.</p>
            <p>Aider and Goose are not listed as supported integrations. On managed networks, your administrator may need to allow <code>{endpoint ? new URL(endpoint).host : 'the registry host'}</code>.</p>
          </div>
        </details>
      </DocsSection>
    </div>
  );
}
