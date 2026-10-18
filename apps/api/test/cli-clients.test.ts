import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL, parseClaudeResult, runClaude } from '../src/verification/cli-clients.js';

function final(patch: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', terminal_reason: 'completed', is_error: false,
    result: '{"ok":true}', structured_output: { ok: true }, permission_denials: [],
    usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 2, thinking_text: 'PRIVATE_REASONING' } },
    modelUsage: { [CLAUDE_MODEL]: { canonicalModel: CLAUDE_MODEL, provider: 'firstParty', inputTokens: 10, outputTokens: 5, secret: 'PRIVATE_USAGE' } },
    hidden_thinking: 'PRIVATE_REASONING', session_id: 'PRIVATE_SESSION', ...patch });
}
describe('installed Claude verification boundary', () => {
  it('requires the exact observed canonical model and refuses fallback or missing identity', () => {
    expect(parseClaudeResult(final()).observed_model).toBe(CLAUDE_MODEL);
    for (const modelUsage of [{}, undefined, { other: { canonicalModel: 'other' } }, { [CLAUDE_MODEL]: { canonicalModel: 'different' } }, { [CLAUDE_MODEL]: { canonicalModel: CLAUDE_MODEL }, fallback: {} }]) {
      expect(() => parseClaudeResult(final({ modelUsage }))).toThrow('canonical model');
    }
  });
  it('retains only final output and filtered numerical usage, never hidden thinking or session metadata', () => {
    const result = parseClaudeResult(final(), { schema: true });
    expect(result.output).toEqual({ ok: true });
    expect(result.usage.output_tokens_details).toEqual({ thinking_tokens: 2 });
    expect(result.metadata).toMatchObject({ locality: 'hosted_cli', eligible_as_local_required_evidence: false, requested_effort: 'medium' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_REASONING|PRIVATE_SESSION|PRIVATE_USAGE/);
  });
  it('refuses incomplete, denied, errored or missing structured output', () => {
    for (const patch of [{ subtype: 'error_max_turns' }, { is_error: true }, { terminal_reason: 'cancelled' }, { permission_denials: [{ tool: 'x' }] }, { structured_output: undefined }]) {
      expect(() => parseClaudeResult(final(patch), { schema: true })).toThrow();
    }
  });
  it('rejects nonempty workspaces and cancellation before spawning any CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lf-claude-boundary-')); await writeFile(join(root, 'user-file'), 'keep');
    await expect(runClaude({ cwd: root, system: 'test', user: 'test' })).rejects.toThrow('must be empty');
    const empty = join(root, 'empty'); await mkdir(empty); const controller = new AbortController(); controller.abort();
    await expect(runClaude({ cwd: empty, system: 'test', user: 'test', signal: controller.signal })).rejects.toThrow('cancelled before start');
    expect(await readdir(empty)).toEqual([]);
  });
  it('refuses privileged MCP tools and unbounded process options before spawning', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lf-claude-limits-'));
    await expect(runClaude({ cwd, system: 'test', user: 'test', timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow('timeout');
    await expect(runClaude({ cwd, system: 'test', user: 'test', maxTurns: 100 })).rejects.toThrow('maxTurns');
    await expect(runClaude({ cwd, system: 'test', user: 'test', mcp: { url: 'http://localhost:1234/mcp', bearer: 'NEVER_WRITE_THIS', allowedTools: ['mcp__localfirst__project_publish'] } })).rejects.toThrow('read-only');
    expect(await readdir(cwd)).toEqual([]);
  });
  it('refuses remote MCP credentials before writing its ephemeral config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lf-claude-remote-'));
    await expect(runClaude({ cwd, system: 'test', user: 'test', mcp: { url: 'https://remote.example/mcp', bearer: 'NEVER_WRITE_THIS' } })).rejects.toThrow('loopback');
    expect(await readdir(cwd)).toEqual([]);
  });
});
