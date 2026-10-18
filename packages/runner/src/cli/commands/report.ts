import { readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { digestOf, anyTestResultSubmissionSchema, workflowLocalReportSchema, type AnyTestResultSubmission } from '@localfirst/contracts';
import { exportWorkflowUpload, compareWorkflowReports } from '../../reports/workflow.js';
import { workflowTrail, renderWorkflowTrailHtml } from '../../reports/workflow-trail.js';
import { ConsentSession } from '../../consent/state-machine.js';
import { VARIABLE_DIMENSIONS, type VariableDimension } from '../../reports/compare.js';
import { ExportRefusedError } from '../../reports/export.js';
import { exportUpload, type BuildSource } from '../../reports/upload.js';
import { LocalBundleSource, validateBundle } from '../bundle.js';
import type { LocalReport } from '@localfirst/contracts';
import type { CliEnv } from '../context.js';
import { CliError, EXIT, refusal, usageError } from '../errors.js';
import { requireTty } from '../io.js';
import { KeychainError, registryAccount } from '../keychain.js';
import { ensurePrivateDir } from '../paths.js';
import { RegistryClient, RegistryError } from '../registry.js';
import { hexOf, loadReport, parse, registryOrigin, str } from './common.js';

export const EXPORT_FILE_SCHEMA = 'localfirst/export-file/v0.2' as const;

export interface ExportFile {
  schema: typeof EXPORT_FILE_SCHEMA;
  /** The exact upload: the sanitized result and its inline build, under one digest. */
  payload: AnyTestResultSubmission;
  payload_digest: string;
  reviewed_at: string;
}

async function rawReport(path: string): Promise<unknown> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new CliError(`Could not read a local report at ${path}.`, EXIT.failed);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw refusal('Invalid or oversized local report.');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new CliError(`The file at ${path} is not valid JSON, so it is not a local report.`, EXIT.failed);
  }
}
function isWorkflow(raw: unknown): boolean { return raw !== null && typeof raw === 'object' && (raw as { schema?: unknown }).schema === 'localfirst/local-report/v0.2'; }

