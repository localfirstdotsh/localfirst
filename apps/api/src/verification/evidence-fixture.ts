import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { signJWT } from 'better-auth/plugins';
import type { AnyBuildInput, AnyTestResult } from '@localfirst/contracts';
import { auth } from '../auth/instance.js';
import { P0_SCOPES, P1_SCOPES } from '../auth/scopes.js';
import { config } from '../config.js';
import { db, getPool } from '../db/client.js';
import { userTable } from '../db/schema/auth.js';
import { runReports, testDefinitions } from '../db/schema/evidence.js';
import { operatorRoles, userProfiles } from '../db/schema/registry.js';
import type { Actor } from '../http/context.js';
import { createWorkerCycle } from '../jobs/worker.js';
import { createRecordDraft, publishRecordDraft } from '../services/contributions.js';
import { createApproval, loadOwnedDraft } from '../services/drafts.js';
import { reaggregateProject } from '../services/evidence.js';
import { reviewReport } from '../services/reports.js';
import { ensureTestDefinitions } from '../services/test-definitions.js';

const sha = (char: string) => `sha256:${char.repeat(64)}`;
const sessionScopes = () => new Set<string>([...P0_SCOPES, ...P1_SCOPES]);

export interface Account { userId: string; actor: Actor }

async function insertUsers(ids: string[], operator = false) {
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const now = new Date();
    await db().insert(userTable).values(chunk.map((id) => ({ id, name: id, email: `${id}@verification.invalid`, emailVerified: false, createdAt: now, updatedAt: now })));
    await db().insert(userProfiles).values(chunk.map((id) => ({ userId: id, handle: id, displayName: id })));
  }
  if (operator) await db().insert(operatorRoles).values(ids.map((userId) => ({ userId, role: 'admin', grantedReason: 'verification' })));
}

export async function createAccount(operator = false): Promise<Account> {
  const userId = `verify-${randomUUID()}`;
  await insertUsers([userId], operator);
  return { userId, actor: { kind: 'session', userId, sessionId: `session-${randomUUID()}`, operatorRoles: operator ? ['admin'] : [], scopes: sessionScopes() } };
}

/** An audience-bound access token (REST by default), the same shape the real issuer signs. */
export async function mintToken(userId: string, scope: string, audience = config().restResource) {
  const cfg = config();
  const context = await (auth() as unknown as { $context: Promise<unknown> }).$context;
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ context } as never, { payload: {
    iss: cfg.authIssuer, sub: userId, aud: audience, iat: now, exp: now + 3600,
    jti: randomUUID(), client_id: 'load-verification', scope,
  } });
}

function buildFor(version: { projectId: string; versionId: string; contentDigest: string }, inference: unknown): AnyBuildInput {
  return {
    schema: 'localfirst/build/v0.1', project_id: version.projectId, project_version_id: version.versionId,
    configuration_key: 'local-chat',
    source: { kind: 'documentation', url: 'https://example.org/request-labeler', revision: null, project_manifest_digest: version.contentDigest },
    model_bindings: [{
      role: 'classifier', runtime_model_id: 'qwen2.5:1.5b', model_version_id: null,
      artifact_identity: { scheme: 'ollama_manifest_sha256', digest: sha('6'), reference: null },
      source_url: 'https://ollama.com/library/qwen2.5', quantization: 'Q4_K_M', license_state: 'known',
      execution_location: 'local', locality_method: 'adapter_preflight',
    }],
    runtime: { family: 'ollama', application_version: '0.35.1', cli_version: null, engine_version: 'llama.cpp-b1', adapter_profile: 'ollama-native/v0.1', backend: 'metal' },
    hardware: { platform: 'apple-silicon', os: { name: 'macos', version: '26.0' }, cpu_architecture: 'arm64', cpu_model: 'Example chip', memory_bytes: 17179869184, unified_memory: true, accelerators: [{ vendor: 'apple', backend: 'metal', memory_bytes: null }] },
    effective_settings: { ...(inference as AnyBuildInput['effective_settings']) },
    changes: [], parent_build_id: null, manual_report: null,
  };
}

/** A compatibility request that names the exact build the fixture saves. */
export const exactEnvironment = () => ({
  requirements: { inference: 'local_required', offline: false, accelerator: null },
  hardware: { cpu_architecture: 'arm64', platform: 'apple-silicon', os: 'macos', os_version: '26.0', memory_bytes: 17179869184, vram_bytes: null, unified_memory: true, accelerator: 'metal' },
  runtime: { family: 'ollama', version: '0.35.1', backend: 'metal', api_profile: null },
  selected_models: [{
    role: 'classifier', capabilities: ['chat', 'json_output'], unsupported_capabilities: [], context_tokens: 4096,
    execution_location: 'local', identity_known: true,
    artifact_identity: { scheme: 'ollama_manifest_sha256', digest: sha('6'), reference: null },
  }],
});

