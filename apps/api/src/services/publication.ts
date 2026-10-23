/**
 * Publication (BACKEND_PRD sections 14.1, 16.3).
 *
 * One transaction locks the draft, approval, and target, rechecks revision,
 * digest, and policy, inserts the immutable version, updates the current
 * pointer and visibility, consumes the approval, and writes audit and outbox
 * rows. There is no partial publication, and nothing here creates run evidence.
 */

import { publishDerivativeLink } from './derivatives.js';
import { lockActiveAccount } from './accounts.js';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  digestOf,
  digestOfBytes,
  ERROR_CODES,
  parseSafeYaml,
  type DerivedFacts,
  type ProjectSpec,
} from '@localfirst/contracts';
import {
  attributions,
  drafts,
  projects,
  projectVersionFiles,
  projectVersions,
  projectVersionTests,
  publicationApprovals,
  sourceReferences,
  userProfiles,
} from '../db/schema/registry.js';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { assertApprovalUsable } from '../domain/approval.js';
import { APPROVAL_POLICY_VERSION, SERIALIZER_POLICY_VERSION } from '../domain/policy.js';
import { slugCandidates } from '../domain/slug.js';
import { validateDraft } from './validation.js';
import { linkVersionReferences } from './references.js';
import { ensureTestDefinitions } from './test-definitions.js';
import { writeSearchDocument } from './search.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './outbox.js';
import { enqueueJob } from './jobs.js';
import { clientDisplayName, recordDelegatedApproval } from './delegation.js';

export interface PublishInput {
  actor: Actor;
  draftId: string;
  /** A person's approval, or null when a delegated connection publishes without one (section 10.4). */
  approvalId: string | null;
  draftRevision: number;
  payloadDigest: string;
  /** Required instead of an approval: the delegated connection acknowledges each warning itself. */
  acknowledgedWarningCodes?: string[];
}

export interface PublishResult {
  project_id: string;
  project_version_id: string;
  slug: string;
  version_number: number;
  spec_version: string;
  content_digest: string;
  visibility: string;
  /** Publication never assigns run verification (section 14.1). */
  evidence_level: 'claimed' | 'documented';
  review_state: 'not_applicable';
  url: string;
  published_at: string;
  warning_codes: string[];
  publication_authorization: 'human' | 'delegated';
}

function parseGitHubSource(url: string | null): {
  providerName: string | null;
  providerOwner: string | null;
  providerRepo: string | null;
} {
  if (!url) return { providerName: null, providerOwner: null, providerRepo: null };
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') {
      return { providerName: null, providerOwner: null, providerRepo: null };
    }
    const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repo) return { providerName: 'github', providerOwner: null, providerRepo: null };
    return {
      providerName: 'github',
      providerOwner: owner,
      providerRepo: repo.replace(/\.git$/, ''),
    };
  } catch {
    return { providerName: null, providerOwner: null, providerRepo: null };
  }
}

