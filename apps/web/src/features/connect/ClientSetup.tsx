import type { ReactNode } from 'react';
import { CommandBlock } from '../../components/composites/CommandBlock';
import { AI_INTEGRATIONS, readSetupState, shellArgument, sourceSetupClients, type SetupClient, type SetupState } from '../../lib/capabilities';
import { publicApiUrl } from '../../lib/api';
import { cursorInstallUrl, vscodeInstallUrl } from '../../lib/mcp-setup';
import { McpConfigBlock } from './McpConfigBlock';
import { McpUrlBlock } from './McpUrlBlock';
import { ClientSetupTabs } from './ClientSetupTabs';

function CliSetup({ client, endpoint, setup }: { client: SetupClient['id']; endpoint: string | null; setup: SetupState }) {
  const source = setup.state === 'unavailable';
  const configured = (source ? sourceSetupClients(publicApiUrl()) : setup.clients).find((item) => item.id === client);
  // Native commands match the registration profiles implemented by the runner.
  const native = endpoint ? {
    'claude-code': `claude mcp add --transport http --scope user localfirst ${shellArgument(endpoint)}`,
    codex: `codex mcp add localfirst --url ${shellArgument(endpoint)}`,
    'gemini-cli': `gemini mcp add --transport http --scope user localfirst ${shellArgument(endpoint)}`,
  }[client] : null;
  const command = configured?.command ?? native;
  return <div className="stack gap-16">
    <p className="small muted">Requires your installed AI client{configured ? ' and Node.js 22+' : ''}. Use an interactive terminal to review and confirm registration.</p>
    {source && <details className="docs-prerequisites">
      <summary>First time? Build the Localfirst CLI</summary>
      <div className="stack gap-8">
        <p>The npm package is not released yet. From a checkout of the <a href="https://github.com/localfirstdotsh/localfirst">Localfirst repository</a>, run:</p>
        <CommandBlock clients={[]} command="pnpm install --frozen-lockfile && pnpm build:contracts && pnpm --filter localfirstdotsh build" note="Build once, then run the connection command below from the same repository root." />
      </div>
    </details>}
    {command ? <CommandBlock clients={[]} command={command} note={source ? 'Run from your built repository checkout. This registers the client; it does not download models or run project code.' : 'Run in your terminal, then complete sign-in through your client.'} /> : <p className="notice">The registry’s MCP endpoint is unavailable. <a href={`/docs/connect#${client}`}>Retry setup</a> or contact your registry operator.</p>}
  </div>;
}

