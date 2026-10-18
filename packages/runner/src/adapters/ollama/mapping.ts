import { MODEL_CAPABILITIES, nanosecondsToMilliseconds, tokensPerSecond, type ModelCapability } from '@localfirst/contracts';
import {
  UNKNOWN_CAPABILITY,
  capabilityTable,
  type AdapterInferRequest,
  type ArtifactIdentity,
  type Capability,
  type LocalityAssessment,
} from '../contract.js';
import { AdapterError, type ProviderStats } from '../types.js';

export const OLLAMA_PROFILE = 'ollama-native/v0.1';
export const PROVIDER_TAG = 'ollama_native_v1';

/** Endpoints this adapter may call. Anything else is a bug, and tests assert it. */
export const ALLOWED_ROUTES = [
  'GET /api/version',
  'GET /api/tags',
  'GET /api/ps',
  'POST /api/show',
  'POST /api/chat',
] as const;

type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const LOCAL_FORMATS = new Set(['gguf', 'safetensors', 'mlx']);

/** Ollama marks cloud models with `remote_host`/`remote_model` and a `-cloud`/`:cloud` name. */
export function hasRemoteMarkers(name: string, ...sources: Array<Json | undefined>): boolean {
  if (/(?:[:-])cloud$/.test(name)) return true;
  return sources.some((source) => source !== undefined && ('remote_host' in source || 'remote_model' in source));
}

/**
 * Locality is fail-closed: `local` needs positive evidence (a local weight
 * format, a non-zero size, and no remote markers). Remote markers mean
 * `remote`. Anything else is `unknown` and blocks a local-only run.
 */
export function assessLocality(name: string, tags: Json | undefined, show: Json | undefined): LocalityAssessment {
  if (hasRemoteMarkers(name, tags, show)) {
    return { value: 'remote', method: 'adapter_preflight', reason: 'cloud_model' };
  }
  const details = isRecord(tags?.details) ? tags.details : undefined;
  const format = typeof details?.format === 'string' ? details.format.toLowerCase() : '';
  const size = typeof tags?.size === 'number' ? tags.size : 0;
  if (LOCAL_FORMATS.has(format) && size > 0) {
    return { value: 'local', method: 'adapter_preflight', reason: `local_${format}` };
  }
  return { value: 'unknown', method: 'unknown', reason: 'no_locality_signal' };
}

/**
 * Capabilities from `/api/tags` or `/api/show`. Only what Ollama reports is
 * marked; the rest stays unknown with no source. `json_output` is a runtime
 * feature (`format`), so it is marked from the tested adapter profile, and only
 * for models that advertise completion.
 */
export function mapCapabilities(reported: unknown): Record<ModelCapability, Capability> {
  if (!Array.isArray(reported)) return capabilityTable({});
  const has = (name: string) => reported.includes(name);
  const provider: Capability = { value: 'supported', source: 'provider_metadata' };
  const known: Partial<Record<ModelCapability, Capability>> = {};
  if (has('completion')) {
    known.chat = provider;
    known.completion = provider;
    known.json_output = { value: 'supported', source: 'tested_adapter_profile' };
  }
  if (has('tools')) known.tool_calls = provider;
  if (has('vision')) known.vision = provider;
  if (has('thinking')) known.reasoning = provider;
  if (has('embedding')) known.embeddings = provider;
  const table = capabilityTable(known);
  for (const name of MODEL_CAPABILITIES) table[name] ??= UNKNOWN_CAPABILITY;
  return table;
}

export function artifactIdentity(digest: unknown): ArtifactIdentity {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return null;
  return { scheme: 'ollama_manifest_sha256', digest: `sha256:${digest}`, reference: null };
}

/** Context length from `/api/show` model_info (`<arch>.context_length`), else the listing. */
export function contextLength(show: Json | undefined, tags: Json | undefined): number | null {
  const info = isRecord(show?.model_info) ? show.model_info : undefined;
  const arch = typeof info?.['general.architecture'] === 'string' ? info['general.architecture'] : undefined;
  const fromShow = arch ? info?.[`${arch}.context_length`] : undefined;
  if (typeof fromShow === 'number' && fromShow > 0) return fromShow;
  const details = isRecord(tags?.details) ? tags.details : undefined;
  const fromTags = details?.context_length;
  return typeof fromTags === 'number' && fromTags > 0 ? fromTags : null;
}

