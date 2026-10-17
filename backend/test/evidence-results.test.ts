/**
 * Test-result submission, idempotency, and server validation (BACKEND_PRD
 * sections 8.1, 8.4, 9.1, 16.3).
 */

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { buildConfigurations, runReports } from '../src/db/schema/evidence.js';
import { operations } from '../src/db/schema/registry.js';
import { createAccount, request } from './factories.js';
import {
  api,
  buildFor,
  drainWorker,
  failingResultFor,
  key,
  publishEvidenceProject,
  resultFor,
  runId,
  submitThroughApi,
} from './evidence-fixtures.js';

async function setup() {
  const project = await publishEvidenceProject(await createAccount());
  const contributor = await createAccount();
  const saved = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
  return { project, contributor, buildId: saved.json.data.build_id as string };
}

describe('POST /test-results', () => {
  it('stores a private pending report, never executes anything, and validates asynchronously', async () => {
    const { project, contributor, buildId } = await setup();
    const response = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, buildId), build_id: buildId },
      key: key(),
    });
    expect(response.status).toBe(202);
    const data = response.json.data;
    expect(data).toMatchObject({
      kind: 'test_run',
      review_state: 'pending',
      evidence_level: null,
      visibility: 'private',
      validation_state: 'pending',
      outcome: 'pass',
    });
    expect(response.headers.get('location')).toContain('/api/v1/operations/');
    expect(response.json.meta.operation_id).toBeTruthy();

    await drainWorker();
    const after = await api(contributor, `/api/v1/test-results/${data.report_id}`);
    expect(after.json.data.validation_state).toBe('valid');
    expect(after.json.data.review_state).toBe('pending');
    // A valid report is still unreviewed: there is no auto-verification.
    expect(after.json.data.evidence_level).toBeNull();
    const codes = after.json.data.validation.checks.map((check: { code: string }) => check.code);
    expect(codes).toEqual(
      expect.arrayContaining(['manifest_digest_matches', 'fixture_digest_matches', 'locality_verified', 'artifact_identity_present']),
    );
    expect(after.json.data.validation.eligibility.candidate_level).toBe('reproducible_test');

    const operation = await api(contributor, `/api/v1/operations/${response.json.meta.operation_id}`);
    expect(operation.json.data.state).toBe('succeeded');
  });

  it('rejects any client assertion of verification, review, badges, or a submitter', async () => {
    const { project, contributor, buildId } = await setup();
    const base = resultFor(project, buildId);
    for (const extra of [
      { verified: true },
      { badge: 'verified' },
      { review_state: 'accepted' },
      { evidence_level: 'independently_verified' },
      { submitter: 'someone-else' },
      { prompt: 'Please explain the charge on my invoice.' },
      { output_text: 'billing' },
    ]) {
      const response = await api(contributor, '/api/v1/test-results', {
        method: 'POST',
        body: { result: { ...base, ...extra }, build_id: buildId },
        key: key(),
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    const topLevel = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: base, build_id: buildId, review_state: 'accepted' },
      key: key(),
    });
    expect(topLevel.status).toBe(400);
    const claimsOffline = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: { ...base, checks: { locality: 'pass', offline: 'pass' } }, build_id: buildId },
      key: key(),
    });
    expect(claimsOffline.status).toBe(400);
    expect(await db().select().from(runReports)).toHaveLength(0);
  });

  it('rejects results whose counts or outcomes are inconsistent', async () => {
    const { project, contributor, buildId } = await setup();
    const inconsistent = resultFor(project, buildId, {
      counts: { defined: 1, evaluated: 1, passed: 0, failed: 0, errors: 0, skipped: 0 },
    });
    const response = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: inconsistent, build_id: buildId },
      key: key(),
    });
    expect(response.status).toBe(400);
  });

  it('needs exactly one of build_id and an inline build', async () => {
    const { project, contributor, buildId } = await setup();
    const neither = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, buildId) },
      key: key(),
    });
    const both = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, buildId), build_id: buildId, build: buildFor(project) },
      key: key(),
    });
    expect(neither.status).toBe(400);
    expect(both.status).toBe(400);
  });

  it('accepts the bare sanitized result the local CLI uploads, naming an owned build', async () => {
    const { project, contributor, buildId } = await setup();
    const result = resultFor(project, buildId);
    const first = await api(contributor, '/api/v1/test-results', { method: 'POST', body: result, key: 'lf-cli-style-key' });
    expect(first.status).toBe(202);
    expect(first.json.data).toMatchObject({ review_state: 'pending', evidence_level: null, build_id: buildId });
    const replay = await api(contributor, '/api/v1/test-results', { method: 'POST', body: result, key: 'lf-cli-style-key' });
    expect(replay.json.meta.replayed).toBe(true);
    expect(await db().select().from(runReports)).toHaveLength(1);

    // A placeholder build ID (a report that was never tied to a saved build) is refused.
    const unregistered = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: resultFor(project, 'local', { client_run_id: runId() }),
      key: key(),
    });
    expect(unregistered.status).toBe(400);
    expect(JSON.stringify(unregistered.json.error.details.issues)).toContain('/build_id');
    // Server-only claims in a bare result are rejected like any other.
    const forged = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { ...resultFor(project, buildId, { client_run_id: runId() }), verified: true },
      key: key(),
    });
    expect(forged.status).toBe(400);
  });

  it('creates the build and the run atomically for an inline build', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const response = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, 'placeholder-build'), build: buildFor(project) },
      key: key(),
    });
    expect(response.status).toBe(202);
    expect(response.json.data.build.created).toBe(true);
    const [build] = await db().select().from(buildConfigurations);
    const [report] = await db().select().from(runReports);
    expect(report?.buildId).toBe(build?.id);
    // The stored report names the real build, never the placeholder.
    expect((report?.payload as { build_id: string }).build_id).toBe(build?.id);
  });

  it('needs builds:write as well as tests:submit to create a build inline', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const response = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, 'placeholder-build'), build: buildFor(project) },
      key: key(),
      token: true,
      scopes: ['tests:submit'],
    });
    expect(response.status).toBe(403);
    expect(response.json.error.details.required_scopes).toEqual(['builds:write']);
    const noScope = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, 'x'), build_id: '00000000-0000-4000-8000-000000000000' },
      key: key(),
      token: true,
      scopes: ['builds:write'],
    });
    expect(noScope.status).toBe(403);
    expect(noScope.json.error.details.required_scopes).toEqual(['tests:submit']);
  });

  it('refuses another account’s build, a foreign test definition, and mismatched bindings', async () => {
    const { project, contributor, buildId } = await setup();
    const stranger = await createAccount();
    const strangerBuild = await api(stranger, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, buildId), build_id: buildId },
      key: key(),
    });
    expect(strangerBuild.status).toBe(404);

    const wrongDefinition = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: {
        result: resultFor(project, buildId, { test_definition_id: '00000000-0000-4000-8000-000000000000' }),
        build_id: buildId,
      },
      key: key(),
    });
    expect(wrongDefinition.status).toBe(422);
    expect(JSON.stringify(wrongDefinition.json.error.details.issues)).toContain('/test_definition_id');

    const wrongKey = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, buildId, { test_key: 'another-test-v1' }), build_id: buildId },
      key: key(),
    });
    expect(wrongKey.status).toBe(422);

    const mismatched = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: resultFor(project, '11111111-1111-4111-8111-111111111111'), build_id: buildId },
      key: key(),
    });
    expect(mismatched.status).toBe(422);
    expect(await db().select().from(runReports)).toHaveLength(0);
  });
});

