import { CliError, EXIT } from './errors.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class RegistryError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.code = code;
  }
  /** The route is documented but its phase has not shipped (BACKEND_PRD section 12). */
  get phaseUnavailable(): boolean {
    return this.code === 'PHASE_UNAVAILABLE';
  }
}

/**
 * Validate a user-configured registry origin: https, or http for loopback
 * development only. No path, credentials, query, or fragment.
 */
export function parseRegistryOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`"${value}" is not a valid registry URL.`, EXIT.usage);
  }
  const secure = url.protocol === 'https:';
  const devLoopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!secure && !devLoopback) {
    throw new CliError('The registry must be https (http is allowed only for a loopback address).', EXIT.usage);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CliError('The registry URL must be an origin only (no path, credentials, query, or fragment).', EXIT.usage);
  }
  return url.origin;
}

/**
 * Read a body of at most `limit` bytes, or return null. A declared length over
 * the limit is refused before reading, and an undeclared or understated one
 * is cut off at the limit, so an oversized body is never buffered whole.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface RegistryTestItem {
  key: string;
  test_definition_id?: string | null;
  runner_available?: boolean;
}

/** The public parts of `GET /api/v1/test-definitions/:id` the runner relies on. */
export interface RegistryTestDefinition {
  test_definition_id: string;
  key: string;
  project_id: string;
  project_version_id: string;
  runner_available: boolean;
  manifest_digest: string;
  fixture_digest: string;
  evaluator_digest: string;
  bundle_digest: string;
  bundle_files: Array<{ path: string; kind: string; content: string; content_digest: string }>;
}

export interface RegistryResponse<T> {
  data: T;
  meta: Record<string, unknown>;
  etag: string | null;
}

/**
 * Minimal registry client. It talks to one configured origin, never follows a
 * redirect, bounds responses, and sends a bearer token only when given one.
 */
export interface ApproverLinkStart {
  link_id: string;
  user_code: string;
  poll_secret: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export type ApproverLinkPoll =
  | { status: 'authorization_pending'; interval: number }
  | { status: 'issued'; credential: string; credential_id: string; label: string; expires_at: string };

export interface DraftReview {
  draft: Record<string, unknown> & { draft_id?: string; kind?: string; revision?: number; payload_digest?: string; state?: string };
  stale: boolean;
  content: string;
  content_label: string;
  content_digest: string | null;
  slug: string | null;
  files: Array<{ path: string; content: string }>;
  issues: Array<{ code: string; message: string; severity: string; pointer?: string }>;
  warning_codes: string[];
  approval_window_seconds: number;
}

export class RegistryClient {
  constructor(
    readonly origin: string,
    private readonly fetchImpl: typeof fetch,
    private readonly token: string | null = null,
  ) {}

  private async send(path: string, init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> }) {
    const headers: Record<string, string> = { accept: 'application/json, text/markdown', ...(init.headers ?? {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new RegistryError(0, 'REGISTRY_UNREACHABLE', `Could not reach the registry at ${this.origin}: ${(cause as Error).name}`);
    }
    let text: string | null;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch (cause) {
      throw new RegistryError(0, 'REGISTRY_UNREACHABLE', `The registry response from ${this.origin} was interrupted: ${(cause as Error).name}`);
    }
    if (text === null) throw new RegistryError(response.status, 'RESPONSE_TOO_LARGE', 'The registry response was too large.');
    return { response, text };
  }

  private static failure(status: number, text: string): RegistryError {
    try {
      const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      const code = typeof body.error?.code === 'string' ? body.error.code : null;
      const message = typeof body.error?.message === 'string' ? body.error.message : `Registry answered ${status}.`;
      return new RegistryError(status, code, message);
    } catch {
      return new RegistryError(status, null, `Registry answered ${status}.`);
    }
  }

  private async json<T>(path: string, init: Parameters<RegistryClient['send']>[1]): Promise<RegistryResponse<T>> {
    const { response, text } = await this.send(path, init);
    if (!response.ok) throw RegistryClient.failure(response.status, text);
    let parsed: { data?: T; meta?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text) as { data?: T; meta?: Record<string, unknown> };
    } catch {
      throw new RegistryError(response.status, 'MALFORMED_RESPONSE', 'The registry returned a body that is not JSON.');
    }
    return { data: parsed.data as T, meta: parsed.meta ?? {}, etag: response.headers.get('etag') };
  }

  /** Anonymous: the current version ID and content digest of a public project. */
  async currentVersion(projectId: string): Promise<{ versionId: string; contentDigest: string | null }> {
    const { data } = await this.json<{ current_version?: { project_version_id?: string; content_digest?: string } | null }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      { method: 'GET' },
    );
    const version = data?.current_version;
    if (!version?.project_version_id) throw new RegistryError(404, 'NO_PUBLISHED_VERSION', 'The project has no published version.');
    return { versionId: version.project_version_id, contentDigest: version.content_digest ?? null };
  }

