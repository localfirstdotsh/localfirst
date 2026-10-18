import type { AnyBuildPayload } from '@localfirst/contracts';
/**
 * Evidence domain rules for builds and run reports (BACKEND_PRD sections 6, 8,
 * 9.1, 14.2). Everything here is pure and deterministic: fingerprints,
 * reproducibility, public projections, server checks, and the evidence level a
 * reviewed report may receive.
 *
 * Evidence levels are server-derived classifications, never client assertions.
 * A manual build report caps at `community_reported`. A test run can reach
 * `reproducible_test` only after operator acceptance *and* every server check
 * passes. `independently_verified` is unreachable through this path: it needs a
 * separate independent-reproduction decision in services/verification.ts.
 */

import {
  EXPORT_REDACTION_VERSION,
  digestOf,
  testDigests,
  type AnyBuildInput,
  type BuildReport,
  type TestManifest,
  type AnyTestResult,
} from '@localfirst/contracts';
import { z } from 'zod';

/** Evidence levels a report can be assigned by this phase. */
export type AssignableEvidenceLevel = 'community_reported' | 'reproducible_test';

export const EVIDENCE_POLICY_VERSION = 'localfirst/evidence-policy/v0.1' as const;

// --------------------------------------------------------------------------
// Builds
// --------------------------------------------------------------------------

export type Reproducibility = 'incomplete' | 'partial' | 'complete';

/**
 * Every effective setting is confirmed. `seed: null` means the run was unseeded
 * (a known fact), so it does not count as an unknown setting.
 */
const settingsKnown = (build: AnyBuildInput): boolean => {
  const { seed: _seed, ...rest } = build.effective_settings;
  void _seed;
  return Object.values(rest).every((value) => value !== null && value !== 'unknown');
};

/**
 * Server-derived reproducibility record completeness (section 6.1):
 * - `incomplete`: a model binding lacks an artifact identity or upstream
 *   identity, an effective setting is unknown, or the runtime version is
 *   unknown;
 * - `partial`: every identity and setting is known, but the engine version,
 *   hardware memory, or a content digest is missing;
 * - `complete`: all of the above are known, with digest identities.
 */
export function classifyReproducibility(build: AnyBuildInput): Reproducibility {
  const bindingsIdentified = build.model_bindings.every(
    (binding) =>
      binding.artifact_identity !== null &&
      (binding.model_version_id !== null || binding.source_url !== null),
  );
  if (!bindingsIdentified || !settingsKnown(build) || build.runtime.application_version === null) {
    return 'incomplete';
  }
  const digestsKnown = build.model_bindings.every(
    (binding) => binding.artifact_identity?.digest != null,
  );
  if (
    !digestsKnown ||
    build.runtime.engine_version === null ||
    build.hardware === null ||
    build.hardware.memory_bytes === null
  ) {
    return 'partial';
  }
  return 'complete';
}

/**
 * Identity-scheme, runtime, settings, and coarse platform. Never a machine
 * serial or a file path: two machines of the same coarse class share it.
 */
export function buildFingerprint(build: AnyBuildInput): string {
  return digestOf({
    version: 'localfirst/fingerprint/v0.1',
    project_version_id: build.project_version_id,
    configuration_key: build.configuration_key,
    models: [...build.model_bindings]
      .map((binding) => ({
        role: binding.role,
        identity: binding.artifact_identity
          ? {
              scheme: binding.artifact_identity.scheme,
              digest: binding.artifact_identity.digest,
              reference: binding.artifact_identity.reference,
            }
          : // Without an identity only the local alias is known; it is not portable.
            { alias: binding.runtime_model_id },
        quantization: binding.quantization,
      }))
      .sort((a, b) => a.role.localeCompare(b.role)),
    runtime: {
      family: build.runtime.family,
      application_version: build.runtime.application_version,
      engine_version: build.runtime.engine_version,
      backend: build.runtime.backend,
      adapter_profile: build.runtime.adapter_profile,
    },
    settings: build.effective_settings,
    ...(build.schema === 'localfirst/build/v0.2' ? { workflow: build.workflow } : {}),
    platform: build.hardware
      ? {
          os: build.hardware.os.name,
          cpu_architecture: build.hardware.cpu_architecture,
          accelerators: build.hardware.accelerators.map((accelerator) => accelerator.backend).sort(),
        }
      : null,
  });
}

