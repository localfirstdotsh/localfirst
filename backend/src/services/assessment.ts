/**
 * Compatibility assessment with registry facts (BACKEND_PRD section 9.2).
 *
 * Wraps the pure domain function with the two things only the database knows:
 * whether the version has a test definition the runner can execute, and which
 * accepted evidence names this exact version. Evidence is withheld for a
 * project that is not publicly visible.
 */

import type { CompatibilityAssessment, CompatibilityRequest } from '@localfirst/contracts';
import { config } from '../config.js';
import { assessCompatibility } from '../domain/compatibility.js';
import { summariesForVersion } from './evidence.js';
import type { ProjectRow, VersionDetail } from './projects.js';
import { runnerAvailabilityByVersion } from './test-definitions.js';

export async function assessProjectVersion(input: {
  project: ProjectRow;
  version: VersionDetail;
  request: CompatibilityRequest;
}): Promise<CompatibilityAssessment> {
  const { project, version, request } = input;
  const availability = await runnerAvailabilityByVersion([version.id]);
  const summaries = project.visibility === 'published' && config().features.evidenceClassification ? await summariesForVersion(version.id) : [];
  return assessCompatibility({
    projectId: project.id,
    projectVersionId: version.id,
    spec: version.manifest,
    sourcesPinned: version.derived.sources_pinned,
    request,
    // True only when a definition exists that the first-party runner can execute.
    runnerAvailable: availability.get(version.id) ?? false,
    evidence: summaries.map((summary) => ({
      id: summary.id,
      configurationKey: summary.configurationKey,
      subject: summary.subject,
      testDefinitionId: summary.testDefinitionId,
      scope: summary.scope,
      evidenceLevel: summary.evidenceLevel,
      counts: summary.counts,
      distinctContributors: summary.distinctContributors,
      conflict: summary.conflict,
      evidenceIds: summary.evidenceIds,
    })),
  });
}