/** A local inspection artifact, deliberately separate from the sanitized upload. */
export async function reportTrace(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { workspace: { type: 'string' }, out: { type: 'string' }, format: { type: 'string' }, 'include-private': { type: 'boolean' } }, { min: 1, max: 1 });
  const workspace = str(values.workspace), destination = str(values.out), format = str(values.format) ?? 'html';
  if (!workspace || !destination || !['html', 'json'].includes(format)) throw usageError('Use --workspace <bundle-dir> --out <new-file> and --format html|json.');
  const report = workflowLocalReportSchema.parse(await rawReport(resolve(env.cwd, positionals[0]!)));
  const bundle = await new LocalBundleSource(resolve(env.cwd, workspace)).load();
  const includePrivate = values['include-private'] === true;
  if (includePrivate && report.plan.data_class === 'private_local') {
    requireTty(env.io, 'Including private workflow contents in a local trail');
    env.io.out('This local file will contain customer messages, business data and model outputs from report ' + report.client_run_id + '. Nothing is uploaded.\n');
    if (!await env.io.ask('Include private contents in ' + resolve(env.cwd, destination) + '? Type "yes": ')) throw refusal('Private trail declined.');
  }
  const trail = workflowTrail(report, bundle, { includePrivate });
  const path = resolve(env.cwd, destination);
  await ensurePrivateDir(dirname(path));
  await writeFile(path, format === 'html' ? renderWorkflowTrailHtml(trail) : JSON.stringify(trail, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  env.io.out('Local workflow trail: ' + path + '\nIncludes recorded execution and reconstructs prompts from the matching bundle; external MCP/setup events are available only when captured by the verifier. Nothing uploaded.\n');
  return EXIT.ok;
}

/** `report show <report> [--outputs]`: a summary of a local report. Model outputs only with --outputs. */
export async function reportShow(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { outputs: { type: 'boolean' } }, { min: 1, max: 1 });
  const raw = await rawReport(resolve(env.cwd, positionals[0] as string));
  if (isWorkflow(raw)) {
    const workflow = workflowLocalReportSchema.parse(raw);
    env.io.out('Workflow report ' + workflow.client_run_id + ' (' + workflow.run.state + ', ' + workflow.plan.data_class + ')\n');
    for (const c of workflow.run.cases) {
      env.io.out(c.key + ': ' + c.outcome + (c.error_code ? ' (' + c.error_code + ')' : '') + '\n');
      for (const step of c.steps) env.io.out('  ' + step.id + ': ' + step.outcome + '\n');
      if (values.outputs === true) env.io.out(JSON.stringify(c.output) + '\n');
    }
    return EXIT.ok;
  }
  const report = await loadReport(resolve(env.cwd, positionals[0] as string));
  const { counts } = report;
  const lines = [
    `Report ${report.client_run_id}  (${report.execution_state}, data class ${report.data_class})`,
    `Test: ${report.test_key} (${report.scope}), evaluator ${report.evaluator.kind}`,
    `Outcome: ${report.outcome}`,
    `Cases: ${counts.defined} defined, ${counts.evaluated} evaluated, ${counts.passed} passed, ${counts.failed} failed, ${counts.errors} errors, ${counts.skipped} skipped`,
    `Plan digest: ${report.plan_digest}`,
    `Checks: locality ${report.checks.locality}, offline ${report.checks.offline}`,
    'Measurements:',
    ...Object.entries(report.measurements).map(([name, metric]) =>
      metric.value === null ? `  ${name}: unavailable (${metric.reason})` : `  ${name}: ${metric.value} (${metric.method}, ${metric.samples} sample(s))`,
    ),
  ];
  if (report.diagnostic_codes.length > 0) lines.push(`Diagnostics: ${report.diagnostic_codes.join(', ')}`);
  lines.push('Cases:');
  for (const detail of report.case_details) {
    lines.push(`  ${detail.key} #${detail.repetition}: ${detail.outcome}${detail.error_code ? ` (${detail.error_code})` : ''}`);
    if (values.outputs === true && detail.output_text !== null) lines.push(`    output: ${JSON.stringify(detail.output_text)}`);
  }
  env.io.out(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

/** `report compare <a> <b> [--varies model,hardware]`: eligibility and reasons, never a score. */
export async function reportCompare(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { varies: { type: 'string' } }, { min: 2, max: 2 });
  const raw = await Promise.all(positionals.map(path => rawReport(resolve(env.cwd, path))));
  if (raw.some(isWorkflow)) {
    if (!raw.every(isWorkflow)) throw refusal('Component and workflow reports are different protocols.');
    if (values.varies && values.varies !== 'model' && values.varies !== 'runtime') throw refusal('Workflow comparison supports model/runtime fixture outcomes only.');
    const comparison = compareWorkflowReports(workflowLocalReportSchema.parse(raw[0]), workflowLocalReportSchema.parse(raw[1]));
    env.io.out(JSON.stringify(comparison, null, 2) + '\n');
    return comparison.eligible ? EXIT.ok : EXIT.failed;
  }
  const [a, b] = await Promise.all(positionals.map((path) => loadReport(resolve(env.cwd, path))));
  const requested = (str(values.varies) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = requested.filter((item) => !(VARIABLE_DIMENSIONS as readonly string[]).includes(item));
  if (unknown.length > 0) {
    throw usageError(`--varies accepts ${VARIABLE_DIMENSIONS.join(', ')}; got ${unknown.join(', ')}`);
  }
  const varies = requested as VariableDimension[];
  let result;
  try {
    result = env.compare(a!, b!, { intentionallyVaries: varies });
  } catch (cause) {
    throw new CliError(`Comparison is unavailable: ${(cause as Error).message}`, EXIT.failed);
  }
  const lines = [`Eligible for comparison: ${result.eligible ? 'yes' : 'no'}`];
  if (varies.length > 0) lines.push(`Intended to vary: ${result.varies.join(', ') || varies.join(', ')}`);
  if (result.reasons.length > 0) {
    lines.push('Reasons it is not eligible:');
    for (const reason of result.reasons) lines.push(`  [${reason.dimension}] ${reason.code}: ${reason.detail}`);
  }
  if (result.confounders.length > 0) {
    lines.push('Confounders (differences not declared as the variable):');
    for (const reason of result.confounders) lines.push(`  [${reason.dimension}] ${reason.code}: ${reason.detail}`);
  }
  lines.push('Dimensions:');
  for (const dimension of result.dimensions) lines.push(`  ${dimension.dimension}: ${dimension.status}`);
  lines.push('No combined score is produced.');
  env.io.out(`${lines.join('\n')}\n`);
  return result.eligible ? EXIT.ok : EXIT.failed;
}

/** A model source the user declares: public https only, no credentials, nothing but an address. */
function parseModelSourceUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError('--model-source-url must be a valid https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.length > 500) {
    throw usageError('--model-source-url must be a public https URL without credentials, query, or fragment (max 500 characters).');
  }
  return url.toString();
}

const SOURCE_FALLBACK: Omit<BuildSource, 'project_manifest_digest'> = { kind: 'authored_specification', url: null, revision: null };

/**
 * The project source the build names: the first source of the project
 * specification in the bundle the run used, when that bundle is still on disk
 * and still has the planned digest. Otherwise the registry's own specification.
 */
async function resolveBuildSource(env: CliEnv, report: LocalReport): Promise<Omit<BuildSource, 'project_manifest_digest'>> {
  try {
    const planFile = JSON.parse(await readFile(join(env.home.plansDir, `${hexOf(report.plan_digest)}.plan.json`), 'utf8')) as { bundle_dir?: unknown };
    if (typeof planFile.bundle_dir !== 'string') return SOURCE_FALLBACK;
    const validated = validateBundle(await new LocalBundleSource(planFile.bundle_dir).load());
    if (validated.content_digest !== report.plan.test.bundle_digest) return SOURCE_FALLBACK;
    const source = validated.spec?.sources[0];
    return source ? { kind: source.kind, url: source.url ?? null, revision: source.revision ?? null } : SOURCE_FALLBACK;
  } catch {
    return SOURCE_FALLBACK;
  }
}

/**
 * `report export <report> --review [--test-definition-id Y] [--model-source-url U]`.
 * Assembles the exact upload (sanitized result plus the inline build derived
 * from the approved plan), shows it with ONE digest, and writes the export file
 * only after an interactive yes. Hardware details are included only if you opt
 * in here; otherwise none are shared.
 */
export async function reportExport(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { review: { type: 'boolean' }, 'test-definition-id': { type: 'string' }, 'model-source-url': { type: 'string' }, out: { type: 'string' } },
    { min: 1, max: 1 },
  );
  if (values.review !== true) throw usageError('Exporting requires --review: you must see the exact payload before it is written.');
  const raw = await rawReport(resolve(env.cwd, positionals[0] as string));
  if (isWorkflow(raw)) {
    const report = workflowLocalReportSchema.parse(raw);
    requireTty(env.io, 'Reviewing a workflow export');
    const shareHardware = await env.io.ask('Include coarse hardware? Type "yes", otherwise share none: ');
    const exported = exportWorkflowUpload(report, {
      ...(str(values['test-definition-id']) ? { definitionId: str(values['test-definition-id']) } : {}),
      modelSourceUrl: parseModelSourceUrl(str(values['model-source-url'])), hardware: shareHardware ? env.hardware() : null,
    });
    env.io.out(JSON.stringify(exported.payload, null, 2) + '\nRaw customer text, state, prompts, tool outputs and private paths are omitted. Nothing is uploaded.\n');
    if (!await env.io.ask('Write exactly this export (' + exported.payload_digest + ')? Type "yes": ')) throw refusal('Export declined.');
    await ensurePrivateDir(env.home.exportsDir);
    const path = resolve(env.cwd, str(values.out) ?? join(env.home.exportsDir, hexOf(exported.payload_digest).slice(0, 16) + '.export.json'));
    await writeFile(path, JSON.stringify({ schema: EXPORT_FILE_SCHEMA, payload: exported.payload, payload_digest: exported.payload_digest, reviewed_at: env.now().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    env.io.out('Export written to ' + path + '\nNothing uploaded.\n');
    return EXIT.ok;
  }

  const report = await loadReport(resolve(env.cwd, positionals[0] as string));
  const modelSourceUrl = parseModelSourceUrl(str(values['model-source-url']));
  requireTty(env.io, 'Reviewing an export');

  const share = await env.io.ask(
    'Include a coarse hardware summary in the build (OS name and release, CPU architecture, memory rounded to whole GiB; no hostname, paths, or device list)?\n' +
      'Without it the build cannot be matched to a platform. Type "yes" to include it, anything else to share none: ',
  );
  let hardware = share ? env.hardware() : null;
  if (share && hardware === null) env.io.out('The hardware could not be summarized safely; none will be shared.\n');
  if (!share) hardware = null;

  let exported;
  try {
    exported = exportUpload(report, {
      testDefinitionId: str(values['test-definition-id']),
      modelSourceUrl,
      hardware,
      source: await resolveBuildSource(env, report),
    });
  } catch (cause) {
    if (cause instanceof ExportRefusedError) {
      throw refusal(
        `This report cannot be exported (${cause.reason}).${cause.reason === 'private_data_class' ? '' : ' Pass the registry --test-definition-id, or plan from the registry so it is recorded.'}`,
      );
    }
    throw cause;
  }

  env.io.out(`${JSON.stringify(exported.payload, null, 2)}\n\nPayload digest: ${exported.payload_digest}\n`);
  const session = ConsentSession.resume('local_report_saved', {
    project_manifest_digest: report.plan_digest,
    report_digest: digestOf(report),
  }, env.now);
  const approved = await env.io.ask(`Write exactly this payload (${exported.payload_digest}) as an export file? Type "yes" to approve: `);
  if (!approved) throw refusal('The export was not approved. Nothing was written.');
  session.advance('export_reviewed', { payload_digest: exported.payload_digest });

  await ensurePrivateDir(env.home.exportsDir);
  const path = resolve(env.cwd, str(values.out) ?? join(env.home.exportsDir, `${hexOf(exported.payload_digest).slice(0, 16)}.export.json`));
  const file: ExportFile = {
    schema: EXPORT_FILE_SCHEMA,
    payload: exported.payload,
    payload_digest: exported.payload_digest,
    reviewed_at: env.now().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  env.io.out(`Export written to ${path}\nNothing was uploaded.\n`);
  return EXIT.ok;
}

async function readExportFile(path: string): Promise<ExportFile> {
  let parsed: ExportFile;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as ExportFile;
  } catch {
    throw new CliError(`Could not read an export file at ${path}.`, EXIT.failed);
  }
  const payload = anyTestResultSubmissionSchema.safeParse(parsed.payload);
  if (parsed.schema !== EXPORT_FILE_SCHEMA || !payload.success || digestOf(payload.data) !== parsed.payload_digest) {
    throw refusal('The export file is invalid or was edited after review. Export it again.');
  }
  return { ...parsed, payload: payload.data };
}

/**
 * `report submit <export-file> --registry <url>`. Needs its own upload consent
 * naming the registry and the payload digest, and a token with scopes
 * `tests:submit` and `builds:write` (the build is created in the same request)
 * from the OS keychain. The report is stored private and pending review.
 */
export async function reportSubmit(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { registry: { type: 'string' } }, { min: 1, max: 1 });
  const file = await readExportFile(resolve(env.cwd, positionals[0] as string));
  const origin = registryOrigin(env, str(values.registry));

  requireTty(env.io, 'Uploading a report');
  const session = ConsentSession.resume('export_reviewed', {
    project_manifest_digest: file.payload_digest,
    payload_digest: file.payload_digest,
  }, env.now);
  env.io.out(
    `This uploads the reviewed export file (digest ${file.payload_digest}) to ${origin} as a private submission. ` +
      'Nothing else is sent; it is not made public by uploading.\n',
  );
  const approved = await env.io.ask(`Upload to ${origin}? Type "yes" to upload: `);
  if (!approved) throw refusal('The upload was not approved. Nothing was sent.');
  session.advance('upload_authorized', { payload_digest: file.payload_digest, registry_origin: origin, channel: 'interactive_tty' });

  let token: string | null;
  try {
    token = await env.keychain.get(registryAccount(origin));
  } catch (cause) {
    if (cause instanceof KeychainError) throw new CliError(cause.message, EXIT.failed);
    throw cause;
  }
  if (!token) {
    throw new CliError(
      `No token stored for ${origin}. Run \`localfirstdotsh auth set-token --registry ${origin}\` (scopes tests:submit and builds:write).`,
      EXIT.failed,
    );
  }

  const client = new RegistryClient(origin, env.fetch, token);
  try {
    const { data, meta } = await client.submitTestResult(file.payload, `lf-${hexOf(file.payload_digest).slice(0, 32)}`);
    const id = String(data.report_id ?? 'unknown');
    session.advance('private_submission', { payload_digest: file.payload_digest, submission_id: id });
    const operation = typeof meta.operation_id === 'string' ? ` Metadata validation is queued as operation ${meta.operation_id}.` : '';
    env.io.out(
      `Submitted privately. Report: ${id} (review: ${String(data.review_state ?? 'pending')}, visibility: ${String(data.visibility ?? 'private')}).${operation}${meta.replayed === true ? ' This was a retry; the original submission was returned.' : ''}\n` +
        'It is not public and carries no evidence level until reviewed; publishing needs a separate browser approval.\n',
    );
    return EXIT.ok;
  } catch (cause) {
    if (cause instanceof RegistryError) {
      if (cause.phaseUnavailable) throw new CliError('The registry does not accept test results (PHASE_UNAVAILABLE). Nothing was stored.', EXIT.failed);
      if (cause.status === 401 || cause.status === 403) {
        throw new CliError(`The registry refused the token (${cause.code ?? cause.status}); it needs scopes tests:submit and builds:write.`, EXIT.failed);
      }
      if (cause.status === 409) throw new CliError(`The registry reports a conflict (${cause.code ?? 409}): ${cause.message}`, EXIT.failed);
      throw new CliError(`Upload failed (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    }
    throw cause;
  }
}
