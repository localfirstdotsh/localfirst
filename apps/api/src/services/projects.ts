/**
 * Project reads and owner visibility controls (BACKEND_PRD sections 12.1, 14.3).
 *
 * Public reads of hidden records must not disclose private content. Public and
 * private serializers differ, and a visibility predicate is applied in the
 * query rather than inferred from an ID.
 */

import { lockActiveAccount } from './accounts.js';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  ERROR_CODES,
  projectSpecSchema,
  serializeProjectDocument,
  type DerivedFacts,
  type ProjectSpec,
} from '@localfirst/contracts';
import {
  attributions,
  hardwareDescriptors,
  modelReferences,
  projects,
  projectVersionFiles,
  projectVersionHardware,
  projectVersionModelRoles,
  projectVersions,
  projectVersionRuntimes,
  projectVersionTests,
  runtimeReferences,
  sourceDriftChecks,
  sourceReferences,
  userProfiles,
} from '../db/schema/registry.js';
import { derivativeRelationships } from '../db/schema/community.js';
import { db } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { encodeCursor, type PageRequest } from '../http/envelope.js';
import type { Actor } from '../http/context.js';
import { isOperator } from '../http/context.js';
import { config } from '../config.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { enqueueJob } from './jobs.js';
import { markProjectionStale, removeSearchDocument } from './search.js';
import { ensureTestDefinitions, runnerAvailabilityByVersion } from './test-definitions.js';
import { testDefinitions } from '../db/schema/evidence.js';
import { connectionsAuthorized, EMPTY_USAGE, usageTotalsFor, type UsageTotals } from './usage.js';

export interface ProjectRow {
  id: string;
  slug: string;
  projectKey: string;
  managerUserId: string;
  type: string;
  visibility: string;
  listingOrigin: string;
  currentVersionId: string | null;
  quarantineReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Load a project the caller may see. A published project is public; a hidden or
 * quarantined one is visible to its manager and operators only, and looks
 * missing to everyone else.
 */
export async function loadVisibleProject(
  identifier: { id?: string; slug?: string },
  actor: Actor,
): Promise<ProjectRow> {
  const condition = identifier.id
    ? eq(projects.id, identifier.id)
    : eq(projects.slug, identifier.slug ?? '');
  const [row] = await db().select().from(projects).where(condition).limit(1);
  if (!row) throw ApiError.notFound();
  const project = row as unknown as ProjectRow;
  if (project.visibility === 'published') return project;
  const isManager = actor.kind !== 'anonymous' && actor.userId === project.managerUserId;
  if (isManager || isOperator(actor)) return project;
  throw ApiError.notFound();
}

export interface VersionDetail {
  id: string;
  projectId: string;
  versionNumber: number;
  specVersion: string;
  schemaId: string;
  manifest: ProjectSpec;
  markdown: string;
  contentDigest: string;
  derived: DerivedFacts;
  warningCodes: string[];
  publicationAuthorization: 'human' | 'delegated';
  publishedViaClientName: string | null;
  publishedAt: Date;
}

/**
 * How a version's publication was authorized (section 10.4). A delegated
 * version had no per-version human review; the client name is self-reported.
 */
export function publicationOf(version: VersionDetail) {
  return {
    authorization: version.publicationAuthorization,
    via_client_name: version.publishedViaClientName,
    via_client_name_is_unverified: version.publishedViaClientName !== null,
  };
}

export async function loadVersion(projectId: string, versionId: string): Promise<VersionDetail> {
  const [row] = await db()
    .select()
    .from(projectVersions)
    .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId)))
    .limit(1);
  if (!row) throw ApiError.notFound();
  return row as unknown as VersionDetail;
}

export async function loadCurrentVersion(project: ProjectRow): Promise<VersionDetail | null> {
  if (!project.currentVersionId) return null;
  return loadVersion(project.id, project.currentVersionId);
}

export async function listVersions(projectId: string): Promise<VersionDetail[]> {
  const rows = await db()
    .select()
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(desc(projectVersions.versionNumber));
  return rows as unknown as VersionDetail[];
}

export interface VersionRelations {
  sources: Array<Record<string, unknown>>;
  authors: Array<Record<string, unknown>>;
  submitter: Record<string, unknown> | null;
  models: Array<Record<string, unknown>>;
  runtimes: Array<Record<string, unknown>>;
  hardware: Array<Record<string, unknown>>;
  tests: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  derivedFrom: DerivedFrom | null;
}

/**
 * The pinned parent of a derivative version. The IDs, key, and version are
 * already public in the version's `derivative_of`; the parent's slug and links
 * appear only while the parent is published.
 */
