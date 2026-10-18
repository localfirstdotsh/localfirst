import type { AnyBuildPayload } from '@localfirst/contracts';
/**
 * Exact-identity evidence matching (BACKEND_PRD sections 9.2, 9.5).
 *
 * Accepted evidence applies only when the caller's shared facts establish the
 * same model artifact identity, runtime and version, and platform the evidence
 * names. A similar name or parameter count never matches, and anything the
 * caller did not share is reported as an unmatched dimension instead of being
 * assumed.
 */

import { digestOf, type CompatibilityRequest, type WorkflowBuildInput } from '@localfirst/contracts';
import { coarseMemoryBytes } from './evidence.js';

export interface EvidenceSubject {
  models: Array<{
    role: string;
    identity: { scheme: string; digest: string | null; reference: string | null } | null;
    alias: string | null;
    quantization: string | null;
  }>;
  runtime: {
    family: string;
    application_version: string | null;
    engine_version: string | null;
    backend: string | null;
    adapter_profile: string;
  };
  /** `null` when the contributor shared no hardware details; such evidence never matches a platform. */
  platform: { os: string; cpu_architecture: string; accelerators: string[]; memory_bytes?: number | null; platform?: string | null } | null;
  settings: Record<string, unknown>;
  workflow?: WorkflowBuildInput['workflow'];
}

export function buildSubject(payload: AnyBuildPayload): EvidenceSubject {
  return {
    models: payload.model_bindings.map((binding) => ({
      role: binding.role,
      identity: binding.artifact_identity
        ? {
            scheme: binding.artifact_identity.scheme,
            digest: binding.artifact_identity.digest,
            reference: binding.artifact_identity.reference,
          }
        : null,
      alias: binding.artifact_identity ? null : binding.runtime_model_id,
      quantization: binding.quantization,
    })),
    runtime: {
      family: payload.runtime.family,
      application_version: payload.runtime.application_version,
      engine_version: payload.runtime.engine_version,
      backend: payload.runtime.backend,
      adapter_profile: payload.runtime.adapter_profile,
    },
    platform: payload.hardware
      ? {
          os: payload.hardware.os.name,
          memory_bytes: payload.hardware.memory_bytes,
          platform: payload.hardware.platform,
          cpu_architecture: payload.hardware.cpu_architecture,
          accelerators: payload.hardware.accelerators.map((accelerator) => accelerator.backend).sort(),
        }
      : null,
    settings: payload.effective_settings,
    ...(payload.schema === 'localfirst/build/v0.2' ? { workflow: payload.workflow } : {}),
  };
}

export interface EvidenceMatchResult {
  /** True only when every dimension is established by the caller's shared facts. */
  exact: boolean;
  /** Stable codes for dimensions that are missing or different. */
  unmatched: string[];
}

const sameIdentity = (
  a: { scheme: string; digest: string | null; reference: string | null },
  b: { scheme: string; digest: string | null; reference: string | null },
): boolean => a.scheme === b.scheme && a.digest === b.digest && a.reference === b.reference;

export function matchSubject(subject: EvidenceSubject, request: CompatibilityRequest): EvidenceMatchResult {
  const unmatched: string[] = [];
  if (subject.workflow && !request.workflow_identity) unmatched.push('workflow_identity_not_shared');
  else if (subject.workflow && digestOf(subject.workflow) !== digestOf(request.workflow_identity)) unmatched.push('workflow_identity_differs');
  else if (!subject.workflow && request.workflow_identity) unmatched.push('workflow_evidence_missing');

  for (const model of subject.models) {
    if (!model.identity) {
      unmatched.push(`model_identity_unknown_in_evidence:${model.role}`);
      continue;
    }
    const selected = request.selected_models.find((entry) => entry.role === model.role);
    if (!selected) unmatched.push(`model_not_shared:${model.role}`);
    else if (!selected.artifact_identity) unmatched.push(`model_identity_not_shared:${model.role}`);
    else if (!sameIdentity(selected.artifact_identity, model.identity)) {
      unmatched.push(`model_identity_differs:${model.role}`);
    }
  }

  if (request.effective_settings === undefined) unmatched.push('settings_not_shared');
  else if (digestOf(request.effective_settings) !== digestOf(subject.settings)) unmatched.push('settings_differs');

  const runtime = request.runtime;
  if (!runtime) unmatched.push('runtime_not_shared');
  else {
    if (subject.runtime.engine_version !== null && runtime.engine_version !== subject.runtime.engine_version) unmatched.push('runtime_engine_not_shared_or_differs');
    if (runtime.api_profile !== subject.runtime.adapter_profile) unmatched.push('runtime_profile_not_shared_or_differs');
    if (runtime.family !== subject.runtime.family) unmatched.push('runtime_family_differs');
    if (subject.runtime.application_version === null) unmatched.push('runtime_version_unknown_in_evidence');
    else if (runtime.version === null) unmatched.push('runtime_version_not_shared');
    else if (runtime.version !== subject.runtime.application_version) unmatched.push('runtime_version_differs');
    if (subject.runtime.backend !== null) {
      if (runtime.backend === null) unmatched.push('runtime_backend_not_shared');
      else if (runtime.backend !== subject.runtime.backend) unmatched.push('runtime_backend_differs');
    }
  }

  for (const model of subject.models) {
    const selected = request.selected_models.find(m => m.role === model.role);
    // An omitted quantization is the same unshared fact as an explicit null.
    if ((selected?.quantization ?? null) !== model.quantization) unmatched.push(`model_quantization_not_shared_or_differs:${model.role}`);
  }
  const hardware = request.hardware;
  if (!subject.platform) unmatched.push('hardware_not_shared_in_evidence');
  else if (!hardware) unmatched.push('hardware_not_shared');
  else {
    if (subject.platform.memory_bytes === null || subject.platform.memory_bytes === undefined) unmatched.push('memory_unknown_in_evidence');
    // Evidence memory is published as a power-of-two GiB bucket; compare the caller's figure in the same bucket.
    else if (coarseMemoryBytes(hardware.memory_bytes) !== subject.platform.memory_bytes) unmatched.push('memory_not_shared_or_differs');
    if (hardware.platform !== subject.platform.platform) unmatched.push('platform_not_shared_or_differs');
    if (hardware.os === null) unmatched.push('os_not_shared');
    else if (hardware.os !== subject.platform.os) unmatched.push('os_differs');
    if (hardware.cpu_architecture === null) unmatched.push('cpu_architecture_not_shared');
    else if (hardware.cpu_architecture !== subject.platform.cpu_architecture) {
      unmatched.push('cpu_architecture_differs');
    }
    if (subject.platform.accelerators.length > 0) {
      if (hardware.accelerator === null) unmatched.push('accelerator_not_shared');
      else if (!subject.platform.accelerators.includes(hardware.accelerator)) {
        unmatched.push('accelerator_differs');
      }
    }
  }

  return { exact: unmatched.length === 0, unmatched };
}
