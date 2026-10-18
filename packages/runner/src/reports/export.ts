import { digestOf, exportSanitizedResult, type LocalReport, type TestResult } from '@localfirst/contracts';
import { UNASSIGNED_ID } from './build.js';

export type ExportRefusal =
  | 'private_data_class'
  | 'build_not_saved'
  | 'test_definition_unresolved';

export class ExportRefusedError extends Error {
  readonly reason: ExportRefusal;
  constructor(reason: ExportRefusal) {
    super(`report cannot be exported: ${reason}`);
    this.name = 'ExportRefusedError';
    this.reason = reason;
  }
}

export interface SanitizedExport {
  payload: TestResult;
  /** Digest of the exact payload the user reviews and later approves. */
  payload_digest: string;
}

export interface ExportIds {
  /** The build ID the registry returned when the build was saved. */
  build_id?: string;
  test_definition_id?: string;
}

/**
 * Allowlisted, sanitized subset of a local report for review. Only
 * public-fixture runs are exportable: a private local run is a separate
 * protocol and is never comparable or shareable (BACKEND_PRD section 5.3).
 * Server-assigned IDs must be real; the local placeholder is refused.
 */
export function exportSanitized(report: LocalReport, ids: ExportIds = {}): SanitizedExport {
  if (report.data_class !== 'public_fixture') throw new ExportRefusedError('private_data_class');
  const buildId = ids.build_id ?? report.build_id;
  const definitionId = ids.test_definition_id ?? report.test_definition_id;
  if (buildId === UNASSIGNED_ID) throw new ExportRefusedError('build_not_saved');
  if (definitionId === UNASSIGNED_ID) throw new ExportRefusedError('test_definition_unresolved');

  const payload = exportSanitizedResult({
    ...report,
    build_id: buildId,
    test_definition_id: definitionId,
  });
  return { payload, payload_digest: digestOf(payload) };
}
