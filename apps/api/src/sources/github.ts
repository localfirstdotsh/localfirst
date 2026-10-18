/**
 * GitHub import adapter (BACKEND_PRD section 15.1).
 *
 * A convenience adapter, not a requirement: it validates a public repository,
 * resolves the ref once, reads only the selected manifest and declared test
 * files at that commit, parses deterministically, preserves provenance, and
 * scans for secrets. No install hook, build, container, model, or test runs.
 */

import { z } from 'zod';
import {
  DocumentParseError, environmentSchema, environmentFilePaths, parseSafeYaml,
  parseProjectDocument,
  projectSpecSchema,
  scanSecrets,
  SPEC_LIMITS,
  type ProjectSpec,
} from '@localfirst/contracts';
import { config } from '../config.js';
import {
  FETCH_LIMITS,
  safeFetchText,
  SourceFetchError,
  type SafeFetchOptions,
} from './safe-fetch.js';

export interface ImportDescriptor {
  provider: string;
  repository_url: string;
  ref: string;
  manifest_path: string;
}

export interface ImportProvenanceEntry {
  field_path: string;
  source_kind: string;
  source_url: string;
  source_identity: string | null;
  source_version: string | null;
  extraction_method: string;
  file: string | null;
  observed_at: string;
  evidence_class: 'documented' | 'claimed';
}

export interface ImportResult {
  payload: { project_md: string; files: Array<{ path: string; content: string }> };
  provenance: ImportProvenanceEntry[];
  repository: {
    provider: string;
    provider_repo_id: string;
    owner: string;
    repo: string;
    default_branch: string;
    resolved_commit: string;
    visibility: 'public';
    archived: boolean;
  };
  /** Paths read at the resolved commit; nothing else was fetched. */
  files_read: string[];
  bytes_read: number;
}

const GITHUB_API = 'https://api.github.com';

function parseRepositoryUrl(raw: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'The repository URL is not a valid URL.');
  }
  const match = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash || !match) {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Only public github.com repository URLs of the form https://github.com/owner/repository are imported.');
  }
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/, '') };
}

function assertSafePath(path: string): string {
  const normalized = path.replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('\\') ||
    /[^A-Za-z0-9._\-/]/.test(normalized)
  ) {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      `The path \`${path}\` is not a simple relative repository path.`,
    );
  }
  return normalized;
}

function authHeaders(): Record<string, string> {
  const token = config().github.ingestionToken;
  return token ? { authorization: `Bearer ${token}` } : {};
}

interface FetchJsonOptions extends SafeFetchOptions {
  notFoundCode?: string;
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>, options: FetchJsonOptions = {}): Promise<T> {
  const result = await safeFetchText(url, {
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  });
  if (result.status === 404) {
    throw new SourceFetchError(
      options.notFoundCode ?? 'SOURCE_UNAVAILABLE',
      'The requested public source was not found.',
      404,
    );
  }
  if (result.status === 403 || result.status === 429) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source provider rate limited this import.', result.status);
  }
  if (result.status >= 400) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source provider returned an error.', result.status);
  }
  try {
    const parsed = schema.safeParse(JSON.parse(result.body));
    if (!parsed.success) throw new Error('Unexpected provider shape');
    return parsed.data;
  } catch {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The source provider returned an unreadable response.');
  }
}

const repoSchema = z.object({
  id: z.int().positive(), private: z.boolean(), archived: z.boolean(),
  default_branch: z.string().min(1), visibility: z.string().optional(),
});
const commitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const contentSchema = z.object({
  type: z.string(), size: z.int().nonnegative(), path: z.string(),
  encoding: z.string().optional(), content: z.string().optional(),
});
type GitHubContent = z.infer<typeof contentSchema>;

function decodeContent(entry: GitHubContent, path: string): string {
  if (entry.type !== 'file') {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', `\`${path}\` is not a regular file.`);
  }
  if (entry.size > FETCH_LIMITS.perFileBytes) {
    throw new SourceFetchError('SOURCE_TOO_LARGE', `\`${path}\` exceeds the per-file limit.`);
  }
  if (entry.encoding !== 'base64' || typeof entry.content !== 'string') {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', `\`${path}\` could not be decoded as text.`);
  }
  const encoded = entry.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The provider returned invalid base64 content.');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > FETCH_LIMITS.perFileBytes) {
    throw new SourceFetchError('SOURCE_TOO_LARGE', 'The decoded source exceeds the per-file limit.');
  }
  if (buffer.length !== entry.size) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The provider returned inconsistent source size.');
  }
  if (buffer.includes(0)) {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', `\`${path}\` is binary; only text is imported.`);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Only valid UTF-8 text is imported.'); }
}

