import { inspect } from 'node:util';
import {
  RunRegistry,
  SENSORS_UNSUPPORTED,
  type AdapterInferRequest,
  type CancelResult,
  type Finding,
  type InferOptions,
  type MeasureResult,
  type MeasureScope,
  type ModelDetails,
  type ModelEntry,
  type PreflightRequest,
  type PreflightResult,
  type ProbeResult,
  type RuntimeAdapter,
} from '../contract.js';
import { LoopbackClient } from '../http.js';
import { AdapterError, type InferResponse, type ProviderStats } from '../types.js';
import {
  findModel,
  parseNativeModels,
  parseOpenAiModels,
  sameModel,
  toEntry,
  assessLocality,
  type ListedModel,
} from './models.js';
import {
  ALLOWED_REQUESTS,
  NATIVE_PROFILE,
  OPENAI_COMPAT_PROFILE,
  structuredOutputTested,
  type ChatProfile,
} from './profiles.js';
import { mapNativeRequest, mapOpenAiRequest } from './requests.js';
import { openAiStreamCollector } from './stream.js';
import { summarizeEngines, unobservedVersions, type VersionSource } from './versions.js';

export interface LmStudioAdapterOptions {
  /** The explicitly approved loopback endpoint, ordinarily `http://127.0.0.1:1234`. */
  endpoint: string;
  /** Server token, supplied by the caller from secure storage. Never stored beyond the client. */
  credential?: string;
  /** Chat API: OpenAI-compatible (default) or the optional native instrumentation profile. */
  chatProfile?: ChatProfile;
  versions?: VersionSource;
  /** Deadline for discovery calls (not inference), in milliseconds. */
  discoveryTimeoutMs?: number;
}

