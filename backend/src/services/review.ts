/**
 * What a person reviews before approving one exact artifact (section 10.4).
 *
 * The browser page and the linked-machine review read the same data, so what
 * is shown for approval never depends on the surface.
 */

import { and, eq } from 'drizzle-orm';
import { projectSpecSchema, type ProjectSpec, type AgentEnvironment } from '@localfirst/contracts';
import { db } from '../db/client.js';
import { projects, projectVersions } from '../db/schema/registry.js';
import type { DraftRecord } from './drafts.js';
import { evaluateRecordDraft, isRecordKind, type RecordDraftPayload, type RecordKind } from './contributions.js';
import { validateDraft } from './validation.js';

export interface ReviewIssue {
  code: string;
  message: string;
  severity: string;
  pointer?: string;
}

export interface ReviewData {
  /** The exact public text: PROJECT.md, or the public projection as JSON. */
  content: string;
  contentLabel: string;
  contentDigest: string | null;
  slug: string | null;
  /** The record changed since the draft was last validated. */
  stale: boolean;
  issues: ReviewIssue[];
  warningCodes: string[];
  /** Project drafts: the parsed spec. */
  spec: ProjectSpec | null;
  environments?: AgentEnvironment[];
  /** Record drafts: the projection and the public source it refers to. */
  projection: Record<string, unknown> | null;
  source: ProjectSpec | null;
}

export async function loadReviewData(draft: DraftRecord): Promise<ReviewData> {
  if (isRecordKind(draft.kind)) {
    const payload = draft.payload as unknown as RecordDraftPayload;
    const validation = await evaluateRecordDraft({
      kind: draft.kind as RecordKind,
      ownerUserId: draft.ownerUserId,
      recordId: payload.record_id,
      selection: payload.selection,
    });
    const projection = (
      draft.state === 'published' ? draft.manifest : validation.projection
    ) as Record<string, unknown> | null;
    let source: ProjectSpec | null = null;
    if (projection && typeof projection.project_version_id === 'string') {
      const [version] = await db()
        .select({ manifest: projectVersions.manifest })
        .from(projectVersions)
        .innerJoin(projects, eq(projects.id, projectVersions.projectId))
        .where(
          and(
            eq(projectVersions.id, projection.project_version_id),
            eq(projects.visibility, 'published'),
          ),
        )
        .limit(1);
      const parsed = projectSpecSchema.safeParse(version?.manifest);
      if (parsed.success) source = parsed.data;
    }
    return {
      content: JSON.stringify(
        draft.state === 'published' ? (draft.manifest ?? {}) : (validation.projection ?? {}),
        null,
        2,
      ),
      contentLabel: 'Inspect exact public projection',
      contentDigest: null,
      slug: null,
      stale: validation.payloadDigest !== draft.payloadDigest,
      issues: validation.issues,
      warningCodes: validation.warning_codes,
      spec: null,
      projection,
      source,
    };
  }
  const validation = await validateDraft({
    payload: draft.payload,
    ownerUserId: draft.ownerUserId,
    projectId: draft.projectId,
  });
  return {
    content: draft.payload.project_md,
    contentLabel: 'Inspect exact documentation',
    contentDigest: validation.content_digest,
    slug: validation.proposedSlug,
    stale: false,
    issues: validation.issues,
    warningCodes: validation.warning_codes,
    spec: validation.spec,
    environments: validation.environments?.map(e => e.manifest) ?? [],
    projection: null,
    source: null,
  };
}
