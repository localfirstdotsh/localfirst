import type { CliEnv } from '../context.js';
import { CliError, EXIT, refusal, usageError } from '../errors.js';
import { requireTty } from '../io.js';
import { parse, registryOrigin, str } from './common.js';

/**
 * `mcp add --client <client>`: register the registry's hosted MCP server with
 * an agent application through that application's own CLI.
 *
 * Only clients whose native `mcp add` was exercised are offered. The MCP URL
 * comes from the registry's protected-resource metadata, never from a guess.
 * The command line is shown in full and run only after an interactive "yes",
 * as an argument vector without a shell. No token passes through this CLI:
 * the application signs in with the registry's OAuth flow itself.
 */

interface ClientProfile {
  label: string;
  program: string;
  args: (name: string, url: string, scope: string | undefined) => string[];
  scopes?: readonly string[];
  /** The client starts its own browser sign-in as part of adding the server. */
  signsInDuringAdd?: boolean;
  signIn: (name: string) => string;
}

/**
 * A client with no command line for adding a server. The CLI prints the
 * configuration to paste and never edits the application's files.
 */
interface SnippetProfile {
  label: string;
  /** A one-click install link the editor confirms before adding anything. */
  installLink?: (url: string) => string;
  file: string;
  snippet: (name: string, url: string) => string;
  signIn: (name: string) => string;
}

const CLIENTS: Record<string, ClientProfile> = {
  'claude-code': {
    label: 'Claude Code',
    program: 'claude',
    args: (name, url, scope) => ['mcp', 'add', '--transport', 'http', '--scope', scope ?? 'user', name, url],
    scopes: ['local', 'user', 'project'],
    signIn: (name) => `In Claude Code, run /mcp, select "${name}", and sign in in your browser.`,
  },
  codex: {
    label: 'Codex CLI',
    program: 'codex',
    args: (name, url) => ['mcp', 'add', name, '--url', url],
    // `codex mcp add` signs in immediately when the server uses OAuth.
    signsInDuringAdd: true,
    signIn: (name) => `If you did not finish signing in, run \`codex mcp login ${name}\`.`,
  },
  'github-copilot': {
    label: 'GitHub Copilot CLI',
    program: 'copilot',
    args: (name, url) => ['mcp', 'add', '--transport', 'http', name, url],
    signIn: (name) => `In Copilot CLI, run /mcp auth ${name} if sign-in is needed.`,
  },
  // https://geminicli.com/docs/tools/mcp-server/#adding-a-server-gemini-mcp-add
  'gemini-cli': {
    label: 'Gemini CLI',
    program: 'gemini',
    args: (name, url, scope) => ['mcp', 'add', '--transport', 'http', '--scope', scope ?? 'user', name, url],
    scopes: ['user', 'project'],
    signIn: (name) => `In Gemini CLI, run /mcp auth ${name} and complete browser sign-in.`,
  },
};

/**
 * A hosted app with no file or command: the person pastes the URL into its
 * settings. The CLI prints the verified URL and the steps; it changes nothing.
 */
interface GuideProfile {
  label: string;
  steps: (url: string) => string[];
}

const GUIDES: Record<string, GuideProfile> = {
  'claude-desktop': {
    label: 'Claude (claude.ai and Claude Desktop)',
    steps: () => [
      'Free, Pro, Max: Customize > Connectors > Add custom connector, paste the URL, and click Add.',
      'Team, Enterprise: an Owner opens Organization settings > Connectors > Add > Custom (Web) and pastes the URL.',
      'Then each person opens Customize > Connectors, finds the connector marked Custom, and clicks Connect.',
      'If Claude asks how it identifies itself, choose "Register automatically". Sign in in your browser and review the requested permissions.',
    ],
  },
  chatgpt: {
    label: 'ChatGPT',
    steps: () => [
      'Open ChatGPT Plugins (chatgpt.com/plugins), select +, then Add custom MCP server.',
      'Enter a name and description, choose Public endpoint, and paste the URL (it must include /mcp).',
      'Choose OAuth for authentication, acknowledge the risk warning, and create it. Sign in in your browser.',
      'Custom MCP servers need a plan and workspace role that allow them; menu names change, so follow OpenAI\'s current help article if yours differ.',
    ],
  },
};

