/**
 * Builds and manual reports (BACKEND_PRD sections 6, 6.2, 12.2).
 */

import { describe, expect, it } from 'vitest';
import { buildSubject } from '../src/domain/evidence-match.js';
import { matchSubject } from '../src/domain/evidence-match.js';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { buildConfigurations, runReports } from '../src/db/schema/evidence.js';
import { classifyReproducibility, buildFingerprint } from '../src/domain/evidence.js';
import { createAccount, request } from './factories.js';
import { api, buildFor, key, publishEvidenceProject, runId } from './evidence-fixtures.js';

const manual = () => ({
  schema: 'localfirst/build-report/v0.1' as const,
  client_run_id: runId('manual'),
  outcome: 'partial' as const,
  method: 'Followed the documented setup and sent one request by hand.',
  changes: null,
  checks: [{ name: 'Server starts', result: 'reported_pass' as const }],
  diagnostic_codes: [],
  completed_at: '2026-10-11T20:30:00Z',
});

describe('POST /builds', () => {
  it('saves a private immutable build and answers with server-derived fields', async () => {
    const author = await createAccount();
    const project = await publishEvidenceProject(author);
    const contributor = await createAccount();
    const response = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project),
      key: key(),
    });
    expect(response.status).toBe(201);
    const data = response.json.data;
    expect(data.visibility).toBe('private');
    expect(data.reproducibility).toBe('complete');
    expect(data.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(data.manual_report).toBeNull();
    expect(response.headers.get('location')).toContain(`/api/v1/builds/${data.build_id}`);
  });

  it('rejects server-only and unknown fields instead of stripping them', async () => {
    const contributor = await createAccount();
    const project = await publishEvidenceProject(await createAccount());
    for (const extra of [
      { id: 'build_x' },
      { visibility: 'public' },
      { reproducibility: 'complete' },
      { verified: true },
      { badge: 'verified' },
      { evidence_level: 'independently_verified' },
    ]) {
      const response = await api(contributor, '/api/v1/builds', {
        method: 'POST',
        body: { ...buildFor(project), ...extra },
        key: key(),
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await db().select().from(buildConfigurations)).toHaveLength(0);
  });

  it('returns the same build for identical content and replays a repeated key', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const body = buildFor(project);
    const first = await api(contributor, '/api/v1/builds', { method: 'POST', body, key: 'same-key' });
    const replay = await api(contributor, '/api/v1/builds', { method: 'POST', body, key: 'same-key' });
    const sameContent = await api(contributor, '/api/v1/builds', { method: 'POST', body, key: key() });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.json.meta.replayed).toBe(true);
    expect(sameContent.status).toBe(200);
    expect(sameContent.json.data.build_id).toBe(first.json.data.build_id);
    expect(await db().select().from(buildConfigurations)).toHaveLength(1);

    const conflict = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: { ...body, changes: [{ kind: 'other', role: null, note: 'different' }] },
      key: 'same-key',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires an Idempotency-Key and the builds:write scope', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const noKey = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project) });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const wrongScope = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project),
      key: key(),
      token: true,
      scopes: ['projects:read', 'tests:submit', 'projects:draft'],
    });
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.json.error.details.required_scopes).toEqual(['builds:write']);

    const anonymous = await request('/api/v1/builds', { method: 'POST', body: buildFor(project), idempotencyKey: key() });
    expect(anonymous.status).toBe(401);
  });

  it('validates the build against the exact project version', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const cases: Array<[string, (build: ReturnType<typeof buildFor>) => void, string]> = [
      ['an undeclared configuration', (b) => (b.configuration_key = 'no-such-config'), '/configuration_key'],
      ['an undeclared model role', (b) => (b.model_bindings[0]!.role = 'summarizer'), '/model_bindings/0/role'],
      ['a drifted project digest', (b) => (b.source.project_manifest_digest = `sha256:${'0'.repeat(64)}`), '/source/project_manifest_digest'],
      ['a parent build that is not yours', (b) => (b.parent_build_id = '00000000-0000-4000-8000-000000000000'), '/parent_build_id'],
    ];
    for (const [name, edit, pointer] of cases) {
      const build = buildFor(project);
      edit(build);
      const response = await api(contributor, '/api/v1/builds', { method: 'POST', body: build, key: key() });
      expect(response.status, name).toBe(422);
      expect(JSON.stringify(response.json.error.details.issues), name).toContain(pointer);
    }
    const missingProject = { ...buildFor(project), project_id: '00000000-0000-4000-8000-000000000000' };
    expect((await api(contributor, '/api/v1/builds', { method: 'POST', body: missingProject, key: key() })).status).toBe(404);
  });

  it('refuses a build for a project that is not publicly visible', async () => {
    const author = await createAccount();
    const project = await publishEvidenceProject(author);
    await request(`/api/v1/projects/${project.published.projectId}/unpublish`, { method: 'POST', user: author.userId });
    const contributor = await createAccount();
    const response = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    expect(response.status).toBe(404);
  });
});

