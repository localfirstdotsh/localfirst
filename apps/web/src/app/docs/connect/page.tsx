import Link from 'next/link';
import { DocsSection } from '../../../components/DocsSection';
import type { Metadata } from 'next';
import { McpConfigBlock } from '../../../features/connect/McpConfigBlock';
import { McpUrlBlock } from '../../../features/connect/McpUrlBlock';
import { McpToolTable } from '../../../features/connect/McpToolTable';
import { cursorInstallUrl, discoverMcpEndpoint, vscodeInstallUrl } from '../../../lib/mcp-setup';
import { CommandBlock } from '../../../components/composites/CommandBlock';
import { IntegrationGroup } from '../../../features/connect/IntegrationGroup';
import { SetupSection } from '../../../features/connect/SetupSection';
import { publicApiUrl } from '../../../lib/api';
import { readSetupState, shellArgument } from '../../../lib/capabilities';
import { toolkitPreviewEnabled } from '../../../lib/toolkit';

export const metadata: Metadata = { title: 'Connect your agent' };

export default async function ConnectDocsPage() {
  const api = publicApiUrl();
  const endpoint = await discoverMcpEndpoint();
  const released = readSetupState().state === 'available';
  return (
    <div className="stack gap-32">
      <header className="stack gap-8">
        <h1>Connect your agent</h1>
        <p className="muted">Search, read, and prepare project contributions from the AI client you already use. You review permissions and publication separately.</p>
      </header>
      <SetupSection />
      <section id="setup" className="stack gap-16" aria-labelledby="requirements">
        <h2 id="requirements">Before you connect</h2>
        <p>For command setup, install Node.js 22 or newer and Claude Code, Codex CLI, or Gemini CLI. Other clients can use their native configuration instructions below directly. Use an interactive terminal; the CLI shows the exact registration command and asks for confirmation.</p>
        {!released && <>
          <p className="muted">The <code>localfirstdotsh</code> package is built from this repository until it is published to npm. From a repository checkout, install dependencies and build the CLI:</p>
          <CommandBlock clients={[]} command="pnpm install --frozen-lockfile && pnpm build:contracts && pnpm --filter localfirstdotsh build" note="Run from the repository root, then copy the connection command above." />
        </>}
        <p className="small muted">The command targets <code>{publicApiUrl()}</code>. It discovers this registry’s MCP endpoint; it does not install a model or execute project code.</p>
      </section>
      <IntegrationGroup />
      <section id="claude-desktop" className="stack gap-16" aria-labelledby="claude-desktop-heading">
        <h2 id="claude-desktop-heading">Claude (claude.ai and Claude Desktop)</h2>
        <p>Add Localfirst as a custom connector by URL. No terminal is needed.</p>
        <McpUrlBlock client="claude-desktop" endpoint={endpoint} />
        <ol className="stack gap-8">
          <li>On Free, Pro, or Max, open <strong>Customize → Connectors → Add custom connector</strong>, paste the URL, and click <strong>Add</strong>.</li>
          <li>On Team or Enterprise, an Owner opens <strong>Organization settings → Connectors → Add → Custom</strong> (choose Web) and pastes the URL. Each person then opens <strong>Customize → Connectors</strong>, finds the connector marked Custom, and clicks <strong>Connect</strong>.</li>
          <li>If Claude asks how it identifies itself to the server, choose <strong>Register automatically</strong>. Sign in with GitHub in your browser and review the permissions requested.</li>
        </ol>
        <p>Free accounts can add one custom connector. Turn Localfirst on or off per conversation from the <strong>+</strong> menu. Custom connectors reach services Anthropic has not verified, so connect only a registry you trust.</p>
        <p className="small muted"><a href="https://claude.com/docs/connectors/custom/add-unlisted">Claude custom connector documentation</a></p>
      </section>
      <section id="chatgpt" className="stack gap-16" aria-labelledby="chatgpt-heading">
        <h2 id="chatgpt-heading">ChatGPT</h2>
        <p>Add Localfirst as a custom MCP server by URL. Custom MCP servers are limited to certain plans and workspace roles, so ask your workspace admin if you do not see the option.</p>
        <McpUrlBlock client="chatgpt" endpoint={endpoint} />
        <ol className="stack gap-8">
          <li>Open <strong>ChatGPT Plugins</strong>, select <strong>+</strong>, then <strong>Add custom MCP server</strong>.</li>
          <li>Enter a name and description, choose <strong>Public endpoint</strong>, and paste the URL. It must include the <code>/mcp</code> path.</li>
          <li>Choose OAuth for authentication, acknowledge the risk warning, and create it. Sign in with GitHub in your browser, then review the tools ChatGPT discovered.</li>
        </ol>
        <p>OpenAI has moved these menus before; if yours differ, follow OpenAI’s current help article.</p>
        <p className="small muted"><a href="https://developers.openai.com/plugins/deploy/connect-chatgpt">ChatGPT custom MCP server documentation</a></p>
      </section>
      <section id="claude-code" className="stack gap-8" aria-labelledby="claude-heading">
        <h2 id="claude-heading">Claude Code</h2>
        <p>Choose Claude Code above. Localfirst runs <code>claude mcp add --transport http</code> using the discovered endpoint, with user scope by default. Review and confirm the command, then open <code>/mcp</code> in Claude Code, choose Localfirst, and sign in in your browser.</p>
      </section>
      <section id="codex" className="stack gap-8" aria-labelledby="codex-heading">
        <h2 id="codex-heading">Codex CLI</h2>
        <p>Choose Codex CLI above. Localfirst runs <code>codex mcp add</code> with the discovered endpoint. Codex starts its own browser sign-in. If sign-in was interrupted, run <code>codex mcp login localfirst</code>.</p>
      </section>
      <section id="gemini-cli" className="stack gap-16" aria-labelledby="gemini-heading">
        <h2 id="gemini-heading">Gemini CLI</h2>
        <p>With a current source build, choose Gemini CLI above. Localfirst runs <code>gemini mcp add --transport http --scope user</code> with the discovered endpoint. Review the command and confirm registration, then run <code>/mcp auth localfirst</code> inside Gemini CLI and complete browser sign-in. Tool approvals stay enabled.</p>
        {endpoint && <CommandBlock command={`gemini mcp add --transport http --scope user localfirst ${shellArgument(endpoint)}`} clients={[]} note="You can also register directly with your installed Gemini CLI, including when it is not in this deployment’s Localfirst CLI selector." />}
        <p className="small muted"><a href="https://geminicli.com/docs/tools/mcp-server/">Gemini CLI MCP documentation</a></p>
      </section>
      <section id="cursor" className="stack gap-16" aria-labelledby="cursor-heading">
        <h2 id="cursor-heading">Cursor</h2>
        <p>Cursor CLI uses the same MCP configuration as the editor. Merge the <code>localfirst</code> entry below into <code>~/.cursor/mcp.json</code> for global access, or <code>.cursor/mcp.json</code> in your project. Preserve your other servers and settings.</p>
        {endpoint && <p><a href={cursorInstallUrl(endpoint)}>Install in Cursor</a> opens Cursor and asks you to confirm adding Localfirst. Or merge the entry yourself:</p>}
        <McpConfigBlock client="cursor" endpoint={endpoint} />
        <p>In Cursor CLI, run <code>agent mcp login localfirst</code> to sign in and review access, then check <code>agent mcp list</code>. In the editor, authenticate from MCP settings when prompted.</p>
        <p className="small muted"><a href="https://cursor.com/docs/cli/mcp">Cursor CLI MCP documentation</a></p>
      </section>
      <section id="opencode" className="stack gap-16" aria-labelledby="opencode-heading">
        <h2 id="opencode-heading">OpenCode</h2>
        <p>Merge the <code>localfirst</code> entry into the <code>mcp</code> object in your project’s <code>opencode.json</code> or <code>opencode.jsonc</code>. Preserve existing providers, servers, and other settings. OpenCode discovers OAuth from the remote server.</p>
        <McpConfigBlock client="opencode" endpoint={endpoint} />
        <p>Run <code>opencode mcp auth localfirst</code> to open browser sign-in and review permissions. Check registration with <code>opencode mcp list</code>. You can also use the interactive <code>opencode mcp add</code> wizard to add the same remote endpoint.</p>
        <p className="small muted"><a href="https://opencode.ai/docs/mcp-servers/">OpenCode MCP documentation</a></p>
      </section>
      <section id="github-copilot" className="stack gap-16" aria-labelledby="copilot-heading">
        <h2 id="copilot-heading">GitHub Copilot</h2>
        <p>For Copilot CLI, merge the <code>localfirst</code> entry into <code>~/.copilot/mcp-config.json</code>. It uses the <code>mcpServers</code> format below. Preserve existing servers and review requested access when Copilot starts browser sign-in.</p>
        <McpConfigBlock client="github-copilot" endpoint={endpoint} />
        {endpoint && <CommandBlock command={`copilot mcp add --transport http localfirst ${shellArgument(endpoint)}`} clients={[]} note="Alternatively, register with your installed Copilot CLI. This changes Copilot’s user MCP configuration; review the command before running it." />}
        <p>Inside Copilot CLI, use <code>/mcp auth localfirst</code> if sign-in is needed, then <code>/mcp list</code> to inspect the server. The <code>tools</code> list makes tools available; it does not replace your consent or tool approvals. VS Code Copilot uses a different configuration format; use its MCP settings for editor setup.</p>
        <p className="small muted"><a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers">GitHub Copilot CLI MCP documentation</a></p>
      </section>
      <section id="vscode" className="stack gap-16" aria-labelledby="vscode-heading">
        <h2 id="vscode-heading">VS Code</h2>
        <p>Run <strong>MCP: Open User Configuration</strong> (all workspaces) or edit <code>.vscode/mcp.json</code> in a workspace, and merge this entry into the <code>servers</code> object. VS Code uses <code>servers</code>, not <code>mcpServers</code>. Preserve existing servers.</p>
        {endpoint && <p><a href={vscodeInstallUrl(endpoint)}>Install in VS Code</a> opens VS Code and asks you to confirm adding Localfirst. Or edit the file yourself:</p>}
        <McpConfigBlock client="vscode" endpoint={endpoint} />
        <p>Start the server from <strong>MCP: List Servers</strong>, then complete the browser sign-in VS Code opens and review the tools it offers before using them.</p>
        <p className="small muted"><a href="https://code.visualstudio.com/docs/copilot/customization/mcp-servers">VS Code MCP documentation</a></p>
      </section>
      <section id="windsurf" className="stack gap-16" aria-labelledby="windsurf-heading">
        <h2 id="windsurf-heading">Windsurf</h2>
        <p>For Windsurf’s Cascade agent, open the Cascade panel’s MCP settings and choose the raw configuration or Open MCP config file action. Merge this entry into <code>mcpServers</code> in the file your installed app opens, preserving other settings.</p>
        <McpConfigBlock client="windsurf" endpoint={endpoint} />
        <p>Save and refresh the server list, enable Localfirst, and complete the client’s OAuth sign-in when prompted. These instructions target Cascade; newer builds with a separate Devin Local agent use different MCP configuration. Team administrators may need to enable MCP access.</p>
        <p className="small muted"><a href="https://docs.windsurf.com/windsurf/cascade/mcp">Windsurf Cascade MCP documentation</a></p>
      </section>
      <section id="cline" className="stack gap-16" aria-labelledby="cline-heading">
        <h2 id="cline-heading">Cline</h2>
        <p>In the Cline extension, open MCP Servers → Configure → Configure MCP Servers and merge the entry below. Cline CLI uses <code>~/.cline/data/settings/cline_mcp_settings.json</code> unless its settings path is overridden. Keep <code>type: streamableHttp</code> explicit and preserve existing servers.</p>
        <McpConfigBlock client="cline" endpoint={endpoint} />
        <p>For guided setup, run <code>cline mcp</code>, or use the extension’s Remote Servers tab and select Streamable HTTP. Complete browser authorization from the client’s OAuth action when requested. The empty <code>autoApprove</code> list keeps tool approval with you.</p>
        <p className="small muted"><a href="https://docs.cline.bot/mcp/mcp-overview">Cline MCP documentation</a></p>
      </section>
      <section id="tools" className="stack gap-16" aria-labelledby="tools-heading">
        <h2 id="tools-heading">What your agent can do</h2>
        <p>These are the tools Localfirst gives a connected client. Which ones work depends on the permissions you grant when you sign in. None of them can reach your computer, run a model, or execute project code.</p>
        <McpToolTable />
      </section>
      <section id="safety" className="stack gap-8" aria-labelledby="safety-heading">
        <h2 id="safety-heading">Stay in control</h2>
        <ul className="stack gap-8">
          <li>Turn on your client’s tool-approval setting so you can review each call before it runs, and use <strong>Always allow</strong> only for read-only tools.</li>
          <li>Project descriptions are written by other people. A connected agent reads them as data, but treat anything that tells your agent to do something as untrusted, especially if you have other servers connected.</li>
          <li>Review the permissions on the sign-in screen. Publishing always needs your approval of the exact version in your browser.</li>
          <li>On a work or school network, your IT administrator may need to allow <code>{endpoint ? new URL(endpoint).host : 'the registry host'}</code>.</li>
        </ul>
      </section>
      <section className="stack gap-8" aria-labelledby="permissions">
        <h2 id="permissions">Review access, then explore</h2>
        <ol className="stack gap-8">
          <li>Sign in with GitHub when your client asks, and review its requested permissions.</li>
          <li>Ask your agent to search projects or read a specification.</li>
          <li>To publish, ask it to prepare a draft. Review the exact version at the approval link before your agent publishes it.</li>
        </ol>
      </section>
      <section className="stack gap-8" aria-labelledby="ecosystem">
        <h2 id="ecosystem">Local AI ecosystem</h2>
        <p className="muted">The source runner has adapters for Ollama and LM Studio. Discovering installed models and running a test are separate local actions, with their own plan and approval. These runtimes are not MCP hosts configured by this connection command.</p>
        <p className="small muted">Aider and Goose are not listed as supported integrations here. Configuration-based integrations use each client’s native setup; the Localfirst CLI offers automatic registration only for the clients in its selector.</p>
      </section>
      <DocsSection id="access-scopes" title="Check access and confirm the connection">
        <p>Ask your agent to search for a public project and read an exact version. Public REST catalog reads are available without sign-in; authenticated MCP access and private draft operations require the appropriate permissions.</p>
        <p>Request only the scopes your task needs. Preparing drafts uses <code>projects:draft</code>; publication uses <code>projects:publish</code> and separate approval of the exact artifact. A registry connection cannot run a model on your machine.</p>
        <p>Review or revoke client access in <a href="/account/connections">Connections</a>. Keep registry tokens separate from GitHub and local runtime credentials.</p>
      </DocsSection>
      <DocsSection id="client-support" title="Client support and troubleshooting">
        <p>The official MCP SDK exercises discovery, tool calls, and resource reads. Claude Code has exercised discovery and read-only environment tool calls in a real model session. Its browser OAuth flow is not established by that test. Codex CLI configuration has been checked; a live model-session connection is not claimed. Other desktop clients remain untested here.</p>
        <ul className="stack gap-8">
          <li><strong>Unauthorized:</strong> reconnect through the client&apos;s supported authentication flow. A REST token and an MCP token have different audiences and are not interchangeable.</li>
          <li><strong>Insufficient scope:</strong> review the permission needed for the requested action and authorize it deliberately.</li>
          <li><strong>Endpoint or transport error:</strong> confirm the URL ends in <code>/mcp</code> and the client supports Streamable HTTP. Opening the endpoint as a browser GET is not a connection test.</li>
          <li><strong>Unsupported client:</strong> use the <a href={`${api}/openapi.json`}>REST API reference</a> and <a href={`${api}/schemas/project/v0.2.json`}>project schema</a> as a fallback. Do not assume an untested client works.</li>
        </ul>
      </DocsSection>
      <p>Next: <Link href="/docs/project-spec">write a project specification</Link>, <Link href="/docs/testing">test locally</Link>, or <Link href="/docs/environments/setup">set up a business environment</Link>.</p>
      {toolkitPreviewEnabled() && <p className="small muted">Preview: <a href="/docs/toolkit">the agent toolkit</a>.</p>}
    </div>
  );
}
