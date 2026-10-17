/**
 * Immutable test definitions (BACKEND_PRD sections 5.3, 12.2, 16.1).
 *
 * A definition is derived from a test bundled in a published project version.
 * Manifest, fixture set, and evaluator specification are hashed independently,
 * and the version content digest is the bundle digest. Definitions are created
 * when a version is published and, for versions that predate this surface,
 * lazily and idempotently the first time a read needs them: no migration step
 * has to parse YAML, and a retry can never create a second definition because
 * `(project_version_id, key)` is unique.
 *
 * `runner_available` is true only for a definition the first-party runner can
 * execute (`testExecutability`); a declared harness alone is not a shipped
 * runner.
 */

import { and, eq, inArray, sql, ne } from 'drizzle-orm';
import {
  parseSafeYaml,
  RUNNER_CONTRACT_ID,
  testDigests,
  testExecutability,
  testManifestSchema,
  type TestManifest,
  workflowTestSchema, workflowDigests, type WorkflowTest,
} from '@localfirst/contracts';
import {
  projects,
  projectVersionFiles,
  projectVersions,
  projectVersionTests,
} from '../db/schema/registry.js';
import { testDefinitions } from '../db/schema/evidence.js';
import { db, type DbOrTx } from '../db/client.js';
import { config } from '../config.js';

export interface DefinitionRow {
  id: string;
  projectId: string;
  projectVersionId: string;
  key: string;
  configurationKey: string;
  scope: string;
  harness: string;
  modelRole: string | null;
  requiredCapabilities: unknown;
  manifest: TestManifest | WorkflowTest;
  manifestDigest: string;
  fixtureDigest: string;
  evaluatorDigest: string;
  bundleDigest: string;
  executable: boolean;
  refusalCodes: string[];
  createdAt: Date;
}

/**
 * Create any missing definitions for these versions. Idempotent and safe to
 * call from concurrent readers; a bundle file that does not parse as a test
 * manifest is skipped (publication already validated every declared test).
 */
export async function ensureTestDefinitions(
  versionIds: string[],
  conn: DbOrTx = db(),
): Promise<void> {
  if (versionIds.length === 0) return;
  const declared = await conn
    .select({
      versionId: projectVersionTests.projectVersionId,
      count: sql<number>`count(*)::int`,
    })
    .from(projectVersionTests)
    .where(inArray(projectVersionTests.projectVersionId, versionIds))
    .groupBy(projectVersionTests.projectVersionId);
  if (declared.length === 0) return;

  const defined = await conn
    .select({
      versionId: testDefinitions.projectVersionId,
      count: sql<number>`count(*)::int`,
    })
    .from(testDefinitions)
    .where(inArray(testDefinitions.projectVersionId, versionIds))
    .groupBy(testDefinitions.projectVersionId);
  const definedCount = new Map(defined.map((row) => [row.versionId, row.count]));
  const missing = declared
    .filter((row) => (definedCount.get(row.versionId) ?? 0) < row.count)
    .map((row) => row.versionId);
  if (missing.length === 0) return;

  const versions = await conn
    .select({
      id: projectVersions.id,
      projectId: projectVersions.projectId,
      contentDigest: projectVersions.contentDigest,
    })
    .from(projectVersions)
    .where(inArray(projectVersions.id, missing));
  const files = await conn
    .select({
      versionId: projectVersionFiles.projectVersionId,
      path: projectVersionFiles.path,
      content: projectVersionFiles.content,
    })
    .from(projectVersionFiles)
    .where(
      and(
        inArray(projectVersionFiles.projectVersionId, missing),
        eq(projectVersionFiles.kind, 'test_manifest'),
      ),
    );

  for (const version of versions) {
    for (const file of files.filter((entry) => entry.versionId === version.id)) {
      let raw: unknown;
      try {
        raw = parseSafeYaml(file.content, file.path);
      } catch {
        continue;
      }
      const workflow = workflowTestSchema.safeParse(raw);
      const parsed = workflow.success ? workflow : testManifestSchema.safeParse(raw);
      if (!parsed.success) continue;
      const manifest = parsed.data;
      const isWorkflow = manifest.harness === 'declarative_workflow_v1';
      const digests = isWorkflow ? workflowDigests(manifest) : testDigests(manifest);
      const executability = isWorkflow ? { executable: true as const } : testExecutability(raw);
      await conn
        .insert(testDefinitions)
        .values({
          projectId: version.projectId,
          projectVersionId: version.id,
          key: manifest.key,
          configurationKey: manifest.configuration_key,
          scope: manifest.scope,
          harness: manifest.harness,
          modelRole: isWorkflow ? null : manifest.model_role,
          environmentKey: isWorkflow ? manifest.environment_key : null,
          environmentDigest: isWorkflow ? manifest.environment_digest : null,
          requiredCapabilities: isWorkflow ? ['chat', 'json_output'] : manifest.required_capabilities,
          manifest,
          manifestDigest: digests.manifest_digest,
          fixtureDigest: digests.fixture_digest,
          evaluatorDigest: digests.evaluator_digest,
          bundleDigest: version.contentDigest,
          executable: executability.executable,
          refusalCodes: executability.executable ? [] : executability.reasons,
        })
        .onConflictDoNothing();
      await conn
        .update(projectVersionTests)
        .set({ runnerAvailable: executability.executable })
        .where(
          and(
            eq(projectVersionTests.projectVersionId, version.id),
            eq(projectVersionTests.key, manifest.key),
          ),
        );
    }
  }
}