const wrap = (key: string, name: string, entry: object) => JSON.stringify({ [key]: { [name]: entry } }, null, 2);
const BROWSER = 'sign in in your browser when the application asks';

const SNIPPETS: Record<string, SnippetProfile> = {
  cursor: {
    label: 'Cursor',
    file: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json (this project)',
    // The link always names the server `localfirst`; it carries only the URL.
    installLink: (url) =>
      `cursor://anysphere.cursor-deeplink/mcp/install?name=localfirst&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url }), 'utf8').toString('base64'))}`,
    snippet: (name, url) => wrap('mcpServers', name, { url }),
    signIn: () => 'In Cursor, open Settings > MCP, select the server, and sign in in your browser.',
  },
  vscode: {
    label: 'VS Code',
    file: '.vscode/mcp.json (this workspace) or your user mcp.json (run "MCP: Open User Configuration")',
    installLink: (url) =>
      `https://vscode.dev/redirect/mcp/install?name=localfirst&config=${encodeURIComponent(JSON.stringify({ type: 'http', url }))}`,
    snippet: (name, url) => wrap('servers', name, { type: 'http', url }),
    signIn: () => 'In VS Code, start the server from the MCP: List Servers command and sign in in your browser.',
  },
  opencode: {
    label: 'OpenCode',
    file: 'opencode.json or opencode.jsonc (merge into the existing "mcp" object)',
    snippet: (name, url) => wrap('mcp', name, { type: 'remote', url, enabled: true }),
    signIn: (name) => `Run \`opencode mcp auth ${name}\` and ${BROWSER}.`,
  },
  windsurf: {
    label: 'Windsurf',
    file: 'the mcp_config.json that Windsurf opens from its MCP settings (merge into "mcpServers")',
    snippet: (name, url) => wrap('mcpServers', name, { serverUrl: url }),
    signIn: () => `In Windsurf, refresh the MCP server list, enable the server, and ${BROWSER}.`,
  },
  cline: {
    label: 'Cline',
    file: 'Cline\'s MCP settings (extension: MCP Servers > Configure; CLI: ~/.cline/data/settings/cline_mcp_settings.json)',
    snippet: (name, url) => wrap('mcpServers', name, { type: 'streamableHttp', url, disabled: false, autoApprove: [] }),
    signIn: () => `In Cline, use the server's OAuth action and ${BROWSER}.`,
  },
};

export const MCP_CLIENTS = [...Object.keys(CLIENTS), ...Object.keys(SNIPPETS), ...Object.keys(GUIDES)];
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const MAX_METADATA_BYTES = 64 * 1024;

