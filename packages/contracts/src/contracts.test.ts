import { describe, expect, it } from 'vitest';
import { canonicalize, digestOf, versionContentDigest } from './canonical.js';
import { MAX_YAML_DEPTH, parseProjectDocument, parseSafeYaml, serializeProjectDocument, splitMarkdownSections } from './project/document.js';
import { validateProjectBundle } from './project/validate.js';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML } from './examples.js';
import { scanSecrets, scanUnsafeMarkdown } from './safety.js';
import { projectJsonSchema } from './json-schema.js';

const bundle = { project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }] };

describe('canonicalization', () => {
  it('sorts keys and ignores insertion order', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });

  it('drops undefined members but rejects undefined in arrays', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalize([undefined])).toThrow(/undefined/);
  });

  it('rejects non-finite numbers and emits integers without exponents', () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
    expect(canonicalize({ x: 1e21 })).toBe('{"x":1000000000000000000000}');
    expect(canonicalize({ x: -0 })).toBe('{"x":0}');
  });

  it('changes the version digest when any part of the content changes', () => {
    const base = { manifest: { a: 1 }, markdown: '# one', files: { 'TESTS/a.yaml': digestOf('x') } };
    expect(versionContentDigest(base)).toBe(versionContentDigest({ ...base }));
    expect(versionContentDigest({ ...base, markdown: '# two' })).not.toBe(versionContentDigest(base));
    expect(versionContentDigest({ ...base, files: {} })).not.toBe(versionContentDigest(base));
  });
});

describe('document parsing', () => {
  it('parses the PRD example frontmatter and body', () => {
    const parsed = parseProjectDocument(EXAMPLE_PROJECT_MD);
    expect((parsed.frontmatter as { schema: string }).schema).toBe('localfirst/project/v0.2');
    expect(parsed.markdown.startsWith('## Purpose')).toBe(true);
  });

  it('rejects documents without frontmatter', () => {
    expect(() => parseProjectDocument('# just markdown')).toThrow(/frontmatter/i);
  });

  it('rejects YAML anchors, tags, and prototype keys', () => {
    expect(() => parseProjectDocument('---\na: &x 1\nb: *x\n---\n')).toThrow(/anchors/i);
    expect(() => parseProjectDocument('---\na: !!python/object x\n---\n')).toThrow(/tags|parseable/i);
    expect(() => parseProjectDocument('---\n__proto__: {polluted: true}\n---\n')).toThrow(/not allowed/i);
  });

  it('rejects YAML nested deeper than the limit, in frontmatter and in test manifests', () => {
    const nested = (levels: number) => Array.from({ length: levels }, (_, depth) => `${'  '.repeat(depth)}k${depth}:`).join('\n') + ' leaf';
    expect(() => parseSafeYaml(nested(MAX_YAML_DEPTH))).not.toThrow();
    expect(() => parseSafeYaml(nested(MAX_YAML_DEPTH + 1), 'tests/deep.yaml')).toThrow(expect.objectContaining({ code: 'FRONTMATTER_TOO_DEEP' }));
    const flow = `${'['.repeat(MAX_YAML_DEPTH + 1)}1${']'.repeat(MAX_YAML_DEPTH + 1)}`;
    expect(() => parseSafeYaml(`response_schema: ${flow}`)).toThrow(expect.objectContaining({ code: 'FRONTMATTER_TOO_DEEP' }));
  });

  it('ignores headings inside fenced code blocks', () => {
    const sections = splitMarkdownSections('## Purpose\ntext\n```\n## Setup\n```\n## Limitations\nmore');
    expect(sections.map((section) => section.key)).toEqual(['purpose', 'limitations']);
  });

  it('round-trips a normalized manifest into PROJECT.md text', () => {
    const result = validateProjectBundle(bundle);
    const text = serializeProjectDocument(result.manifest, result.markdown);
    const reparsed = validateProjectBundle({ project_md: text, files: bundle.files });
    expect(reparsed.ok).toBe(true);
    expect(reparsed.content_digest).toBe(result.content_digest);
  });
});