function asRow(row: Record<string, unknown>): DefinitionRow {
  return {
    ...(row as unknown as DefinitionRow),
    refusalCodes: Array.isArray(row.refusalCodes) ? (row.refusalCodes as string[]) : [],
  };
}

export async function listVersionDefinitions(versionId: string): Promise<DefinitionRow[]> {
  await ensureTestDefinitions([versionId]);
  const rows = await db()
    .select()
    .from(testDefinitions)
    .where(eq(testDefinitions.projectVersionId, versionId))
    .orderBy(testDefinitions.key);
  return rows.map((row) => asRow(row as unknown as Record<string, unknown>));
}

export async function loadDefinitionById(id: string): Promise<DefinitionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db().select().from(testDefinitions).where(eq(testDefinitions.id, id)).limit(1);
  return row ? asRow(row as unknown as Record<string, unknown>) : null;
}

export async function loadDefinitionByKey(
  versionId: string,
  key: string,
): Promise<DefinitionRow | null> {
  await ensureTestDefinitions([versionId]);
  const [row] = await db()
    .select()
    .from(testDefinitions)
    .where(and(eq(testDefinitions.projectVersionId, versionId), eq(testDefinitions.key, key)))
    .limit(1);
  return row ? asRow(row as unknown as Record<string, unknown>) : null;
}

/**
 * Whether each version has at least one definition the runner can execute.
 * Backs every `runner_available` the API reports.
 */
export async function runnerAvailabilityByVersion(
  versionIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(versionIds.map((id) => [id, false]));
  if (!config().features.testDefinitions) return result;
  if (versionIds.length === 0) return result;
  await ensureTestDefinitions(versionIds);
  const rows = await db()
    .select({ versionId: testDefinitions.projectVersionId, manifest: testDefinitions.manifest })
    .from(testDefinitions)
    .where(and(inArray(testDefinitions.projectVersionId, versionIds), eq(testDefinitions.executable, true), ...(config().features.agentEnvironments ? [] : [ne(testDefinitions.harness, 'declarative_workflow_v1')])) )
    ;
  for (const row of rows) {
    const workflow = workflowTestSchema.safeParse(row.manifest);
    if (!workflow.success || workflow.data.profile === 'declarative' || config().features.frameworkEnvironments) result.set(row.versionId, true);
  }
  return result;
}

export function definitionAvailable(row: DefinitionRow): boolean {
  return config().features.testDefinitions && row.executable && (row.manifest.harness !== 'declarative_workflow_v1' || (config().features.agentEnvironments && (row.manifest.profile === 'declarative' || config().features.frameworkEnvironments)));
}

export function serializeDefinitionSummary(row: DefinitionRow): Record<string, unknown> {
  return {
    test_definition_id: row.id,
    key: row.key,
    schema: row.manifest.schema,
    harness: row.harness,
    scope: row.scope,
    configuration_key: row.configurationKey,
    model_role: row.modelRole,
    required_capabilities: row.requiredCapabilities,
    manifest_digest: row.manifestDigest,
    fixture_digest: row.fixtureDigest,
    evaluator_digest: row.evaluatorDigest,
    bundle_digest: row.bundleDigest,
    // A declared harness is not a shipped runner (section 1.2).
    runner_available: definitionAvailable(row),
    refusal_codes: !definitionAvailable(row) && row.executable ? ['workflow_profile_disabled'] : row.refusalCodes,
  };
}

