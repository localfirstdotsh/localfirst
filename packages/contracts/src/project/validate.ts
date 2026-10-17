/**
 * Bundle validation for draft kind `project` (BACKEND_PRD sections 4.3, 14.4).
 *
 * Validation never executes, fetches, or installs anything. Unknown metadata
 * stays visible as unknown; it must not invent model, hardware, or license
 * facts.
 */

import { digestOf, digestOfBytes, versionContentDigest } from '../canonical.js';
import {
  scanContentShape,
  scanSecrets,
  scanUnsafeMarkdown,
  type SafetyFinding,
} from '../safety.js';
import { environmentSchema, verifyEnvironmentFiles, workflowTestSchema, type AgentEnvironment, type WorkflowTest } from '../environment/schema.js';
import { testManifestSchema, type TestManifest } from '../test/schema.js';
import {
  DocumentParseError,
  parseProjectDocument,
  parseSafeYaml,
  RECOMMENDED_SECTIONS,
  REQUIRED_SECTIONS,
  splitMarkdownSections,
} from './document.js';
import { projectSpecSchema, SPEC_LIMITS, type ProjectSpec } from './schema.js';
import type {
  CpuArchitecture,
  ModelCapability,
  OperatingSystem,
  RuntimeFamily,
  SourceKind,
  TaskCategory,
} from '../vocabulary.js';

export interface BundleFile {
  path: string;
  content: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** JSON pointer into the manifest, a bundle path, or `markdown:<line>`. */
  pointer: string;
}

/** Relational/search projection derived from a validated specification. */
export interface DerivedFacts {
  project_key: string;
  name: string;
  summary: string;
  type: string;
  categories: TaskCategory[];
  spec_version: string;
  license_state: string;
  license_id: string | null;
  runtime_families: RuntimeFamily[];
  architectures: CpuArchitecture[];
  operating_systems: OperatingSystem[];
  accelerator: string;
  minimum_memory_bytes: number | null;
  minimum_vram_bytes: number | null;
  required_capabilities: ModelCapability[];
  model_hints: string[];
  test_support: string;
  test_keys: string[];
  source_kinds: SourceKind[];
  source_urls: string[];
  /** True only when every source that execution depends on is revision- or digest-pinned. */
  sources_pinned: boolean;
  inference_boundary: string;
  /** `yes` requires a declared no-network runtime; otherwise `unknown`/`no`. */
  offline_declared: 'yes' | 'no' | 'unknown';
  search_text: string;
}

export interface ValidatedBundle {
  /** False when at least one error-severity issue is present. */
  ok: boolean;
  issues: ValidationIssue[];
  /** Unacknowledged warning codes an approval must cover (section 10.4). */
  warning_codes: string[];
  spec: ProjectSpec | null;
  /** Normalized manifest in schema key order. */
  manifest: ProjectSpec | null;
  markdown: string;
  files: BundleFile[];
  file_digests: Record<string, string>;
  tests: Array<{ path: string; manifest: TestManifest }>;
  environments?: Array<{ path: string; manifest: AgentEnvironment }>;
  workflow_tests?: Array<{ path: string; manifest: WorkflowTest }>;
  /** Digest of the exact reviewable draft payload. */
  payload_digest: string;
  /** Digest of the publishable version content. */
  content_digest: string | null;
  derived: DerivedFacts | null;
}