export interface DerivedFrom {
  project_id: string;
  project_version_id: string;
  project_key: string;
  version: string;
  change_summary: string;
  parent_visible: boolean;
  slug: string | null;
  url: string | null;
}

async function loadDerivedFrom(versionId: string): Promise<DerivedFrom | null> {
  const [row] = await db()
    .select({
      projectId: derivativeRelationships.parentProjectId,
      projectVersionId: derivativeRelationships.parentVersionId,
      changeSummary: derivativeRelationships.changeSummary,
      projectKey: projects.projectKey,
      slug: projects.slug,
      visibility: projects.visibility,
      version: projectVersions.specVersion,
    })
    .from(derivativeRelationships)
    .innerJoin(projects, eq(projects.id, derivativeRelationships.parentProjectId))
    .innerJoin(projectVersions, eq(projectVersions.id, derivativeRelationships.parentVersionId))
    .where(eq(derivativeRelationships.childVersionId, versionId));
  if (!row) return null;
  const visible = row.visibility === 'published';
  return {
    project_id: row.projectId,
    project_version_id: row.projectVersionId,
    project_key: row.projectKey,
    version: row.version,
    change_summary: row.changeSummary,
    parent_visible: visible,
    slug: visible ? row.slug : null,
    url: visible ? `${config().apiBaseUrl}/api/v1/projects/${row.projectId}/versions/${row.projectVersionId}` : null,
  };
}

