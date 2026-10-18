/**
 * Accepted-evidence aggregation and its use in compatibility assessments
 * (BACKEND_PRD sections 9.2, 9.5, 16.3).
 */

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { compatibilitySummaries, runReports } from '../src/db/schema/evidence.js';
import { reaggregateProject } from '../src/services/evidence.js';
import { createAccount, request } from './factories.js';
import {
  acceptedRun,
  api,
  buildFor,
  drainWorker,
  exactEnvironment,
  failingResultFor,
  publishEvidenceProject,
  publishRecords,
  publishUpdate,
  resultFor,
  submitThroughApi,
} from './evidence-fixtures.js';

const summaries = () => db().select().from(compatibilitySummaries);

async function world() {
  const author = await createAccount();
  const project = await publishEvidenceProject(author);
  const operator = await createAccount({ operator: true });
  return { author, project, operator };
}

describe('aggregation', () => {
  it('counts accepted public reports and exposes nothing before acceptance', async () => {
    const { project, operator } = await world();
    const contributor = await createAccount();
    const { buildId, reportId } = await submitThroughApi(contributor, project);
    await publishRecords(contributor, buildId, reportId);
    await drainWorker();
    expect(await summaries()).toHaveLength(0);

    await api(operator, `/api/v1/admin/test-results/${reportId}/review`, {
      method: 'POST',
      body: { decision: 'accepted', reason_code: 'accepted_as_reported' },
    });
    await drainWorker();
    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'component',
      evidenceLevel: 'reproducible_test',
      distinctContributors: 1,
      conflict: false,
      counts: { reports: 1, successes: 1, failures: 0, partial: 0 },
    });
    expect(rows[0]?.evidenceIds).toEqual([reportId]);
  });

  it('counts distinct contributors, so one creator’s reruns are one contributor', async () => {
    const { project, operator } = await world();
    const solo = await createAccount();
    // Three reports from one contributor (different completion times, so different content).
    for (let index = 0; index < 3; index += 1) {
      const build = buildFor(project);
      await acceptedRun(project, operator, {
        contributor: solo,
        build,
        result: (buildId) => resultFor(project, buildId, { completed_at: `2026-10-11T20:0${index}:00Z` }),
      });
    }
    let [row] = await summaries();
    expect(row?.counts).toMatchObject({ reports: 3, successes: 3 });
    expect(row?.distinctContributors).toBe(1);

    await acceptedRun(project, operator);
    [row] = await summaries();
    expect(row?.counts).toMatchObject({ reports: 4, successes: 4 });
    expect(row?.distinctContributors).toBe(2);
  });

  it('includes accepted failures and flags a conflict instead of averaging', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    let [row] = await summaries();
    expect(row?.conflict).toBe(false);

    await acceptedRun(project, operator, { result: (buildId) => failingResultFor(project, buildId) });
    [row] = await summaries();
    expect(row).toMatchObject({ conflict: true, distinctContributors: 2 });
    expect(row?.counts).toMatchObject({ reports: 2, successes: 1, failures: 1 });
  });

  it('excludes rejected, private, and withdrawn reports', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator, { decision: 'rejected' });
    expect(await summaries()).toHaveLength(0);

    const contributor = await createAccount();
    await submitThroughApi(contributor, project); // private, never published
    await drainWorker();
    expect(await summaries()).toHaveLength(0);

    const kept = await acceptedRun(project, operator);
    expect(await summaries()).toHaveLength(1);
    await api(kept.contributor, `/api/v1/test-results/${kept.reportId}/withdraw`, { method: 'POST' });
    await drainWorker();
    expect(await summaries()).toHaveLength(0);
  });

  it('removes evidence when its build is withdrawn', async () => {
    const { project, operator } = await world();
    const { contributor, buildId } = await acceptedRun(project, operator);
    expect(await summaries()).toHaveLength(1);
    await api(contributor, `/api/v1/builds/${buildId}/withdraw`, { method: 'POST' });
    await drainWorker();
    expect(await summaries()).toHaveLength(0);
  });

  it('is idempotent and fully recomputable', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    await acceptedRun(project, operator);
    const before = (await summaries()).map(({ id: _id, computedAt: _c, ...rest }) => rest);

    await reaggregateProject(project.published.projectId);
    await reaggregateProject(project.published.projectId);
    expect((await summaries()).map(({ id: _id, computedAt: _c, ...rest }) => rest)).toEqual(before);

    await db().delete(compatibilitySummaries);
    await reaggregateProject(project.published.projectId);
    expect((await summaries()).map(({ id: _id, computedAt: _c, ...rest }) => rest)).toEqual(before);
  });

  it('converges when a withdrawal races an aggregation', async () => {
    const { project, operator } = await world();
    const runs = [];
    for (let index = 0; index < 3; index += 1) runs.push(await acceptedRun(project, operator));
    const target = runs[0]!;
    await Promise.all([
      api(target.contributor, `/api/v1/test-results/${target.reportId}/withdraw`, { method: 'POST' }),
      reaggregateProject(project.published.projectId),
      reaggregateProject(project.published.projectId),
      reaggregateProject(project.published.projectId),
    ]);
    // The event the withdrawal emitted schedules the last recomputation.
    await drainWorker();
    const [row] = await summaries();
    expect(row?.counts).toMatchObject({ reports: 2 });
    expect(row?.evidenceIds).not.toContain(target.reportId);
    const [report] = await db().select().from(runReports).where(eq(runReports.id, target.reportId));
    expect(report?.visibility).toBe('withdrawn');
  });

  it('stands down only when a rebuild that started after the change already covers it', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const projectId = project.published.projectId;
    // Database instants at full (microsecond) precision around the last rebuild's start.
    const instants = async () => (await db().execute<{ at: string; before: string; after: string }>(sql`
      select max(computed_at)::text as at, (max(computed_at) - interval '1 microsecond')::text as before,
             (max(computed_at) + interval '1 microsecond')::text as after
        from compatibility_summaries where project_id = ${projectId}`)).rows[0]!;
    const rebuilt = await instants();

    // Queued before, or exactly when, the last rebuild started: covered.
    expect(await reaggregateProject(projectId, { unlessRebuiltSince: rebuilt.before })).toMatchObject({ skipped: true });
    expect(await reaggregateProject(projectId, { unlessRebuiltSince: rebuilt.at })).toMatchObject({ skipped: true });
    expect((await instants()).at).toBe(rebuilt.at);

    // Queued a microsecond after it: the change may be newer, so it rebuilds.
    const later = await reaggregateProject(projectId, { unlessRebuiltSince: rebuilt.after });
    expect(later.skipped).toBeUndefined();
    expect(later.reports).toBe(1);
    expect((await instants()).at > rebuilt.at).toBe(true);

    // No summaries cannot prove coverage, so it always rebuilds.
    await db().delete(compatibilitySummaries);
    const empty = await reaggregateProject(projectId, { unlessRebuiltSince: '1970-01-01 00:00:00+00' });
    expect(empty.skipped).toBeUndefined();
    expect(await summaries()).toHaveLength(1);
  });

  it('keeps evidence bound to the exact version', async () => {
    const { author, project, operator } = await world();
    await acceptedRun(project, operator);
    const updated = await publishUpdate(author, project);

    const view = await request(`/api/v1/projects/${project.published.projectId}/compatibility-reports`);
    expect(view.status).toBe(200);
    expect(view.json.data.current_version_id).toBe(updated.published.projectVersionId);
    expect(view.json.data.summaries).toHaveLength(1);
    // Evidence for the earlier version is historical and never verifies the new one.
    expect(view.json.data.summaries[0].current_version).toBe(false);
    const forNew = await request(
      `/api/v1/projects/${project.published.projectId}/compatibility-reports?version=${updated.published.projectVersionId}`,
    );
    expect(forNew.json.data.summaries).toEqual([]);

    const compat = await request(`/api/v1/projects/${project.published.projectId}/compatibility-checks`, {
      method: 'POST',
      body: exactEnvironment(),
    });
    expect(compat.json.data.project_version_id).toBe(updated.published.projectVersionId);
    expect(compat.json.data.outcome).not.toBe('evidence_match');
  });

  it('reports the strongest accepted level in the search projection', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const found = await request('/api/v1/projects?evidence_level=reproducible_test');
    expect(found.json.data.items.map((item: { project_id: string }) => item.project_id)).toContain(
      project.published.projectId,
    );
  });
});