/** Digest of the stored build content, excluding the optional manual report. */
export function buildContentPayload(build: AnyBuildInput): AnyBuildPayload {
  const { manual_report: _manualReport, ...rest } = build;
  void _manualReport;
  return rest;
}

// --------------------------------------------------------------------------
// Public projections (section 14.2): the exact fields a person approves
// --------------------------------------------------------------------------

export const buildSelectionSchema = z
  .object({
    /** `coarse` shares OS, architecture, accelerator backend, and bucketed memory. */
    hardware: z.enum(['none', 'coarse']).default('none'),
    /** The model's upstream source URL, when the build recorded one. */
    model_source_url: z.boolean().default(true),
    /** The runtime-local model alias, which can be a user-chosen name. */
    model_alias: z.boolean().default(true),
    /** Whether the attached manual report is part of this contribution. */
    manual_report: z.boolean().default(true),
  })
  .strict();

export const resultSelectionSchema = z
  .object({
    /** `keys` shares public case IDs; `counts_only` shares aggregate counts only. */
    case_results: z.enum(['keys', 'counts_only']).default('keys'),
  })
  .strict();

export type BuildSelection = z.infer<typeof buildSelectionSchema>;
export type ResultSelection = z.infer<typeof resultSelectionSchema>;

const GIB = 1024 ** 3;

/** Bucket memory to a power-of-two GiB so exact figures never identify a machine. */
export function coarseMemoryBytes(bytes: number | null): number | null {
  if (bytes === null || bytes < GIB) return null;
  const gib = bytes / GIB;
  return 2 ** Math.floor(Math.log2(gib)) * GIB;
}

export interface BuildProjectionInput {
  buildId: string;
  payload: AnyBuildPayload;
  reproducibility: Reproducibility;
  manualReport: { report_id: string; payload: BuildReport } | null;
}

export function projectBuild(input: BuildProjectionInput, selection: BuildSelection): Record<string, unknown> {
  const { payload } = input;
  return {
    schema: payload.schema,
    ...(payload.schema === 'localfirst/build/v0.2' ? { workflow: payload.workflow } : {}),
    redaction_version: EXPORT_REDACTION_VERSION,
    build_id: input.buildId,
    project_id: payload.project_id,
    project_version_id: payload.project_version_id,
    configuration_key: payload.configuration_key,
    source: payload.source,
    model_bindings: payload.model_bindings.map((binding) => ({
      role: binding.role,
      runtime_model_id: selection.model_alias ? binding.runtime_model_id : null,
      model_version_id: binding.model_version_id,
      artifact_identity: binding.artifact_identity,
      source_url: selection.model_source_url ? binding.source_url : null,
      quantization: binding.quantization,
      license_state: binding.license_state,
      execution_location: binding.execution_location,
      locality_method: binding.locality_method,
    })),
    runtime: payload.runtime,
    hardware:
      selection.hardware === 'coarse' && payload.hardware
        ? {
            platform: payload.hardware.platform,
            os: { name: payload.hardware.os.name, version: null },
            cpu_architecture: payload.hardware.cpu_architecture,
            memory_bytes: coarseMemoryBytes(payload.hardware.memory_bytes),
            unified_memory: payload.hardware.unified_memory,
            accelerators: payload.hardware.accelerators.map((accelerator) => ({
              vendor: accelerator.vendor,
              backend: accelerator.backend,
              memory_bytes: null,
            })),
          }
        : null,
    effective_settings: payload.effective_settings,
    changes: payload.changes,
    parent_build_id: payload.parent_build_id,
    reproducibility: input.reproducibility,
    manual_report:
      selection.manual_report && input.manualReport
        ? {
            report_id: input.manualReport.report_id,
            outcome: input.manualReport.payload.outcome,
            method: input.manualReport.payload.method,
            changes: input.manualReport.payload.changes,
            checks: input.manualReport.payload.checks,
            diagnostic_codes: input.manualReport.payload.diagnostic_codes,
            completed_at: input.manualReport.payload.completed_at,
          }
        : null,
  };
}