function pointerOf(path: ReadonlyArray<string | number | symbol>): string {
  if (path.length === 0) return '';
  return `/${path
    .map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
}

function findingsToIssues(
  findings: SafetyFinding[],
  severity: 'error' | 'warning',
): ValidationIssue[] {
  return findings.map((finding) => ({
    severity,
    code: finding.code,
    message: finding.message,
    pointer: finding.location,
  }));
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface ValidateBundleInput {
  project_md: string;
  files?: BundleFile[];
}

export function validateProjectBundle(input: ValidateBundleInput): ValidatedBundle {
  const issues: ValidationIssue[] = [];
  const files = input.files ?? [];
  const projectMd = input.project_md ?? '';

  const emptyResult = (markdown = ''): ValidatedBundle => ({
    ok: false,
    issues,
    warning_codes: uniqueWarningCodes(issues),
    spec: null,
    manifest: null,
    markdown,
    files,
    file_digests: {},
    tests: [],
    payload_digest: digestOf({ project_md: projectMd, files }),
    content_digest: null,
    derived: null,
  });

  if (projectMd.trim().length === 0) {
    issues.push({
      severity: 'error',
      code: 'PROJECT_MD_EMPTY',
      message: 'project_md is required',
      pointer: '',
    });
    return emptyResult();
  }
  if (utf8Bytes(projectMd) > SPEC_LIMITS.markdownBytes) {
    issues.push({
      severity: 'error',
      code: 'PROJECT_MD_TOO_LARGE',
      message: `project_md exceeds ${SPEC_LIMITS.markdownBytes} bytes`,
      pointer: '',
    });
    return emptyResult();
  }
  issues.push(...findingsToIssues(scanContentShape(projectMd, 'project_md'), 'error'));

  // --- Bundle shape -------------------------------------------------------
  if (files.length > SPEC_LIMITS.bundleFiles) {
    issues.push({
      severity: 'error',
      code: 'BUNDLE_TOO_MANY_FILES',
      message: `at most ${SPEC_LIMITS.bundleFiles} bundled files are accepted`,
      pointer: '',
    });
  }
  const totalBytes = files.reduce((sum, file) => sum + utf8Bytes(file.content), 0);
  if (totalBytes > SPEC_LIMITS.bundleBytes) {
    issues.push({
      severity: 'error',
      code: 'BUNDLE_TOO_LARGE',
      message: `bundled files exceed ${SPEC_LIMITS.bundleBytes} bytes`,
      pointer: '',
    });
  }
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) {
      issues.push({
        severity: 'error',
        code: 'BUNDLE_DUPLICATE_PATH',
        message: `duplicate bundle path \`${file.path}\``,
        pointer: file.path,
      });
    }
    seenPaths.add(file.path);
    if (
      file.path.startsWith('/') ||
      file.path.includes('..') ||
      file.path.includes('\\') ||
      /[^A-Za-z0-9._\-/]/.test(file.path)
    ) {
      issues.push({
        severity: 'error',
        code: 'BUNDLE_UNSAFE_PATH',
        message: `bundle path \`${file.path}\` must be relative, simple, and traversal-free`,
        pointer: file.path,
      });
    }
    if (!/\.(?:ya?ml|json|txt|md|mjs)$/i.test(file.path)) {
      issues.push({
        severity: 'error',
        code: 'BUNDLE_UNSUPPORTED_FILE_TYPE',
        message: 'only YAML, JSON, text, and Markdown bundle files are accepted',
        pointer: file.path,
      });
    }
    if (utf8Bytes(file.content) > SPEC_LIMITS.bundleFileBytes) {
      issues.push({
        severity: 'error',
        code: 'BUNDLE_FILE_TOO_LARGE',
        message: `bundle file exceeds ${SPEC_LIMITS.bundleFileBytes} bytes`,
        pointer: file.path,
      });
    }
    issues.push(...findingsToIssues(scanContentShape(file.content, file.path), 'error'));
    issues.push(...findingsToIssues(scanSecrets(file.content, file.path), 'error'));
  }

  // --- Document and schema -----------------------------------------------
  let parsed;
  try {
    parsed = parseProjectDocument(projectMd);
  } catch (error) {
    const parseError = error as DocumentParseError;
    issues.push({
      severity: 'error',
      code: parseError.code ?? 'PROJECT_MD_INVALID',
      message: parseError.message,
      pointer: parseError.pointer ?? '',
    });
    return emptyResult();
  }

  const { frontmatter, markdown } = parsed;
  issues.push(...findingsToIssues(scanSecrets(projectMd, 'project_md'), 'error'));
  issues.push(...findingsToIssues(scanUnsafeMarkdown(markdown), 'error'));

  const schemaResult = projectSpecSchema.safeParse(frontmatter);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      issues.push({
        severity: 'error',
        code: issue.code === 'unrecognized_keys' ? 'SCHEMA_UNKNOWN_FIELD' : 'SCHEMA_INVALID',
        message: issue.message,
        pointer: pointerOf(issue.path),
      });
    }
    return emptyResult(markdown);
  }
  const spec = schemaResult.data;

  if (utf8Bytes(JSON.stringify(spec)) > SPEC_LIMITS.manifestBytes) {
    issues.push({
      severity: 'error',
      code: 'MANIFEST_TOO_LARGE',
      message: `normalized manifest exceeds ${SPEC_LIMITS.manifestBytes} bytes`,
      pointer: '',
    });
  }

  issues.push(...checkMarkdownSections(markdown));
  issues.push(...checkSpecSemantics(spec));

  // --- Bundled tests ------------------------------------------------------
  const fileMap = new Map(files.map((file) => [file.path, file.content] as const));
  const tests: Array<{ path: string; manifest: TestManifest }> = [];
  const referenced = new Set<string>();

  const environments: Array<{ path: string; manifest: AgentEnvironment }> = [];
  const workflowTests: Array<{ path: string; manifest: WorkflowTest }> = [];
  if (spec.schema === 'localfirst/project/v0.3') {
    if (new Set(spec.environments.map(e => e.key)).size !== spec.environments.length || new Set(spec.environments.map(e => e.path)).size !== spec.environments.length) {
      issues.push({ severity: 'error', code: 'ENVIRONMENT_DUPLICATE', message: 'Environment keys and paths must be unique.', pointer: '/environments' });
    }
    if (totalBytes + utf8Bytes(projectMd) > SPEC_LIMITS.bundleBytes) issues.push({ severity: 'error', code: 'BUNDLE_TOO_LARGE', message: 'The complete environment bundle exceeds 2 MiB.', pointer: '' });
    for (const declaration of spec.environments) {
      referenced.add(declaration.path);
      try {
        const content = fileMap.get(declaration.path);
        if (content === undefined) throw new Error('environment manifest missing');
        const env = environmentSchema.parse(parseSafeYaml(content, declaration.path));
        if (env.key !== declaration.key || digestOf(env) !== declaration.digest) throw new Error('environment identity mismatch');
        verifyEnvironmentFiles(env, fileMap);
        if (env.framework) referenced.add(env.framework.entry_path);
        for (const file of [...env.prompts, ...env.data]) referenced.add(file.path);
        for (const role of env.model_roles) {
          const declared = spec.models.roles.find(r => r.key === role.key);
          if (!declared || role.required_capabilities.some(c => !declared.required_capabilities.includes(c))) throw new Error('environment model role not declared');
        }
        environments.push({ path: declaration.path, manifest: env });
      } catch (error) {
        issues.push({ severity: 'error', code: 'ENVIRONMENT_INVALID', message: (error as Error).message, pointer: declaration.path });
      }
    }
  }
  spec.tests.forEach((declaration, index) => {
    const pointer = `/tests/${index}`;
    referenced.add(declaration.path);
    const content = fileMap.get(declaration.path);
    if (content === undefined) {
      issues.push({
        severity: 'error',
        code: 'TEST_FILE_MISSING',
        message: `declared test file \`${declaration.path}\` is not in the bundle`,
        pointer: `${pointer}/path`,
      });
      return;
    }
    let raw: unknown;
    try {
      raw = parseSafeYaml(content, declaration.path);
    } catch (error) {
      const parseError = error as DocumentParseError;
      issues.push({
        severity: 'error',
        code: parseError.code ?? 'TEST_YAML_INVALID',
        message: parseError.message,
        pointer: declaration.path,
      });
      return;
    }
    if (declaration.schema === 'localfirst/test/v0.2') {
      try {
        const test = workflowTestSchema.parse(raw);
        const env = environments.find(e => e.manifest.key === test.environment_key)?.manifest;
        if (test.profile !== (env?.framework?.profile ?? 'declarative')) throw new Error('workflow execution profile mismatch');
        if (!env || digestOf(env) !== test.environment_digest || test.key !== declaration.key || test.project_key !== spec.project.key ||
          !spec.configurations.some(c => c.key === test.configuration_key && env.model_roles.every(r => c.model_roles.includes(r.key)))) throw new Error('workflow environment/project/configuration identity mismatch');
        workflowTests.push({ path: declaration.path, manifest: test });
      } catch (error) {
        issues.push({ severity: 'error', code: 'WORKFLOW_TEST_INVALID', message: (error as Error).message, pointer: declaration.path });
      }
      return;
    }
    const testResult = testManifestSchema.safeParse(raw);
    if (!testResult.success) {
      for (const issue of testResult.error.issues) {
        issues.push({
          severity: 'error',
          code: 'TEST_SCHEMA_INVALID',
          message: issue.message,
          pointer: `${declaration.path}${pointerOf(issue.path)}`,
        });
      }
      return;
    }
    const manifest = testResult.data;
    tests.push({ path: declaration.path, manifest });

    if (manifest.key !== declaration.key) {
      issues.push({
        severity: 'error',
        code: 'TEST_KEY_MISMATCH',
        message: `test manifest key \`${manifest.key}\` does not match declared key \`${declaration.key}\``,
        pointer: `${declaration.path}/key`,
      });
    }
    if (manifest.project_key !== spec.project.key) {
      issues.push({
        severity: 'error',
        code: 'TEST_PROJECT_MISMATCH',
        message: `test manifest project_key \`${manifest.project_key}\` does not match \`${spec.project.key}\``,
        pointer: `${declaration.path}/project_key`,
      });
    }
    if (!spec.configurations.some((configuration) => configuration.key === manifest.configuration_key)) {
      issues.push({
        severity: 'error',
        code: 'TEST_CONFIGURATION_UNKNOWN',
        message: `test references undeclared configuration \`${manifest.configuration_key}\``,
        pointer: `${declaration.path}/configuration_key`,
      });
    }
    const role = spec.models.roles.find((entry) => entry.key === manifest.model_role);
    if (!role) {
      issues.push({
        severity: 'error',
        code: 'TEST_MODEL_ROLE_UNKNOWN',
        message: `test references undeclared model role \`${manifest.model_role}\``,
        pointer: `${declaration.path}/model_role`,
      });
    } else {
      const missing = manifest.required_capabilities.filter(
        (capability) => !role.required_capabilities.includes(capability),
      );
      if (missing.length > 0) {
        issues.push({
          severity: 'warning',
          code: 'TEST_CAPABILITY_BROADER_THAN_ROLE',
          message: `test requires capabilities the role does not declare: ${missing.join(', ')}`,
          pointer: `${declaration.path}/required_capabilities`,
        });
      }
    }
    if (manifest.scope !== 'component') {
      issues.push({
        severity: 'warning',
        code: 'TEST_SCOPE_UNSUPPORTED',
        message:
          'only `component` scope is supported by the planned harness; wider scopes stay declarative',
        pointer: `${declaration.path}/scope`,
      });
    }
  });

  for (const file of files) {
    if (!referenced.has(file.path)) {
      issues.push({
        severity: 'error',
        code: 'BUNDLE_FILE_UNREFERENCED',
        message: `bundle file \`${file.path}\` is not referenced by the specification`,
        pointer: file.path,
      });
    }
  }

  const fileDigests: Record<string, string> = {};
  for (const file of files) fileDigests[file.path] = digestOfBytes(file.content);

  const ok = !issues.some((issue) => issue.severity === 'error');
  return {
    ok,
    issues,
    warning_codes: uniqueWarningCodes(issues),
    spec,
    manifest: spec,
    markdown,
    files,
    file_digests: fileDigests,
    tests,
    environments,
    workflow_tests: workflowTests,
    payload_digest: digestOf({ project_md: projectMd, files }),
    content_digest: ok
      ? versionContentDigest({ manifest: spec, markdown, files: fileDigests })
      : null,
    derived: ok ? deriveFacts(spec, markdown) : null,
  };
}