let runCounter = 0;
function resultFor(ids: { projectId: string; versionId: string; buildId: string }, definition: typeof testDefinitions.$inferSelect): AnyTestResult {
  return {
    schema: 'localfirst/test-result/v0.1', client_run_id: `load_${Date.now().toString(36)}_${(runCounter += 1)}`,
    project_id: ids.projectId, project_version_id: ids.versionId, build_id: ids.buildId,
    test_key: definition.key, test_definition_id: definition.id,
    test_manifest_digest: definition.manifestDigest, fixture_digest: definition.fixtureDigest, fixture_kind: 'public_inline',
    evaluator: { kind: 'json_assert_v1', version: '1' }, scope: 'component',
    runner: { version: '0.1.0', contract: 'localfirst/runner/v0.1' }, outcome: 'pass',
    counts: { defined: 1, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 },
    case_results: [{ key: 'billing-001', outcome: 'pass', repetition: 1 }],
    measurements: {
      latency_ms: { value: 1200, method: 'client_monotonic_end_to_end_v1', samples: 1 },
      time_to_first_token_ms: { value: null, reason: 'nonstreaming_run' },
      tokens_per_second: { value: null, reason: 'generation_interval_not_exported' },
      peak_memory_bytes: { value: null, reason: 'runtime_sensor_unavailable' },
      hardware_utilization: { value: null, reason: 'sensor_unavailable' },
    },
    measurement_context: { load_state: 'unknown', cache_state: 'unknown', repetitions: 1, warmup_runs: 0 },
    checks: { locality: 'pass', offline: 'not_run' },
    completed_at: '2026-10-11T20:00:00Z', redaction_version: 'localfirst/export/v0.1', diagnostic_codes: [], visibility_requested: 'private',
  } as AnyTestResult;
}

export async function drainWorker(maxMs = 120_000) {
  const cycle = createWorkerCycle('verify-drain');
  const start = Date.now();
  let ran = 0;
  while (Date.now() - start < maxMs) {
    const handled = await cycle();
    ran += handled;
    if (handled === 0 && (await cycle()) === 0) break;
  }
  return { handled: ran, ms: Date.now() - start };
}

async function publishRecord(account: Account, kind: 'build' | 'test_result', recordId: string, selection: Record<string, unknown>) {
  const { draftRow } = await createRecordDraft({ actor: account.actor, kind, recordId, selection });
  const loaded = await loadOwnedDraft(account.actor, draftRow.id);
  const approval = await createApproval({
    actor: account.actor, draftId: loaded.id, draftRevision: loaded.revision, payloadDigest: loaded.payloadDigest,
    acknowledgedWarningCodes: loaded.warningCodes, decision: 'approved', sessionId: 'verification-session',
  });
  await publishRecordDraft({ actor: account.actor, draftId: loaded.id, approvalId: approval.approvalId as string, draftRevision: loaded.revision, payloadDigest: loaded.payloadDigest });
}

export interface EvidenceTarget { projectId: string; versionId: string; definitionId: string }
export interface CloneTarget { project: string; version: string; definition: string }
export interface Submission { token: string; key: string; body: unknown }

/**
 * Evidence for the P1 load run. One contributor's run goes through the real
 * path (REST build and result, validation job, exact-artifact publication,
 * operator acceptance). That accepted record is then copied, with fresh
 * contributors and remapped identities, onto many projects, and the real
 * aggregator rebuilds each project's summaries.
 */