type Listing = { models: ListedModel[]; source: 'native' | 'openai_compat' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** LM Studio adapter (BACKEND_PRD section 7.5). Reads models and runs chat; changes nothing. */
export class LmStudioAdapter implements RuntimeAdapter {
  readonly family = 'lmstudio' as const;
  private readonly client: LoopbackClient;
  private readonly chatProfile: ChatProfile;
  private readonly versions: VersionSource;
  private readonly discoveryTimeoutMs: number;
  private readonly registry = new RunRegistry();

  constructor(options: LmStudioAdapterOptions) {
    this.client = new LoopbackClient(
      options.credential === undefined
        ? { endpoint: options.endpoint }
        : { endpoint: options.endpoint, credential: options.credential },
    );
    this.chatProfile = options.chatProfile ?? 'openai_compat_v1';
    this.versions = options.versions ?? unobservedVersions;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 10_000;
  }

  /** Keep the client (and its token) out of serialization and logging. */
  toJSON(): { family: 'lmstudio'; chatProfile: ChatProfile } {
    return { family: this.family, chatProfile: this.chatProfile };
  }

  [inspect.custom](): string {
    return `LmStudioAdapter { chatProfile: '${this.chatProfile}' }`;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    if (!ALLOWED_REQUESTS.some((entry) => entry.method === method && entry.path === path)) {
      throw new AdapterError('path_not_allowed', 'the adapter never calls this endpoint');
    }
    return this.client.request(body === undefined ? { method, path, signal } : { method, path, body, signal });
  }

  private async stream(
    path: string,
    signal: AbortSignal,
    body: unknown,
    onLine: (line: string) => void,
  ): Promise<{ status: number; json: unknown }> {
    if (!ALLOWED_REQUESTS.some((entry) => entry.method === 'POST' && entry.path === path)) {
      throw new AdapterError('path_not_allowed', 'the adapter never calls this endpoint');
    }
    return this.client.stream({ method: 'POST', path, body, signal }, 'text/event-stream', onLine);
  }

  /** Native discovery first; the `/v1/models` fallback when it is absent or malformed. */
  private async discover(): Promise<Listing> {
    const signal = AbortSignal.timeout(this.discoveryTimeoutMs);
    const native = await this.call('GET', '/api/v1/models', signal).catch((cause: unknown) => {
      if (cause instanceof AdapterError && cause.code === 'malformed_response') return null;
      throw cause;
    });
    if (native && (native.status === 401 || native.status === 403)) {
      throw new AdapterError('unauthorized', 'the runtime rejected the server token');
    }
    if (native && native.status >= 200 && native.status < 300) {
      const models = parseNativeModels(native.json);
      if (models) return { models, source: 'native' };
    }
    const fallback = await this.call('GET', '/v1/models', AbortSignal.timeout(this.discoveryTimeoutMs));
    if (fallback.status === 401 || fallback.status === 403) {
      throw new AdapterError('unauthorized', 'the runtime rejected the server token');
    }
    const models = fallback.status >= 200 && fallback.status < 300 ? parseOpenAiModels(fallback.json) : null;
    if (!models) throw new AdapterError('malformed_response', 'model listing did not match the documented shape');
    return { models, source: 'openai_compat' };
  }

  async probe(): Promise<ProbeResult> {
    const versions = await this.versions.read();
    const base = {
      family: this.family,
      endpoint: this.client.endpoint,
      versions: {
        application: versions.application,
        cli: versions.cli,
        engine: summarizeEngines(versions.engines),
      },
    };
    try {
      const listing = await this.discover();
      return {
        ...base,
        api_profile: listing.source === 'native' ? NATIVE_PROFILE : OPENAI_COMPAT_PROFILE,
        reachable: true,
        failure: null,
      };
    } catch (cause) {
      return {
        ...base,
        api_profile: OPENAI_COMPAT_PROFILE,
        reachable: false,
        failure: cause instanceof AdapterError ? cause.code : 'connection_error',
      };
    }
  }

  async list_models(): Promise<ModelEntry[]> {
    const { models } = await this.discover();
    return models.filter((model) => model.type !== 'embedding').map((model) => toEntry(model, this.chatProfile));
  }

  async inspect_model(model: string): Promise<ModelDetails> {
    const { models } = await this.discover();
    const found = findModel(models, model);
    if (!found) throw new AdapterError('model_not_found', 'the runtime does not list this model');
    const options: ModelDetails['effective_options'] = {};
    const source = 'GET /api/v1/models';
    if (found.loadedContext !== null) options.context_length = { value: found.loadedContext, source };
    if (found.loadedParallel !== null) options.parallel = { value: found.loadedParallel, source };
    if (found.maxContext !== null) options.max_context_length = { value: found.maxContext, source };
    return {
      ...toEntry(found, this.chatProfile),
      quantization: found.quantization,
      format: found.format,
      effective_options: options,
    };
  }

  async preflight(request: PreflightRequest): Promise<PreflightResult> {
    const blockers: Finding[] = [];
    const unknowns: Finding[] = [];
    let listing: Listing;
    try {
      listing = await this.discover();
    } catch (cause) {
      const code = cause instanceof AdapterError ? cause.code : 'connection_error';
      blockers.push({ code: 'runtime_unreachable', message: `LM Studio did not answer (${code})` });
      return { ok: false, blockers, unknowns, effects: { may_load_model: false, model_state: null } };
    }

    const found = findModel(listing.models, request.model);
    if (!found) {
      blockers.push({ code: 'model_not_found', message: 'the model is not listed by the runtime' });
      return { ok: false, blockers, unknowns, effects: { may_load_model: false, model_state: null } };
    }
    const entry = toEntry(found, this.chatProfile);
    const { requirements } = request;
    const { settings } = requirements;

    const locality = assessLocality(found);
    if (locality.value === 'remote') {
      const finding: Finding = { code: 'model_remote', message: `model is not local (${locality.reason})` };
      (requirements.locality === 'local_required' ? blockers : unknowns).push(finding);
    } else if (locality.value === 'unknown') {
      const finding: Finding = {
        code: 'locality_unknown',
        message: `local execution cannot be established (${locality.reason})`,
      };
      (requirements.locality === 'local_required' ? blockers : unknowns).push(finding);
    }

    for (const name of requirements.capabilities) {
      const capability = entry.capabilities[name];
      if (capability.value === 'unsupported') {
        blockers.push({ code: 'capability_unsupported', message: `${name} is not supported by this model` });
      } else if (capability.value === 'unknown') {
        blockers.push({ code: 'capability_unknown', message: `${name} support is unknown for this model` });
      }
    }

    if (settings.stream && this.chatProfile === 'native_v1') {
      blockers.push({ code: 'stream_unsupported', message: 'the native profile has no tested streaming mapping' });
    }
    if (settings.reasoning !== 'default') {
      blockers.push({ code: 'option_unsupported', message: 'reasoning: disabled has no tested mapping' });
    }
    if (this.chatProfile === 'native_v1' && settings.seed !== null) {
      blockers.push({ code: 'option_unsupported', message: 'the native profile has no tested seed mapping' });
    }
    if (requirements.structured_output && !structuredOutputTested(this.chatProfile, found.format)) {
      blockers.push({
        code: 'profile_untested',
        message: `structured output is untested for ${this.chatProfile} with format ${found.format ?? 'unknown'}`,
      });
    }

    if (found.loaded && found.loadedContext !== null) {
      if (found.loadedContext < settings.context_tokens) {
        blockers.push({
          code: 'context_exceeded',
          message: `loaded context ${found.loadedContext} is below the required ${settings.context_tokens}`,
        });
      }
    } else if (found.maxContext !== null && found.maxContext < settings.context_tokens) {
      blockers.push({
        code: 'context_exceeded',
        message: `model maximum context ${found.maxContext} is below the required ${settings.context_tokens}`,
      });
    } else {
      unknowns.push({
        code: 'context_exceeded',
        message: 'context length is fixed when the model is loaded and is not yet known',
      });
    }

    return {
      ok: blockers.length === 0,
      blockers,
      unknowns,
      effects: { may_load_model: !found.loaded, model_state: entry.state },
    };
  }

  async infer(request: AdapterInferRequest, options: InferOptions): Promise<InferResponse> {
    // Map first: unsupported options fail before any request is made.
    let format: string | null = null;
    const needsFormat =
      this.chatProfile === 'openai_compat_v1' && request.responseSchema !== null && request.responseSchema !== undefined;
    if (needsFormat) {
      const { models } = await this.discover();
      const listed = findModel(models, request.model);
      if (!listed) throw new AdapterError('model_not_found', 'the runtime does not list this model');
      format = listed.format;
    }
    const body =
      this.chatProfile === 'native_v1'
        ? mapNativeRequest(request.model, request)
        : mapOpenAiRequest(request.model, request, format);

    const run = this.registry.begin(options.runId, options.signal);
    try {
      const path = this.chatProfile === 'native_v1' ? '/api/v1/chat' : '/v1/chat/completions';
      if (request.settings.stream) {
        const collector = openAiStreamCollector(request.model, options.onFirstContent);
        const streamed = await this.stream(path, run.signal, body, (line) => collector.push(line));
        this.throwForStatus(streamed.status, streamed.json);
        return collector.finish();
      }
      const response = await this.call('POST', path, run.signal, body);
      this.throwForStatus(response.status, response.json);
      return this.chatProfile === 'native_v1'
        ? parseNativeChat(request.model, response.json)
        : parseOpenAiChat(request.model, response.json);
    } finally {
      run.end();
    }
  }

  private throwForStatus(status: number, json: unknown): void {
    if (status >= 200 && status < 300) return;
    const code = isRecord(json) && isRecord(json.error) ? json.error.code : undefined;
    if (status === 404 && code === 'model_not_found') {
      throw new AdapterError('model_not_found', 'the runtime does not know this model');
    }
    if (status === 401 || status === 403) throw new AdapterError('unauthorized', 'the runtime rejected the server token');
    if (status === 404) throw new AdapterError('endpoint_not_found', 'the runtime does not offer this endpoint');
    throw new AdapterError('runtime_error', `the runtime answered HTTP ${status}`);
  }

  async cancel(runId: string): Promise<CancelResult> {
    return this.registry.cancel(runId);
  }

  async measure(_scope: MeasureScope): Promise<MeasureResult> {
    return SENSORS_UNSUPPORTED;
  }
}

const malformed = (what: string) => new AdapterError('malformed_response', `chat response ${what}`);

const OPENAI_USAGE: Array<[string, string]> = [
  ['prompt_tokens', 'usage_prompt_tokens'],
  ['completion_tokens', 'usage_completion_tokens'],
  ['total_tokens', 'usage_total_tokens'],
];

/**
 * `/v1/chat/completions` answers HTTP 200 with the loaded model when the
 * requested one does not exist (M0 fixture), so the returned model must match.
 */
export function parseOpenAiChat(requested: string, json: unknown): InferResponse {
  if (!isRecord(json)) throw malformed('is not an object');
  if (typeof json.model !== 'string' || json.model.length === 0) throw malformed('names no model');
  if (!sameModel(requested, json.model)) {
    throw new AdapterError('model_not_found', 'the runtime answered with a different model than requested');
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
    throw malformed('has no message content');
  }
  const stats: ProviderStats = { provider: 'lmstudio_openai_compat_v1' };
  if (typeof choice.finish_reason === 'string') stats.finish_reason = choice.finish_reason;
  if (isRecord(json.usage)) {
    for (const [from, to] of OPENAI_USAGE) {
      const value = json.usage[from];
      if (typeof value === 'number') stats[to] = value;
    }
  }
  return { content: choice.message.content, providerStats: stats };
}

const NATIVE_STATS: Array<[string, string]> = [
  ['tokens_per_second', 'provider_native.tokens_per_second'],
  ['time_to_first_token_seconds', 'provider_native.time_to_first_token_seconds'],
  ['input_tokens', 'provider_native.input_tokens'],
  ['total_output_tokens', 'provider_native.total_output_tokens'],
  ['reasoning_output_tokens', 'provider_native.reasoning_output_tokens'],
];

/** Native statistics stay tagged `provider_native.*` and are never merged with client timings. */
export function parseNativeChat(requested: string, json: unknown): InferResponse {
  if (!isRecord(json)) throw malformed('is not an object');
  if (typeof json.model_instance_id !== 'string' || json.model_instance_id.length === 0) {
    throw malformed('names no model instance');
  }
  if (!sameModel(requested, json.model_instance_id)) {
    throw new AdapterError('model_not_found', 'the runtime answered with a different model than requested');
  }
  if (!Array.isArray(json.output)) throw malformed('has no output');
  const parts: string[] = [];
  for (const item of json.output) {
    if (isRecord(item) && item.type === 'message' && typeof item.content === 'string') parts.push(item.content);
  }
  if (parts.length === 0) throw malformed('has no message content');
  const stats: ProviderStats = { provider: 'lmstudio_native_v1' };
  if (isRecord(json.stats)) {
    for (const [from, to] of NATIVE_STATS) {
      const value = json.stats[from];
      if (typeof value === 'number') stats[to] = value;
    }
  }
  return { content: parts.join(''), providerStats: stats };
}