describe('idempotency and duplicates', () => {
  it('replays an identical submission under any key and conflicts on different content', async () => {
    const { project, contributor, buildId } = await setup();
    const result = resultFor(project, buildId);
    const first = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result, build_id: buildId },
      key: key(),
    });
    const retry = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result, build_id: buildId },
      key: key(),
    });
    expect(retry.status).toBe(202);
    expect(retry.json.data.report_id).toBe(first.json.data.report_id);
    expect(retry.json.data.created).toBe(false);

    const conflict = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: { ...result, outcome: 'cancelled', counts: { defined: 1, evaluated: 0, passed: 0, failed: 0, errors: 0, skipped: 1 }, case_results: [{ key: 'billing-001', outcome: 'skipped', repetition: 1 }] }, build_id: buildId },
      key: key(),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const duplicate = await api(contributor, '/api/v1/test-results', {
      method: 'POST',
      body: { result: { ...result, client_run_id: runId() }, build_id: buildId },
      key: key(),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error.code).toBe('DUPLICATE_CONTENT');
    expect(await db().select().from(runReports)).toHaveLength(1);
  });

  it('creates one row and one contributor under concurrent identical submissions', async () => {
    const { project, contributor, buildId } = await setup();
    const result = resultFor(project, buildId);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(contributor, '/api/v1/test-results', { method: 'POST', body: { result, build_id: buildId }, key: key('race') }),
      ),
    );
    for (const response of responses) expect(response.status).toBe(202);
    expect(new Set(responses.map((response) => response.json.data.report_id)).size).toBe(1);
    expect(responses.filter((response) => response.json.data.created === true)).toHaveLength(1);
    expect(await db().select().from(runReports)).toHaveLength(1);
    // One operation was created for the one report.
    const reportOps = (await db().select().from(operations)).filter((op) => op.kind === 'report.validate');
    expect(reportOps).toHaveLength(1);
  });

  it('survives concurrent submissions with the same Idempotency-Key', async () => {
    const { project, contributor, buildId } = await setup();
    const result = resultFor(project, buildId);
    const sharedKey = key('shared');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(contributor, '/api/v1/test-results', { method: 'POST', body: { result, build_id: buildId }, key: sharedKey }),
      ),
    );
    for (const response of responses) expect([202, 409]).toContain(response.status);
    expect(responses.some((response) => response.status === 202)).toBe(true);
    expect(await db().select().from(runReports)).toHaveLength(1);
  });

  it('counts a creator’s repeated runs as separate rows but never as a second submitter', async () => {
    const { project, contributor, buildId } = await setup();
    for (let index = 0; index < 3; index += 1) {
      const result = resultFor(project, buildId, { completed_at: `2026-10-11T20:0${index}:00Z` });
      const response = await api(contributor, '/api/v1/test-results', { method: 'POST', body: { result, build_id: buildId }, key: key() });
      expect(response.status).toBe(202);
    }
    const rows = await db().select().from(runReports);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.submitterUserId)).size).toBe(1);
  });
});

