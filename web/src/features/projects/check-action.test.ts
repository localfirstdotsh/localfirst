import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck, type CheckState } from './check-action';

const meta = { request_id: 'req_test' };
const idle: CheckState = { status: 'idle' };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const assessment = {
  project_id: 'p1',
  project_version_id: 'v1',
  outcome: 'candidate',
  evidence_level: 'documented',
  evidence_scope: 'requirements_only',
  checks: [{ requirement: 'Architecture', status: 'pass', source: 'project_declaration' }],
  blockers: [],
  uncertainties: [],
  missing_prerequisites: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runCheck', () => {
  it('sends only the entered facts, pinned to the viewed version, and returns the assessment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { data: assessment, meta }));
    vi.stubGlobal('fetch', fetchMock);
    const state = await runCheck(
      idle,
      form({ project_id: 'p1', project_version_id: 'v1', cpu_architecture: 'arm64', memory_gib: '16', require_local: 'on' }),
    );
    expect(state).toEqual({ status: 'done', assessment });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.project_version_id).toBe('v1');
    expect(body.hardware).toMatchObject({ cpu_architecture: 'arm64', memory_bytes: 16 * 1024 ** 3 });
    expect(body.requirements.inference).toBe('local_required');
    expect(body.runtime).toBeNull();
  });

  it('refuses a request with no project id without calling the registry', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const state = await runCheck(idle, form({ project_version_id: 'v1' }));
    expect(state.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid value without calling the registry', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const state = await runCheck(idle, form({ project_id: 'p1', project_version_id: 'v1', memory_gib: '-4' }));
    expect(state.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rate limit in plain words and keeps the request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(429, { error: { code: 'RATE_LIMITED', message: 'Slow down.', retryable: true }, meta }),
      ),
    );
    const state = await runCheck(idle, form({ project_id: 'p1', project_version_id: 'v1' }));
    expect(state).toMatchObject({ status: 'error', requestId: 'req_test' });
    expect(state.status === 'error' && state.message).toContain('Too many checks');
  });

  it('says the registry is unavailable rather than showing a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const state = await runCheck(idle, form({ project_id: 'p1', project_version_id: 'v1' }));
    expect(state).toMatchObject({ status: 'error' });
    expect(state.status === 'error' && state.message).toContain('unavailable');
  });

  it('does not render a result from an unexpected response shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { data: { outcome: 7 }, meta })));
    const state = await runCheck(idle, form({ project_id: 'p1', project_version_id: 'v1' }));
    expect(state.status).toBe('error');
  });
});
