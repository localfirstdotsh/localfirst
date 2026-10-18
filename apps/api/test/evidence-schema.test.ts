/**
 * Ownership, binding, and policy constraints enforced by PostgreSQL itself
 * (BACKEND_PRD sections 16.2, 20.4). The services check these too; the database
 * must hold even if a service has a bug.
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { buildConfigurations, compatibilitySummaries, runReports, testDefinitions } from '../src/db/schema/evidence.js';
import { projects } from '../src/db/schema/registry.js';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_YAML } from '@localfirst/contracts';
import { createAccount } from './factories.js';
import { buildFor, publishEvidenceProject, publishUpdate, type EvidenceProject } from './evidence-fixtures.js';


/** Drizzle wraps the driver error; the constraint and code live on its cause. */
async function expectViolation(operation: Promise<unknown>, hint?: RegExp): Promise<void> {
  let failure: { code?: string; constraint?: string; message?: string } | null = null;
  try {
    await operation;
  } catch (error) {
    failure = ((error as { cause?: unknown }).cause ?? error) as typeof failure;
  }
  expect(failure, 'expected the database to refuse this write').not.toBeNull();
  expect(['23503', '23505', '23514']).toContain(failure?.code);
  if (hint) expect(`${failure?.constraint ?? ''} ${failure?.message ?? ''}`).toMatch(hint);
}

const sha = (char: string) => `sha256:${char.repeat(64)}`;
let counter = 0;
const unique = () => (counter += 1).toString(16).padStart(64, '0');

async function insertBuild(owner: { userId: string }, project: EvidenceProject, overrides: Record<string, unknown> = {}) {
  const [row] = await db()
    .insert(buildConfigurations)
    .values({
      ownerUserId: owner.userId,
      projectId: project.published.projectId,
      projectVersionId: project.published.projectVersionId,
      configurationKey: 'local-chat',
      payload: buildFor(project),
      contentDigest: `sha256:${unique()}`,
      fingerprint: sha('f'),
      reproducibility: 'complete',
      ...overrides,
    } as never)
    .returning();
  return row!;
}

function reportValues(owner: { userId: string }, project: EvidenceProject, buildId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'test_run' as const,
    submitterUserId: owner.userId,
    clientRunId: `run-${unique().slice(-12)}`,
    requestDigest: `sha256:${unique()}`,
    contentDigest: `sha256:${unique()}`,
    projectId: project.published.projectId,
    projectVersionId: project.published.projectVersionId,
    buildId,
    testDefinitionId: project.definition.id,
    payload: {},
    outcome: 'pass',
    ...overrides,
  };
}

async function setup() {
  const author = await createAccount();
  const project = await publishEvidenceProject(author);
  const owner = await createAccount();
  const build = await insertBuild(owner, project);
  return { author, project, owner, build };
}

const insertReport = (values: ReturnType<typeof reportValues>) => db().insert(runReports).values(values as never).returning();

describe('ownership and version binding', () => {
  it('accepts a report that names the submitter’s own build and this version’s definition', async () => {
    const { project, owner, build } = await setup();
    const [row] = await insertReport(reportValues(owner, project, build.id));
    expect(row?.reviewState).toBe('pending');
    expect(row?.evidenceLevel).toBeNull();
    expect(row?.visibility).toBe('private');
  });

  it('refuses a report that names another account’s build', async () => {
    const { project, build } = await setup();
    const stranger = await createAccount();
    await expectViolation(
      insertReport(reportValues(stranger, project, build.id)), /run_reports_build_owned_fk|foreign key/i,
    );
  });

  it('refuses a report whose build belongs to a different version', async () => {
    const { author, project, owner } = await setup();
    const updated = await publishUpdate(author, project);
    const oldBuild = await insertBuild(owner, project);
    await expectViolation(
      insertReport(
        reportValues(owner, updated, oldBuild.id, { testDefinitionId: updated.definition.id }),
      ),
    );
  });

  it('refuses a test definition from another version', async () => {
    const { author, project, owner, build } = await setup();
    const updated = await publishUpdate(author, project);
    await expectViolation(
      insertReport(reportValues(owner, project, build.id, { testDefinitionId: updated.definition.id })), /run_reports_test_definition_belongs_fk|foreign key/i,
    );
  });

  it('refuses a project and version pair that do not belong together', async () => {
    const { project, owner } = await setup();
    await expectViolation(
      db().insert(buildConfigurations).values({
        ownerUserId: owner.userId,
        projectId: '00000000-0000-4000-8000-000000000000',
        projectVersionId: project.published.projectVersionId,
        configurationKey: 'local-chat',
        payload: {},
        contentDigest: `sha256:${unique()}`,
        fingerprint: sha('f'),
        reproducibility: 'complete',
      }),
    );
  });

  it('refuses a definition or summary bound to the wrong version', async () => {
    const { project, author } = await setup();
    const updated = await publishUpdate(author, project);
    await expectViolation(
      db().insert(testDefinitions).values({
        projectId: project.published.projectId,
        projectVersionId: '00000000-0000-4000-8000-000000000000',
        key: 'x', configurationKey: 'x', scope: 'component', harness: 'declarative_task_v1', modelRole: 'x',
        requiredCapabilities: [], manifest: {}, manifestDigest: sha('1'), fixtureDigest: sha('2'),
        evaluatorDigest: sha('3'), bundleDigest: sha('4'), executable: true,
      }),
    );
    await expectViolation(
      db().insert(compatibilitySummaries).values({
        projectId: project.published.projectId,
        projectVersionId: project.published.projectVersionId,
        configurationKey: 'local-chat',
        subjectFingerprint: sha('a'),
        subject: {},
        testDefinitionId: updated.definition.id, // belongs to the other version
        scope: 'component',
        evidenceLevel: 'reproducible_test',
        counts: {},
        distinctContributors: 1,
        conflict: false,
        evidenceIds: [],
        latestReportAt: new Date(),
      }),
    );
  });
});