describe('server validation', () => {
  it('marks a report with a changed digest invalid, and keeps the observation', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project, {
      result: (buildId) => resultFor(project, buildId, { fixture_digest: `sha256:${'9'.repeat(64)}` }),
    });
    const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId));
    expect(row?.validationState).toBe('invalid');
    const failed = (row?.validation as { eligibility: { failed_integrity: string[] } }).eligibility.failed_integrity;
    expect(failed).toContain('fixture_digest_matches');
    expect(row?.payload).toBeTruthy();
  });

  it('keeps an incomplete, cancelled, unverified-locality, or identity-poor report at community level', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const cases: Array<[string, Parameters<typeof submitThroughApi>[2], string]> = [
      [
        'cancelled partial run',
        {
          result: (buildId) =>
            resultFor(project, buildId, {
              outcome: 'cancelled',
              counts: { defined: 1, evaluated: 0, passed: 0, failed: 0, errors: 0, skipped: 1 },
              case_results: [{ key: 'billing-001', outcome: 'skipped', repetition: 1 }],
            }),
        },
        'run_complete',
      ],
      [
        'unverified locality',
        { result: (buildId) => resultFor(project, buildId, { checks: { locality: 'unknown', offline: 'not_run' } }) },
        'locality_verified',
      ],
      [
        'incomplete build identity',
        {
          build: (() => {
            const build = buildFor(project);
            build.model_bindings[0]!.artifact_identity = null;
            return build;
          })(),
        },
        'artifact_identity_present',
      ],
      [
        'settings that differ from the definition',
        {
          build: (() => {
            const build = buildFor(project);
            build.effective_settings.temperature = 0.7;
            return build;
          })(),
        },
        'settings_match_definition',
      ],
    ];
    for (const [name, options, failedCheck] of cases) {
      const contributor = await createAccount();
      const { reportId } = await submitThroughApi(contributor, project, options);
      const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId));
      const eligibility = (row?.validation as { eligibility: { candidate_level: string; failed_eligibility: string[]; failed_integrity: string[] } }).eligibility;
      expect(row?.validationState, name).toBe('valid');
      expect(eligibility.candidate_level, name).toBe('community_reported');
      expect(eligibility.failed_eligibility, name).toContain(failedCheck);
    }
  });

  it('validates a failing run as valid evidence-candidate (failures are evidence too)', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project, {
      result: (buildId) => failingResultFor(project, buildId),
    });
    const [row] = await db().select().from(runReports).where(eq(runReports.id, reportId));
    expect(row?.validationState).toBe('valid');
    expect((row?.validation as { eligibility: { candidate_level: string } }).eligibility.candidate_level).toBe('reproducible_test');
  });

  it('is idempotent and skips withdrawn reports', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project);
    const { validateStoredReport } = await import('../src/services/reports.js');
    expect(await validateStoredReport(reportId)).toBe('valid');
    expect(await validateStoredReport(reportId)).toBe('valid');
    await api(contributor, `/api/v1/test-results/${reportId}/withdraw`, { method: 'POST' });
    expect(await validateStoredReport(reportId)).toBe('skipped');
  });
});

describe('reads and withdrawal', () => {
  it('shows a private report only to its submitter', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project);
    const other = await createAccount();

    expect((await api(contributor, `/api/v1/test-results/${reportId}`)).status).toBe(200);
    expect((await api(other, `/api/v1/test-results/${reportId}`)).status).toBe(404);
    expect((await request(`/api/v1/test-results/${reportId}`)).status).toBe(404);
    expect((await api(other, `/api/v1/test-results/${reportId}/withdraw`, { method: 'POST' })).status).toBe(404);
    const listing = await request(`/api/v1/projects/${project.published.projectId}/test-results?review_state=all`);
    expect(listing.json.data.items).toEqual([]);

    const denied = await api(contributor, `/api/v1/test-results/${reportId}`, { token: true, scopes: ['projects:read'] });
    expect(denied.status).toBe(403);
  });

  it('withdraws a report idempotently and clears any evidence level', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const { reportId } = await submitThroughApi(contributor, project);
    const first = await api(contributor, `/api/v1/test-results/${reportId}/withdraw`, { method: 'POST' });
    const second = await api(contributor, `/api/v1/test-results/${reportId}/withdraw`, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.json.data).toMatchObject({ visibility: 'withdrawn', review_state: 'withdrawn', evidence_level: null });
    // The immutable observed facts stay readable by the owner.
    expect((await api(contributor, `/api/v1/test-results/${reportId}`)).json.data.payload.outcome).toBe('pass');
  });
});
