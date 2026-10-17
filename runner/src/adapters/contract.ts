/**
 * Provider-neutral runtime adapter contract (BACKEND_PRD section 7.3).
 *
 * Capability and identity facts always carry where they came from; a fact the
 * runtime did not give us is `unknown`/`null`, never guessed. Unsupported
 * critical options fail instead of being dropped, and nothing here pulls,
 * creates, deletes, or reconfigures a model or server.
 */

import type { BuildInput, ModelCapability } from '@localfirst/contracts';
import { MODEL_CAPABILITIES } from '@localfirst/contracts';
import type { ExecutionGrant } from '../consent/plan.js';
import {
  AdapterError,
  type InferRequest,
  type InferResponse,
  type InferSettings,
  type InferenceAdapter,
} from './types.js';

export type RuntimeFamily = 'ollama' | 'lmstudio';

export type CapabilityValue = 'supported' | 'unsupported' | 'unknown';
export type CapabilitySource =
  | 'provider_metadata'
  | 'tested_adapter_profile'
  | 'user_declared'
  | 'consented_probe';

export interface Capability {
  value: CapabilityValue;
  /** Null only when the value is `unknown`. */
  source: CapabilitySource | null;
}

export const UNKNOWN_CAPABILITY: Capability = { value: 'unknown', source: null };

/** A model capability table with every known capability present. */
export function capabilityTable(
  known: Partial<Record<ModelCapability, Capability>>,
): Record<ModelCapability, Capability> {
  const table = {} as Record<ModelCapability, Capability>;
  for (const name of MODEL_CAPABILITIES) table[name] = known[name] ?? UNKNOWN_CAPABILITY;
  return table;
}

/** A fact with its observation source. Missing facts stay `null`. */
export interface ObservedFact<T> {
  value: T | null;
  /** Where it was observed, e.g. `GET /api/version`, `lms version`; null if unobserved. */
  source: string | null;
}

export const unobserved = <T>(): ObservedFact<T> => ({ value: null, source: null });

export interface ProbeResult {
  family: RuntimeFamily;
  api_profile: string;
  endpoint: string;
  reachable: boolean;
  /** Application/server, CLI, and engine versions are reported separately. */
  versions: {
    application: ObservedFact<string>;
    cli: ObservedFact<string>;
    engine: ObservedFact<string>;
  };
  /** Stable reason code when not reachable. */
  failure: string | null;
}

export type ModelState = 'loaded' | 'available';
export type LocalityValue = 'local' | 'remote' | 'unknown';

export interface LocalityAssessment {
  value: LocalityValue;
  method: 'adapter_preflight' | 'user_declared' | 'unknown';
  /** Why, in a stable code (e.g. `cloud_model`, `remote_linked`, `no_locality_signal`). */
  reason: string | null;
}

export type ArtifactIdentity = BuildInput['model_bindings'][number]['artifact_identity'];

export interface ModelEntry {
  runtime_model_id: string;
  /** Loaded versus merely available are different facts. */
  state: ModelState;
  /** Runtime-specific identity; never presented as a portable weight hash. */
  artifact_identity: ArtifactIdentity;
  capabilities: Record<ModelCapability, Capability>;
  context_tokens: number | null;
  size_bytes: number | null;
  locality: LocalityAssessment;
}

export interface ModelDetails extends ModelEntry {
  quantization: string | null;
  format: string | null;
  /** Settings the runtime reports as effective; absent means unconfirmed. */
  effective_options: Record<string, ObservedFact<number | string | boolean>>;
}

export interface Finding {
  code: PreflightCode;
  message: string;
}

export type PreflightCode =
  | 'runtime_unreachable'
  | 'model_not_found'
  | 'model_remote'
  | 'locality_unknown'
  | 'capability_unsupported'
  | 'capability_unknown'
  | 'option_unsupported'
  | 'stream_unsupported'
  | 'profile_untested'
  | 'context_exceeded';

export interface PreflightRequest {
  model: string;
  requirements: {
    capabilities: ModelCapability[];
    locality: 'local_required' | 'local_preferred';
    settings: InferSettings;
    structured_output: boolean;
  };
}

export interface PreflightResult {
  /** True only when there are no blockers. Unknowns are surfaced, not hidden. */
  ok: boolean;
  blockers: Finding[];
  unknowns: Finding[];
  effects: { may_load_model: boolean; model_state: ModelState | null };
}

export interface AdapterInferRequest extends InferRequest {
  model: string;
  grant: ExecutionGrant;
}

export interface InferOptions {
  signal: AbortSignal;
  /** Handle for best-effort `cancel`. */
  runId?: string;
  /** Called once, when a streamed reply delivers its first non-empty content fragment. */
  onFirstContent?: () => void;
}

export interface CancelResult {
  cancelled: boolean;
  detail: 'aborted_request' | 'no_active_run';
}

export interface MeasureScope {
  metric: 'peak_memory_bytes' | 'hardware_utilization';
  intervalMs: number;
}

export type MeasureResult =
  | { status: 'unsupported'; reason: string }
  | { status: 'observed'; method: string; value: number | null; reason: string | null };

export interface RuntimeAdapter {
  readonly family: RuntimeFamily;
  probe(): Promise<ProbeResult>;
  list_models(): Promise<ModelEntry[]>;
  inspect_model(model: string): Promise<ModelDetails>;
  /** Hard blockers and unknowns. Never runs inference. */
  preflight(request: PreflightRequest): Promise<PreflightResult>;
  infer(request: AdapterInferRequest, options: InferOptions): Promise<InferResponse>;
  cancel(runId: string): Promise<CancelResult>;
  measure(scope: MeasureScope): Promise<MeasureResult>;
}

/** Bind one model and approval so the harness can drive any runtime adapter. */
export function bindModel(adapter: RuntimeAdapter, model: string, grant: ExecutionGrant): InferenceAdapter {
  let sequence = 0;
  return {
    infer: (request, { signal, onFirstContent }) => {
      sequence += 1;
      return adapter.infer(
        { ...request, model, grant },
        { signal, runId: `${model}#${sequence}`, ...(onFirstContent ? { onFirstContent } : {}) },
      );
    },
  };
}

/** Active-request registry backing best-effort `cancel`. */
export class RunRegistry {
  private readonly active = new Map<string, AbortController>();

  /** Register a run; returns a signal that also fires when `cancel` is called. */
  begin(runId: string | undefined, outer: AbortSignal): { signal: AbortSignal; end: () => void } {
    if (runId === undefined) return { signal: outer, end: () => undefined };
    const controller = new AbortController();
    this.active.set(runId, controller);
    return {
      signal: AbortSignal.any([outer, controller.signal]),
      end: () => {
        if (this.active.get(runId) === controller) this.active.delete(runId);
      },
    };
  }

  cancel(runId: string): CancelResult {
    const controller = this.active.get(runId);
    if (!controller) return { cancelled: false, detail: 'no_active_run' };
    controller.abort(new AdapterError('cancelled', 'cancelled by caller'));
    this.active.delete(runId);
    return { cancelled: true, detail: 'aborted_request' };
  }
}

/** Standard result until method-tagged sensors exist. */
export const SENSORS_UNSUPPORTED: MeasureResult = {
  status: 'unsupported',
  reason: 'sensors_not_implemented',
};