function uniqueWarningCodes(issues: ValidationIssue[]): string[] {
  return [
    ...new Set(issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code)),
  ].sort();
}

function checkMarkdownSections(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sections = splitMarkdownSections(markdown);
  const present = new Set(sections.map((section) => section.key).filter(Boolean));
  for (const key of REQUIRED_SECTIONS) {
    if (!present.has(key)) {
      issues.push({
        severity: 'error',
        code: 'MARKDOWN_SECTION_MISSING',
        message: `a \`${key}\` section is required in the Markdown body`,
        pointer: 'markdown',
      });
    }
  }
  for (const key of RECOMMENDED_SECTIONS) {
    if (!present.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'MARKDOWN_SECTION_RECOMMENDED',
        message: `a \`${key}\` section is recommended in the Markdown body`,
        pointer: 'markdown',
      });
    }
  }
  const emptySection = sections.find((section) => section.key && section.body.length === 0);
  if (emptySection) {
    issues.push({
      severity: 'warning',
      code: 'MARKDOWN_SECTION_EMPTY',
      message: `section \`${emptySection.heading}\` has no content`,
      pointer: 'markdown',
    });
  }
  return issues;
}

// eslint-disable-next-line complexity
function checkSpecSemantics(spec: ProjectSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, pointer: string): void => {
    issues.push({ severity: 'error', code, message, pointer });
  };
  const warn = (code: string, message: string, pointer: string): void => {
    issues.push({ severity: 'warning', code, message, pointer });
  };

  // Declaration states must agree with their payloads: `unknown` cannot carry data.
  const stateChecks: Array<{ pointer: string; state: string; count: number; label: string }> = [
    { pointer: '/models/roles', state: spec.models.state, count: spec.models.roles.length, label: 'model roles' },
    {
      pointer: '/runtimes/supported',
      state: spec.runtimes.state,
      count: spec.runtimes.supported.length,
      label: 'supported runtimes',
    },
    {
      pointer: '/operating_systems/supported',
      state: spec.operating_systems.state,
      count: spec.operating_systems.supported.length,
      label: 'supported operating systems',
    },
  ];
  for (const check of stateChecks) {
    if (check.state === 'declared' && check.count === 0) {
      error(
        'DECLARED_STATE_EMPTY',
        `state is \`declared\` but no ${check.label} are listed; use \`unknown\` or \`not_applicable\` instead`,
        check.pointer,
      );
    }
    if (check.state !== 'declared' && check.count > 0) {
      error(
        'UNDECLARED_STATE_POPULATED',
        `${check.label} are listed while state is \`${check.state}\``,
        check.pointer,
      );
    }
  }
  // `dependencies: {state: declared, items: []}` is a meaningful statement that
  // the project has no dependencies, so only the inverse is contradictory.
  if (spec.dependencies.state !== 'declared' && spec.dependencies.items.length > 0) {
    error(
      'UNDECLARED_STATE_POPULATED',
      `dependency items are listed while state is \`${spec.dependencies.state}\``,
      '/dependencies/items',
    );
  }
  if (spec.hardware.state === 'declared' && spec.hardware.architectures.length === 0) {
    error(
      'DECLARED_STATE_EMPTY',
      'hardware state is `declared` but no architectures are listed',
      '/hardware/architectures',
    );
  }
  if (spec.hardware.state !== 'declared' && spec.hardware.architectures.length > 0) {
    error(
      'UNDECLARED_STATE_POPULATED',
      `architectures are listed while hardware state is \`${spec.hardware.state}\``,
      '/hardware/architectures',
    );
  }

  // Unique keys.
  const dupes = (values: string[]): string[] =>
    [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  for (const [pointer, keys, code] of [
    ['/sources', spec.sources.map((source) => source.key), 'SOURCE_KEY_DUPLICATE'],
    ['/configurations', spec.configurations.map((configuration) => configuration.key), 'CONFIGURATION_KEY_DUPLICATE'],
    ['/models/roles', spec.models.roles.map((role) => role.key), 'MODEL_ROLE_KEY_DUPLICATE'],
    ['/tests', spec.tests.map((test) => test.key), 'TEST_KEY_DUPLICATE'],
  ] as const) {
    for (const duplicate of dupes([...keys])) {
      error(code, `duplicate key \`${duplicate}\``, pointer);
    }
  }
  for (const duplicate of dupes([...spec.project.categories])) {
    error('CATEGORY_DUPLICATE', `duplicate category \`${duplicate}\``, '/project/categories');
  }
  for (const duplicate of dupes(spec.tests.map((test) => test.path))) {
    error('TEST_PATH_DUPLICATE', `duplicate test path \`${duplicate}\``, '/tests');
  }

  // Configurations must reference declared model roles.
  const roleKeys = new Set(spec.models.roles.map((role) => role.key));
  spec.configurations.forEach((configuration, index) => {
    for (const roleKey of configuration.model_roles) {
      if (!roleKeys.has(roleKey)) {
        error(
          'CONFIGURATION_ROLE_UNKNOWN',
          `configuration references undeclared model role \`${roleKey}\``,
          `/configurations/${index}/model_roles`,
        );
      }
    }
    if (configuration.setup_kind === 'unsupported' && spec.test_support === 'declarative_task_v1') {
      warn(
        'CONFIGURATION_SETUP_UNSUPPORTED',
        'a declared task harness with an unsupported setup cannot be prepared automatically',
        `/configurations/${index}/setup_kind`,
      );
    }
  });

  // Sources and attribution.
  const executionDependsOnSources =
    spec.test_support === 'declarative_task_v1' || spec.project.type !== 'documentation';
  let anyPinned = false;
  let allExecutionSourcesPinned = true;
  spec.sources.forEach((source, index) => {
    const pointer = `/sources/${index}`;
    if (source.kind === 'authored_specification') {
      if (source.url !== null) {
        error(
          'AUTHORED_SOURCE_URL_PRESENT',
          'an authored specification has no external URL; use another source kind instead',
          `${pointer}/url`,
        );
      }
      if (spec.attribution.relationship !== 'original_author_claimed') {
        error(
          'AUTHORED_SOURCE_ATTRIBUTION_REQUIRED',
          'an authored specification requires `original_author_claimed` attribution',
          '/attribution/relationship',
        );
      }
    } else if (source.url === null) {
      error(
        'SOURCE_URL_REQUIRED',
        `source kind \`${source.kind}\` requires a public https URL`,
        `${pointer}/url`,
      );
    }
    const pinned = source.revision !== null || source.content_digest !== null;
    if (pinned) anyPinned = true;
    if (source.kind === 'repository' && !pinned) {
      allExecutionSourcesPinned = false;
      warn(
        'SOURCE_UNPINNED',
        'a repository source without a revision or content digest is explicitly unpinned',
        `${pointer}/revision`,
      );
    }
    if (source.kind === 'documentation' && !pinned) {
      allExecutionSourcesPinned = false;
      warn(
        'SOURCE_CONTENT_UNVERIFIED',
        'the registry has not fetched this documentation URL; its public state is declared, not verified',
        `${pointer}/url`,
      );
    }
    if (source.license === null) {
      warn(
        'SOURCE_LICENSE_UNKNOWN',
        'this source has no stated license reference',
        `${pointer}/license`,
      );
    }
  });
  if (executionDependsOnSources && !anyPinned && spec.sources.every((s) => s.kind !== 'authored_specification')) {
    warn(
      'EXECUTION_SOURCE_UNPINNED',
      'no source is pinned, so reproducible execution claims are not supported',
      '/sources',
    );
  }
  if (!allExecutionSourcesPinned && spec.test_support === 'declarative_task_v1') {
    warn(
      'TEST_SOURCE_DRIFT_POSSIBLE',
      'declared tests reference unpinned sources that may drift',
      '/sources',
    );
  }

  if (spec.attribution.relationship === 'curator_submitted') {
    warn(
      'LISTING_CURATED',
      'this listing is curated from upstream material; the authors did not submit it',
      '/attribution/relationship',
    );
  }
  if (spec.attribution.relationship === 'unknown') {
    warn(
      'ATTRIBUTION_RELATIONSHIP_UNKNOWN',
      'the submitter relationship to the authors is unknown',
      '/attribution/relationship',
    );
  }

  // Licensing.
  if (spec.project.license.state === 'known' && !spec.project.license.id) {
    error(
      'LICENSE_ID_REQUIRED',
      'a known license state requires a license identifier',
      '/project/license/id',
    );
  }
  if (spec.project.license.state !== 'known' && spec.project.license.id) {
    error(
      'LICENSE_ID_UNEXPECTED',
      `a license identifier is set while state is \`${spec.project.license.state}\``,
      '/project/license/id',
    );
  }
  if (spec.project.license.state === 'unknown') {
    warn(
      'LICENSE_UNKNOWN',
      'an unknown license does not support reuse, redistribution, or automatic download claims',
      '/project/license',
    );
  }

  // Test support.
  if ((spec.test_support === 'declarative_task_v1' || spec.test_support === 'declarative_workflow_v1') && spec.tests.length === 0) {
    error(
      'TEST_DECLARATION_REQUIRED',
      '`declarative_task_v1` support requires at least one declared test',
      '/tests',
    );
  }
  if (spec.test_support !== 'declarative_task_v1' && spec.test_support !== 'declarative_workflow_v1' && spec.tests.length > 0) {
    error(
      'TEST_DECLARATION_UNEXPECTED',
      `tests are declared while test_support is \`${spec.test_support}\``,
      '/tests',
    );
  }
  if (spec.test_support === 'declarative_task_v1') {
    warn(
      'RUNNER_UNAVAILABLE',
      'a declared harness is a preview fixture: no supported runner has shipped, so no test has run',
      '/test_support',
    );
  }
  if (spec.test_support === 'none') {
    warn(
      'NO_TEST_SUPPORT',
      'this project declares no test support, so no evidence beyond documentation is possible',
      '/test_support',
    );
  }

  // Data boundary and offline claims.
  if (spec.data_boundary.inference === 'local_required' && spec.data_boundary.runtime_network === 'unknown') {
    warn(
      'OFFLINE_UNVERIFIED',
      'runtime network behaviour is unknown, so offline operation cannot be claimed',
      '/data_boundary/runtime_network',
    );
  }
  if (spec.data_boundary.inference === 'external_allowed') {
    warn(
      'EXTERNAL_INFERENCE_ALLOWED',
      'this project permits external inference; it is not a local-only listing',
      '/data_boundary/inference',
    );
  }
  if (spec.data_boundary.external_services.length > 0) {
    warn(
      'EXTERNAL_SERVICES_DECLARED',
      'declared external services leave the local-only boundary',
      '/data_boundary/external_services',
    );
  }

  // Models and hardware completeness.
  if (spec.models.state === 'unknown') {
    warn('MODEL_FACTS_UNKNOWN', 'model requirements are unknown', '/models/state');
  }
  if (spec.hardware.state === 'unknown') {
    warn('HARDWARE_FACTS_UNKNOWN', 'hardware requirements are unknown', '/hardware/state');
  }
  if (spec.hardware.state === 'declared' && spec.hardware.minimum_memory_bytes === null) {
    warn(
      'HARDWARE_MEMORY_UNKNOWN',
      'no minimum memory requirement is declared; local fit cannot be assessed',
      '/hardware/minimum_memory_bytes',
    );
  }
  if (spec.hardware.minimum_memory_bytes !== null) {
    warn(
      'HARDWARE_MEMORY_IS_A_CLAIM',
      'a declared minimum memory figure is a creator claim, not an observed fit',
      '/hardware/minimum_memory_bytes',
    );
  }
  if (spec.runtimes.state === 'declared') {
    warn(
      'RUNTIME_SUPPORT_DECLARED',
      'runtime support is declared by the author and has not been exercised by the registry',
      '/runtimes/state',
    );
  }
  for (const role of spec.models.roles) {
    if (role.substitution === 'unknown') {
      warn(
        'MODEL_SUBSTITUTION_UNKNOWN',
        `substitution policy for role \`${role.key}\` is unknown`,
        '/models/roles',
      );
    }
  }

  if (spec.evidence.length > 0) {
    warn(
      'EVIDENCE_CLAIMS_UNVERIFIED',
      'submitted evidence entries are references and claims; the registry does not treat them as observations',
      '/evidence',
    );
  }
  if (spec.media.length > 0) {
    warn('MEDIA_NOT_HOSTED', 'media entries are external references and are not hosted', '/media');
  }
  if (spec.derivative_of !== null) {
    warn(
      'DERIVATIVE_NO_INHERITED_EVIDENCE',
      'a derivative inherits no evidence or verification from its parent',
      '/derivative_of',
    );
  }
  if (spec.project.type === 'robotics') {
    warn(
      'ACTUATION_OUT_OF_SCOPE',
      'robotics actuation is outside the supported harness; testing stays manual',
      '/project/type',
    );
  }

  return issues;
}

