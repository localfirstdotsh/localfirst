import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digestOf, localReportSchema, type LocalReport } from '@localfirst/contracts';

export interface SavedReport {
  path: string;
  digest: string;
}

/** `<client_run_id>.report.json`; the run ID is already restricted to safe characters. */
export function reportPath(directory: string, clientRunId: string): string {
  return join(directory, `${clientRunId}.report.json`);
}

/**
 * Write a local report privately (0700 directory, 0600 file) and atomically.
 * It never overwrites an existing report: a run ID names one immutable set of
 * observed facts. Reports keep raw provider statistics and model output, so
 * they stay on disk and are only ever shared through `exportSanitized`.
 */
export async function saveLocalReport(directory: string, report: LocalReport): Promise<SavedReport> {
  const valid = localReportSchema.parse(report);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = reportPath(directory, valid.client_run_id);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    // A hard link fails atomically if the target exists, so a report is never replaced.
    await link(temp, path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`a report already exists for run ${valid.client_run_id}`, { cause });
    }
    throw cause;
  } finally {
    await rm(temp, { force: true });
  }
  return { path, digest: digestOf(valid) };
}

export async function readLocalReport(path: string): Promise<LocalReport> {
  return localReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
