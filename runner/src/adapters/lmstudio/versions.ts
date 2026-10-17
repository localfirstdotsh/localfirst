/**
 * LM Studio version facts (BACKEND_PRD section 7.5). The HTTP API exposes no
 * version endpoint, so application, CLI, and engine versions come from other
 * sources and are reported separately. These are pure parsers over text the
 * CLI/discovery step (an explicitly authorized M5 action) has collected; the
 * adapter itself never spawns a process or reads the app bundle.
 */

import { unobserved, type ObservedFact } from '../contract.js';

export type LmStudioFormat = 'gguf' | 'mlx';

export interface LmStudioVersions {
  application: ObservedFact<string>;
  cli: ObservedFact<string>;
  /** Selected inference engine per model format. A missing format stays absent. */
  engines: Partial<Record<LmStudioFormat, ObservedFact<string>>>;
}

/** Supplies version facts. The default reports everything as unobserved. */
export interface VersionSource {
  read(): Promise<LmStudioVersions>;
}

export const NO_VERSIONS: LmStudioVersions = {
  application: unobserved(),
  cli: unobserved(),
  engines: {},
};

export const unobservedVersions: VersionSource = { read: async () => NO_VERSIONS };

/** `lms version` prints `CLI commit: <hash>`; that is the CLI, not an engine or app version. */
export function parseLmsVersion(text: string): ObservedFact<string> {
  const match = /^CLI commit:\s*([0-9a-f]{7,40})\s*$/m.exec(text);
  return match?.[1] ? { value: match[1], source: 'lms version' } : unobserved();
}

export interface RuntimeEngine {
  name: string;
  version: string;
  format: string;
  selected: boolean;
}

export interface RuntimeList {
  engines: RuntimeEngine[];
  /** The selected engine (`name@version`) per model format. */
  selected: Partial<Record<LmStudioFormat, string>>;
}

const ENGINE_LINE = /^(\S+)@(\S+)\s+(✓\s+)?(GGUF|MLX|[A-Za-z0-9_-]+)\s*$/u;

/** Parse `lms runtime ls`. Unrecognized lines are ignored, never guessed at. */
export function parseRuntimeList(text: string): RuntimeList {
  const engines: RuntimeEngine[] = [];
  const selected: RuntimeList['selected'] = {};
  for (const line of text.split('\n')) {
    const match = ENGINE_LINE.exec(line.trimEnd());
    if (!match?.[1] || !match[2] || !match[4]) continue;
    const format = match[4].toLowerCase();
    const engine = { name: match[1], version: match[2], format, selected: match[3] !== undefined };
    engines.push(engine);
    if (engine.selected && (format === 'gguf' || format === 'mlx')) {
      selected[format] = `${engine.name}@${engine.version}`;
    }
  }
  return { engines, selected };
}

/** Selected engines as version facts, sourced to `lms runtime ls`. */
export function engineFacts(list: RuntimeList): LmStudioVersions['engines'] {
  const facts: LmStudioVersions['engines'] = {};
  for (const [format, engine] of Object.entries(list.selected) as Array<[LmStudioFormat, string]>) {
    facts[format] = { value: engine, source: 'lms runtime ls' };
  }
  return facts;
}

/** `CFBundleShortVersionString` from `plutil -p` output or an XML Info.plist. */
export function parseAppVersion(plistText: string): ObservedFact<string> {
  const printed = /"CFBundleShortVersionString"\s*=>\s*"([^"]+)"/.exec(plistText);
  const xml = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plistText);
  const value = printed?.[1] ?? xml?.[1];
  return value ? { value, source: 'Info.plist CFBundleShortVersionString' } : unobserved();
}

/**
 * One engine value for the contract's single `engine` fact: the selected engine
 * for each format, `format=engine`, sorted. Null when none was observed.
 */
export function summarizeEngines(engines: LmStudioVersions['engines']): ObservedFact<string> {
  const parts = Object.entries(engines)
    .filter((entry): entry is [string, ObservedFact<string>] => entry[1]?.value != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([format, fact]) => `${format}=${fact.value}`);
  if (parts.length === 0) return unobserved();
  return { value: parts.join(';'), source: 'lms runtime ls' };
}
