import {
  buildInputSchema,
  digestOf,
  exportSanitizedResult,
  testResultSubmissionSchema,
  type BuildInput,
  type LocalReport,
  type TestResultSubmission,
} from '@localfirst/contracts';
import { ExportRefusedError } from './export.js';
import { UNASSIGNED_ID } from './build.js';

export type BuildSource = BuildInput['source'];
export type BuildHardware = NonNullable<BuildInput['hardware']>;

export interface UploadInput {
  /** The registry definition ID, when the local report does not already carry it. */
  testDefinitionId?: string | undefined;
  /** A public https URL the user declares for where the model comes from, or `null` to share none. */
  modelSourceUrl?: string | null | undefined;
  /** Coarse hardware the user chose to share, or `null` to share none. */
  hardware: BuildHardware | null;
  /** Where the build's project came from (kind/url/revision); the digest is taken from the plan. */
  source: Omit<BuildSource, 'project_manifest_digest'>;
}

export interface UploadExport {
  payload: TestResultSubmission;
  /** One digest over the whole payload the user reviews and the upload sends. */
  payload_digest: string;
}

/**
 * The build the registry stores for this run, derived only from the approved
 * plan snapshot: the selected model binding, runtime versions, effective
 * settings, and the project version. No inventory, paths, or other models.
 */
export function buildFromReport(report: LocalReport, input: Pick<UploadInput, 'hardware' | 'source' | 'modelSourceUrl'>): BuildInput {
  const { plan } = report;
  return buildInputSchema.parse({
    schema: 'localfirst/build/v0.1',
    project_id: plan.project.project_id,
    project_version_id: plan.project.project_version_id,
    configuration_key: plan.project.configuration_key,
    source: { ...input.source, project_manifest_digest: plan.test.bundle_digest },
    model_bindings: [
      {
        role: plan.model.role,
        runtime_model_id: plan.model.runtime_model_id,
        model_version_id: null,
        artifact_identity: plan.model.artifact_identity,
        source_url: input.modelSourceUrl ?? null,
        quantization: null,
        license_state: 'unknown',
        execution_location: plan.model.execution_location,
        locality_method: plan.model.locality_method,
      },
    ],
    runtime: {
      family: plan.runtime.family,
      application_version: plan.runtime.application_version,
      cli_version: plan.runtime.cli_version,
      engine_version: plan.runtime.engine_version,
      adapter_profile: plan.runtime.adapter_profile,
      backend: null,
    },
    hardware: input.hardware,
    effective_settings: plan.settings,
    changes: [{ kind: 'model_selection', role: plan.model.role, note: 'Selected an already installed model.' }],
    parent_build_id: null,
    manual_report: null,
  });
}

/**
 * The reviewable upload for a local report: the allowlisted sanitized result
 * plus its inline build. Only public-fixture runs are exportable. The result
 * names the build with the local placeholder; the registry replaces it with
 * the real build ID when it stores both in one transaction.
 */
export function exportUpload(report: LocalReport, input: UploadInput): UploadExport {
  if (report.data_class !== 'public_fixture') throw new ExportRefusedError('private_data_class');
  const definitionId = input.testDefinitionId ?? report.test_definition_id;
  if (definitionId === UNASSIGNED_ID) throw new ExportRefusedError('test_definition_unresolved');

  const result = exportSanitizedResult({ ...report, test_definition_id: definitionId });
  const payload = testResultSubmissionSchema.parse({ result, build: buildFromReport(report, input) });
  return { payload, payload_digest: digestOf(payload) };
}