/** One picker for CLI commands, native JSON configuration, and URL-based clients. */
export function ClientSetup({ endpoint }: { endpoint: string | null }) {
  const setup = readSetupState();
  const panels: { id: string; label: string; icon?: string; content: ReactNode }[] = [
    { id: 'claude-code', label: 'Claude Code', icon: AI_INTEGRATIONS.find((client) => client.id === 'claude-code')?.icon, content: <>
        <CliSetup client="claude-code" endpoint={endpoint} setup={setup} />
        <p>After registration, open <code>/mcp</code> in Claude Code, choose Localfirst, and complete browser sign-in.</p>
      </> },
    { id: 'codex', label: 'Codex CLI', icon: AI_INTEGRATIONS.find((client) => client.id === 'codex')?.icon, content: <>
        <CliSetup client="codex" endpoint={endpoint} setup={setup} />
        <p>Complete browser sign-in when Codex asks. If sign-in was interrupted, run <code>codex mcp login localfirst</code>.</p>
      </> },
    { id: 'gemini-cli', label: 'Gemini CLI', icon: AI_INTEGRATIONS.find((client) => client.id === 'gemini-cli')?.icon, content: <>
        <CliSetup client="gemini-cli" endpoint={endpoint} setup={setup} />
        <p>After registration, run <code>/mcp auth localfirst</code> inside Gemini CLI and complete browser sign-in. Keep tool approvals enabled.</p>
        <p className="small muted"><a href="https://geminicli.com/docs/tools/mcp-server/">Gemini CLI MCP documentation</a></p>
      </> },
    { id: 'cursor', label: 'Cursor', icon: AI_INTEGRATIONS.find((client) => client.id === 'cursor')?.icon, content: <>
        <p>Cursor CLI uses the same MCP configuration as the editor. Merge the <code>localfirst</code> entry below into <code>~/.cursor/mcp.json</code> for global access, or <code>.cursor/mcp.json</code> in your project. Preserve your other servers and settings.</p>
        {endpoint && <p><a href={cursorInstallUrl(endpoint)}>Install in Cursor</a> opens Cursor and asks you to confirm adding Localfirst. Or merge the entry yourself:</p>}
        <McpConfigBlock client="cursor" endpoint={endpoint} />
        <p>In Cursor CLI, run <code>agent mcp login localfirst</code> to sign in and review access, then check <code>agent mcp list</code>. In the editor, authenticate from MCP settings when prompted.</p>
        <p className="small muted"><a href="https://cursor.com/docs/cli/mcp">Cursor CLI MCP documentation</a></p>
      </> },
    { id: 'opencode', label: 'OpenCode', icon: AI_INTEGRATIONS.find((client) => client.id === 'opencode')?.icon, content: <>
        <p>Merge the <code>localfirst</code> entry into the <code>mcp</code> object in your project’s <code>opencode.json</code> or <code>opencode.jsonc</code>. Preserve existing providers, servers, and other settings. OpenCode discovers OAuth from the remote server.</p>
        <McpConfigBlock client="opencode" endpoint={endpoint} />
        <p>Run <code>opencode mcp auth localfirst</code> to open browser sign-in and review permissions. Check registration with <code>opencode mcp list</code>. You can also use the interactive <code>opencode mcp add</code> wizard to add the same remote endpoint.</p>
        <p className="small muted"><a href="https://opencode.ai/docs/mcp-servers/">OpenCode MCP documentation</a></p>
      </> },
    { id: 'github-copilot', label: 'GitHub Copilot', icon: AI_INTEGRATIONS.find((client) => client.id === 'github-copilot')?.icon, content: <>
        <p>For Copilot CLI, merge the <code>localfirst</code> entry into <code>~/.copilot/mcp-config.json</code>. It uses the <code>mcpServers</code> format below. Preserve existing servers and review requested access when Copilot starts browser sign-in.</p>
        <McpConfigBlock client="github-copilot" endpoint={endpoint} />
        {endpoint && <CommandBlock command={`copilot mcp add --transport http localfirst ${shellArgument(endpoint)}`} clients={[]} note="Alternatively, register with your installed Copilot CLI. This changes Copilot’s user MCP configuration; review the command before running it." />}
        <p>Inside Copilot CLI, use <code>/mcp auth localfirst</code> if sign-in is needed, then <code>/mcp list</code> to inspect the server. The <code>tools</code> list makes tools available; it does not replace your consent or tool approvals. VS Code Copilot uses a different configuration format; use its MCP settings for editor setup.</p>
        <p className="small muted"><a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers">GitHub Copilot CLI MCP documentation</a></p>
      </> },
    { id: 'windsurf', label: 'Windsurf', icon: AI_INTEGRATIONS.find((client) => client.id === 'windsurf')?.icon, content: <>
        <p>For Windsurf’s Cascade agent, open the Cascade panel’s MCP settings and choose the raw configuration or Open MCP config file action. Merge this entry into <code>mcpServers</code> in the file your installed app opens, preserving other settings.</p>
        <McpConfigBlock client="windsurf" endpoint={endpoint} />
        <p>Save and refresh the server list, enable Localfirst, and complete the client’s OAuth sign-in when prompted. These instructions target Cascade; newer builds with a separate Devin Local agent use different MCP configuration. Team administrators may need to enable MCP access.</p>
        <p className="small muted"><a href="https://docs.windsurf.com/windsurf/cascade/mcp">Windsurf Cascade MCP documentation</a></p>
      </> },
    { id: 'cline', label: 'Cline', icon: AI_INTEGRATIONS.find((client) => client.id === 'cline')?.icon, content: <>
        <p>In the Cline extension, open MCP Servers → Configure → Configure MCP Servers and merge the entry below. Cline CLI uses <code>~/.cline/data/settings/cline_mcp_settings.json</code> unless its settings path is overridden. Keep <code>type: streamableHttp</code> explicit and preserve existing servers.</p>
        <McpConfigBlock client="cline" endpoint={endpoint} />
        <p>For guided setup, run <code>cline mcp</code>, or use the extension’s Remote Servers tab and select Streamable HTTP. Complete browser authorization from the client’s OAuth action when requested. The empty <code>autoApprove</code> list keeps tool approval with you.</p>
        <p className="small muted"><a href="https://docs.cline.bot/mcp/mcp-overview">Cline MCP documentation</a></p>
      </> },
    { id: 'claude-desktop', label: 'Claude', icon: 'claude', content: <>
        <p>Add Localfirst as a custom connector by URL. No terminal is needed.</p>
        <McpUrlBlock client="claude-desktop" endpoint={endpoint} />
        <ol className="stack gap-8">
          <li>On Free, Pro, or Max, open <strong>Customize → Connectors → Add custom connector</strong>, paste the URL, and click <strong>Add</strong>.</li>
          <li>On Team or Enterprise, an Owner opens <strong>Organization settings → Connectors → Add → Custom</strong> (choose Web) and pastes the URL. Each person then opens <strong>Customize → Connectors</strong>, finds the connector marked Custom, and clicks <strong>Connect</strong>.</li>
          <li>If Claude asks how it identifies itself to the server, choose <strong>Register automatically</strong>. Sign in with GitHub in your browser and review the permissions requested.</li>
        </ol>
        <p>Free accounts can add one custom connector. Turn Localfirst on or off per conversation from the <strong>+</strong> menu. Custom connectors reach services Anthropic has not verified, so connect only a registry you trust.</p>
        <p className="small muted"><a href="https://claude.com/docs/connectors/custom/add-unlisted">Claude custom connector documentation</a></p>
      </> },
    { id: 'chatgpt', label: 'ChatGPT', icon: 'openai', content: <>
        <p>Add Localfirst as a custom MCP server by URL. Custom MCP servers are limited to certain plans and workspace roles, so ask your workspace admin if you do not see the option.</p>
        <McpUrlBlock client="chatgpt" endpoint={endpoint} />
        <ol className="stack gap-8">
          <li>Open <strong>ChatGPT Plugins</strong>, select <strong>+</strong>, then <strong>Add custom MCP server</strong>.</li>
          <li>Enter a name and description, choose <strong>Public endpoint</strong>, and paste the URL. It must include the <code>/mcp</code> path.</li>
          <li>Choose OAuth for authentication, acknowledge the risk warning, and create it. Sign in with GitHub in your browser, then review the tools ChatGPT discovered.</li>
        </ol>
        <p>OpenAI has moved these menus before; if yours differ, follow OpenAI’s current help article.</p>
        <p className="small muted"><a href="https://developers.openai.com/plugins/deploy/connect-chatgpt">ChatGPT custom MCP server documentation</a></p>
      </> },
    { id: 'vscode', label: 'VS Code', content: <>
        <p>Run <strong>MCP: Open User Configuration</strong> (all workspaces) or edit <code>.vscode/mcp.json</code> in a workspace, and merge this entry into the <code>servers</code> object. VS Code uses <code>servers</code>, not <code>mcpServers</code>. Preserve existing servers.</p>
        {endpoint && <p><a href={vscodeInstallUrl(endpoint)}>Install in VS Code</a> opens VS Code and asks you to confirm adding Localfirst. Or edit the file yourself:</p>}
        <McpConfigBlock client="vscode" endpoint={endpoint} />
        <p>Start the server from <strong>MCP: List Servers</strong>, then complete the browser sign-in VS Code opens and review the tools it offers before using them.</p>
        <p className="small muted"><a href="https://code.visualstudio.com/docs/copilot/customization/mcp-servers">VS Code MCP documentation</a></p>
      </> },
  ];
  return <section id="setup" className="setup-section stack gap-16" aria-labelledby="choose-client">
    <div className="stack gap-8">
      <h2 id="choose-client">Choose your client</h2>
      <p className="muted">Select an app to see its setup command, configuration, or server URL.</p>
    </div>
    <ClientSetupTabs clients={panels} />
  </section>;
}