/** Parse a small JSON body, or null if it is oversized, interrupted, or not JSON. */
async function boundedJson(response: Response): Promise<unknown> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** The MCP resource the registry itself advertises, which must live on the registry's origin. */
async function mcpResource(env: CliEnv, origin: string): Promise<string> {
  let response: Response;
  try {
    response = await env.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      headers: { accept: 'application/json' },
      // Never follow a redirect: the metadata must come from the registry's own origin.
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new CliError(`Could not reach ${origin}: ${(cause as Error).message}`, EXIT.failed);
  }
  if (!response.ok) throw new CliError(`${origin} did not publish MCP metadata (HTTP ${response.status}).`, EXIT.failed);
  const body = (await boundedJson(response)) as { resource?: unknown } | null;
  if (typeof body?.resource !== 'string') throw new CliError(`${origin} published MCP metadata without a resource URL.`, EXIT.failed);
  let resource: URL;
  try {
    resource = new URL(body.resource);
  } catch {
    throw new CliError(`${origin} published an invalid MCP resource URL.`, EXIT.failed);
  }
  if (resource.origin !== origin) {
    throw refusal(`The registry advertises an MCP server on a different origin (${resource.origin}); not adding it.`);
  }
  if (resource.username || resource.password || resource.search || resource.hash) {
    throw refusal('The advertised MCP URL carries credentials, a query, or a fragment; not adding it.');
  }
  return resource.href;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

export async function mcpAdd(env: CliEnv, argv: string[]): Promise<number> {
  const { values } = parse(
    argv,
    {
      client: { type: 'string' },
      registry: { type: 'string' },
      name: { type: 'string' },
      scope: { type: 'string' },
      print: { type: 'boolean' },
    },
    { min: 0, max: 0 },
  );
  const clientKey = str(values.client);
  if (!clientKey) throw usageError(`Pass --client ${MCP_CLIENTS.join('|')}.`);
  const snippet = SNIPPETS[clientKey];
  const guide = GUIDES[clientKey];
  const client = CLIENTS[clientKey];
  if (!client && !snippet && !guide) {
    throw usageError(`"${clientKey}" is not a tested client. Supported: ${MCP_CLIENTS.join(', ')}.`);
  }
  const name = str(values.name) ?? 'localfirst';
  if (!NAME.test(name)) throw usageError('--name must be 1-40 lowercase letters, digits, or hyphens.');
  const scope = str(values.scope);
  if (snippet && scope !== undefined) throw usageError(`${snippet.label} has no --scope option; choose the file yourself.`);
  if (guide && scope !== undefined) throw usageError(`${guide.label} has no --scope option.`);
  if (client && scope !== undefined && !client.scopes?.includes(scope)) {
    throw usageError(client.scopes ? `--scope must be one of ${client.scopes.join(', ')}.` : `${client.label} has no --scope option.`);
  }

  const origin = registryOrigin(env, str(values.registry));
  const url = await mcpResource(env, origin);
  if (guide) {
    env.io.out(
      [
        `Add the Localfirst registry to ${guide.label} by URL. Nothing was changed; no application is edited by this CLI.`,
        '',
        `MCP server URL: ${url}`,
        '',
        ...guide.steps(url).map((step, index) => `${index + 1}. ${step}`),
      ].join('\n') + '\n',
    );
    return EXIT.ok;
  }
  if (snippet) {
    env.io.out(
      [
        `Add this to ${snippet.file}. Nothing was changed; ${snippet.label} is not edited by this CLI.`,
        '',
        snippet.snippet(name, url),
        '',
        ...(snippet.installLink && name === 'localfirst'
          ? [`Or open this link to let ${snippet.label} add it (it asks you to confirm):`, `  ${snippet.installLink(url)}`, '']
          : []),
        `Next: ${snippet.signIn(name)}`,
      ].join('\n') + '\n',
    );
    return EXIT.ok;
  }
  if (!client) throw usageError(`"${clientKey}" is not a tested client.`);
  const args = client.args(name, url, scope);
  const commandLine = [client.program, ...args].map(quote).join(' ');

  if (values.print === true) {
    env.io.out(`${commandLine}\n`);
    return EXIT.ok;
  }

  requireTty(env.io, `Adding an MCP server to ${client.label}`);
  env.io.out(
    [
      `This adds the Localfirst registry at ${url} to ${client.label} as "${name}".`,
      'It runs exactly this command, which changes that application\'s MCP configuration:',
      '',
      `  ${commandLine}`,
      '',
      client.signsInDuringAdd
        ? `${client.label} then starts its own browser sign-in in this terminal; no token passes through this CLI.`
        : 'No token is created or stored here; you sign in from the application afterwards.',
    ].join('\n') + '\n',
  );
  if (!(await env.io.ask('Run it? Type "yes" to continue: '))) {
    env.io.out('Nothing was changed.\n');
    return EXIT.refused;
  }

  // Attached to this terminal: some clients (Codex) start their browser sign-in
  // as part of `mcp add`, and the person must see and finish it.
  const result = await env.runInteractive(client.program, args);
  if (result.errorCode === 'ENOENT') {
    throw new CliError(`\`${client.program}\` was not found on your PATH. Install ${client.label}, or run the command above yourself.`, EXIT.failed);
  }
  if (result.code !== 0) {
    throw new CliError(`${client.label} did not complete the change (exit ${result.code ?? 'none'}). Its own output above says why.`, EXIT.failed);
  }
  env.io.out(`Added "${name}" to ${client.label}.\nNext: ${client.signIn(name)}\n`);
  return EXIT.ok;
}