/** `qwen2.5` and `qwen2.5:latest` are the same Ollama model. */
export function sameModel(requested: string, returned: string): boolean {
  const normalize = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return normalize(requested) === normalize(returned);
}

const SCHEMA_KEYS = new Set(['type', 'properties', 'items', 'required', 'enum', 'additionalProperties', 'description']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const MAX_SCHEMA_DEPTH = 8;

function unsupported(message: string): never {
  throw new AdapterError('option_unsupported', message);
}

/**
 * Map the bounded manifest schema subset to Ollama's `format` JSON Schema. The
 * subset is already JSON Schema; this validates it node by node and rejects
 * anything it cannot express, so no constraint is silently dropped.
 */
export function mapResponseSchema(node: unknown, depth = 0): Json {
  if (depth > MAX_SCHEMA_DEPTH) unsupported('response schema is nested too deeply');
  if (!isRecord(node)) unsupported('response schema node must be an object');
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYS.has(key)) unsupported(`response schema keyword \`${key}\` cannot be mapped`);
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) unsupported('response schema type is unsupported');
  const mapped: Json = { type: node.type };
  if (node.properties !== undefined) {
    if (!isRecord(node.properties)) unsupported('properties must be an object');
    mapped.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, child]) => [key, mapResponseSchema(child, depth + 1)]),
    );
  }
  if (node.items !== undefined) mapped.items = mapResponseSchema(node.items, depth + 1);
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) unsupported('required must be strings');
    mapped.required = [...node.required];
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum)) unsupported('enum must be an array');
    mapped.enum = [...node.enum];
  }
  if (node.additionalProperties !== undefined) {
    if (typeof node.additionalProperties !== 'boolean') unsupported('additionalProperties must be a boolean');
    mapped.additionalProperties = node.additionalProperties;
  }
  if (node.description !== undefined) mapped.description = node.description;
  return mapped;
}

/** Native `/api/chat` request body. `think:false` is sent only for models that can think. */
export function buildChatBody(request: AdapterInferRequest, supportsThinking: boolean): Json {
  const { settings } = request;
  const options: Json = {
    temperature: settings.temperature,
    num_predict: settings.max_output_tokens,
    num_ctx: settings.context_tokens,
  };
  if (settings.seed !== null) options.seed = settings.seed;
  const body: Json = {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: settings.stream,
  };
  if (request.responseSchema !== null && request.responseSchema !== undefined) {
    body.format = mapResponseSchema(request.responseSchema);
  }
  if (settings.reasoning === 'disabled' && supportsThinking) body.think = false;
  body.options = options;
  return body;
}

const NATIVE_COUNTERS = [
  'total_duration',
  'load_duration',
  'prompt_eval_count',
  'prompt_eval_cached_count',
  'prompt_eval_duration',
  'eval_count',
  'eval_duration',
] as const;

/**
 * Raw Ollama counters in their native units (nanoseconds and token counts),
 * plus clearly named derived values. These are provider statistics and are
 * never merged with client-side timings.
 */
export function toProviderStats(body: Json): ProviderStats {
  const stats: ProviderStats = { provider: PROVIDER_TAG };
  for (const key of NATIVE_COUNTERS) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) stats[key] = value;
  }
  if (typeof body.done_reason === 'string') stats.done_reason = body.done_reason;
  const ms = (key: (typeof NATIVE_COUNTERS)[number]) => {
    const value = stats[key];
    return typeof value === 'number' ? nanosecondsToMilliseconds(value) : null;
  };
  stats.derived_total_ms = ms('total_duration');
  stats.derived_load_ms = ms('load_duration');
  stats.derived_eval_ms = ms('eval_duration');
  stats.derived_tokens_per_second =
    typeof stats.eval_count === 'number' && typeof stats.eval_duration === 'number'
      ? tokensPerSecond(stats.eval_count, stats.eval_duration)
      : null;
  return stats;
}