export async function seedEvidenceFixture(options: { baseUrl: string; projects: number; reportsPerProject: number; submissions: number }) {
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, run: () => Promise<T>) => { const start = performance.now(); const value = await run(); timings[name] = Math.round(performance.now() - start); return value; };

  // Targets: projects whose current version bundles a test manifest.
  const candidates = await getPool().query<{ project_id: string; version_id: string; content_digest: string }>(
    `select p.id as project_id, v.id as version_id, v.content_digest from projects p
       join project_versions v on v.id = p.current_version_id
      where exists (select 1 from project_version_tests t where t.project_version_id = v.id) order by p.slug limit $1`, [options.projects + 1]);
  if (candidates.rows.length < options.projects + 1) throw new Error(`Only ${candidates.rows.length} projects bundle a test; need ${options.projects + 1}`);
  const [templateRow, ...targetRows] = candidates.rows as [typeof candidates.rows[number], ...typeof candidates.rows];
  await timed('ensure_definitions_ms', () => ensureTestDefinitions(candidates.rows.map((r) => r.version_id)));
  const definitions = await db().select().from(testDefinitions).where(inArray(testDefinitions.projectVersionId, candidates.rows.map((r) => r.version_id)));
  const definitionOf = new Map(definitions.map((d) => [d.projectVersionId, d]));
  const templateDefinition = definitionOf.get(templateRow.version_id)!;
  if (!templateDefinition.executable) throw new Error('Template definition is not executable');
  const ids = { projectId: templateRow.project_id, versionId: templateRow.version_id };
  const build = buildFor({ ...ids, contentDigest: templateRow.content_digest }, templateDefinition.manifest && (templateDefinition.manifest as { inference: unknown }).inference);

  // Real flow, once.
  const operator = await createAccount(true);
  const contributor = await createAccount();
  const token = await mintToken(contributor.userId, 'builds:write tests:submit');
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${options.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) });
    const json = await response.json() as { data?: Record<string, string> };
    if (response.status >= 300) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
    return json.data!;
  };
  const templateBuildId = (await post('/api/v1/builds', build))['build_id']!;
  const templateReportId = (await post('/api/v1/test-results', { result: resultFor({ ...ids, buildId: templateBuildId }, templateDefinition), build_id: templateBuildId }))['report_id']!;
  await drainWorker();
  await publishRecord(contributor, 'build', templateBuildId, { hardware: 'coarse' });
  await publishRecord(contributor, 'test_result', templateReportId, {});
  await reviewReport({ actor: operator.actor, reportId: templateReportId, decision: 'accepted', reasonCode: 'accepted_as_reported', note: null });
  await drainWorker();
  const [templateReport] = await db().select().from(runReports).where(eq(runReports.id, templateReportId));
  if (templateReport?.reviewState !== 'accepted' || templateReport.visibility !== 'public') throw new Error('Template report was not accepted and public');

  // Copies. jsonb columns have the template identities replaced as text.
  const columns = async (table: string) => (await getPool().query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table])).rows.map((c) => c.column_name);
  const [buildColumns, reportColumns, reviewColumns] = await Promise.all([columns('build_configurations'), columns('run_reports'), columns('evidence_reviews')]);
  const remap = (column: string) => `replace(replace(replace(replace(r."${column}"::text, '${ids.projectId}', m.project), '${ids.versionId}', m.version), '${templateBuildId}', m.build), '${templateDefinition.id}', m.definition)::jsonb`;
  const jsonColumns = new Set(['payload', 'public_projection']);

  /**
   * Copy the template build and report onto targets, one fresh contributor
   * each. `accepted` copies the operator review too; `pending` leaves the
   * public, server-validated report awaiting review.
   */
  const clone = async (rows: CloneTarget[], state: 'accepted' | 'pending') => {
    const copies = rows.map((row) => ({ ...row, build: randomUUID(), report: randomUUID(), user: `verify-${randomUUID()}` }));
    for (let offset = 0; offset < copies.length; offset += 400) {
      const chunk = copies.slice(offset, offset + 400);
      await insertUsers(chunk.map((c) => c.user));
      const mapping = JSON.stringify(chunk);
      const client = await getPool().connect();
      try {
        await client.query('begin');
        const buildSelect = buildColumns.map((c) => {
          if (c === 'id') return 'm.build::uuid';
          if (c === 'owner_user_id') return 'm.user';
          if (c === 'project_id') return 'm.project::uuid';
          if (c === 'project_version_id') return 'm.version::uuid';
          if (jsonColumns.has(c)) return remap(c);
          return `r."${c}"`;
        });
        await client.query(`insert into build_configurations (${buildColumns.map((c) => `"${c}"`).join(', ')}) select ${buildSelect.join(', ')} from build_configurations r cross join jsonb_to_recordset($1::jsonb) as m(project text, version text, build text, report text, "user" text, definition text) where r.id = '${templateBuildId}'`, [mapping]);
        const reportSelect = reportColumns.map((c) => {
          if (c === 'id') return 'm.report::uuid';
          if (c === 'submitter_user_id') return 'm.user';
          if (c === 'project_id') return 'm.project::uuid';
          if (c === 'project_version_id') return 'm.version::uuid';
          if (c === 'build_id') return 'm.build::uuid';
          if (c === 'test_definition_id') return 'm.definition::uuid';
          if (c === 'operation_id') return 'null';
          if (state === 'pending' && c === 'review_state') return "'pending'";
          if (state === 'pending' && c === 'evidence_level') return 'null';
          if (jsonColumns.has(c)) return remap(c);
          return `r."${c}"`;
        });
        await client.query(`insert into run_reports (${reportColumns.map((c) => `"${c}"`).join(', ')}) select ${reportSelect.join(', ')} from run_reports r cross join jsonb_to_recordset($1::jsonb) as m(project text, version text, build text, report text, "user" text, definition text) where r.id = '${templateReportId}'`, [mapping]);
        const reviewSelect = reviewColumns.map((c) => c === 'id' ? 'gen_random_uuid()' : c === 'run_report_id' ? 'm.report::uuid' : `r."${c}"`);
        if (state === 'accepted') await client.query(`insert into evidence_reviews (${reviewColumns.map((c) => `"${c}"`).join(', ')}) select ${reviewSelect.join(', ')} from evidence_reviews r cross join jsonb_to_recordset($1::jsonb) as m(project text, version text, build text, report text, "user" text, definition text) where r.run_report_id = '${templateReportId}'`, [mapping]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    return copies.map((c) => c.report);
  };
  const accepted = targetRows.flatMap((target) => Array.from({ length: options.reportsPerProject }, () => ({ project: target.project_id, version: target.version_id, definition: definitionOf.get(target.version_id)!.id })));
  await timed('clone_evidence_ms', () => clone(accepted, 'accepted'));

  // The real aggregator, once per project.
  const aggregation: number[] = [];
  await timed('aggregate_ms', async () => {
    for (const target of targetRows) {
      const start = performance.now();
      await reaggregateProject(target.project_id);
      aggregation.push(performance.now() - start);
    }
  });
  await getPool().query('analyze');
  aggregation.sort((a, b) => a - b);

  // Pre-built submitters for the submission routes: each owns a saved build
  // and holds a fresh, valid result for it, so the measured request is only
  // the result submission itself.
  const submitters: Submission[] = [];
  await timed('prepare_submitters_ms', async () => {
    const rows = Array.from({ length: options.submissions }, (_, i) => {
      const target = targetRows[i % targetRows.length]!;
      return { project: target.project_id, version: target.version_id, build: randomUUID(), user: `verify-${randomUUID()}`, definition: definitionOf.get(target.version_id)!.id, report: randomUUID() };
    });
    await insertUsers(rows.map((r) => r.user));
    const mapping = JSON.stringify(rows);
    const buildSelect = buildColumns.map((c) => c === 'id' ? 'm.build::uuid' : c === 'owner_user_id' ? 'm.user' : c === 'project_id' ? 'm.project::uuid' : c === 'project_version_id' ? 'm.version::uuid'
      : c === 'visibility' ? "'private'" : ['public_projection', 'public_projection_digest', 'published_at'].includes(c) ? 'null' : jsonColumns.has(c) ? remap(c) : `r."${c}"`);
    await getPool().query(`insert into build_configurations (${buildColumns.map((c) => `"${c}"`).join(', ')}) select ${buildSelect.join(', ')} from build_configurations r cross join jsonb_to_recordset($1::jsonb) as m(project text, version text, build text, report text, "user" text, definition text) where r.id = '${templateBuildId}'`, [mapping]);
    for (const row of rows) {
      const definition = definitions.find((d) => d.id === row.definition)!;
      submitters.push({
        token: await mintToken(row.user, 'tests:submit'), key: `load-${randomUUID()}`,
        body: { result: resultFor({ projectId: row.project, versionId: row.version, buildId: row.build }, definition), build_id: row.build },
      });
    }
  });

  const probes = targetRows.map((t) => ({ projectId: t.project_id, versionId: t.version_id, definitionId: definitionOf.get(t.version_id)!.id }));
  const probe = (await getPool().query<{ n: number }>("select count(*)::int as n from compatibility_summaries")).rows[0]!.n;
  return {
    targets: probes satisfies EvidenceTarget[], submitters, timings, clone, operator,
    shape: {
      evidence_projects: targetRows.length, accepted_reports: accepted.length + 1, reports_per_project: options.reportsPerProject,
      compatibility_summaries: probe, template: 'one report through the real REST, validation, publication and operator path; others are identity-remapped copies',
      aggregate_project_p95_ms: Number(aggregation[Math.ceil(aggregation.length * 0.95) - 1]?.toFixed(1)), aggregate_project_max_ms: Number(aggregation.at(-1)?.toFixed(1)),
    },
  };
}
