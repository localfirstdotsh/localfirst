/**
 * Cross-cutting evidence behaviour: phase gates, account deletion, project
 * visibility, and the operator queue (BACKEND_PRD sections 3.2, 17, 19.4).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { config, setConfig } from '../src/config.js';
import { advertisedScopes } from '../src/auth/scopes.js';
import { openApiDocument } from '../src/api/openapi.js';
import { db } from '../src/db/client.js';
import { buildConfigurations, compatibilitySummaries, runReports } from '../src/db/schema/evidence.js';
import { createAccount, request } from './factories.js';
import {
  acceptedRun,
  api,
  buildFor,
  drainWorker,
  key,
  publishEvidenceProject,
  publishRecords,
  resultFor,
  submitThroughApi,
} from './evidence-fixtures.js';

afterEach(() => setConfig(null));

function withFeatures(features: Partial<ReturnType<typeof config>['features']>) {
  const current = config();
  setConfig({ ...current, features: { ...current.features, ...features } });
}

describe('phase gates', () => {
  it('advertises the P1 scopes and routes by default', () => {
    for (const scope of ['builds:write', 'builds:publish', 'tests:submit', 'tests:publish']) {
      expect(advertisedScopes(config())).toContain(scope);
    }
  });

  it('removes scopes, OpenAPI paths, and routes when a gate is off', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    withFeatures({ resultSubmission: false, evidenceClassification: false });
    expect(advertisedScopes(config())).not.toContain('tests:submit');
    const paths = Object.keys((openApiDocument(config()) as { paths: Record<string, unknown> }).paths);
    expect(paths.some((path) => path.includes('test-results'))).toBe(false);
    expect(paths.some((path) => path.includes('/admin/test-results'))).toBe(false);
    expect(paths).toContain('/api/v1/builds');

    const submitted = await api(contributor, '/api/v1/test-results', { method: 'POST', body: {}, key: key() });
    expect(submitted.status).toBe(404);
    expect(submitted.json.error.code).toBe('PHASE_UNAVAILABLE');
    expect((await request(`/api/v1/projects/${project.published.projectId}/compatibility-reports`)).status).toBe(404);

    withFeatures({ testDefinitions: false, resultSubmission: false, evidenceClassification: false });
    expect(advertisedScopes(config())).not.toContain('builds:write');
    const build = await api(contributor, '/api/v1/builds', { method: 'POST', body: buildFor(project), key: key() });
    expect(build.status).toBe(404);
    expect((await request(`/api/v1/test-definitions/${project.definition.id}`)).status).toBe(404);
  });

  it('keeps disabled community routes unavailable', async () => {
    withFeatures({ communityNetwork: false });
    for (const path of ['/api/v1/comparisons', '/api/v1/collections']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.json.error.code).toBe('PHASE_UNAVAILABLE');
    }
  });
});

describe('visibility and the operator queue', () => {
  it('hides evidence reads when the project is unpublished', async () => {
    const author = await createAccount();
    const project = await publishEvidenceProject(author);
    const operator = await createAccount({ operator: true });
    const { contributor, buildId, reportId } = await acceptedRun(project, operator);
    const stranger = await createAccount();
    expect((await api(stranger, `/api/v1/projects/${project.published.projectId}/builds`)).status).toBe(200);

    await request(`/api/v1/projects/${project.published.projectId}/unpublish`, { method: 'POST', user: author.userId });
    for (const path of [
      `/api/v1/projects/${project.published.projectId}/builds`,
      `/api/v1/projects/${project.published.projectId}/test-results`,
      `/api/v1/projects/${project.published.projectId}/compatibility-reports`,
    ]) {
      expect((await api(stranger, path)).status, path).toBe(404);
    }
    // Direct reads honour the project's visibility too; the owner still sees their own record.
    for (const path of [`/api/v1/builds/${buildId}`, `/api/v1/test-results/${reportId}`]) {
      expect((await request(path)).status, path).toBe(404);
      expect((await api(stranger, path)).status, path).toBe(404);
    }
    const contributorView = await api(contributor, `/api/v1/test-results/${reportId}`);
    expect(contributorView.status).toBe(200);
    // The author managing the project can still see it, as for any hidden project.
    expect((await api(author, `/api/v1/builds/${buildId}`)).status).toBe(200);
  });

  it('lists published pending reports for operators and nothing private', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const contributor = await createAccount();
    const operator = await createAccount({ operator: true });
    const priv = await submitThroughApi(contributor, project);
    const other = await createAccount();
    const pub = await submitThroughApi(other, project);
    await publishRecords(other, pub.buildId, pub.reportId);

    const queue = await api(operator, '/api/v1/admin/reviews?kind=evidence');
    expect(queue.status).toBe(200);
    const pending = queue.json.data.evidence_reviews.pending as Array<{ report_id: string }>;
    expect(pending.map((row) => row.report_id)).toEqual([pub.reportId]);
    expect(pending.map((row) => row.report_id)).not.toContain(priv.reportId);
    expect((await api(contributor, '/api/v1/admin/reviews?kind=evidence')).status).toBe(404);
  });
});

describe('account deletion', () => {
  it('removes private evidence, withdraws public evidence, and reaggregates', async () => {
    const project = await publishEvidenceProject(await createAccount());
    const operator = await createAccount({ operator: true });
    const leaving = await createAccount();
    const staying = await createAccount();

    const kept = await acceptedRun(project, operator, { contributor: staying });
    const published = await acceptedRun(project, operator, { contributor: leaving });
    const leavingPrivate = await submitThroughApi(leaving, project, {
      build: buildFor(project, { changes: [{ kind: 'other', role: null, note: 'private variation' }] }),
      result: (id) => resultFor(project, id, { completed_at: '2026-10-12T01:00:00Z' }),
    });
    await drainWorker();
    expect((await db().select().from(compatibilitySummaries))[0]?.distinctContributors).toBe(2);

    const response = await request('/api/v1/me/deletion-requests', {
      user: leaving.userId,
      method: 'POST',
      body: { confirm: true, handle: leaving.handle },
    });
    expect(response.status).toBe(202);
    expect(response.json.data.effects.public_evidence.withdrawn_reports).toBe(1);
    await drainWorker();

    const mine = await db().select().from(runReports).where(eq(runReports.submitterUserId, leaving.userId));
    expect(mine.map((row) => row.visibility)).toEqual(['withdrawn']);
    expect(mine[0]?.id).toBe(published.reportId);
    expect(await db().select().from(runReports).where(eq(runReports.id, leavingPrivate.reportId))).toHaveLength(0);
    const builds = await db().select().from(buildConfigurations).where(eq(buildConfigurations.ownerUserId, leaving.userId));
    expect(builds.every((row) => row.visibility === 'withdrawn')).toBe(true);

    const [summary] = await db().select().from(compatibilitySummaries);
    expect(summary?.distinctContributors).toBe(1);
    expect(summary?.evidenceIds).toEqual([kept.reportId]);
  });
});