describe('reproducibility and fingerprint', () => {
  it('derives reproducibility on the server and never from the client', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const complete = buildFor(project);
    expect(classifyReproducibility(complete)).toBe('complete');

    const noEngine = buildFor(project, { runtime: { ...complete.runtime, engine_version: null } });
    expect(classifyReproducibility(noEngine)).toBe('partial');

    const noIdentity = buildFor(project);
    noIdentity.model_bindings[0]!.artifact_identity = null;
    expect(classifyReproducibility(noIdentity)).toBe('incomplete');

    const unknownSetting = buildFor(project);
    unknownSetting.effective_settings.temperature = null;
    expect(classifyReproducibility(unknownSetting)).toBe('incomplete');

    const noUpstream = buildFor(project);
    noUpstream.model_bindings[0]!.source_url = null;
    expect(classifyReproducibility(noUpstream)).toBe('incomplete');
  });

  it('shares a fingerprint across machines of one class and splits on a different artifact', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const a = buildFor(project);
    const b = buildFor(project);
    b.hardware.cpu_model = 'A different chip';
    b.hardware.memory_bytes = 34359738368;
    b.model_bindings[0]!.runtime_model_id = 'my-alias:latest';
    expect(buildFingerprint(a)).toBe(buildFingerprint(b));

    const c = buildFor(project);
    c.model_bindings[0]!.artifact_identity = { scheme: 'ollama_manifest_sha256', digest: `sha256:${'7'.repeat(64)}`, reference: null };
    expect(buildFingerprint(c)).not.toBe(buildFingerprint(a));
  });
});

describe('a build that shares no hardware', () => {
  it('is accepted, private, and only partially reproducible', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const build = buildFor(project);
    build.hardware = null;
    expect(classifyReproducibility(build)).toBe('partial');
    const response = await api(contributor, '/api/v1/builds', { method: 'POST', body: build, key: key() });
    expect(response.status).toBe(201);
    expect(response.json.data.build.hardware).toBeNull();
    expect(response.json.data.reproducibility).toBe('partial');
    expect(response.json.data.visibility).toBe('private');
  });

  it('has a fingerprint without a platform and never matches a caller platform', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const withHardware = buildFor(project);
    const without = buildFor(project);
    without.hardware = null;
    expect(buildFingerprint(without)).not.toBe(buildFingerprint(withHardware));

    const subject = buildSubject(without);
    expect(subject.platform).toBeNull();
    const match = matchSubject(subject, {
      project_version_id: null,
      configuration_key: null,
      requirements: { inference: 'any', offline: false, accelerator: null },
      hardware: { cpu_architecture: 'arm64', platform: null, os: 'macos', os_version: null, memory_bytes: null, vram_bytes: null, unified_memory: null, accelerator: null },
      runtime: null,
      selected_models: [],
    });
    expect(match.exact).toBe(false);
    expect(match.unmatched).toContain('hardware_not_shared_in_evidence');
  });
});