export function projectTestResult(
  reportId: string,
  payload: AnyTestResult,
  selection: ResultSelection,
): Record<string, unknown> {
  return {
    schema: payload.schema,
    ...(payload.schema === 'localfirst/test-result/v0.2' ? { workflow: { ...payload.workflow, steps: selection.case_results === 'keys' ? payload.workflow.steps : [] } } : {}),
    redaction_version: EXPORT_REDACTION_VERSION,
    report_id: reportId,
    project_id: payload.project_id,
    project_version_id: payload.project_version_id,
    build_id: payload.build_id,
    test_key: payload.test_key,
    test_definition_id: payload.test_definition_id,
    test_manifest_digest: payload.test_manifest_digest,
    fixture_digest: payload.fixture_digest,
    fixture_kind: payload.fixture_kind,
    evaluator: payload.evaluator,
    scope: payload.scope,
    runner: payload.runner,
    outcome: payload.outcome,
    counts: payload.counts,
    case_results: selection.case_results === 'keys' ? payload.case_results : null,
    measurements: payload.measurements,
    measurement_context: payload.measurement_context,
    checks: payload.checks,
    completed_at: payload.completed_at,
    diagnostic_codes: payload.diagnostic_codes,
  };
}

/** Digest of the exact reviewed projection, bound to its source record. */
export function projectionDigest(input: {
  kind: 'build' | 'test_result';
  recordId: string;
  recordDigest: string;
  selection: unknown;
  projection: Record<string, unknown>;
}): string {
  return digestOf({
    redaction_version: EXPORT_REDACTION_VERSION,
    kind: input.kind,
    record_id: input.recordId,
    record_digest: input.recordDigest,
    selection: input.selection,
    projection: input.projection,
  });
}

/** Warnings an approver must acknowledge for these exact selections. */
export function buildWarnings(
  reproducibility: Reproducibility,
  selection: BuildSelection,
  hasManualReport: boolean,
  hasHardware = true,
): string[] {
  const warnings: string[] = [];
  if (reproducibility === 'incomplete') warnings.push('build_identity_incomplete');
  if (selection.hardware === 'none' || !hasHardware) warnings.push('hardware_not_shared');
  if (!selection.model_source_url) warnings.push('model_source_not_shared');
  if (!selection.model_alias) warnings.push('model_alias_not_shared');
  if (hasManualReport && !selection.manual_report) warnings.push('manual_report_not_shared');
  return warnings;
}

export function resultWarnings(selection: ResultSelection): string[] {
  return selection.case_results === 'counts_only' ? ['case_results_not_shared'] : [];
}

// --------------------------------------------------------------------------
// Server checks on a test-run report
// --------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface ServerCheck {
  /** Stable machine code. Never submitted content. */
  code: string;
  status: CheckStatus;
  /** `integrity` failures invalidate the report; `eligibility` only cap its level. */
  kind: 'integrity' | 'eligibility';
}

export interface ReportCheckInput {
  result: AnyTestResult;
  manifest: TestManifest;
  /** Stored digests of the definition (the source of truth). */
  definition: {
    id: string;
    projectId: string;
    projectVersionId: string;
    key: string;
    configurationKey: string;
    executable: boolean;
    manifestDigest: string;
    fixtureDigest: string;
  };
  build: {
    id: string;
    ownerUserId: string;
    projectId: string;
    projectVersionId: string;
    configurationKey: string;
    reproducibility: Reproducibility;
    payload: AnyBuildPayload;
  };
  submitterUserId: string;
}

const check = (
  code: string,
  kind: ServerCheck['kind'],
  ok: boolean | null,
): ServerCheck => ({ code, kind, status: ok === null ? 'unknown' : ok ? 'pass' : 'fail' });

/**
 * Recompute everything the server can verify about a submitted run. Integrity
 * checks (identity, digests, bindings) decide whether the report is valid at
 * all; eligibility checks decide whether it may rise above
 * `community_reported`.
 */
