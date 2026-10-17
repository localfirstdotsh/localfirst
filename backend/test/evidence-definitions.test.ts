/**
 * Test definitions and `runner_available` truthfulness (BACKEND_PRD sections
 * 5.3, 12.2, 16.2).
 */

import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML, digestOfBytes, testDigests, testManifestSchema, parseSafeYaml, validateProjectBundle } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { testDefinitions } from '../src/db/schema/evidence.js';
import { projectVersionTests } from '../src/db/schema/registry.js';
import { ensureTestDefinitions } from '../src/services/test-definitions.js';
import { createAccount, projectDocument, publishProject, request } from './factories.js';
import { publishEvidenceProject } from './evidence-fixtures.js';

describe('test definitions', () => {
  it('materializes independent digests from the bundled test at publication', async () => {
    const author = await createAccount();
    const { published, definition } = await publishEvidenceProject(author);
    const manifest = testManifestSchema.parse(parseSafeYaml(EXAMPLE_TEST_YAML));
    const expected = testDigests(manifest);

    expect(definition.key).toBe('request-label-v1');
    expect(definition.manifestDigest).toBe(expected.manifest_digest);
    expect(definition.fixtureDigest).toBe(expected.fixture_digest);
    expect(definition.evaluatorDigest).toBe(expected.evaluator_digest);
    expect(definition.bundleDigest).toBe(published.contentDigest);
    expect(new Set([definition.manifestDigest, definition.fixtureDigest, definition.evaluatorDigest]).size).toBe(3);
    expect(definition.executable).toBe(true);
  });

  it('creates definitions lazily and idempotently for versions that predate them', async () => {
    const author = await createAccount();
    const { published } = await publishEvidenceProject(author);
    await db().delete(testDefinitions);
    await db().update(projectVersionTests).set({ runnerAvailable: false });

    // Concurrent first reads race to create the same definition.
    const [a, b, c] = await Promise.all([
      request(`/api/v1/projects/${published.projectId}/tests`),
      request(`/api/v1/projects/${published.projectId}/tests`),
      ensureTestDefinitions([published.projectVersionId]).then(() => null),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c).toBeNull();
    const rows = await db().select().from(testDefinitions);
    expect(rows).toHaveLength(1);
    expect(a.json.data.items[0].runner_available).toBe(true);
    // The declaration row mirrors the definition.
    const [declared] = await db().select().from(projectVersionTests);
    expect(declared?.runnerAvailable).toBe(true);

    await ensureTestDefinitions([published.projectVersionId]);
    expect(await db().select().from(testDefinitions)).toHaveLength(1);
  });

  it('serves the immutable manifest, public fixtures, digests, and safe provenance', async () => {
    const author = await createAccount();
    const { published, definition } = await publishEvidenceProject(author);
    const response = await request(`/api/v1/test-definitions/${definition.id}`);
    expect(response.status).toBe(200);
    const data = response.json.data;
    expect(data.manifest_digest).toBe(definition.manifestDigest);
    expect(data.bundle_digest).toBe(published.contentDigest);
    expect(data.manifest.cases[0].messages.length).toBeGreaterThan(0);
    expect(data.provenance.project_slug).toBe(published.slug);
    expect(data.runner_available).toBe(true);
    // Provenance carries no submitter-private data.
    expect(JSON.stringify(data)).not.toMatch(/user-/);
  });

  it('serves every public bundle file so a client can recompute the version digest', async () => {
    const author = await createAccount();
    const { published, definition } = await publishEvidenceProject(author);
    const detail = await request(`/api/v1/test-definitions/${definition.id}`);
    const files = detail.json.data.bundle_files as Array<{ path: string; kind: string; content: string; content_digest: string }>;
    expect(files.map((file) => file.path)).toEqual([EXAMPLE_TEST_PATH]);
    expect(files[0]!.content).toBe(EXAMPLE_TEST_YAML);
    for (const file of files) expect(digestOfBytes(file.content)).toBe(file.content_digest);

    // Exported PROJECT.md + served files re-validate to exactly the served bundle digest.
    const exported = await request(`/api/v1/projects/${published.projectId}/export?version=${published.projectVersionId}`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('etag')).toBe(`"${published.contentDigest}"`);
    const validated = validateProjectBundle({ project_md: exported.text, files: files.map((file) => ({ path: file.path, content: file.content })) });
    expect(validated.ok).toBe(true);
    expect(validated.content_digest).toBe(detail.json.data.bundle_digest);
    expect(validated.content_digest).toBe(published.contentDigest);
  });

  it('serves a generic plan template that probes and executes nothing', async () => {
    const author = await createAccount();
    const { definition } = await publishEvidenceProject(author);
    const response = await request(`/api/v1/test-definitions/${definition.id}/plan`);
    expect(response.status).toBe(200);
    const plan = response.json.data;
    expect(plan.schema).toBe('localfirst/plan-template/v0.1');
    expect(plan.probing).toBe('none');
    expect(plan.executes).toBe(false);
    expect(plan.effects).toMatchObject({
      inference_requests: 1,
      network: 'loopback_only',
      downloads: false,
      tools: false,
      project_code: false,
    });
    expect(plan.digests.fixture).toBe(definition.fixtureDigest);
    expect(plan.consent.stages).toContain('execution_authorized');
    expect(JSON.stringify(plan)).not.toMatch(/allow_run|--yes/);
  });

  it('does not claim a runner for a declared test the runner cannot execute', async () => {
    const author = await createAccount();
    const workflow = EXAMPLE_TEST_YAML.replace('scope: component', 'scope: workflow');
    const { published, definition } = await publishEvidenceProject(author, workflow);
    expect(definition.executable).toBe(false);
    expect(definition.refusalCodes).toContain('unsupported_scope');

    const tests = await request(`/api/v1/projects/${published.projectId}/tests`);
    expect(tests.json.data.items[0].runner_available).toBe(false);
    expect(tests.json.data.items[0].refusal_codes).toContain('unsupported_scope');
    expect(tests.json.meta.runner_available).toBe(false);

    const plan = await request(`/api/v1/test-definitions/${definition.id}/plan`);
    expect(plan.status).toBe(422);
    expect(plan.json.error.code).toBe('PLAN_BLOCKED');

    const detail = await request(`/api/v1/projects/${published.projectId}`);
    expect(detail.json.data.test_support.runner_available).toBe(false);
    const compat = await request(`/api/v1/projects/${published.projectId}/compatibility-checks`, {
      method: 'POST',
      body: {},
    });
    expect(compat.json.data.test_support.runner_available).toBe(false);
  });

  it('reports runner availability in detail, list, and compatibility for an executable test', async () => {
    const author = await createAccount();
    const { published } = await publishEvidenceProject(author);
    const detail = await request(`/api/v1/projects/${published.projectId}`);
    expect(detail.json.data.test_support).toMatchObject({ declared_kind: 'declarative_task_v1', runner_available: true });
    const list = await request('/api/v1/projects');
    expect(list.json.data.items[0].test_support.runner_available).toBe(true);
    const compat = await request(`/api/v1/projects/${published.projectId}/compatibility-checks`, {
      method: 'POST',
      body: {},
    });
    expect(compat.json.data.test_support.runner_available).toBe(true);
    // Availability of a runner is not evidence.
    expect(compat.json.data.evidence_level).not.toBe('reproducible_test');
    expect(compat.json.data.outcome).not.toBe('evidence_match');
  });

  it('keeps a project without tests at runner_available false', async () => {
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'no-tests' }));
    const response = await request(`/api/v1/projects/${published.projectId}/tests`);
    expect(response.status).toBe(200);
    expect(response.json.data.items).toEqual([]);
    expect(response.json.meta.runner_available).toBe(false);
  });

  it('hides definitions of a project that is not visible', async () => {
    const author = await createAccount();
    const stranger = await createAccount();
    const { published, definition } = await publishEvidenceProject(author);
    await request(`/api/v1/projects/${published.projectId}/unpublish`, { method: 'POST', user: author.userId });
    const hidden = await request(`/api/v1/test-definitions/${definition.id}`, { user: stranger.userId });
    expect(hidden.status).toBe(404);
    const plan = await request(`/api/v1/test-definitions/${definition.id}/plan`);
    expect(plan.status).toBe(404);
    expect(await db().select().from(testDefinitions).where(eq(testDefinitions.id, definition.id))).toHaveLength(1);
    void sql;
  });

  it('answers 404 for unknown or malformed definition IDs', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect((await request(`/api/v1/test-definitions/${id}`)).status).toBe(404);
    }
  });

  it('uses the same executable bundle path constants as the example', () => {
    expect(EXAMPLE_TEST_PATH).toBe('TESTS/request-label-v1.yaml');
    expect(EXAMPLE_PROJECT_MD).toContain('request-label-v1');
  });
});
