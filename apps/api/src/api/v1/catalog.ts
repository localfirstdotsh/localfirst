/**
 * Reference catalogs and the controlled filter vocabulary
 * (BACKEND_PRD section 12.1).
 *
 * Models, hardware, and runtimes are joined references derived from project
 * records. No weights are hosted, and no private machine inventory exists here.
 */

import { Hono } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import {
  ACCELERATOR_REQUIREMENTS,
  EVIDENCE_LEVELS,
  MODEL_CAPABILITIES,
  OPERATING_SYSTEMS,
  PROJECT_TYPES,
  RUNTIME_FAMILIES,
  TASK_CATEGORIES,
  TEST_SUPPORT_KINDS_V3,
} from '@localfirst/contracts';
import type { AppEnv } from '../../http/context.js';
import { success } from '../../http/middleware.js';
import { db } from '../../db/client.js';
import {
  hardwareDescriptors,
  modelReferences,
  projects,
  projectVersionHardware,
  projectVersionModelRoles,
  projectVersions,
  projectVersionRuntimes,
  runtimeReferences,
} from '../../db/schema/registry.js';
import { config, independentVerificationEnabled } from '../../config.js';
import { catalogCounts } from '../../services/projects.js';
import { SEARCH_SORTS } from '../../services/search.js';
import { limitPublicRead } from './limits.js';
import { visibleCurrentProject } from '../../services/references.js';

export const catalogRoutes = new Hono<AppEnv>();


catalogRoutes.get('/catalog/facets', async (c) => {
  await limitPublicRead(c);
  const counts = await catalogCounts();
  const features = config().features;
  return c.json(
    success(
      {
        schema: { project: 'localfirst/project/v0.2', test: 'localfirst/test/v0.1' },
        project_type: PROJECT_TYPES,
        category: TASK_CATEGORIES,
        runtime: RUNTIME_FAMILIES,
        operating_system: OPERATING_SYSTEMS,
        accelerator: ACCELERATOR_REQUIREMENTS,
        capability: MODEL_CAPABILITIES,
        test_support: TEST_SUPPORT_KINDS_V3,
        supported_schemas: { project: ['localfirst/project/v0.2', 'localfirst/project/v0.3'], test: ['localfirst/test/v0.1', 'localfirst/test/v0.2'], environment: ['localfirst/environment/v0.1'] },
        evidence_level: EVIDENCE_LEVELS,
        offline: ['yes', 'no', 'unknown'],
        derivative: ['yes', 'no'],
        sort: SEARCH_SORTS,
        counts,
        /** What this deployment actually implements, by phase. */
        phase_support: {
          phase: features.communityNetwork ? 'P2' : 'P1',
          project_publication: true,
          source_import: features.githubImport,
          compatibility_assessment: features.evidenceClassification
            ? 'requirements_and_accepted_evidence'
            : 'requirements_only',
          test_definitions: features.testDefinitions,
          test_results: features.resultSubmission,
          evidence_levels_reachable: features.evidenceClassification
            ? ['claimed', 'documented', 'community_reported', 'reproducible_test', ...(independentVerificationEnabled(features) ? ['independently_verified'] : [])]
            : ['claimed', 'documented'],
          // The runner contract is served; the first-party runner is not yet published.
          local_runner_available: features.testDefinitions,
          local_runner_distribution: 'unpublished',
          comparisons: features.communityNetwork,
          derivatives: features.communityNetwork,
          collections: features.communityNetwork,
          troubleshooting: features.communityNetwork,
          independent_verification: independentVerificationEnabled(features),
          custom_harnesses: false, multi_agent_execution: features.agentEnvironments && features.testDefinitions, richer_modalities: false,
          environment_handoffs: features.agentEnvironments && features.testDefinitions,
          framework_profiles: features.agentEnvironments && features.testDefinitions && features.frameworkEnvironments ? ['langgraph-docker/v0.1'] : [],
          workflow_result_submission: features.workflowResults && features.resultSubmission,
        },
      },
      c.get('requestId'),
    ),
  );
});