/** Joined references for a version. Nothing private is included. */
export async function loadVersionRelations(versionId: string): Promise<VersionRelations> {
  await ensureTestDefinitions([versionId]);
  const [sources, people, models, runtimes, hardware, tests, files, derivedFrom] = await Promise.all([
    db()
      .select({
        key: sourceReferences.key,
        kind: sourceReferences.kind,
        url: sourceReferences.url,
        revision: sourceReferences.revision,
        content_digest: sourceReferences.contentDigest,
        path: sourceReferences.path,
        provider: sourceReferences.providerName,
        provider_owner: sourceReferences.providerOwner,
        provider_repo: sourceReferences.providerRepo,
        license_state: sourceReferences.licenseState,
        license_id: sourceReferences.licenseId,
        license_reference: sourceReferences.licenseReference,
        note: sourceReferences.note,
        pinned: sourceReferences.pinned,
        last_checked_at: sourceDriftChecks.lastCheckedAt,
        observed_upstream_revision: sourceDriftChecks.observedUpstreamRevision,
        pinned_revision_available: sourceDriftChecks.pinnedRevisionAvailable,
        source_visibility: sourceDriftChecks.sourceVisibility,
        error_class: sourceDriftChecks.errorClass,
      })
      .from(sourceReferences)
      .leftJoin(sourceDriftChecks, eq(sourceDriftChecks.sourceReferenceId, sourceReferences.id))
      .where(eq(sourceReferences.projectVersionId, versionId)),
    db()
      .select({
        role: attributions.role,
        name: attributions.name,
        url: attributions.url,
        relationship: attributions.relationship,
        handle: userProfiles.handle,
      })
      .from(attributions)
      .leftJoin(userProfiles, eq(userProfiles.userId, attributions.userId))
      .where(eq(attributions.projectVersionId, versionId))
      .orderBy(attributions.position),
    db()
      .select({
        role: projectVersionModelRoles.roleKey,
        required_capabilities: projectVersionModelRoles.requiredCapabilities,
        minimum_context_tokens: projectVersionModelRoles.minimumContextTokens,
        substitution: projectVersionModelRoles.substitution,
        preferred_hint: projectVersionModelRoles.preferredHint,
        model_reference_id: projectVersionModelRoles.modelReferenceId,
        model_key: modelReferences.key,
        model_display_name: modelReferences.displayName,
        model_license_state: modelReferences.licenseState,
      })
      .from(projectVersionModelRoles)
      .leftJoin(modelReferences, eq(modelReferences.id, projectVersionModelRoles.modelReferenceId))
      .where(eq(projectVersionModelRoles.projectVersionId, versionId)),
    db()
      .select({
        family: runtimeReferences.family,
        display_name: runtimeReferences.displayName,
        api_profile: runtimeReferences.apiProfile,
        support_status: runtimeReferences.supportStatus,
        docs_url: runtimeReferences.docsUrl,
        version_constraint: projectVersionRuntimes.versionConstraint,
      })
      .from(projectVersionRuntimes)
      .innerJoin(runtimeReferences, eq(runtimeReferences.id, projectVersionRuntimes.runtimeReferenceId))
      .where(eq(projectVersionRuntimes.projectVersionId, versionId)),
    db()
      .select({
        key: hardwareDescriptors.key,
        display_name: hardwareDescriptors.displayName,
        platform: hardwareDescriptors.platform,
        cpu_architecture: hardwareDescriptors.cpuArchitecture,
        accelerator: hardwareDescriptors.accelerator,
        memory_bytes: hardwareDescriptors.memoryBytes,
        vram_bytes: hardwareDescriptors.vramBytes,
        unified_memory: hardwareDescriptors.unifiedMemory,
        docs_url: hardwareDescriptors.docsUrl,
        relation: projectVersionHardware.relation,
      })
      .from(projectVersionHardware)
      .innerJoin(hardwareDescriptors, eq(hardwareDescriptors.id, projectVersionHardware.hardwareDescriptorId))
      .where(eq(projectVersionHardware.projectVersionId, versionId)),
    db()
      .select({
        test_definition_id: testDefinitions.id,
        key: projectVersionTests.key,
        schema: projectVersionTests.schemaId,
        path: projectVersionTests.path,
        harness: projectVersionTests.harness,
        scope: projectVersionTests.scope,
        configuration_key: projectVersionTests.configurationKey,
        model_role: projectVersionTests.modelRole,
        required_capabilities: projectVersionTests.requiredCapabilities,
        // The definition's independent digests are authoritative once it exists.
        manifest_digest: sql<string>`coalesce(${testDefinitions.manifestDigest}, ${projectVersionTests.manifestDigest})`,
        fixture_digest: sql<string>`coalesce(${testDefinitions.fixtureDigest}, ${projectVersionTests.fixtureDigest})`,
        evaluator_digest: testDefinitions.evaluatorDigest,
        bundle_digest: testDefinitions.bundleDigest,
        // True only for a definition the first-party runner can execute.
        runner_available: sql<boolean>`coalesce(${testDefinitions.executable}, false)`,
        refusal_codes: testDefinitions.refusalCodes,
        definition_manifest: testDefinitions.manifest,
      })
      .from(projectVersionTests)
      .leftJoin(
        testDefinitions,
        and(
          eq(testDefinitions.projectVersionId, projectVersionTests.projectVersionId),
          eq(testDefinitions.key, projectVersionTests.key),
        ),
      )
      .where(eq(projectVersionTests.projectVersionId, versionId)),
    db()
      .select({
        path: projectVersionFiles.path,
        kind: projectVersionFiles.kind,
        content_digest: projectVersionFiles.contentDigest,
      })
      .from(projectVersionFiles)
      .where(eq(projectVersionFiles.projectVersionId, versionId)),
    loadDerivedFrom(versionId),
  ]);

  return {
    sources,
    authors: people.filter((person) => person.role === 'author'),
    submitter: people.find((person) => person.role !== 'author') ?? null,
    models,
    runtimes,
    hardware,
    tests: tests.map(({ definition_manifest, ...t }) => t.harness === 'declarative_workflow_v1' && (!config().features.agentEnvironments || ((definition_manifest as { profile?: string } | null)?.profile === 'langgraph-docker/v0.1' && !config().features.frameworkEnvironments)) ? { ...t, runner_available: false, refusal_codes: ['workflow_profile_disabled'] } : t),
    files,
    derivedFrom,
  };
}

export interface PublicProjectSummary {
  project_id: string;
  slug: string;
  name: string;
  summary: string;
  type: string;
  categories: string[];
  spec_version: string;
  license: { state: string; id: string | null };
  test_support: { declared_kind: string; runner_available: boolean };
  evidence_level: string;
  listing_origin: string;
  sources_pinned: boolean;
  offline_declared: string;
  runtime_families: string[];
  architectures: string[];
  operating_systems: string[];
  required_capabilities: string[];
  updated_at: string;
  url: string;
  /** Request counts, not installs or runs (BACKEND_PRD section 19.3.1). */
  usage: UsageTotals;
}

