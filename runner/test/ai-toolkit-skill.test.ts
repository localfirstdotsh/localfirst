/**
 * The `localfirst` agent skill (`skills/localfirst`) names MCP tools, CLI commands and a schema.
 * It is documentation an agent will obey, so it must not drift from the code it describes.
 * No database is needed: the tool names are read from the backend source.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_SCHEMA_ID } from '@localfirst/contracts';
import { HELP } from '../src/cli/main.js';

const root = resolve(import.meta.dirname, '..', '..');
const skillDir = join(root, 'skills', 'localfirst');
const files = ['SKILL.md', ...readdirSync(join(skillDir, 'references')).map((f) => join('references', f))];
const skill = Object.fromEntries(files.map((f) => [f, readFileSync(join(skillDir, f), 'utf8')]));
const all = Object.values(skill).join('\n');

const mcpSource = ['tools.ts', 'environments.ts']
  .map((f) => readFileSync(join(root, 'backend', 'src', 'mcp', f), 'utf8'))
  .join('\n');

describe('localfirst agent skill', () => {
  it('has frontmatter naming the skill after its directory', () => {
    const head = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill['SKILL.md']!);
    expect(head?.[1]).toBe('localfirst');
    expect(head?.[2]!.length).toBeGreaterThan(40);
  });

  const registered = new Set([
    ...[...mcpSource.matchAll(/registerTool\(\s*'([a-z]+_[a-z_]+)'/g)].map((m) => m[1]!),
    'environment_get',
    'environment_plan_local',
  ]);
  const inventory = skill['SKILL.md']!.split('## Tool inventory')[1]!.split('## Reporting')[0]!;
  // Tool names are the backticked identifiers that start a list item or follow a comma in the inventory.
  const named = new Set([...inventory.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!).filter((n) => n !== 'expected_revision'));

  it('names only MCP tools that the backend registers', () => {
    expect(named.size).toBeGreaterThan(15);
    for (const tool of named) expect(registered, tool).toContain(tool);
  });

  it('lists every tool the backend registers', () => {
    for (const tool of registered) expect(named, tool).toContain(tool);
  });

  it('uses only CLI commands the runner help lists', () => {
    const commands = [...all.matchAll(/localfirstdotsh ((?:auth|contribution|environment|framework|project|report|runtime|test) [a-z-]+)/g)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThan(5);
    for (const command of commands) expect(HELP, command).toContain(`localfirstdotsh ${command}`);
  });

  it('points at the current project schema and a client matrix that exists', () => {
    expect(SPEC_SCHEMA_ID).toBe('localfirst/project/v0.2');
    expect(all).toContain('localfirst://schemas/project/v0.2');
    expect(all).toContain(`/schemas/project/v0.2.json`);
    expect(() => readFileSync(join(skillDir, 'references', '..', '..', '..', 'backend', 'docs', 'CLIENT_MATRIX.md'))).not.toThrow();
  });

  it('does not advertise the unpublished `mcp add` command as working', () => {
    expect(all).toMatch(/`localfirstdotsh mcp add` is not available yet/);
    // Publishable metadata does not mean a release exists on npm. Keep the
    // package's release notice and the agent guidance consistent until the
    // verified public release updates both together.
    const packageReadme = readFileSync(join(root, 'runner', 'README.md'), 'utf8');
    expect(packageReadme).toContain('being prepared for its first npm release');
  });
});