catalogRoutes.get('/models', async (c) => {
  await limitPublicRead(c);
  const rows = await db()
    .select({
      model_reference_id: modelReferences.id,
      key: modelReferences.key,
      display_name: modelReferences.displayName,
      family: modelReferences.family,
      source_url: modelReferences.sourceUrl,
      license_state: modelReferences.licenseState,
      license_id: modelReferences.licenseId,
      identity_scheme: modelReferences.identityScheme,
      project_count: sql<number>`count(distinct ${projects.id})`,
    })
    .from(modelReferences)
    .innerJoin(projectVersionModelRoles, eq(projectVersionModelRoles.modelReferenceId, modelReferences.id))
    .innerJoin(projectVersions, eq(projectVersions.id, projectVersionModelRoles.projectVersionId))
    .innerJoin(projects, visibleCurrentProject)
    .groupBy(modelReferences.id)
    .orderBy(desc(sql`count(distinct ${projects.id})`), modelReferences.key)
    .limit(100);
  return c.json(
    success(
      {
        items: rows.map((row) => ({ ...row, project_count: Number(row.project_count) })),
        has_more: false,
        next_cursor: null,
      },
      c.get('requestId'),
      {
        note: 'Model references are external pointers derived from project declarations. No weights are hosted and no identity is resolved for you.',
      },
    ),
  );
});

catalogRoutes.get('/runtimes', async (c) => {
  await limitPublicRead(c);
  const rows = await db()
    .select({
      runtime_reference_id: runtimeReferences.id,
      family: runtimeReferences.family,
      display_name: runtimeReferences.displayName,
      api_profile: runtimeReferences.apiProfile,
      support_status: runtimeReferences.supportStatus,
      docs_url: runtimeReferences.docsUrl,
      project_count: sql<number>`count(distinct ${projects.id})`,
    })
    .from(runtimeReferences)
    .leftJoin(projectVersionRuntimes, eq(projectVersionRuntimes.runtimeReferenceId, runtimeReferences.id))
    .leftJoin(projectVersions, eq(projectVersions.id, projectVersionRuntimes.projectVersionId))
    // Runtime families are a fixed public vocabulary, so every family stays
    // listed; only visible current projects count toward it.
    .leftJoin(projects, visibleCurrentProject)
    .groupBy(runtimeReferences.id)
    .orderBy(desc(sql`count(distinct ${projects.id})`), runtimeReferences.family)
    .limit(100);
  return c.json(
    success(
      {
        items: rows.map((row) => ({
          ...row,
          project_count: Number(row.project_count),
          /** No adapter has shipped: support is a declaration, not coverage. */
          adapter_available: false,
        })),
        has_more: false,
        next_cursor: null,
      },
      c.get('requestId'),
    ),
  );
});

catalogRoutes.get('/hardware', async (c) => {
  await limitPublicRead(c);
  const rows = await db()
    .select({
      hardware_descriptor_id: hardwareDescriptors.id,
      key: hardwareDescriptors.key,
      display_name: hardwareDescriptors.displayName,
      platform: hardwareDescriptors.platform,
      cpu_architecture: hardwareDescriptors.cpuArchitecture,
      accelerator: hardwareDescriptors.accelerator,
      memory_bytes: hardwareDescriptors.memoryBytes,
      vram_bytes: hardwareDescriptors.vramBytes,
      unified_memory: hardwareDescriptors.unifiedMemory,
      docs_url: hardwareDescriptors.docsUrl,
      project_count: sql<number>`count(distinct ${projects.id})`,
    })
    .from(hardwareDescriptors)
    .innerJoin(projectVersionHardware, eq(projectVersionHardware.hardwareDescriptorId, hardwareDescriptors.id))
    .innerJoin(projectVersions, eq(projectVersions.id, projectVersionHardware.projectVersionId))
    .innerJoin(projects, visibleCurrentProject)
    .groupBy(hardwareDescriptors.id)
    .orderBy(desc(sql`count(distinct ${projects.id})`), hardwareDescriptors.key)
    .limit(100);
  return c.json(
    success(
      {
        items: rows.map((row) => ({ ...row, project_count: Number(row.project_count) })),
        has_more: false,
        next_cursor: null,
      },
      c.get('requestId'),
      {
        note: 'Coarse public hardware descriptors only. Declared figures are creator claims, not observed measurements.',
      },
    ),
  );
});