export function summarizeProject(
  project: ProjectRow,
  version: VersionDetail,
  runnerAvailable = false,
  usage: UsageTotals = EMPTY_USAGE,
): PublicProjectSummary {
  const derived = version.derived;
  return {
    project_id: project.id,
    slug: project.slug,
    name: derived.name,
    summary: derived.summary,
    type: derived.type,
    categories: derived.categories,
    spec_version: derived.spec_version,
    license: { state: derived.license_state, id: derived.license_id },
    test_support: {
      declared_kind: derived.test_support,
      // A declared harness does not mean a runner has shipped (section 1.2):
      // true only when the version has a definition the runner can execute.
      runner_available: runnerAvailable,
    },
    evidence_level: derived.sources_pinned ? 'documented' : 'claimed',
    listing_origin: project.listingOrigin,
    sources_pinned: derived.sources_pinned,
    offline_declared: derived.offline_declared,
    runtime_families: derived.runtime_families,
    architectures: derived.architectures,
    operating_systems: derived.operating_systems,
    required_capabilities: derived.required_capabilities,
    updated_at: project.updatedAt.toISOString(),
    url: `${config().apiBaseUrl}/api/v1/projects/${project.id}`,
    usage,
  };
}

export async function serializeProjectDetail(
  project: ProjectRow,
  version: VersionDetail,
): Promise<Record<string, unknown>> {
  const relations = await loadVersionRelations(version.id);
  const available = await runnerAvailabilityByVersion([version.id]);
  const usage = project.visibility === 'published' ? (await usageTotalsFor([project.id])).get(project.id) : undefined;
  return {
    ...summarizeProject(project, version, available.get(version.id) ?? false, usage),
    visibility: project.visibility,
    project_key: project.projectKey,
    current_version: serializeVersion(project, version, relations),
    manager: { handle: relations.submitter?.handle ?? null },
    quarantine_reason: project.visibility === 'quarantined' ? project.quarantineReason : null,
    created_at: project.createdAt.toISOString(),
  };
}

export function serializeVersion(
  project: ProjectRow,
  version: VersionDetail,
  relations: VersionRelations,
): Record<string, unknown> {
  return {
    project_version_id: version.id,
    project_id: project.id,
    version_number: version.versionNumber,
    spec_version: version.specVersion,
    schema: version.schemaId,
    content_digest: version.contentDigest,
    published_at: version.publishedAt.toISOString(),
    publication: publicationOf(version),
    /** Warnings the publisher explicitly acknowledged for this artifact. */
    acknowledged_warning_codes: version.warningCodes,
    manifest: normalizedManifest(version),
    markdown: version.markdown,
    sources: relations.sources,
    attribution: {
      authors: relations.authors.map((author) => ({
        name: author.name,
        url: author.url,
        relationship: author.relationship,
      })),
      submitted_by: relations.submitter
        ? {
            role: relations.submitter.role,
            handle: relations.submitter.handle ?? null,
            relationship: relations.submitter.relationship,
          }
        : null,
      listing_origin: project.listingOrigin,
    },
    models: relations.models,
    runtimes: relations.runtimes,
    hardware: relations.hardware,
    tests: relations.tests,
    files: relations.files,
    /** The pinned parent when this version is a published derivative, otherwise null. */
    derived_from: relations.derivedFrom,
    resources: {
      manifest: `localfirst://projects/${project.id}/versions/${version.id}/manifest`,
      documentation: `localfirst://projects/${project.id}/versions/${version.id}/documentation`,
      export: `${config().apiBaseUrl}/api/v1/projects/${project.id}/export?version=${version.id}`,
    },
  };
}

/**
 * JSONB does not preserve key order, so a stored manifest is re-normalized
 * through the schema before serialization. Exports are then byte-deterministic
 * in schema order, and the content digest (computed over canonical bytes) is
 * unaffected either way.
 */
export function normalizedManifest(version: VersionDetail): ProjectSpec {
  const result = projectSpecSchema.safeParse(version.manifest);
  return result.success ? result.data : version.manifest;
}

/** `PROJECT.md` export: deterministic text with no credentials embedded. */
export function exportProjectDocument(version: VersionDetail): string {
  return serializeProjectDocument(normalizedManifest(version), version.markdown);
}

export interface ListProjectsOptions {
  page: PageRequest;
  bound: string;
}

