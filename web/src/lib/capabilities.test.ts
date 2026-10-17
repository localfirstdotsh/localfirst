import { describe, expect, it } from 'vitest';
import { AI_INTEGRATIONS, readSetupState, sourceSetupClients } from './capabilities';

describe('readSetupState', () => {
  it('is unavailable unless the CLI is explicitly marked released', () => {
    expect(readSetupState({})).toEqual({ state: 'unavailable' });
    expect(readSetupState({ LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add' })).toEqual({
      state: 'unavailable',
    });
    expect(
      readSetupState({ LOCALFIRST_CLI_RELEASED: 'yes', LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add' }),
    ).toEqual({ state: 'unavailable' });
  });

  it('is unavailable when released but the command is missing or unsafe', () => {
    expect(readSetupState({ LOCALFIRST_CLI_RELEASED: 'true' })).toEqual({ state: 'unavailable' });
    expect(
      readSetupState({ LOCALFIRST_CLI_RELEASED: 'true', LOCALFIRST_CLI_SETUP_COMMAND: 'npx x\nrm -rf /' }),
    ).toEqual({ state: 'unavailable' });
  });

  it('returns the exact configured command and tested clients', () => {
    const state = readSetupState({
      LOCALFIRST_CLI_RELEASED: 'true',
      LOCALFIRST_CLI_VERSION: '0.1.0',
      LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add',
      LOCALFIRST_TESTED_CLIENTS: JSON.stringify([
        { id: 'claude-code', label: 'Claude Code', command: 'npx localfirstdotsh mcp add --client claude-code' },
      ]),
    });
    expect(state).toEqual({
      state: 'available',
      version: '0.1.0',
      command: 'npx localfirstdotsh mcp add',
      clients: [{ id: 'claude-code', label: 'Claude Code', command: 'npx localfirstdotsh mcp add --client claude-code' }],
    });
  });

  it('refuses malformed client data rather than advertising an untested client', () => {
    expect(
      readSetupState({
        LOCALFIRST_CLI_RELEASED: 'true',
        LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add',
        LOCALFIRST_TESTED_CLIENTS: '{not json',
      }),
    ).toEqual({ state: 'unavailable' });
    expect(
      readSetupState({
        LOCALFIRST_CLI_RELEASED: 'true',
        LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add',
        LOCALFIRST_TESTED_CLIENTS: JSON.stringify([{ id: 'Bad Id', label: 'X', command: 'x' }]),
      }),
    ).toEqual({ state: 'unavailable' });
  });
});

describe('source setup', () => {
  it('uses the implemented client keys and targets the deployment origin', () => {
    const clients = sourceSetupClients('https://registry.example.test/nested');
    expect(clients.map(({ id }) => id)).toEqual(['claude-code', 'codex', 'gemini-cli']);
    expect(clients[0]!.command).toBe('node runner/dist/cli/bin.js mcp add --client claude-code --registry https://registry.example.test');
    expect(clients[1]!.command).toBe('node runner/dist/cli/bin.js mcp add --client codex --registry https://registry.example.test');
    expect(clients[2]!.command).toBe('node runner/dist/cli/bin.js mcp add --client gemini-cli --registry https://registry.example.test');
  });
});

it('does not accept registration clients absent from the runner', () => {
  expect(readSetupState({ LOCALFIRST_CLI_RELEASED: 'true', LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add --client gemini', LOCALFIRST_TESTED_CLIENTS: JSON.stringify([{ id: 'gemini', label: 'Gemini CLI', command: 'npx localfirstdotsh mcp add --client gemini' }]) })).toEqual({ state: 'unavailable' });
});

it('keeps native configuration integrations out of the automatic CLI selector', () => {
  expect(AI_INTEGRATIONS.filter((item) => item.setup === 'config').map(({ id }) => id)).toEqual(['cursor', 'opencode', 'github-copilot', 'windsurf', 'cline']);
  expect(sourceSetupClients('https://registry.example.test').some(({ command }) => /--client (cursor|opencode|github-copilot|windsurf|cline)/.test(command))).toBe(false);
  expect(readSetupState({ LOCALFIRST_CLI_RELEASED: 'true', LOCALFIRST_CLI_SETUP_COMMAND: 'npx localfirstdotsh mcp add --client gemini-cli', LOCALFIRST_TESTED_CLIENTS: JSON.stringify([{ id: 'gemini-cli', label: 'Gemini CLI', command: 'npx localfirstdotsh mcp add --client gemini-cli' }]) }).state).toBe('available');
});
