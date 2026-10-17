import { MODEL_CAPABILITIES, type ModelCapability } from '@localfirst/contracts';
import {
  UNKNOWN_CAPABILITY,
  capabilityTable,
  type ArtifactIdentity,
  type Capability,
  type LocalityAssessment,
  type ModelEntry,
} from '../contract.js';
import { structuredOutputTested, type ChatProfile } from './profiles.js';

/** Formats LM Studio runs on this machine. Anything else is not positive local evidence. */
const LOCAL_FORMATS = new Set(['mlx', 'gguf']);
const REMOTE_MARKER = /remote|proxy|link|cloud|upstream/i;

export type ListingSource = 'native' | 'openai_compat';

export interface ListedModel {
  key: string;
  /** `llm`, `embedding`, or null when the listing does not say (fallback). */
  type: string | null;
  format: string | null;
  quantization: string | null;
  sizeBytes: number | null;
  paramsString: string | null;
  loaded: boolean;
  loadedContext: number | null;
  loadedParallel: number | null;
  maxContext: number | null;
  vision: boolean | null;
  toolUse: boolean | null;
  variants: string[];
  selectedVariant: string | null;
  remoteMarker: string | null;
  source: ListingSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** A field that suggests the model is served from elsewhere, or null. */
function findRemoteMarker(entry: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(entry)) {
    if (!REMOTE_MARKER.test(name)) continue;
    if (value !== null && value !== false && value !== '' && value !== 0) return name;
  }
  return null;
}

/** Parse `GET /api/v1/models`. Null means the body did not match the documented shape. */
export function parseNativeModels(json: unknown): ListedModel[] | null {
  if (!isRecord(json) || !Array.isArray(json.models)) return null;
  const models: ListedModel[] = [];
  for (const raw of json.models) {
    if (!isRecord(raw)) return null;
    const key = text(raw.key);
    if (!key) return null;
    const instances = Array.isArray(raw.loaded_instances) ? raw.loaded_instances.filter(isRecord) : [];
    const config = isRecord(instances[0]?.config) ? instances[0]?.config : {};
    const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
    const quantization = isRecord(raw.quantization) ? text(raw.quantization.name) : text(raw.quantization);
    models.push({
      key,
      type: text(raw.type),
      format: text(raw.format)?.toLowerCase() ?? null,
      quantization,
      sizeBytes: num(raw.size_bytes),
      paramsString: text(raw.params_string),
      loaded: instances.length > 0,
      loadedContext: num((config as Record<string, unknown>).context_length),
      loadedParallel: num((config as Record<string, unknown>).parallel),
      maxContext: num(raw.max_context_length),
      vision: bool(capabilities.vision),
      toolUse: bool(capabilities.trained_for_tool_use),
      variants: Array.isArray(raw.variants) ? raw.variants.filter((v): v is string => typeof v === 'string') : [],
      selectedVariant: text(raw.selected_variant),
      remoteMarker: findRemoteMarker(raw),
      source: 'native',
    });
  }
  return models;
}

/** Parse `GET /v1/models`: ids only, so everything else is unknown. */
export function parseOpenAiModels(json: unknown): ListedModel[] | null {
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  const models: ListedModel[] = [];
  for (const raw of json.data) {
    if (!isRecord(raw)) return null;
    const key = text(raw.id);
    if (!key) return null;
    models.push({
      key,
      type: null,
      format: null,
      quantization: null,
      sizeBytes: null,
      paramsString: null,
      loaded: false,
      loadedContext: null,
      loadedParallel: null,
      maxContext: null,
      vision: null,
      toolUse: null,
      variants: [],
      selectedVariant: null,
      remoteMarker: findRemoteMarker(raw),
      source: 'openai_compat',
    });
  }
  return models;
}

/**
 * Local-only requires positive evidence: a native listing that names a local
 * format with a real on-disk size and no remote marker. A remote-linked marker
 * is `remote`; the fallback listing, which carries no origin facts, is `unknown`.
 */
export function assessLocality(model: ListedModel): LocalityAssessment {
  if (model.remoteMarker !== null) {
    return { value: 'remote', method: 'adapter_preflight', reason: 'remote_linked' };
  }
  if (model.source === 'openai_compat') {
    return { value: 'unknown', method: 'unknown', reason: 'no_origin_metadata' };
  }
  if (model.format === null || !LOCAL_FORMATS.has(model.format)) {
    return model.format === null
      ? { value: 'unknown', method: 'unknown', reason: 'no_local_evidence' }
      : { value: 'remote', method: 'adapter_preflight', reason: 'non_local_format' };
  }
  if (model.sizeBytes === null || model.sizeBytes <= 0) {
    return { value: 'unknown', method: 'unknown', reason: 'no_local_evidence' };
  }
  return { value: 'local', method: 'adapter_preflight', reason: null };
}

const fromMetadata = (value: boolean | null): Capability =>
  value === null ? UNKNOWN_CAPABILITY : { value: value ? 'supported' : 'unsupported', source: 'provider_metadata' };

export function capabilitiesOf(model: ListedModel, profile: ChatProfile): Record<ModelCapability, Capability> {
  if (model.source === 'openai_compat') return capabilityTable({});
  const known: Partial<Record<ModelCapability, Capability>> = {};
  if (model.type === 'llm') {
    known.chat = { value: 'supported', source: 'provider_metadata' };
    known.vision = fromMetadata(model.vision);
    known.tool_calls = fromMetadata(model.toolUse);
    if (structuredOutputTested(profile, model.format)) {
      known.json_output = { value: 'supported', source: 'tested_adapter_profile' };
    }
  } else if (model.type === 'embedding') {
    known.embeddings = { value: 'supported', source: 'provider_metadata' };
    for (const name of ['chat', 'completion', 'json_output', 'tool_calls', 'reasoning'] as const) {
      known[name] = { value: 'unsupported', source: 'provider_metadata' };
    }
  }
  for (const name of MODEL_CAPABILITIES) known[name] ??= UNKNOWN_CAPABILITY;
  return capabilityTable(known);
}

export function identityOf(model: ListedModel): ArtifactIdentity {
  // LM Studio exposes a model key, not a content digest; never present it as a weight hash.
  return { scheme: 'lmstudio_model_key', digest: null, reference: model.selectedVariant ?? model.key };
}

export function toEntry(model: ListedModel, profile: ChatProfile): ModelEntry {
  return {
    runtime_model_id: model.key,
    state: model.loaded ? 'loaded' : 'available',
    artifact_identity: identityOf(model),
    capabilities: capabilitiesOf(model, profile),
    context_tokens: model.loaded ? model.loadedContext : null,
    size_bytes: model.sizeBytes,
    locality: assessLocality(model),
  };
}

/** Match a requested id to a listed key or one of its `key@variant` forms. */
export function findModel(models: ListedModel[], requested: string): ListedModel | undefined {
  return models.find(
    (model) => model.key === requested || model.variants.includes(requested) || model.selectedVariant === requested,
  );
}

/** Does a model id returned by the server correspond to the requested one? */
export function sameModel(requested: string, returned: unknown): boolean {
  if (typeof returned !== 'string' || returned.length === 0) return false;
  return requested === returned || requested.startsWith(`${returned}@`);
}