function deriveFacts(spec: ProjectSpec, markdown: string): DerivedFacts {
  const capabilities = [
    ...new Set(spec.models.roles.flatMap((role) => role.required_capabilities)),
  ].sort();
  const sourceUrls = spec.sources
    .map((source) => source.url)
    .filter((url): url is string => url !== null);
  const executionSources = spec.sources.filter((source) =>
    ['repository', 'documentation'].includes(source.kind),
  );
  const sourcesPinned =
    executionSources.length > 0 &&
    executionSources.every((source) => source.revision !== null || source.content_digest !== null);

  const offlineDeclared: DerivedFacts['offline_declared'] =
    spec.data_boundary.inference === 'local_required' &&
    spec.data_boundary.runtime_network === 'none' &&
    spec.data_boundary.external_services.length === 0
      ? 'yes'
      : spec.data_boundary.inference === 'external_allowed' ||
          spec.data_boundary.runtime_network === 'required' ||
          spec.data_boundary.external_services.length > 0
        ? 'no'
        : 'unknown';

  return {
    project_key: spec.project.key,
    name: spec.project.name,
    summary: spec.project.summary,
    type: spec.project.type,
    categories: [...spec.project.categories],
    spec_version: spec.project.version,
    license_state: spec.project.license.state,
    license_id: spec.project.license.id,
    runtime_families: spec.runtimes.supported.map((runtime) => runtime.family),
    architectures: [...spec.hardware.architectures],
    operating_systems: [...spec.operating_systems.supported],
    accelerator: spec.hardware.accelerator,
    minimum_memory_bytes: spec.hardware.minimum_memory_bytes,
    minimum_vram_bytes: spec.hardware.minimum_vram_bytes,
    required_capabilities: capabilities,
    model_hints: spec.models.roles
      .map((role) => role.preferred)
      .filter((hint): hint is string => hint !== null),
    test_support: spec.test_support,
    test_keys: spec.tests.map((test) => test.key),
    source_kinds: [...new Set(spec.sources.map((source) => source.kind))],
    source_urls: sourceUrls,
    sources_pinned: sourcesPinned,
    inference_boundary: spec.data_boundary.inference,
    offline_declared: offlineDeclared,
    search_text: [
      spec.project.name,
      spec.project.summary,
      spec.project.categories.join(' '),
      spec.project.type,
      spec.models.roles.map((role) => `${role.key} ${role.preferred ?? ''}`).join(' '),
      spec.runtimes.supported.map((runtime) => runtime.family).join(' '),
      spec.hardware.architectures.join(' '),
      spec.hardware.devices.join(' '),
      spec.operating_systems.supported.join(' '),
      spec.attribution.authors.map((author) => author.name).join(' '),
      markdown.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|\[\]()-]/g, ' '),
    ]
      .join('\n')
      .slice(0, 20_000),
  };
}