describe('manual reports', () => {
  it('saves a manual report with the build, never as a test run', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const response = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project, { manual_report: manual() }),
      key: key(),
    });
    expect(response.status).toBe(201);
    const report = response.json.data.manual_report;
    expect(report.kind).toBe('manual_build');
    expect(report.review_state).toBe('pending');
    expect(report.evidence_level).toBeNull();
    expect(report.visibility).toBe('private');
    expect(response.json.meta.operation_id).toBeTruthy();

    const [row] = await db().select().from(runReports);
    expect(row?.kind).toBe('manual_build');
    expect(row?.testDefinitionId).toBeNull();
  });

  it('replays an identical manual report and conflicts when a run ID is reused with other content', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const report = manual();
    const first = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project, { manual_report: report }),
      key: key(),
    });
    const again = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project, { manual_report: report }),
      key: key(),
    });
    expect(again.status).toBe(200);
    expect(again.json.data.manual_report.report_id).toBe(first.json.data.manual_report.report_id);
    expect(await db().select().from(runReports)).toHaveLength(1);

    const conflict = await api(contributor, '/api/v1/builds', {
      method: 'POST',
      body: buildFor(project, { manual_report: { ...report, outcome: 'reported_success' } }),
      key: key(),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects a manual report that claims a test, an evaluator, or verification', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    for (const extra of [
      { test_definition_id: 'test_example' },
      { evaluator: { kind: 'json_assert_v1', version: '1' } },
      { evidence_level: 'reproducible_test' },
      { verified: true },
    ]) {
      const response = await api(contributor, '/api/v1/builds', {
        method: 'POST',
        body: buildFor(project, { manual_report: { ...manual(), ...extra } as never }),
        key: key(),
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('build ownership and withdrawal', () => {
  it('answers 404 to anyone but the owner for a private build', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const owner = await createAccount();
    const other = await createAccount();
    const saved = await api(owner, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    const id = saved.json.data.build_id;

    expect((await api(owner, `/api/v1/builds/${id}`)).status).toBe(200);
    expect((await api(other, `/api/v1/builds/${id}`)).status).toBe(404);
    expect((await request(`/api/v1/builds/${id}`)).status).toBe(404);
    expect((await api(other, `/api/v1/builds/${id}/withdraw`, { method: 'POST' })).status).toBe(404);
    expect((await api(owner, '/api/v1/builds/not-a-uuid')).status).toBe(404);
    // Another account never sees it in the project listing either.
    const listing = await request(`/api/v1/projects/${project.published.projectId}/builds`);
    expect(listing.json.data.items).toEqual([]);
  });

  it('asks an owner without the scope for it rather than for a different record', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const owner = await createAccount();
    const saved = await api(owner, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    const denied = await api(owner, `/api/v1/builds/${saved.json.data.build_id}`, {
      token: true,
      scopes: ['projects:read'],
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.details.required_scopes).toEqual(['builds:write']);
  });

  it('withdraws a build with its reports and refuses to resurrect identical content', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const owner = await createAccount();
    const body = buildFor(project, { manual_report: manual() });
    const saved = await api(owner, '/api/v1/builds', { method: 'POST', body, key: key() });
    const id = saved.json.data.build_id;

    const withdrawn = await api(owner, `/api/v1/builds/${id}/withdraw`, { method: 'POST' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.json.data.visibility).toBe('withdrawn');
    expect(withdrawn.json.meta.withdrawn_reports).toBe(1);
    const [report] = await db().select().from(runReports);
    expect(report?.visibility).toBe('withdrawn');
    expect(report?.reviewState).toBe('withdrawn');
    expect(report?.evidenceLevel).toBeNull();

    // Withdrawal is idempotent, and the observed content stays readable by the owner.
    expect((await api(owner, `/api/v1/builds/${id}/withdraw`, { method: 'POST' })).status).toBe(200);
    expect((await api(owner, `/api/v1/builds/${id}`)).json.data.build.model_bindings).toHaveLength(1);

    const again = await api(owner, '/api/v1/builds', { method: 'POST', body, key: key() });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('INVALID_LIFECYCLE');
    const [row] = await db().select().from(buildConfigurations).where(eq(buildConfigurations.id, id));
    expect(row?.visibility).toBe('withdrawn');
  });
});