/**
 * Pin repository sources that point at the imported repository to the resolved
 * commit. Unpinned sources stay explicitly unpinned.
 */
function pinRepositorySources(
  projectMd: string,
  spec: ProjectSpec,
  owner: string,
  repo: string,
  commit: string,
): { text: string; pinnedKeys: string[] } {
  const pinnedKeys: string[] = [];
  let text = projectMd;
  for (const source of spec.sources) {
    if (source.kind !== 'repository' || source.revision !== null || !source.url) continue;
    try {
      const url = new URL(source.url);
      const [sourceOwner, sourceRepo] = url.pathname.replace(/^\/+/, '').split('/');
      if (url.hostname !== 'github.com') continue;
      if (sourceOwner !== owner || (sourceRepo ?? '').replace(/\.git$/, '') !== repo) continue;
    } catch {
      continue;
    }
    // Replace only the `revision: null` line inside this source entry.
    const entryPattern = new RegExp(
      `(- key:\\s*${source.key}[\\s\\S]*?revision:\\s*)null`,
      'm',
    );
    if (entryPattern.test(text)) {
      text = text.replace(entryPattern, `$1"${commit}"`);
      pinnedKeys.push(source.key);
    }
  }
  return { text, pinnedKeys };
}

export interface ImportOptions {
  fetchImpl?: typeof fetch;
  /** Attempt deadline; the ingestion job enforces it as well. */
  deadlineMs?: number;
}