describe('compatibility assessment with accepted evidence', () => {
  const check = (projectId: string, body: unknown) =>
    request(`/api/v1/projects/${projectId}/compatibility-checks`, { method: 'POST', body });

  it('answers evidence_match only for an exact identity match, at component scope', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const response = await check(project.published.projectId, exactEnvironment());
    const assessment = response.json.data;
    expect(assessment.outcome).toBe('evidence_match');
    expect(assessment.evidence_level).toBe('reproducible_test');
    expect(assessment.evidence_scope).toBe('component');
    expect(assessment.evidence_ids).toHaveLength(1);
    expect(assessment.checks.find((entry: { requirement: string }) => entry.requirement === 'accepted_evidence').status).toBe('pass');
    // Component evidence never implies offline use or a whole project.
    expect(assessment.checks.find((entry: { requirement: string }) => entry.requirement === 'offline').status).toBe('unknown');
    expect(assessment.uncertainties.join(' ')).toContain('does not establish offline use');
    expect(assessment.test_support.runner_available).toBe(true);
  });

  it('downgrades to candidate when the shared facts do not establish the match', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const differing: Array<[string, Record<string, unknown>]> = [
      [
        'a different model artifact',
        exactEnvironment({
          selected_models: [{ ...exactEnvironment().selected_models[0]!, artifact_identity: { scheme: 'ollama_manifest_sha256', digest: `sha256:${'7'.repeat(64)}`, reference: null } }],
        }),
      ],
      [
        'no shared artifact identity',
        exactEnvironment({ selected_models: [{ ...exactEnvironment().selected_models[0]!, artifact_identity: null }] }),
      ],
      ['a different runtime version', exactEnvironment({ runtime: { family: 'ollama', version: '0.36.0', backend: 'metal', api_profile: null } })],
      ['no runtime shared', exactEnvironment({ runtime: null })],
      ['a different architecture', exactEnvironment({ hardware: { ...exactEnvironment().hardware, cpu_architecture: 'x86_64' } })],
      ['no hardware shared', exactEnvironment({ hardware: null })],
    ];
    for (const [name, environment] of differing) {
      const response = await check(project.published.projectId, environment);
      expect(response.json.data.outcome, name).not.toBe('evidence_match');
      expect(response.json.data.evidence_ids, name).toEqual([]);
    }
    const near = await check(
      project.published.projectId,
      exactEnvironment({ runtime: { family: 'ollama', version: '0.36.0', backend: 'metal', api_profile: null } }),
    );
    expect(near.json.data.outcome).toBe('candidate');
    expect(near.json.data.uncertainties.join(' ')).toContain('runtime_version_differs');
  });

  it('never lets evidence override a known hard failure', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator);
    const tooSmall = exactEnvironment({ hardware: { ...exactEnvironment().hardware, memory_bytes: 1073741824 } });
    const response = await check(project.published.projectId, tooSmall);
    expect(response.json.data.outcome).toBe('incompatible');
    expect(response.json.data.evidence_ids).toEqual([]);
  });

  it('does not call exact accepted failures a match, and surfaces conflicts', async () => {
    const { project, operator } = await world();
    await acceptedRun(project, operator, { result: (buildId) => failingResultFor(project, buildId) });
    const failedOnly = (await check(project.published.projectId, exactEnvironment())).json.data;
    expect(failedOnly.outcome).toBe('unknown');
    expect(failedOnly.evidence_ids).toHaveLength(1);
    expect(failedOnly.uncertainties.join(' ')).toContain('reports failures');

    await acceptedRun(project, operator);
    const conflicting = (await check(project.published.projectId, exactEnvironment())).json.data;
    expect(conflicting.outcome).toBe('unknown');
    expect(conflicting.uncertainties.join(' ')).toContain('conflicts');
    expect(conflicting.evidence_ids.length).toBe(2);
  });

  it('stops matching after the evidence is withdrawn', async () => {
    const { project, operator } = await world();
    const { contributor, reportId } = await acceptedRun(project, operator);
    expect((await check(project.published.projectId, exactEnvironment())).json.data.outcome).toBe('evidence_match');
    await api(contributor, `/api/v1/test-results/${reportId}/withdraw`, { method: 'POST' });
    await drainWorker();
    expect((await check(project.published.projectId, exactEnvironment())).json.data.outcome).toBe('candidate');
  });

  it('withholds evidence for a project that is no longer public', async () => {
    const { author, project, operator } = await world();
    await acceptedRun(project, operator);
    await request(`/api/v1/projects/${project.published.projectId}/unpublish`, { method: 'POST', user: author.userId });
    const asAuthor = await request(`/api/v1/projects/${project.published.projectId}/compatibility-checks`, {
      method: 'POST',
      user: author.userId,
      body: exactEnvironment(),
    });
    expect(asAuthor.json.data.outcome).not.toBe('evidence_match');
    const stranger = await request(`/api/v1/projects/${project.published.projectId}/compatibility-reports`);
    expect(stranger.status).toBe(404);
  });
});
