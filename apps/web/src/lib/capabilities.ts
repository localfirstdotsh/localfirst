import { z } from './validation';

/**
 * What this deployment may truthfully advertise (FRONTEND_PRD sections 4.2, 16.5,
 * 22.2). Setup commands come from validated deployment configuration, never from
 * project labels or prototype data. Unset means unreleased.
 *
 * LOCALFIRST_CLI_RELEASED=true
 * LOCALFIRST_CLI_VERSION=0.1.0-beta.0
 * LOCALFIRST_CLI_SETUP_COMMAND="npx localfirstdotsh@beta mcp add --registry https://localfirst.sh"
 * LOCALFIRST_TESTED_CLIENTS='[{"id":"claude-code","label":"Claude Code","command":"npx localfirstdotsh@beta mcp add --client claude-code --registry https://localfirst.sh"}]'
 */

/** Printable ASCII on one line: it is rendered as text and copied verbatim. */
const COMMAND = z.string().regex(/^[\x20-\x7E]{1,200}$/, 'must be one printable line');

const clientSchema = z.object({
  id: z.enum(['claude-code', 'codex', 'gemini-cli']),
  label: z.string().min(1).max(40),
  command: COMMAND,
});

export type SetupClient = z.infer<typeof clientSchema>;

export type SetupState =
  | { state: 'unavailable' }
  | { state: 'available'; version: string | null; command: string; clients: SetupClient[] };

export function readSetupState(env: Record<string, string | undefined> = process.env): SetupState {
  if (env.LOCALFIRST_CLI_RELEASED !== 'true') return { state: 'unavailable' };

  const command = COMMAND.safeParse(env.LOCALFIRST_CLI_SETUP_COMMAND);
  if (!command.success) return { state: 'unavailable' };

  let clients: SetupClient[] = [];
  if (env.LOCALFIRST_TESTED_CLIENTS) {
    try {
      const parsed = z.array(clientSchema).max(12).safeParse(JSON.parse(env.LOCALFIRST_TESTED_CLIENTS));
      if (!parsed.success) return { state: 'unavailable' };
      clients = parsed.data;
    } catch {
      return { state: 'unavailable' };
    }
  }

  const version = env.LOCALFIRST_CLI_VERSION?.trim();
  return {
    state: 'available',
    version: version && /^[\w.+-]{1,40}$/.test(version) ? version : null,
    command: command.data,
    clients,
  };
}

/** CLI profiles are implemented in the runner. Config integrations use the linked
 * vendor's remote MCP/OAuth format; no Localfirst registration flag is invented.
 * Marks and licenses are recorded in public/integrations/LICENSE.txt.
 */
export const AI_INTEGRATIONS = [
  { id: 'claude-code', label: 'Claude Code', icon: 'claude', setup: 'cli' },
  { id: 'codex', label: 'Codex CLI', icon: 'openai', setup: 'cli' },
  { id: 'gemini-cli', label: 'Gemini CLI', icon: 'googlegemini', setup: 'cli' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor', setup: 'config' },
  { id: 'opencode', label: 'OpenCode', icon: 'opencode', setup: 'config' },
  { id: 'github-copilot', label: 'GitHub Copilot', icon: 'githubcopilot', setup: 'config' },
  { id: 'windsurf', label: 'Windsurf', icon: 'windsurf', setup: 'config' },
  { id: 'cline', label: 'Cline', icon: 'cline', setup: 'config' },
] as const;

export const SUPPORTED_AI_CLIENTS = AI_INTEGRATIONS.filter((client) => client.setup === 'cli');

/** Quote a displayed shell argument without changing the value copied into the terminal. */
export function shellArgument(value: string): string {
  return /^[\w:/.-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Source bin: packages/runner/package.json. Target this deployment rather than guessing an endpoint. */
export function sourceSetupClients(registry: string): SetupClient[] {
  const origin = new URL(registry).origin;
  // Shell quoting is needed even for a URL: a configured hostname can contain metacharacters.
  const quoted = shellArgument(origin);
  return SUPPORTED_AI_CLIENTS.map(({ id, label }) => ({
    id, label, command: `node packages/runner/dist/cli/bin.js mcp add --client ${id} --registry ${quoted}`,
  }));
}