describe('discriminator, uniqueness, and evidence policy', () => {
  it('lets only a test run name a definition, and requires one', async () => {
    const { project, owner, build } = await setup();
    await expectViolation(
      insertReport(reportValues(owner, project, build.id, { kind: 'manual_build' })), /run_reports_definition_discriminator_check|check/i,
    );
    await expectViolation(
      insertReport(reportValues(owner, project, build.id, { testDefinitionId: null })), /run_reports_definition_discriminator_check|check/i,
    );
    const [manual] = await insertReport(reportValues(owner, project, build.id, { kind: 'manual_build', testDefinitionId: null }));
    expect(manual?.testDefinitionId).toBeNull();
  });

  it('keeps (submitter, client run) and (submitter, content) unique', async () => {
    const { project, owner, build } = await setup();
    const first = reportValues(owner, project, build.id);
    await insertReport(first);
    await expectViolation(
      insertReport({ ...reportValues(owner, project, build.id), clientRunId: first.clientRunId }), /run_reports_submitter_run_uq|unique/i,
    );
    await expectViolation(
      insertReport({ ...reportValues(owner, project, build.id), contentDigest: first.contentDigest }), /run_reports_submitter_content_uq|unique/i,
    );
    // A different account may reuse a run ID: it is scoped to the submitter.
    const other = await createAccount();
    const otherBuild = await insertBuild(other, project);
    await insertReport({ ...reportValues(other, project, otherBuild.id), clientRunId: first.clientRunId });
  });

  it('holds the evidence policy in the database', async () => {
    const { project, owner, build } = await setup();
    const [report] = await insertReport(reportValues(owner, project, build.id));
    const set = (values: Record<string, unknown>) => db().update(runReports).set(values as never).where(sql`id = ${report!.id}`);

    // No evidence level without acceptance.
    await expectViolation(
      set({ evidenceLevel: 'community_reported' }), /evidence_requires_acceptance|check/i,
    );
    await set({ reviewState: 'accepted', evidenceLevel: 'reproducible_test' });
    // independently_verified is not representable.
    await expectViolation(
      set({ evidenceLevel: 'independently_verified' }), /run_reports_evidence_level_check|check/i,
    );
    for (const level of ['independently_verified', 'verified', 'documented']) {
      await expectViolation(
      set({ evidenceLevel: level }),
    );
    }
    // Unknown review and visibility values are refused.
    await expectViolation(
      set({ reviewState: 'verified' }),
    );
    await expectViolation(
      set({ visibility: 'internal' }),
    );
    // A public report carries its approved projection; a withdrawn one a timestamp.
    await expectViolation(
      set({ visibility: 'public' }), /public_has_projection|check/i,
    );
    await expectViolation(
      set({ visibility: 'withdrawn' }), /withdrawn_check|check/i,
    );
    await set({ visibility: 'withdrawn', withdrawnAt: new Date() });
  });

  it('refuses malformed digests and unknown states on builds and definitions', async () => {
    const { project, owner } = await setup();
    await expectViolation(
      insertBuild(owner, project, { contentDigest: 'not-a-digest' }), /digest_format|check/i,
    );
    await expectViolation(
      insertBuild(owner, project, { fingerprint: 'sha256:short' }),
    );
    await expectViolation(
      insertBuild(owner, project, { visibility: 'secret' }),
    );
    await expectViolation(
      insertBuild(owner, project, { reproducibility: 'verified' }),
    );
    await expectViolation(
      insertBuild(owner, project, { visibility: 'public' }), /public_has_projection|check/i,
    );
    const dup = await insertBuild(owner, project, { contentDigest: sha('d') });
    await expectViolation(
      insertBuild(owner, project, { contentDigest: dup.contentDigest }), /owner_digest_uq|unique/i,
    );

    await expectViolation(
      db().insert(testDefinitions).values({
        projectId: project.published.projectId,
        projectVersionId: project.published.projectVersionId,
        key: 'bad-digest', configurationKey: 'x', scope: 'component', harness: 'declarative_task_v1', modelRole: 'x',
        requiredCapabilities: [], manifest: {}, manifestDigest: 'bad', fixtureDigest: sha('2'),
        evaluatorDigest: sha('3'), bundleDigest: sha('4'), executable: true,
      }), /digest_format|check/i,
    );
    // A definition the runner cannot execute must say why.
    await expectViolation(
      db().insert(testDefinitions).values({
        projectId: project.published.projectId,
        projectVersionId: project.published.projectVersionId,
        key: 'no-reason', configurationKey: 'x', scope: 'component', harness: 'declarative_task_v1', modelRole: 'x',
        requiredCapabilities: [], manifest: {}, manifestDigest: sha('1'), fixtureDigest: sha('2'),
        evaluatorDigest: sha('3'), bundleDigest: sha('4'), executable: false, refusalCodes: [],
      }), /executable_refusal|check/i,
    );
  });

  it('keeps a definition per (version, key) and one summary row per group', async () => {
    const { project } = await setup();
    await expectViolation(
      db().insert(testDefinitions).values({
        projectId: project.published.projectId,
        projectVersionId: project.published.projectVersionId,
        key: project.definition.key, configurationKey: 'x', scope: 'component', harness: 'declarative_task_v1',
        modelRole: 'x', requiredCapabilities: [], manifest: {}, manifestDigest: sha('1'), fixtureDigest: sha('2'),
        evaluatorDigest: sha('3'), bundleDigest: sha('4'), executable: true,
      }), /version_key_uq|unique/i,
    );

    const summary = {
      projectId: project.published.projectId,
      projectVersionId: project.published.projectVersionId,
      configurationKey: 'local-chat',
      subjectFingerprint: sha('a'),
      subject: {},
      testDefinitionId: project.definition.id,
      scope: 'component' as const,
      evidenceLevel: 'reproducible_test' as const,
      counts: {},
      distinctContributors: 1,
      conflict: false,
      evidenceIds: [],
      latestReportAt: new Date(),
    };
    await db().insert(compatibilitySummaries).values(summary);
    await expectViolation(
      db().insert(compatibilitySummaries).values(summary), /uidx|unique/i,
    );
    await expectViolation(
      db().insert(compatibilitySummaries).values({ ...summary, subjectFingerprint: sha('b'), distinctContributors: 0 }), /contributors_check|check/i,
    );
    await expectViolation(
      db().insert(compatibilitySummaries).values({ ...summary, subjectFingerprint: sha('c'), evidenceLevel: 'independently_verified' as never }), /qualified separate evidence/i,
    );
  });

  it('removes a project’s evidence with the project and leaves other projects alone', async () => {
    const { project, owner, build } = await setup();
    await insertReport(reportValues(owner, project, build.id));
    const survivor = await publishEvidenceProject(
      await createAccount(),
      EXAMPLE_TEST_YAML.replaceAll('request-labeler', 'second-labeler'),
      EXAMPLE_PROJECT_MD.replaceAll('request-labeler', 'second-labeler').replace('Local Request Labeler', 'Second Labeler'),
    );
    await db().delete(projects).where(sql`id = ${project.published.projectId}`);
    expect(await db().select().from(runReports)).toHaveLength(0);
    expect(await db().select().from(buildConfigurations)).toHaveLength(0);
    expect(await db().select().from(testDefinitions).where(sql`project_id = ${project.published.projectId}`)).toHaveLength(0);
    const kept = await db().select().from(testDefinitions);
    expect(kept.map((row) => row.id)).toEqual([survivor.definition.id]);
  });
});