export async function importProjectFromGitHub(
  descriptor: ImportDescriptor,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (descriptor.provider !== 'github') {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      `\`${descriptor.provider}\` is not a supported import provider in Phase 1.`,
    );
  }
  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs ?? FETCH_LIMITS.attemptDeadlineMs;
  const assertDeadline = (): void => {
    if (Date.now() - startedAt > deadlineMs) {
      throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The import attempt deadline was reached.');
    }
  };

  const { owner, repo } = parseRepositoryUrl(descriptor.repository_url);
  const manifestPath = assertSafePath(descriptor.manifest_path);
  const ref = descriptor.ref.trim();
  if (!/^[A-Za-z0-9._\-/]{1,120}$/.test(ref)) {
    throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'The ref contains unsupported characters.');
  }

  const fetchOptions: SafeFetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

  const repository = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    repoSchema,
    { ...fetchOptions, notFoundCode: 'SOURCE_UNAVAILABLE' },
  );
  if (repository.private || repository.visibility === 'private') {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      'Only public repositories are imported; a private source cannot back a public listing.',
    );
  }
  assertDeadline();

  // Resolve the ref exactly once, then read every file at that commit.
  const commit = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    commitSchema,
    { ...fetchOptions, notFoundCode: 'SOURCE_UNAVAILABLE' },
  );
  const sha = commit.sha;
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The provider returned no resolvable commit.');
  }
  assertDeadline();

  const filesRead: string[] = [];
  let bytesRead = 0;
  const readFile = async (path: string): Promise<string> => {
    if (filesRead.length >= FETCH_LIMITS.maxFiles) {
      throw new SourceFetchError('SOURCE_TOO_LARGE', 'The import file limit was reached.');
    }
    const entry = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
      z.union([contentSchema, z.array(contentSchema)]),
      { ...fetchOptions, maxBytes: Math.ceil(FETCH_LIMITS.perFileBytes * 4 / 3) + 65536 },
    );
    if (Array.isArray(entry)) throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'A repository directory cannot be imported as a file.');
    if (entry.path !== path) throw new SourceFetchError('SOURCE_UNAVAILABLE', 'The provider returned a different source path.');
    const text = decodeContent(entry, path);
    bytesRead += Buffer.byteLength(text, 'utf8');
    if (bytesRead > FETCH_LIMITS.totalBytes) {
      throw new SourceFetchError('SOURCE_TOO_LARGE', 'The import total size limit was reached.');
    }
    filesRead.push(path);
    return text;
  };

  const rawProjectMd = await readFile(manifestPath);
  if (Buffer.byteLength(rawProjectMd, 'utf8') > SPEC_LIMITS.markdownBytes) {
    throw new SourceFetchError('SOURCE_TOO_LARGE', 'The imported PROJECT.md exceeds the size limit.');
  }
  const secretFindings = scanSecrets(rawProjectMd, manifestPath);
  if (secretFindings.length > 0) {
    throw new SourceFetchError(
      'SOURCE_NOT_ALLOWED',
      `The imported file contains credential-like content (${secretFindings[0]?.code}).`,
    );
  }

  // Parse deterministically. A malformed document is an import failure, not a
  // guess at what the author meant.
  let parsed: ReturnType<typeof parseProjectDocument>;
  try { parsed = parseProjectDocument(rawProjectMd); }
  catch (error) {
    if (error instanceof DocumentParseError) {
      throw new SourceFetchError('SOURCE_NOT_ALLOWED', `The imported document is invalid (${error.code}).`);
    }
    throw error;
  }
  const specResult = projectSpecSchema.safeParse(parsed.frontmatter);
  const spec = specResult.success ? specResult.data : null;

  const files: Array<{ path: string; content: string }> = [];
  if (spec) {
    for (const declaration of spec.tests) {
      assertDeadline();
      const path = assertSafePath(declaration.path);
      const content = await readFile(path);
      const findings = scanSecrets(content, path);
      if (findings.length > 0) {
        throw new SourceFetchError(
          'SOURCE_NOT_ALLOWED',
          `\`${path}\` contains credential-like content (${findings[0]?.code}).`,
        );
      }
      files.push({ path: declaration.path, content });
    }
  }

  if (spec?.schema === 'localfirst/project/v0.3') {
    const paths = new Set(files.map(f => f.path));
    for (const declaration of spec.environments) {
      assertDeadline();
      const path = assertSafePath(declaration.path);
      if (paths.has(path)) throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Duplicate environment file.');
      const content = await readFile(path);
      files.push({ path, content }); paths.add(path);
      const env = environmentSchema.safeParse(parseSafeYaml(content, path));
      if (!env.success) throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Invalid environment manifest.');
      for (const filePath of environmentFilePaths(env.data)) {
        if (paths.has(filePath)) continue;
        assertDeadline();
        const safe = assertSafePath(filePath);
        const text = await readFile(safe);
        if (scanSecrets(text, safe).length) throw new SourceFetchError('SOURCE_NOT_ALLOWED', 'Environment file contains credential-like content.');
        files.push({ path: safe, content: text }); paths.add(safe);
      }
    }
  }
  const observedAt = new Date().toISOString();
  const pinned = spec
    ? pinRepositorySources(rawProjectMd, spec, owner, repo, sha)
    : { text: rawProjectMd, pinnedKeys: [] };

  const provenance: ImportProvenanceEntry[] = [
    {
      field_path: '',
      source_kind: 'repository',
      source_url: `https://github.com/${owner}/${repo}`,
      source_identity: `github:${repository.id}`,
      source_version: sha,
      extraction_method: 'github_contents_api_at_resolved_commit',
      file: manifestPath,
      observed_at: observedAt,
      // Repository extraction is a source reference, never a hardware or model
      // observation (section 15.2).
      evidence_class: 'documented',
    },
    ...pinned.pinnedKeys.map((key) => ({
      field_path: `/sources/${key}/revision`,
      source_kind: 'repository',
      source_url: `https://github.com/${owner}/${repo}`,
      source_identity: `github:${repository.id}`,
      source_version: sha,
      extraction_method: 'resolved_commit_pinning',
      file: manifestPath,
      observed_at: observedAt,
      evidence_class: 'documented' as const,
    })),
    ...files.map((file) => ({
      field_path: '/tests',
      source_kind: 'repository',
      source_url: `https://github.com/${owner}/${repo}`,
      source_identity: `github:${repository.id}`,
      source_version: sha,
      extraction_method: 'github_contents_api_at_resolved_commit',
      file: file.path,
      observed_at: observedAt,
      evidence_class: 'documented' as const,
    })),
  ];

  return {
    payload: { project_md: pinned.text, files },
    provenance,
    repository: {
      provider: 'github',
      provider_repo_id: String(repository.id),
      owner,
      repo,
      default_branch: repository.default_branch,
      resolved_commit: sha,
      visibility: 'public',
      archived: repository.archived,
    },
    files_read: filesRead,
    bytes_read: bytesRead,
  };
}
