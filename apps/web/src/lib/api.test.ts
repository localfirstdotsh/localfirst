import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client-ip', () => ({ visitorIp: vi.fn().mockResolvedValue(null) }));
import {
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  checkCompatibility,
  getProjectBySlug,
  getVersion,
  listHardware,
  listModels,
  listProjects,
  listVersions,
  publicApiUrl,
  apiBaseUrl,
} from './api';
import { emptyQuery } from './catalog-query';
import { visitorIp } from './client-ip';

const meta = { request_id: 'req_test' };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const summary = {
  project_id: 'p1',
  slug: 'edge-rig',
  name: 'Edge Rig',
  summary: 'A rig.',
  type: 'hardware_build',
  categories: [],
  spec_version: '0.1.0',
  license: { state: 'unknown', id: null },
  test_support: { declared_kind: 'manual', runner_available: false },
  evidence_level: 'documented',
  listing_origin: 'creator_submitted',
  sources_pinned: false,
  offline_declared: 'unknown',
  runtime_families: [],
  architectures: [],
  operating_systems: [],
  required_capabilities: [],
  updated_at: '2026-10-15T00:00:00.000Z',
  url: 'http://localhost:8787/api/v1/projects/p1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registry client', () => {
  it('validates and returns a project page, with usage optional for older APIs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, { data: { items: [summary], has_more: false, next_cursor: null }, meta }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await listProjects(emptyQuery());
    expect(page.items[0]?.slug).toBe('edge-rig');
    expect(page.items[0]?.usage).toBeUndefined();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/projects');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('treats an unreachable registry as unavailable, not as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(listProjects(emptyQuery())).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('treats a 5xx as unavailable and carries the request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(503, { error: { code: 'UNAVAILABLE', message: 'Down.', retryable: true }, meta }),
      ),
    );
    await expect(listProjects(emptyQuery())).rejects.toMatchObject({
      name: 'ApiUnavailableError',
      requestId: 'req_test',
    });
  });

  it('maps a 4xx to a request error that keeps the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(404, { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false }, meta }),
      ),
    );
    await expect(getProjectBySlug('missing')).rejects.toMatchObject({ name: 'ApiRequestError', status: 404 });
    await expect(getProjectBySlug('missing')).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('rejects a successful response of an unexpected shape instead of rendering guesses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { data: { items: 'nope' }, meta })));
    await expect(listProjects(emptyQuery())).rejects.toBeInstanceOf(ApiContractError);
  });

  it('resolves a slug, then reads the authoritative detail by id', async () => {
    const detail = {
      ...summary,
      visibility: 'published',
      project_key: 'edge-rig',
      manager: { handle: 'builder' },
      created_at: '2026-10-15T00:00:00.000Z',
      current_version: {
        project_version_id: 'v1',
        version_number: 1,
        spec_version: '0.1.0',
        content_digest: 'sha256:abc',
        published_at: '2026-10-15T00:00:00.000Z',
      },
      usage: { spec_exports: 2, agent_retrievals: 3, since: '2026-10-15' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { data: { project_id: 'p1', slug: 'edge-rig', url: 'u' }, meta }))
      .mockResolvedValueOnce(respond(200, { data: detail, meta }));
    vi.stubGlobal('fetch', fetchMock);
    const project = await getProjectBySlug('edge-rig');
    expect(project.usage).toEqual({ spec_exports: 2, agent_retrievals: 3, since: '2026-10-15' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/projects/by-slug/edge-rig');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/projects/p1');
  });

  it('lists versions and reads one exact version', async () => {
    const version = {
      project_version_id: 'v1',
      version_number: 1,
      spec_version: '0.1.0',
      content_digest: 'sha256:abc',
      published_at: '2026-10-15T00:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { data: { items: [{ ...version, is_current: true }] }, meta }))
      .mockResolvedValueOnce(
        respond(200, {
          data: {
            ...version,
            project_id: 'p1',
            schema: 'localfirst/project/v0.2',
            acknowledged_warning_codes: [],
            markdown: '# Hi',
            sources: [],
            attribution: { authors: [], submitted_by: null, listing_origin: 'creator_submitted' },
          },
          meta,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect((await listVersions('p1')).items[0]?.is_current).toBe(true);
    expect((await getVersion('p1', 'v1')).markdown).toBe('# Hi');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/projects/p1/versions/v1');
  });

  it('posts a compatibility check uncached and returns the assessment', async () => {
    const assessment = {
      project_id: 'p1',
      project_version_id: 'v1',
      outcome: 'unknown',
      evidence_level: 'claimed',
      evidence_scope: 'requirements_only',
      checks: [{ requirement: 'Architecture', status: 'unknown', source: 'caller_supplied' }],
      blockers: [],
      uncertainties: [],
      missing_prerequisites: ['hardware'],
    };
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { data: assessment, meta }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await checkCompatibility('p1', { project_version_id: 'v1' });
    expect(result.outcome).toBe('unknown');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(String(init.body))).toEqual({ project_version_id: 'v1' });
  });

  it('keeps a rate limit as a request error so the form can say so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(429, { error: { code: 'RATE_LIMITED', message: 'Slow down.', retryable: true }, meta }),
      ),
    );
    await expect(checkCompatibility('p1', {})).rejects.toMatchObject({ name: 'ApiRequestError', status: 429 });
  });

  it('reads the model and hardware references with their stable keys', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond(200, {
          data: {
            items: [{ model_reference_id: 'm1', key: 'llama3-2-3b', display_name: 'Llama 3.2 3B', family: 'llama', source_url: null, license_state: 'unknown', license_id: null, identity_scheme: null, project_count: 2 }],
            has_more: false,
            next_cursor: null,
          },
          meta,
        }),
      )
      .mockResolvedValueOnce(
        respond(200, {
          data: {
            items: [{ hardware_descriptor_id: 'h1', key: 'jetson-orin-nano', display_name: 'Jetson Orin Nano', platform: 'jetson', cpu_architecture: 'arm64', accelerator: 'cuda', memory_bytes: 8589934592, vram_bytes: null, unified_memory: true, docs_url: null, project_count: 5 }],
            has_more: false,
            next_cursor: null,
          },
          meta,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect((await listModels())[0]).toMatchObject({ key: 'llama3-2-3b', project_count: 2 });
    expect((await listHardware())[0]).toMatchObject({ key: 'jetson-orin-nano', memory_bytes: 8589934592 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/models');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/hardware');
  });

  it('rejects a reference list of an unexpected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { data: { items: [{ key: 1 }], has_more: false, next_cursor: null }, meta })));
    await expect(listModels()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('forwards the visitor address to the registry, on reads and on the check, only when there is one', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(respond(200, { data: { items: [], has_more: false, next_cursor: null }, meta })),
    );
    vi.stubGlobal('fetch', fetchMock);

    vi.mocked(visitorIp).mockResolvedValueOnce('203.0.113.9');
    await listProjects(emptyQuery());
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ 'x-forwarded-for': '203.0.113.9' });

    // No visitor (forwarding off, or outside a request): nothing is sent, so a spoofable value never is.
    vi.mocked(visitorIp).mockResolvedValueOnce(null);
    await listProjects(emptyQuery());
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).not.toHaveProperty('x-forwarded-for');

    fetchMock.mockResolvedValueOnce(
      respond(200, {
        data: { project_id: 'p', project_version_id: 'v', outcome: 'unknown', evidence_level: 'claimed', evidence_scope: 'requirements_only', checks: [], blockers: [], uncertainties: [], missing_prerequisites: [] },
        meta,
      }),
    );
    vi.mocked(visitorIp).mockResolvedValueOnce('198.51.100.7');
    await checkCompatibility('p', {});
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({ 'x-forwarded-for': '198.51.100.7', 'content-type': 'application/json' });
  });
});

describe('registry addresses', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses one address for both when no public address is set', () => {
    vi.stubEnv('LOCALFIRST_API_URL', 'http://api.internal:10000/ignored/path');
    vi.stubEnv('LOCALFIRST_PUBLIC_API_URL', '');
    expect(apiBaseUrl()).toBe('http://api.internal:10000');
    expect(publicApiUrl()).toBe('http://localhost:3000');
  });

  it('gives browsers the public address while the server keeps calling the private one', () => {
    vi.stubEnv('LOCALFIRST_API_URL', 'http://api.internal:10000');
    vi.stubEnv('LOCALFIRST_PUBLIC_API_URL', 'https://api.localfirst.sh/extra?x=1');
    expect(apiBaseUrl()).toBe('http://api.internal:10000');
    expect(publicApiUrl()).toBe('https://api.localfirst.sh');
  });

  it('refuses a public address that is not an absolute URL', () => {
    vi.stubEnv('LOCALFIRST_API_URL', 'http://api.internal:10000');
    vi.stubEnv('LOCALFIRST_PUBLIC_API_URL', 'not a url');
    expect(() => publicApiUrl()).toThrow(/LOCALFIRST_PUBLIC_API_URL/);
  });
});