/** Fallback listing used when no search filters are supplied. */
export async function listPublishedProjects(
  options: ListProjectsOptions,
): Promise<{ items: PublicProjectSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const conditions = [eq(projects.visibility, 'published')];
  if (options.page.cursor && options.page.cursor.values.length === 2) {
    const [updatedAt, id] = options.page.cursor.values as [string, string];
    conditions.push(
      or(
        lt(projects.updatedAt, new Date(updatedAt)),
        and(eq(projects.updatedAt, new Date(updatedAt)), lt(projects.id, id)),
      ) as never,
    );
  }
  const rows = await db()
    .select({ project: projects, version: projectVersions })
    .from(projects)
    .innerJoin(projectVersions, eq(projects.currentVersionId, projectVersions.id))
    .where(and(...conditions))
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(options.page.limit + 1);

  const hasMore = rows.length > options.page.limit;
  const items = rows.slice(0, options.page.limit);
  const last = items.at(-1);
  const available = await runnerAvailabilityByVersion(
    items.map((row) => (row.version as unknown as VersionDetail).id),
  );
  const usage = await usageTotalsFor(items.map((row) => (row.project as unknown as ProjectRow).id));
  return {
    items: items.map((row) => {
      const version = row.version as unknown as VersionDetail;
      const project = row.project as unknown as ProjectRow;
      return summarizeProject(project, version, available.get(version.id) ?? false, usage.get(project.id));
    }),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(options.bound, [
            (last.project as unknown as ProjectRow).updatedAt.toISOString(),
            (last.project as unknown as ProjectRow).id,
          ])
        : null,
  };
}

/** Hydrate search projection rows with authoritative current-version data. */
export async function hydrateSummaries(projectIds: string[]): Promise<Map<string, PublicProjectSummary>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db()
    .select({ project: projects, version: projectVersions })
    .from(projects)
    .innerJoin(projectVersions, eq(projects.currentVersionId, projectVersions.id))
    .where(and(inArray(projects.id, projectIds), eq(projects.visibility, 'published')));
  const available = await runnerAvailabilityByVersion(
    rows.map((row) => (row.version as unknown as VersionDetail).id),
  );
  const usage = await usageTotalsFor(rows.map((row) => (row.project as unknown as ProjectRow).id));
  return new Map(
    rows.map((row) => {
      const project = row.project as unknown as ProjectRow;
      const version = row.version as unknown as VersionDetail;
      return [
        project.id,
        summarizeProject(project, version, available.get(version.id) ?? false, usage.get(project.id)),
      ];
    }),
  );
}

export interface VisibilityChangeInput {
  actor: Actor;
  projectId: string;
  action: 'unpublish' | 'republish';
  reason?: string | null;
}

export async function changeOwnVisibility(
  input: VisibilityChangeInput,
): Promise<{ visibility: string }> {
  if (input.actor.kind === 'anonymous') throw ApiError.notFound();
  const actorUserId = input.actor.userId;

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, actorUserId);
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update');
    if (!project) throw ApiError.notFound();
    if (project.managerUserId !== actorUserId) {
      throw ApiError.forbidden('You do not manage this project.');
    }
    // Only an operator can restore a quarantined project (section 3.2).
    if (project.visibility === 'quarantined') {
      throw new ApiError({
        code: ERROR_CODES.QUARANTINED,
        message: 'A quarantined project can only be restored by an operator.',
      });
    }
    if (input.action === 'republish' && !project.currentVersionId) {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'This project has no published version to restore.',
      });
    }

    const visibility = input.action === 'unpublish' ? 'unpublished' : 'published';
    const now = new Date();
    await tx
      .update(projects)
      .set({
        visibility,
        unpublishedAt: input.action === 'unpublish' ? now : null,
        updatedAt: now,
      })
      .where(eq(projects.id, input.projectId));

    if (visibility === 'published') {
      await enqueueJob(tx, {
        kind: 'publication_index',
        payload: { project_id: input.projectId },
        dedupeKey: `publication_index:${input.projectId}:${now.getTime()}`,
      });
      await markProjectionStale(tx, input.projectId);
    } else {
      // Read-time predicates already hide it; remove the projection as well.
      await removeSearchDocument(tx, input.projectId);
    }

    await emitEvent(tx, {
      eventType: 'project.visibility_changed',
      aggregateKind: 'project',
      aggregateId: input.projectId,
      payload: { visibility },
    });
    await writeAudit(tx, input.actor, {
      action: `project.${input.action}`,
      targetKind: 'project',
      targetId: input.projectId,
      reason: input.reason ?? null,
      metadata: { visibility },
    });
    return { visibility };
  });
}

/** Counts for the facets endpoint: honest zeros where a phase has no data. */
export async function catalogCounts(): Promise<Record<string, number>> {
  const result = await db().execute<{ published: string; versions: string }>(sql`
    select
      (select count(*)::text from projects where visibility = 'published') as published,
      (select count(*)::text from project_versions v
        join projects p on p.id = v.project_id and p.visibility = 'published') as versions
  `);
  const row = (result.rows ?? result)[0] as { published: string; versions: string } | undefined;
  return {
    published_projects: Number(row?.published ?? '0'),
    published_versions: Number(row?.versions ?? '0'),
    connections_authorized: await connectionsAuthorized(),
  };
}