describe('project bundle validation', () => {
  it('accepts the PRD reference bundle', () => {
    const result = validateProjectBundle(bundle);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tests).toHaveLength(1);
    expect(result.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('warns about unverified documentation, unknown offline state, and the missing runner', () => {
    const result = validateProjectBundle(bundle);
    expect(result.warning_codes).toContain('SOURCE_CONTENT_UNVERIFIED');
    expect(result.warning_codes).toContain('OFFLINE_UNVERIFIED');
    expect(result.warning_codes).toContain('RUNNER_UNAVAILABLE');
    expect(result.warning_codes).toContain('HARDWARE_MEMORY_IS_A_CLAIM');
  });

  it('derives search and filter facts without inventing any', () => {
    const derived = validateProjectBundle(bundle).derived;
    expect(derived?.runtime_families).toEqual(['ollama', 'lmstudio']);
    expect(derived?.required_capabilities).toEqual(['chat', 'json_output']);
    expect(derived?.offline_declared).toBe('unknown');
    expect(derived?.sources_pinned).toBe(false);
    expect(derived?.test_support).toBe('declarative_task_v1');
  });

  it('rejects unknown manifest fields', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace('test_support: declarative_task_v1', 'surprise: 1\ntest_support: declarative_task_v1'),
      files: bundle.files,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'SCHEMA_UNKNOWN_FIELD')).toBe(true);
  });

  it('rejects a declared test whose file is absent and an unreferenced bundle file', () => {
    const missing = validateProjectBundle({ project_md: EXAMPLE_PROJECT_MD });
    expect(missing.issues.some((issue) => issue.code === 'TEST_FILE_MISSING')).toBe(true);

    const extra = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD,
      files: [...bundle.files, { path: 'TESTS/other.yaml', content: 'schema: localfirst/test/v0.1\n' }],
    });
    expect(extra.issues.some((issue) => issue.code === 'BUNDLE_FILE_UNREFERENCED')).toBe(true);
  });

  it('rejects traversal and absolute bundle paths', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD,
      files: [{ path: '../etc/passwd', content: 'x' }],
    });
    expect(result.issues.some((issue) => issue.code === 'BUNDLE_UNSAFE_PATH')).toBe(true);
  });

  it('rejects a configuration that references an undeclared model role', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace('model_roles: [classifier]', 'model_roles: [missing-role]'),
      files: bundle.files,
    });
    expect(result.issues.some((issue) => issue.code === 'CONFIGURATION_ROLE_UNKNOWN')).toBe(true);
  });

  it('rejects a declared state with no content and an undeclared state with content', () => {
    const empty = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace(/runtimes:\n  state: declared\n  supported:\n    - \{family: ollama, version_constraint: null\}\n    - \{family: lmstudio, version_constraint: null\}/, 'runtimes:\n  state: declared\n  supported: []'),
      files: bundle.files,
    });
    expect(empty.issues.some((issue) => issue.code === 'DECLARED_STATE_EMPTY')).toBe(true);

    const populated = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace('runtimes:\n  state: declared', 'runtimes:\n  state: unknown'),
      files: bundle.files,
    });
    expect(populated.issues.some((issue) => issue.code === 'UNDECLARED_STATE_POPULATED')).toBe(true);
  });

  it('requires a license identifier only when the license state is known', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace(
        'license: {state: known, id: MIT, reference: "https://example.org/request-labeler/license"}',
        'license: {state: unknown, id: MIT, reference: null}',
      ),
      files: bundle.files,
    });
    expect(result.issues.some((issue) => issue.code === 'LICENSE_ID_UNEXPECTED')).toBe(true);
  });

  it('requires the declared test to match the project and configuration', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD,
      files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML.replace('configuration_key: local-chat', 'configuration_key: other-config') }],
    });
    expect(result.issues.some((issue) => issue.code === 'TEST_CONFIGURATION_UNKNOWN')).toBe(true);
  });

  it('requires the four mandatory Markdown sections', () => {
    const result = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace(/## Limitations[\s\S]*?## Sources/, '## Sources'),
      files: bundle.files,
    });
    expect(result.issues.some((issue) => issue.code === 'MARKDOWN_SECTION_MISSING')).toBe(true);
  });

  it('blocks secrets and unsafe markup', () => {
    const withSecret = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace('## Purpose', '## Purpose\n\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      files: bundle.files,
    });
    expect(withSecret.ok).toBe(false);
    expect(withSecret.issues.some((issue) => issue.code === 'SECRET_GITHUB_TOKEN')).toBe(true);

    const withScript = validateProjectBundle({
      project_md: EXAMPLE_PROJECT_MD.replace('## Purpose', '## Purpose\n\n<script>alert(1)</script>'),
      files: bundle.files,
    });
    expect(withScript.issues.some((issue) => issue.code === 'MARKDOWN_SCRIPT_TAG')).toBe(true);
  });

  it('flags localhost links in documentation', () => {
    expect(scanUnsafeMarkdown('see http://localhost:11434/api/tags')).toHaveLength(1);
    expect(scanSecrets('postgres://user:pass@db.example.org/x', 'markdown')).toHaveLength(1);
  });
});

describe('published schemas', () => {
  it('generates a JSON Schema document for the specification', () => {
    const schema = projectJsonSchema('https://api.localfirst.sh');
    expect(schema.$id).toBe('https://api.localfirst.sh/schemas/project/v0.2.json');
    expect((schema as { properties: Record<string, unknown> }).properties).toHaveProperty('data_boundary');
  });
});