export async function publishProjectDraft(input: PublishInput): Promise<PublishResult> {
  if (input.actor.kind === 'anonymous') throw ApiError.notFound();
  const actorUserId = input.actor.userId;

  return db().transaction(async (tx) => {
    await lockActiveAccount(tx, actorUserId);
    // --- Lock the draft and its approval ---------------------------------
    const [draft] = await tx.select().from(drafts).where(eq(drafts.id, input.draftId)).for('update');
    if (!draft || draft.ownerUserId !== actorUserId) throw ApiError.notFound();
    if (draft.kind !== 'project') {
      throw ApiError.phaseUnavailable(`Publishing drafts of kind \`${draft.kind}\``);
    }
    if (draft.state === 'published') {
      throw new ApiError({
        code: ERROR_CODES.INVALID_LIFECYCLE,
        message: 'This draft was already published.',
        details: { published_version_id: draft.publishedVersionId },
      });
    }
    const delegated = input.approvalId === null;
    if (!delegated && draft.state !== 'approved') {
      throw new ApiError({
        code: ERROR_CODES.APPROVAL_REQUIRED,
        message: 'This draft has no live human approval of its exact current artifact.',
        details: { state: draft.state },
      });
    }

    if ((draft.manifest as ProjectSpec | null)?.derivative_of) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('derivative-lineage', 0))`);
    }

    // --- Re-validate the exact payload inside the transaction -------------
    const payload = draft.payload as { project_md: string; files: Array<{ path: string; content: string }> };
    const validation = await validateDraft({
      payload,
      ownerUserId: actorUserId,
      projectId: draft.projectId,
      tx,
    });
    if (!validation.readyForReview || !validation.spec || !validation.derived || !validation.content_digest) {
      throw new ApiError({
        code: ERROR_CODES.PUBLICATION_BLOCKED,
        message: 'This draft cannot be published in its current state.',
        details: { issues: validation.issues.filter((issue) => issue.severity === 'error') },
      });
    }

    const approvalId = input.approvalId ?? await recordDelegatedApproval(tx, {
      actor: input.actor,
      draft,
      warningCodes: validation.warning_codes,
      acknowledgedWarningCodes: input.acknowledgedWarningCodes ?? [],
      draftRevision: input.draftRevision,
      payloadDigest: input.payloadDigest,
    });
    const [approval] = await tx
      .select()
      .from(publicationApprovals)
      .where(eq(publicationApprovals.id, approvalId))
      .for('update');
    assertApprovalUsable(
      approval,
      {
        draftId: draft.id,
        kind: draft.kind,
        revision: draft.revision,
        payloadDigest: draft.payloadDigest,
        warningCodes: validation.warning_codes,
      },
      {
        approvalId,
        draftRevision: input.draftRevision,
        payloadDigest: input.payloadDigest,
      },
      actorUserId,
    );
    const viaClientName = delegated && approval?.clientId ? await clientDisplayName(tx, approval.clientId) : null;

    const spec = validation.spec;
    const derived = validation.derived;
    const listingOrigin =
      spec.attribution.relationship === 'curator_submitted'
        ? 'curated_from_upstream'
        : 'creator_submitted';

    // --- Resolve the target project ---------------------------------------
    let projectId = draft.projectId;
    let slug: string;
    let versionNumber: number;

    if (projectId) {
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update');
      if (!project) throw ApiError.notFound();
      if (project.managerUserId !== actorUserId) {
        throw ApiError.forbidden('You do not manage this project.');
      }
      if (project.visibility === 'quarantined') {
        throw new ApiError({
          code: ERROR_CODES.QUARANTINED,
          message: 'A quarantined project cannot receive new versions.',
        });
      }
      slug = project.slug;
      const [max] = await tx
        .select({ value: sql<number>`coalesce(max(${projectVersions.versionNumber}), 0)` })
        .from(projectVersions)
        .where(eq(projectVersions.projectId, projectId));
      versionNumber = Number(max?.value ?? 0) + 1;
    } else {
      slug = await resolveSlug(tx, spec);
      const [project] = await tx
        .insert(projects)
        .values({
          slug,
          projectKey: spec.project.key,
          managerUserId: actorUserId,
          type: spec.project.type,
          visibility: 'unpublished',
          listingOrigin,
        })
        .returning({ id: projects.id });
      if (!project) throw ApiError.internal('The project record could not be created.');
      projectId = project.id;
      versionNumber = 1;
    }

    // --- Insert the immutable version -------------------------------------
    let versionId: string;
    try {
      const [version] = await tx
        .insert(projectVersions)
        .values({
          projectId,
          versionNumber,
          specVersion: spec.project.version,
          schemaId: spec.schema,
          manifest: spec,
          markdown: validation.markdown,
          contentDigest: validation.content_digest,
          payloadDigest: draft.payloadDigest,
          derived,
          warningCodes: validation.warning_codes,
          publishedByUserId: actorUserId,
          publishedFromDraftId: draft.id,
          approvalId,
          publicationAuthorization: delegated ? 'delegated' : 'human',
          publishedViaClientName: viaClientName,
        })
        .returning({ id: projectVersions.id });
      if (!version) throw ApiError.internal('The version could not be created.');
      versionId = version.id;
    } catch (error) {
      if (isUniqueViolation(error, 'project_versions_project_digest_uq')) {
        throw new ApiError({
          code: ERROR_CODES.DUPLICATE_CONTENT,
          message: 'A version of this project already holds exactly this content.',
        });
      }
      throw error;
    }

    await insertVersionDetail(tx, versionId, spec, payload.files ?? [], actorUserId);
    await publishDerivativeLink(tx, spec, projectId, versionId);
    const links = await linkVersionReferences(tx, versionId, spec);
    // Immutable test identities exist from the moment the version does.
    await ensureTestDefinitions([versionId], tx);

    // --- Pointer, visibility, draft state, approval consumption -----------
    const publishedAt = new Date();
    await tx
      .update(projects)
      .set({
        currentVersionId: versionId,
        visibility: 'published',
        unpublishedAt: null,
        listingOrigin,
        type: spec.project.type,
        updatedAt: publishedAt,
      })
      .where(eq(projects.id, projectId));

    const consumed = await tx
      .update(publicationApprovals)
      .set({ consumedAt: publishedAt })
      .where(and(eq(publicationApprovals.id, approvalId), isNull(publicationApprovals.consumedAt)))
      .returning({ id: publicationApprovals.id });
    if (consumed.length === 0) {
      // Another concurrent publication consumed this single-use approval.
      throw new ApiError({
        code: ERROR_CODES.APPROVAL_REQUIRED,
        message: 'This approval was already used.',
      });
    }

    await tx
      .update(drafts)
      .set({ state: 'published', publishedVersionId: versionId, updatedAt: publishedAt })
      .where(eq(drafts.id, draft.id));

    await writeSearchDocument(tx, {
      projectId,
      projectVersionId: versionId,
      visibility: 'published',
      slug,
      listingOrigin,
      derived,
      modelKeys: links.modelKeys,
      hardwareKeys: links.hardwareKeys,
      projectUpdatedAt: publishedAt,
    });

    await emitEvent(tx, {
      eventType: 'project.published',
      aggregateKind: 'project',
      aggregateId: projectId,
      payload: {
        project_version_id: versionId,
        version_number: versionNumber,
        content_digest: validation.content_digest,
      },
    });
    // Recompute the projection out of band as well, so moderation and drift
    // changes always converge through one idempotent path.
    await enqueueJob(tx, {
      kind: 'publication_index',
      payload: { project_id: projectId },
      dedupeKey: `publication_index:${projectId}:${versionId}`,
    });
    await enqueueJob(tx, {
      kind: 'source_drift_check',
      payload: { project_version_id: versionId },
      dedupeKey: `source_drift_check:${versionId}`,
      runAt: new Date(Date.now() + 60_000),
    });

    await writeAudit(tx, input.actor, {
      action: 'project.published',
      targetKind: 'project_version',
      targetId: versionId,
      policyVersion: APPROVAL_POLICY_VERSION,
      metadata: {
        project_id: projectId,
        draft_id: draft.id,
        approval_id: approvalId,
        authorization: delegated ? 'delegated' : 'human',
        version_number: versionNumber,
        content_digest: validation.content_digest,
        payload_digest: draft.payloadDigest,
        serializer: SERIALIZER_POLICY_VERSION,
        listing_origin: listingOrigin,
      },
    });

    return {
      project_id: projectId,
      project_version_id: versionId,
      slug,
      version_number: versionNumber,
      spec_version: spec.project.version,
      content_digest: validation.content_digest,
      visibility: 'published',
      evidence_level: (derived as DerivedFacts).sources_pinned ? 'documented' : 'claimed',
      review_state: 'not_applicable',
      url: `${config().apiBaseUrl}/api/v1/projects/${projectId}`,
      published_at: publishedAt.toISOString(),
      warning_codes: validation.warning_codes,
      publication_authorization: delegated ? 'delegated' : 'human',
    };
  });
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate?.code === '23505' || candidate?.constraint === constraint;
}

async function resolveSlug(
  tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0],
  spec: ProjectSpec,
): Promise<string> {
  for (const candidate of slugCandidates(spec.project.name, spec.project.key)) {
    const [taken] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  const base = slugCandidates(spec.project.name, spec.project.key)[0] ?? 'project';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`.slice(0, 60);
    const [taken] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  throw new ApiError({
    code: ERROR_CODES.SLUG_TAKEN,
    message: 'A public slug could not be allocated for this project.',
  });
}

async function insertVersionDetail(
  tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0],
  versionId: string,
  spec: ProjectSpec,
  files: Array<{ path: string; content: string }>,
  submitterUserId: string,
): Promise<void> {
  for (const source of spec.sources) {
    const provider = parseGitHubSource(source.url);
    await tx.insert(sourceReferences).values({
      projectVersionId: versionId,
      key: source.key,
      kind: source.kind,
      url: source.url,
      revision: source.revision,
      contentDigest: source.content_digest,
      path: source.path,
      providerName: provider.providerName,
      providerOwner: provider.providerOwner,
      providerRepo: provider.providerRepo,
      licenseState: source.license?.state ?? null,
      licenseId: source.license?.id ?? null,
      licenseReference: source.license?.reference ?? null,
      note: source.note,
      pinned: source.revision !== null || source.content_digest !== null,
    });
  }

  // Original authors stay distinct from the submitting account.
  let position = 0;
  for (const author of spec.attribution.authors) {
    await tx.insert(attributions).values({
      projectVersionId: versionId,
      role: 'author',
      name: author.name,
      url: author.url,
      relationship: spec.attribution.relationship,
      position,
    });
    position += 1;
  }
  const [profile] = await tx
    .select({ displayName: userProfiles.displayName, handle: userProfiles.handle })
    .from(userProfiles)
    .where(eq(userProfiles.userId, submitterUserId))
    .limit(1);
  await tx.insert(attributions).values({
    projectVersionId: versionId,
    role: spec.attribution.relationship === 'curator_submitted' ? 'curator' : 'submitter',
    name: profile?.displayName ?? profile?.handle ?? 'Localfirst contributor',
    url: null,
    relationship: spec.attribution.relationship,
    userId: submitterUserId,
    position: 0,
  });

  const fileMap = new Map(files.map((file) => [file.path, file.content] as const));
  const environmentPaths = spec.schema === 'localfirst/project/v0.3' ? spec.environments.map(e => e.path) : [];
  const promptPaths = new Set<string>(), dataPaths = new Set<string>();
  for (const path of environmentPaths) {
    const environment = parseSafeYaml(fileMap.get(path)!) as { prompts: Array<{ path: string }>; data: Array<{ path: string }> };
    for (const prompt of environment.prompts) promptPaths.add(prompt.path);
    for (const data of environment.data) dataPaths.add(data.path);
  }
  for (const file of files) {
    const declaredTest = spec.tests.find((test) => test.path === file.path);
    await tx.insert(projectVersionFiles).values({
      projectVersionId: versionId,
      path: file.path,
      kind: declaredTest ? 'test_manifest' : environmentPaths.includes(file.path) ? 'environment_manifest' : promptPaths.has(file.path) ? 'prompt' : dataPaths.has(file.path) ? 'fixture' : 'other',
      content: file.content,
      contentDigest: digestOfBytes(file.content),
    });
  }

  // Declared tests are preview fixtures in Phase 1: `runnerAvailable` is false
  // and no run has taken place (section 21).
  for (const declaration of spec.tests) {
    const content = fileMap.get(declaration.path);
    if (!content) continue;
    const manifest = parseSafeYaml(content, declaration.path) as Record<string, unknown>;
    await tx.insert(projectVersionTests).values({
      projectVersionId: versionId,
      key: declaration.key,
      schemaId: declaration.schema,
      path: declaration.path,
      harness: String(manifest.harness ?? 'declarative_task_v1'),
      scope: String(manifest.scope ?? 'component'),
      configurationKey: String(manifest.configuration_key ?? ''),
      modelRole: manifest.harness === 'declarative_workflow_v1' ? null : String(manifest.model_role ?? ''),
      environmentKey: manifest.harness === 'declarative_workflow_v1' ? String(manifest.environment_key) : null,
      environmentDigest: manifest.harness === 'declarative_workflow_v1' ? String(manifest.environment_digest) : null,
      requiredCapabilities: manifest.harness === 'declarative_workflow_v1' ? ['chat', 'json_output'] : manifest.required_capabilities ?? [],
      manifestDigest: digestOf(manifest),
      fixtureDigest: digestOf(manifest.cases ?? []),
      runnerAvailable: false,
    });
  }

}
