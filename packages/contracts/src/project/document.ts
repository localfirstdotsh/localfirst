/**
 * `PROJECT.md` = YAML frontmatter + Markdown body (BACKEND_PRD section 4.1).
 *
 * Parsing is deliberately hostile to the input: no YAML anchors/aliases, no
 * custom tags, no merge keys, bounded nesting, and no prototype-polluting keys
 * (section 4.3).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const FORBIDDEN_YAML_KEYS = ['__proto__', 'constructor', 'prototype'] as const;
export const MAX_YAML_DEPTH = 12;

export class DocumentParseError extends Error {
  readonly code: string;
  readonly pointer: string;
  constructor(code: string, message: string, pointer = '') {
    super(message);
    this.name = 'DocumentParseError';
    this.code = code;
    this.pointer = pointer;
  }
}

export interface ParsedDocument {
  /** Raw frontmatter object exactly as written (not yet schema-validated). */
  frontmatter: unknown;
  /** Markdown body with no trailing whitespace drift. */
  markdown: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

function assertSafeYamlValue(value: unknown, pointer: string, depth: number): void {
  if (depth > MAX_YAML_DEPTH) {
    throw new DocumentParseError(
      'FRONTMATTER_TOO_DEEP',
      `Frontmatter nesting exceeds ${MAX_YAML_DEPTH} levels`,
      pointer,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) {
    throw new DocumentParseError(
      'FRONTMATTER_UNSUPPORTED_TYPE',
      'Timestamps must be quoted strings in frontmatter',
      pointer,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeYamlValue(item, `${pointer}/${index}`, depth + 1));
    return;
  }
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_YAML_KEYS as readonly string[]).includes(key)) {
      throw new DocumentParseError(
        'FRONTMATTER_FORBIDDEN_KEY',
        `Key \`${key}\` is not allowed in frontmatter`,
        pointer,
      );
    }
    assertSafeYamlValue(
      (value as Record<string, unknown>)[key],
      `${pointer}/${key}`,
      depth + 1,
    );
  }
}

/** Parse YAML text with the restricted profile used for all stored documents. */
export function parseSafeYaml(text: string, pointer = ''): unknown {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, {
      customTags: [],
      merge: false,
      maxAliasCount: -1,
      strict: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch (error) {
    throw new DocumentParseError(
      'YAML_INVALID',
      `YAML is not parseable: ${(error as Error).message}`,
      pointer,
    );
  }
  if (/(^|\s)[&*][A-Za-z0-9_-]/m.test(text) || /^\s*<<\s*:/m.test(text)) {
    throw new DocumentParseError(
      'YAML_ANCHORS_REJECTED',
      'YAML anchors, aliases, and merge keys are rejected',
      pointer,
    );
  }
  if (/!!?[A-Za-z]/.test(text)) {
    throw new DocumentParseError('YAML_TAGS_REJECTED', 'YAML tags are rejected', pointer);
  }
  assertSafeYamlValue(parsed, pointer, 0);
  return parsed;
}

export function parseProjectDocument(text: string): ParsedDocument {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = FRONTMATTER.exec(normalized);
  if (!match) {
    throw new DocumentParseError(
      'FRONTMATTER_MISSING',
      'PROJECT.md must start with a `---` delimited YAML frontmatter block',
    );
  }
  const frontmatter = parseSafeYaml(match[1] ?? '', '');
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new DocumentParseError(
      'FRONTMATTER_NOT_OBJECT',
      'Frontmatter must be a YAML mapping',
    );
  }
  return {
    frontmatter,
    markdown: (match[2] ?? '').replace(/[ \t]+$/gm, '').trim(),
  };
}

/** Deterministic `PROJECT.md` text for export (section 12.1 `/export`). */
export function serializeProjectDocument(manifest: unknown, markdown: string): string {
  const yaml = stringifyYaml(manifest, {
    lineWidth: 0,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    nullStr: 'null',
    sortMapEntries: false,
  }).trimEnd();
  return `---\n${yaml}\n---\n\n${markdown.trim()}\n`;
}

export interface MarkdownSection {
  key: string;
  heading: string;
  body: string;
}

const SECTION_ALIASES: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'purpose', patterns: [/^purpose$/i, /^overview$/i, /^what .*(does|is)/i] },
  {
    key: 'architecture',
    patterns: [/^architecture/i, /^workflow$/i, /^architecture (and|\/) workflow$/i, /^how it works$/i],
  },
  { key: 'setup', patterns: [/^setup$/i, /^installation$/i, /^install$/i, /^getting started$/i] },
  { key: 'execution', patterns: [/^execution$/i, /^usage$/i, /^running$/i, /^run$/i] },
  {
    key: 'tests',
    patterns: [/^test/i, /^evaluation$/i, /^test(ing)? (and|\/) evaluation$/i],
  },
  { key: 'limitations', patterns: [/^limitations$/i, /^known limitations$/i, /^caveats$/i] },
  {
    key: 'sources',
    patterns: [/^sources?/i, /^attribution$/i, /^sources? (and|\/) attribution$/i, /^credits$/i],
  },
];

/** Required section keys; their absence blocks publication. */
export const REQUIRED_SECTIONS = ['purpose', 'setup', 'limitations', 'sources'] as const;
/** Recommended section keys; their absence is a warning only. */
export const RECOMMENDED_SECTIONS = ['architecture', 'execution', 'tests'] as const;

export function sectionKeyFor(heading: string): string | null {
  const trimmed = heading.trim();
  for (const entry of SECTION_ALIASES) {
    if (entry.patterns.some((pattern) => pattern.test(trimmed))) return entry.key;
  }
  return null;
}

/** Split a Markdown body on ATX headings of level 1-3, ignoring fenced code. */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (fence && marker.startsWith(fence[0] as string) && marker.length >= fence.length) {
        fence = null;
      } else if (!fence) {
        fence = marker;
      }
    }
    const headingMatch = fence ? null : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      if (current) {
        sections.push({
          key: sectionKeyFor(current.heading) ?? '',
          heading: current.heading,
          body: current.body.join('\n').trim(),
        });
      }
      current = { heading: headingMatch[1] as string, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) {
    sections.push({
      key: sectionKeyFor(current.heading) ?? '',
      heading: current.heading,
      body: current.body.join('\n').trim(),
    });
  }
  return sections;
}