/** Immutable manifest, public fixtures, digests, and safe provenance. */
export async function serializeDefinitionDetail(row: DefinitionRow): Promise<Record<string, unknown>> {
  const [source] = await db()
    .select({
      slug: projects.slug,
      versionNumber: projectVersions.versionNumber,
      specVersion: projectVersions.specVersion,
      publishedAt: projectVersions.publishedAt,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projects.id, projectVersions.projectId))
    .where(eq(projectVersions.id, row.projectVersionId))
    .limit(1);
  // The version content digest covers every bundled file, so a client can
  // recompute it (and thus verify what it will run) only with all of them.
  // Bundles hold public test and fixture text only (section 4.3).
  const bundleFiles = await db()
    .select({
      path: projectVersionFiles.path,
      kind: projectVersionFiles.kind,
      content: projectVersionFiles.content,
      contentDigest: projectVersionFiles.contentDigest,
    })
    .from(projectVersionFiles)
    .where(eq(projectVersionFiles.projectVersionId, row.projectVersionId))
    .orderBy(projectVersionFiles.path);
  const api = config().apiBaseUrl;
  return {
    ...serializeDefinitionSummary(row),
    project_id: row.projectId,
    project_version_id: row.projectVersionId,
    // The manifest carries the public fixture messages and evaluator specs.
    manifest: row.manifest,
    fixture_kind: row.manifest.fixture_kind,
    fixture_license: row.manifest.fixture_license,
    bundle_files: bundleFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
      content: file.content,
      content_digest: file.contentDigest,
    })),
    provenance: {
      project_slug: source?.slug ?? null,
      version_number: source?.versionNumber ?? null,
      spec_version: source?.specVersion ?? null,
      published_at: source?.publishedAt.toISOString() ?? null,
      bundle_digest: row.bundleDigest,
    },
    links: {
      plan: `${api}/api/v1/test-definitions/${row.id}/plan`,
      project: `${api}/api/v1/projects/${row.projectId}`,
    },
    created_at: row.createdAt.toISOString(),
  };
}

/** Inference requests a complete run issues: warmups plus every case in every repetition. */
export function plannedInferenceRequests(manifest: TestManifest): number {
  return manifest.measurement.warmup_runs + manifest.cases.length * manifest.measurement.repetitions;
}

/**
 * Generic local plan template (section 12.2). It describes requirements and
 * effects only: no machine is probed, nothing runs, and the private plan with
 * the selected endpoint and model is sealed and approved on the client.
 */
export function planTemplate(row: DefinitionRow): Record<string, unknown> {
  const { manifest } = row;
  if (manifest.harness === 'declarative_workflow_v1') return { schema: 'localfirst/plan-template/v0.2', test_definition_id: row.id, project_id: row.projectId, project_version_id: row.projectVersionId, test_key: row.key, scope: 'workflow', runner_contract: manifest.runner_contract, environment_key: manifest.environment_key, environment_digest: manifest.environment_digest, executes: false, probing: 'none', upload_default: 'disabled', runner_available: definitionAvailable(row) };
  return {
    schema: 'localfirst/plan-template/v0.1',
    test_definition_id: row.id,
    project_id: row.projectId,
    project_version_id: row.projectVersionId,
    test_key: row.key,
    scope: row.scope,
    runner_contract: RUNNER_CONTRACT_ID,
    digests: {
      manifest: row.manifestDigest,
      fixture: row.fixtureDigest,
      evaluator: row.evaluatorDigest,
      bundle: row.bundleDigest,
    },
    requirements: {
      model_role: row.modelRole,
      required_capabilities: manifest.required_capabilities,
      structured_output: manifest.response_schema !== null,
      locality: manifest.execution.locality,
      settings: manifest.inference,
      limits: manifest.limits,
      measurement: manifest.measurement,
    },
    effects: {
      inference_requests: plannedInferenceRequests(manifest),
      may_load_model: 'depends_on_local_state',
      network: 'loopback_only',
      downloads: false,
      tools: false,
      project_code: false,
      writes_local_report: true,
    },
    consent: {
      note: 'Discovery, execution, export, and upload are each approved locally and separately; a fetched manifest never grants run permission.',
      stages: [
        'local_discovery_authorized',
        'plan_reviewed',
        'execution_authorized',
        'export_reviewed',
        'upload_authorized',
      ],
    },
    sharing: manifest.sharing,
    probing: 'none',
    executes: false,
  };
}
