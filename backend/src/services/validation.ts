/**
 * Registry-aware draft validation (BACKEND_PRD sections 4.3, 14.4, 20.1).
 *
 * Contract validation runs first, then registry policy: ownership, duplicate
 * sources, project-key conflicts, quarantined content, and slug availability.
 * Nothing here fetches a URL or executes anything.
 */

import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  validateProjectBundle,
  type BundleFile,
  type ValidatedBundle,
  type ValidationIssue,
} from '@localfirst/contracts';
import {
  projects,
  projectVersions,
  sourceReferences,
} from '../db/schema/registry.js';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';
import { validateDerivative } from './derivatives.js';
import { slugCandidates } from '../domain/slug.js';

export interface DraftPayload {
  project_md: string;
  files: BundleFile[];
}

export interface RegistryValidation extends ValidatedBundle {
  /** Slug this draft would publish under, or null when it cannot be resolved. */
  proposedSlug: string | null;
  /** True when no error-severity issue remains, including registry policy. */
  readyForReview: boolean;
}

export interface ValidateDraftInput {
  payload: DraftPayload;
  ownerUserId: string;
  /** Set when the draft updates an existing project. */
  projectId: string | null;
  tx?: DbOrTx;
}

export async function validateDraft(input: ValidateDraftInput): Promise<RegistryValidation> {
  const conn = input.tx ?? db();
  const bundle = validateProjectBundle({
    project_md: input.payload.project_md,
    files: input.payload.files,
  });
  const issues: ValidationIssue[] = [...bundle.issues];
  let proposedSlug: string | null = null;

  if (bundle.spec && bundle.derived) {
    const spec = bundle.spec;
    issues.push(...await validateDerivative(spec, input.projectId, conn));

    // --- Project identity -------------------------------------------------
    const existingByKey = await conn
      .select({ id: projects.id, slug: projects.slug, visibility: projects.visibility })
      .from(projects)
      .where(and(eq(projects.managerUserId, input.ownerUserId), eq(projects.projectKey, spec.project.key)))
      .limit(1);
    const owned = existingByKey[0];

    if (input.projectId === null && owned) {
      issues.push({
        severity: 'error',
        code: 'PROJECT_KEY_ALREADY_MANAGED',
        message: `You already manage a project with key \`${spec.project.key}\`. Create a version update draft for it instead.`,
        pointer: '/project/key',
      });
    }

    if (input.projectId !== null) {
      const [target] = await conn
        .select({
          id: projects.id,
          projectKey: projects.projectKey,
          slug: projects.slug,
          managerUserId: projects.managerUserId,
          visibility: projects.visibility,
          currentVersionId: projects.currentVersionId,
        })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!target) {
        issues.push({
          severity: 'error',
          code: 'PROJECT_NOT_FOUND',
          message: 'The project this draft updates no longer exists.',
          pointer: '',
        });
      } else {
        proposedSlug = target.slug;
        if (target.managerUserId !== input.ownerUserId) {
          issues.push({
            severity: 'error',
            code: 'PROJECT_NOT_MANAGED',
            message: 'You do not manage the project this draft updates.',
            pointer: '',
          });
        }
        if (target.projectKey !== spec.project.key) {
          issues.push({
            severity: 'error',
            code: 'PROJECT_KEY_MISMATCH',
            message: `A version update must keep the project key \`${target.projectKey}\`.`,
            pointer: '/project/key',
          });
        }
        if (target.visibility === 'quarantined') {
          issues.push({
            severity: 'error',
            code: 'PROJECT_QUARANTINED',
            message: 'A quarantined project cannot receive new versions.',
            pointer: '',
          });
        }
        if (target.currentVersionId && bundle.content_digest) {
          const [current] = await conn
            .select({
              contentDigest: projectVersions.contentDigest,
              specVersion: projectVersions.specVersion,
            })
            .from(projectVersions)
            .where(eq(projectVersions.id, target.currentVersionId))
            .limit(1);
          if (current?.contentDigest === bundle.content_digest) {
            issues.push({
              severity: 'error',
              code: 'VERSION_CONTENT_UNCHANGED',
              message:
                'This content is identical to the current published version; published content never changes in place.',
              pointer: '',
            });
          } else if (current?.specVersion === spec.project.version) {
            issues.push({
              severity: 'warning',
              code: 'SPEC_VERSION_UNCHANGED',
              message: `The content changed but the version label is still \`${spec.project.version}\`.`,
              pointer: '/project/version',
            });
          }
        }
      }
    } else {
      const candidates = slugCandidates(spec.project.name, spec.project.key);
      for (const candidate of candidates) {
        const [taken] = await conn
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, candidate))
          .limit(1);
        if (!taken) {
          proposedSlug = candidate;
          break;
        }
      }
      if (proposedSlug === null) {
        issues.push({
          severity: 'warning',
          code: 'SLUG_SUFFIX_REQUIRED',
          message:
            'The preferred public slugs are taken; publication will append a distinguishing suffix.',
          pointer: '/project/name',
        });
      }
    }

    // --- Duplicate source detection (warning, never auto-ownership) -------
    const sourceUrls = spec.sources
      .map((source) => source.url)
      .filter((url): url is string => url !== null);
    if (sourceUrls.length > 0) {
      const duplicates = await conn
        .select({ slug: projects.slug, url: sourceReferences.url })
        .from(sourceReferences)
        .innerJoin(projectVersions, eq(sourceReferences.projectVersionId, projectVersions.id))
        .innerJoin(projects, eq(projectVersions.projectId, projects.id))
        .where(
          and(
            eq(projects.visibility, 'published'),
            isNotNull(projects.currentVersionId),
            eq(projectVersions.id, sql`${projects.currentVersionId}`),
            or(...sourceUrls.map((url) => eq(sourceReferences.url, url))),
            input.projectId ? ne(projects.id, input.projectId) : sql`true`,
          ),
        )
        .limit(5);
      for (const duplicate of duplicates) {
        issues.push({
          severity: 'warning',
          code: 'DUPLICATE_SOURCE_CANDIDATE',
          message: `The published project \`${duplicate.slug}\` already lists the source ${duplicate.url}. Overlapping entries are allowed; ownership is never assigned automatically.`,
          pointer: '/sources',
        });
      }
    }

    // --- Quarantine cannot be bypassed by resubmitting the same content ----
    if (bundle.content_digest) {
      const [quarantined] = await conn
        .select({ id: projects.id })
        .from(projectVersions)
        .innerJoin(projects, eq(projectVersions.projectId, projects.id))
        .where(
          and(
            eq(projectVersions.contentDigest, bundle.content_digest),
            eq(projects.visibility, 'quarantined'),
          ),
        )
        .limit(1);
      if (quarantined) {
        issues.push({
          severity: 'error',
          code: 'QUARANTINED_CONTENT',
          message: 'This exact content is quarantined and cannot be published again.',
          pointer: '',
        });
      }
    }
  }

  const warningCodes = [
    ...new Set(issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code)),
  ].sort();
  const readyForReview = !issues.some((issue) => issue.severity === 'error');

  return {
    ...bundle,
    issues,
    warning_codes: warningCodes,
    ok: readyForReview,
    proposedSlug,
    readyForReview,
  };
}
