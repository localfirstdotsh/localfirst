import {
  localPlanSchema,
  testDigests,
  validateProjectBundle,
  type BundleFile,
  type TestManifest,
} from '@localfirst/contracts';
import { checkExecutable, type RefusalCode } from '../harnesses/executable.js';

export type VerificationReason =
  | 'plan_invalid'
  | 'bundle_invalid'
  | 'test_not_found'
  | 'bundle_digest_mismatch'
  | 'manifest_digest_mismatch'
  | 'fixture_digest_mismatch'
  | 'evaluator_digest_mismatch'
  | 'settings_mismatch'
  | 'test_mismatch'
  | 'withdrawn'
  | 'approval_missing'
  | 'approval_mismatch'
  | RefusalCode;

export type Verification =
  | { ok: true; manifest: TestManifest }
  | { ok: false; reasons: VerificationReason[] };

export interface BundleInput {
  project_md: string;
  files: BundleFile[];
}

export interface VerifyInput {
  /** The plan exactly as stored/approved; parsed here, never trusted. */
  plan: unknown;
  /** The bundle as downloaded now. */
  bundle: BundleInput;
  /** Digest the approval is bound to, or null when there is none. */
  approvedPlanDigest: string | null;
  /** Registry state for the test definition, when known. */
  registry?: { withdrawn: boolean };
}

/**
 * Check, immediately before running, that what will execute is exactly what was
 * approved: plan digest, project bundle, manifest, fixture set, evaluator
 * specification, and effective settings. Any difference, a withdrawn
 * definition, or a missing approval blocks execution (BACKEND_PRD section 5.3).
 */
export function verifyForExecution(input: VerifyInput): Verification {
  const parsedPlan = localPlanSchema.safeParse(input.plan);
  if (!parsedPlan.success) return { ok: false, reasons: ['plan_invalid'] };
  const plan = parsedPlan.data;
  const reasons = new Set<VerificationReason>();

  if (input.approvedPlanDigest === null) reasons.add('approval_missing');
  else if (input.approvedPlanDigest !== plan.plan_digest) reasons.add('approval_mismatch');
  if (input.registry?.withdrawn) reasons.add('withdrawn');

  const validated = validateProjectBundle(input.bundle);
  if (!validated.ok || validated.content_digest === null) {
    reasons.add('bundle_invalid');
    return { ok: false, reasons: [...reasons] };
  }
  if (validated.content_digest !== plan.test.bundle_digest) reasons.add('bundle_digest_mismatch');

  const found = validated.tests.find((entry) => entry.manifest.key === plan.test.key);
  if (!found) {
    reasons.add('test_not_found');
    return { ok: false, reasons: [...reasons] };
  }

  const executable = checkExecutable(found.manifest);
  if (!executable.executable) for (const reason of executable.reasons) reasons.add(reason);

  const manifest = found.manifest;
  const digests = testDigests(manifest);
  if (digests.manifest_digest !== plan.test.manifest_digest) reasons.add('manifest_digest_mismatch');
  if (digests.fixture_digest !== plan.test.fixture_digest) reasons.add('fixture_digest_mismatch');
  if (digests.evaluator_digest !== plan.test.evaluator_digest) reasons.add('evaluator_digest_mismatch');

  if (
    manifest.scope !== plan.test.scope ||
    manifest.project_key !== validated.manifest?.project.key ||
    manifest.configuration_key !== plan.project.configuration_key ||
    manifest.model_role !== plan.model.role
  ) {
    reasons.add('test_mismatch');
  }

  const planned = plan.settings;
  const declared = manifest.inference;
  const sameSettings = (Object.keys(declared) as Array<keyof typeof declared>).every(
    (key) => planned[key] === declared[key],
  );
  if (!sameSettings) reasons.add('settings_mismatch');

  return reasons.size === 0 ? { ok: true, manifest } : { ok: false, reasons: [...reasons] };
}