  /** Anonymous: the exact `PROJECT.md` text for one version. */
  async exportProject(projectId: string, versionId: string): Promise<{ text: string; etag: string | null }> {
    const { response, text } = await this.send(
      `/api/v1/projects/${encodeURIComponent(projectId)}/export?version=${encodeURIComponent(versionId)}`,
      { method: 'GET' },
    );
    if (!response.ok) throw RegistryClient.failure(response.status, text);
    return { text, etag: response.headers.get('etag') };
  }

  /** Anonymous: the declared tests of one project version, with their definition IDs. */
  async projectTests(projectId: string, versionId: string): Promise<RegistryTestItem[]> {
    const { data } = await this.json<{ items?: RegistryTestItem[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/tests?version=${encodeURIComponent(versionId)}`,
      { method: 'GET' },
    );
    return Array.isArray(data?.items) ? data.items : [];
  }

  /** Anonymous: an immutable test definition with its digests and the public bundle files. */
  async testDefinition(definitionId: string): Promise<RegistryTestDefinition> {
    const { data } = await this.json<RegistryTestDefinition>(`/api/v1/test-definitions/${encodeURIComponent(definitionId)}`, {
      method: 'GET',
    });
    return data;
  }

  /** Anonymous: generic local plan template for a test definition (BACKEND_PRD section 12.2). */
  async testPlanTemplate(testDefinitionId: string): Promise<unknown> {
    const { data } = await this.json<unknown>(`/api/v1/test-definitions/${encodeURIComponent(testDefinitionId)}/plan`, { method: 'GET' });
    return data;
  }

  /** Anonymous: ask to link this machine as an approval device. A browser session must approve the code. */
  async startApproverLink(label: string): Promise<ApproverLinkStart> {
    const { data } = await this.json<ApproverLinkStart>('/api/v1/approver-links', { method: 'POST', body: { client_label: label } });
    return data;
  }

  /** Anonymous: trade the poll secret for a credential once a person has approved the code. */
  async redeemApproverLink(linkId: string, pollSecret: string): Promise<ApproverLinkPoll> {
    const { data } = await this.json<ApproverLinkPoll>(`/api/v1/approver-links/${encodeURIComponent(linkId)}/token`, {
      method: 'POST',
      body: { poll_secret: pollSecret },
    });
    return data;
  }

  /** With an approval credential: the exact artifact a person is being asked to approve. */
  async reviewDraft(draftId: string): Promise<DraftReview> {
    const { data } = await this.json<DraftReview>(`/api/v1/drafts/${encodeURIComponent(draftId)}/review`, { method: 'GET' });
    return data;
  }

  /** With an approval credential: record the person's decision for one exact revision and digest. */
  async recordApproval(
    draftId: string,
    decision: { draft_revision: number; payload_digest: string; acknowledged_warning_codes: string[]; decision: 'approved' | 'denied' },
  ): Promise<{ approval_id: string | null; decision: string; draft: Record<string, unknown> }> {
    const { data } = await this.json<{ approval_id: string | null; decision: string; draft: Record<string, unknown> }>(
      `/api/v1/drafts/${encodeURIComponent(draftId)}/approval`,
      { method: 'POST', body: decision },
    );
    return data;
  }

  async getDraft(draftId: string): Promise<Record<string, unknown>> {
    const { data } = await this.json<Record<string, unknown>>(`/api/v1/drafts/${encodeURIComponent(draftId)}`, { method: 'GET' });
    return data;
  }

  /** Upload the reviewed submission (sanitized result plus inline build) as a private, pending report. */
  async submitTestResult(payload: unknown, idempotencyKey: string): Promise<RegistryResponse<Record<string, unknown>>> {
    return this.json<Record<string, unknown>>('/api/v1/test-results', {
      method: 'POST',
      body: payload,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }
}