export function evaluateReportChecks(input: ReportCheckInput): ServerCheck[] {
  const { result, manifest, definition, build } = input;
  const evaluatorKinds = new Set(manifest.cases.map((testCase) => testCase.evaluation.kind));
  const [declaredEvaluator] = [...evaluatorKinds];
  const expectedExecutions = manifest.cases.length * manifest.measurement.repetitions;
  const modelRoleBound = build.payload.model_bindings.find(
    (binding) => binding.role === manifest.model_role,
  );
  const derived = testDigests(manifest);

  return [
    // --- integrity -------------------------------------------------------
    check('build_owned_by_submitter', 'integrity', build.ownerUserId === input.submitterUserId),
    check(
      'binding_consistent',
      'integrity',
      result.project_id === definition.projectId &&
        result.project_version_id === definition.projectVersionId &&
        build.projectVersionId === definition.projectVersionId &&
        result.test_key === definition.key &&
        result.test_definition_id === definition.id &&
        result.build_id === build.id &&
        build.configurationKey === definition.configurationKey,
    ),
    check('manifest_digest_matches', 'integrity', result.test_manifest_digest === definition.manifestDigest),
    check('fixture_digest_matches', 'integrity', result.fixture_digest === definition.fixtureDigest),
    check(
      'definition_digests_recomputed',
      'integrity',
      derived.manifest_digest === definition.manifestDigest &&
        derived.fixture_digest === definition.fixtureDigest,
    ),
    check(
      'evaluator_matches',
      'integrity',
      evaluatorKinds.size === 1 && declaredEvaluator === result.evaluator.kind && result.evaluator.version === '1',
    ),
    check('scope_matches', 'integrity', result.scope === manifest.scope),
    check('fixture_public', 'integrity', result.fixture_kind === 'public_inline'),
    // --- eligibility for reproducible_test ------------------------------
    check('definition_executable', 'eligibility', definition.executable),
    check('model_role_bound', 'eligibility', modelRoleBound !== undefined),
    check(
      'artifact_identity_present',
      'eligibility',
      modelRoleBound ? modelRoleBound.artifact_identity !== null : false,
    ),
    check('build_identity_sufficient', 'eligibility', build.reproducibility !== 'incomplete'),
    check(
      'settings_match_definition',
      'eligibility',
      Object.entries(manifest.inference).every(
        ([key, value]) =>
          (build.payload.effective_settings as Record<string, unknown>)[key] === value,
      ),
    ),
    check('locality_verified', 'eligibility', result.checks.locality === 'pass'),
    check(
      'run_complete',
      'eligibility',
      result.outcome !== 'cancelled' &&
        result.counts.skipped === 0 &&
        result.counts.defined === expectedExecutions &&
        result.measurement_context.repetitions === manifest.measurement.repetitions &&
        result.measurement_context.warmup_runs === manifest.measurement.warmup_runs,
    ),
  ];
}

export interface ReportEligibility {
  valid: boolean;
  /** Level the report would receive if an operator accepts it. */
  candidateLevel: AssignableEvidenceLevel;
  failedIntegrity: string[];
  failedEligibility: string[];
}

export function summarizeChecks(checks: ServerCheck[]): ReportEligibility {
  const failedIntegrity = checks
    .filter((entry) => entry.kind === 'integrity' && entry.status !== 'pass')
    .map((entry) => entry.code);
  const failedEligibility = checks
    .filter((entry) => entry.kind === 'eligibility' && entry.status !== 'pass')
    .map((entry) => entry.code);
  return {
    valid: failedIntegrity.length === 0,
    candidateLevel:
      failedIntegrity.length === 0 && failedEligibility.length === 0
        ? 'reproducible_test'
        : 'community_reported',
    failedIntegrity,
    failedEligibility,
  };
}

/**
 * The only way a report acquires an evidence level: operator acceptance of a
 * report that is valid. A manual build report is capped at `community_reported`
 * whatever else is true.
 */
export function evidenceLevelOnAcceptance(
  kind: 'manual_build' | 'test_run',
  eligibility: ReportEligibility,
): AssignableEvidenceLevel {
  if (kind === 'manual_build') return 'community_reported';
  return eligibility.candidateLevel;
}

/** Whether a stored outcome counts as a success, for aggregation. */
export function isSuccessfulOutcome(kind: 'manual_build' | 'test_run', outcome: string): boolean {
  return kind === 'manual_build' ? outcome === 'reported_success' : outcome === 'pass';
}

/** Whether a stored outcome counts as a failure, for aggregation. */
export function isFailedOutcome(kind: 'manual_build' | 'test_run', outcome: string): boolean {
  if (kind === 'manual_build') return outcome === 'reported_failure';
  return outcome === 'fail' || outcome === 'error';
}
