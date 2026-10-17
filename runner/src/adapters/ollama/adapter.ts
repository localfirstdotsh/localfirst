import type { ModelCapability } from '@localfirst/contracts';
import {
  RunRegistry,
  SENSORS_UNSUPPORTED,
  unobserved,
  type CancelResult,
  type AdapterInferRequest,
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
import { ollamaStreamCollector } from './stream.js';
import { AdapterError, type InferResponse } from '../types.js';
import {
  OLLAMA_PROFILE,
  artifactIdentity,
  assessLocality,
  buildChatBody,
  contextLength,
  isRecord,
  mapCapabilities,
  sameModel,
  toProviderStats,
} from './mapping.js';

export interface OllamaAdapterOptions {
  /** The explicitly approved loopback endpoint, ordinarily http://127.0.0.1:11434. */
  endpoint: string;
  credential?: string;
  /** Timeout for metadata calls (version, tags, ps, show). */
  metadataTimeoutMs?: number;
}

type Json = Record<string, unknown>;

interface ModelFacts {
  context: number | null;
  supportsThinking: boolean;
}

const malformed = (what: string) => new AdapterError('malformed_response', `unexpected ${what} from Ollama`);

/**
 * Ollama native-API adapter (BACKEND_PRD section 7.4). Read-only toward the
 * server: it lists, inspects and chats, and never pulls, creates, copies,
 * deletes, or reconfigures anything.
 */
export class OllamaAdapter implements RuntimeAdapter {
  readonly family = 'ollama' as const;
  private readonly client: LoopbackClient;
  private readonly registry = new RunRegistry();
  private readonly metadataTimeoutMs: number;
  private readonly facts = new Map<string, ModelFacts>();

  constructor(options: OllamaAdapterOptions) {
    this.client = new LoopbackClient({ endpoint: options.endpoint, credential: options.credential });
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 10_000;
  }

  private metadataSignal(): AbortSignal {
    return AbortSignal.timeout(this.metadataTimeoutMs);
  }

  async probe(): Promise<ProbeResult> {
    const base = {
      family: 'ollama' as const,
      api_profile: OLLAMA_PROFILE,
      endpoint: this.client.endpoint,
      versions: { application: unobserved<string>(), cli: unobserved<string>(), engine: unobserved<string>() },
    };
    try {
      const { status, json } = await this.client.request({ method: 'GET', path: '/api/version', signal: this.metadataSignal() });
      if (status !== 200 || !isRecord(json) || typeof json.version !== 'string' || json.version.length === 0) {
        return { ...base, reachable: false, failure: 'malformed_response' };
      }
      return {
        ...base,
        reachable: true,
        versions: { ...base.versions, application: { value: json.version, source: 'GET /api/version' } },
        failure: null,
      };
    } catch (cause) {
      return { ...base, reachable: false, failure: cause instanceof AdapterError ? cause.code : 'connection_error' };
    }
  }

  private async getObject(path: string): Promise<Json> {
    const { status, json } = await this.client.request({ method: 'GET', path, signal: this.metadataSignal() });
    if (status !== 200 || !isRecord(json)) throw malformed(path);
    return json;
  }

  private async tags(): Promise<Json[]> {
    const body = await this.getObject('/api/tags');
    if (!Array.isArray(body.models)) throw malformed('/api/tags');
    return body.models.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') throw malformed('/api/tags entry');
      return entry;
    });
  }

  private async loaded(): Promise<Set<string>> {
    const body = await this.getObject('/api/ps');
    if (!Array.isArray(body.models)) throw malformed('/api/ps');
    const names = new Set<string>();
    for (const entry of body.models) {
      if (isRecord(entry) && typeof entry.model === 'string') names.add(entry.model);
      else if (isRecord(entry) && typeof entry.name === 'string') names.add(entry.name);
    }
    return names;
  }

  private async show(model: string, signal: AbortSignal = this.metadataSignal()): Promise<Json> {
    const { status, json } = await this.client.request({ method: 'POST', path: '/api/show', body: { model }, signal });
    if (status === 404) throw new AdapterError('model_not_found', `model \`${model}\` is not installed`);
    if (status !== 200 || !isRecord(json)) throw malformed('/api/show');
    return json;
  }

  private toEntry(tag: Json, loaded: Set<string>, show?: Json): ModelEntry {
    const name = tag.name as string;
    return {
      runtime_model_id: name,
      state: loaded.has(name) ? 'loaded' : 'available',
      artifact_identity: artifactIdentity(tag.digest),
      capabilities: mapCapabilities(show?.capabilities ?? tag.capabilities),
      context_tokens: contextLength(show, tag),
      size_bytes: typeof tag.size === 'number' ? tag.size : null,
      locality: assessLocality(name, tag, show),
    };
  }

  async list_models(): Promise<ModelEntry[]> {
    const [tags, loaded] = await Promise.all([this.tags(), this.loaded()]);
    return tags.map((tag) => this.toEntry(tag, loaded));
  }

  async inspect_model(model: string): Promise<ModelDetails> {
    const [tags, loaded] = await Promise.all([this.tags(), this.loaded()]);
    const tag = tags.find((entry) => entry.name === model || entry.model === model);
    if (!tag) throw new AdapterError('model_not_found', `model \`${model}\` is not installed`);
    const show = await this.show(tag.name as string);
    const details = isRecord(show.details) ? show.details : isRecord(tag.details) ? tag.details : {};
    this.facts.set(model, {
      context: contextLength(show, tag),
      supportsThinking: Array.isArray(show.capabilities) && show.capabilities.includes('thinking'),
    });
    const entry = this.toEntry(tag, loaded, show);
    const effective: ModelDetails['effective_options'] = {};
    const ctx = contextLength(show, tag);
    if (ctx !== null) effective.max_context_tokens = { value: ctx, source: 'POST /api/show' };
    return {
      ...entry,
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : null,
      format: typeof details.format === 'string' ? details.format : null,
      effective_options: effective,
    };
  }

  async preflight(request: PreflightRequest): Promise<PreflightResult> {
    const blockers: Finding[] = [];
    const unknowns: Finding[] = [];
    const none: PreflightResult['effects'] = { may_load_model: false, model_state: null };
    const { requirements } = request;

    let details: ModelDetails;
    try {
      details = await this.inspect_model(request.model);
    } catch (cause) {
      if (cause instanceof AdapterError && cause.code === 'model_not_found') {
        blockers.push({ code: 'model_not_found', message: `model \`${request.model}\` is not installed` });
      } else {
        blockers.push({
          code: 'runtime_unreachable',
          message: `Ollama could not be queried (${cause instanceof AdapterError ? cause.code : 'error'})`,
        });
      }
      return { ok: false, blockers, unknowns, effects: none };
    }

    const required = requirements.locality === 'local_required';
    if (details.locality.value === 'remote') {
      const finding: Finding = { code: 'model_remote', message: 'the model is served from a remote or cloud host' };
      (required ? blockers : unknowns).push(finding);
    } else if (details.locality.value === 'unknown') {
      const finding: Finding = { code: 'locality_unknown', message: 'local execution cannot be established for this model' };
      (required ? blockers : unknowns).push(finding);
    }

    const needed: ModelCapability[] = [...requirements.capabilities];
    if (requirements.structured_output && !needed.includes('json_output')) needed.push('json_output');
    for (const name of needed) {
      const capability = details.capabilities[name];
      if (capability.value === 'unsupported') {
        blockers.push({ code: 'capability_unsupported', message: `the model does not support ${name}` });
      } else if (capability.value === 'unknown') {
        blockers.push({ code: 'capability_unknown', message: `support for ${name} is not reported by Ollama` });
      }
    }

    if (details.context_tokens !== null && requirements.settings.context_tokens > details.context_tokens) {
      blockers.push({
        code: 'context_exceeded',
        message: `requested context ${requirements.settings.context_tokens} exceeds the model limit ${details.context_tokens}`,
      });
    } else if (details.context_tokens === null) {
      unknowns.push({ code: 'context_exceeded', message: 'the model context limit is not reported' });
    }

    return {
      ok: blockers.length === 0,
      blockers,
      unknowns,
      effects: { may_load_model: details.state === 'available', model_state: details.state },
    };
  }

  private async modelFacts(model: string, signal: AbortSignal): Promise<ModelFacts> {
    const cached = this.facts.get(model);
    if (cached) return cached;
    const tags = await this.tags();
    const tag = tags.find((entry) => entry.name === model || entry.model === model);
    if (!tag) throw new AdapterError('model_not_found', `model \`${model}\` is not installed`);
    const show = await this.show(tag.name as string, signal);
    const facts = {
      context: contextLength(show, tag),
      supportsThinking: Array.isArray(show.capabilities) && show.capabilities.includes('thinking'),
    };
    this.facts.set(model, facts);
    return facts;
  }

  async infer(request: AdapterInferRequest, options: InferOptions): Promise<InferResponse> {
    // Map first: an unmappable schema must fail before any network call.
    buildChatBody(request, false);

    const run = this.registry.begin(options.runId, options.signal);
    try {
      const facts = await this.modelFacts(request.model, run.signal);
      if (facts.context !== null && request.settings.context_tokens > facts.context) {
        throw new AdapterError('option_unsupported', 'requested context exceeds the model context limit');
      }
      const body = buildChatBody(request, facts.supportsThinking);
      if (request.settings.stream) {
        const collector = ollamaStreamCollector(request.model, options.onFirstContent);
        const { status, json } = await this.client.stream(
          { method: 'POST', path: '/api/chat', body, signal: run.signal },
          'application/x-ndjson',
          (line) => collector.push(line),
        );
        if (status === 404) throw new AdapterError('model_not_found', `model \`${request.model}\` is not installed`);
        if (status >= 400 || json !== null) {
          throw new AdapterError('provider_error', `Ollama rejected the request with status ${status}`);
        }
        return collector.finish();
      }
      const { status, json } = await this.client.request({ method: 'POST', path: '/api/chat', body, signal: run.signal });
      if (status === 404) throw new AdapterError('model_not_found', `model \`${request.model}\` is not installed`);
      if (status >= 400) {
        throw new AdapterError('provider_error', `Ollama rejected the request with status ${status}`);
      }
      if (!isRecord(json)) throw malformed('/api/chat body');
      if (typeof json.model !== 'string' || !sameModel(request.model, json.model)) {
        throw malformed('response model');
      }
      const message = json.message;
      if (!isRecord(message) || typeof message.content !== 'string') throw malformed('message');
      if (json.done !== true) throw malformed('incomplete response');
      return { content: message.content, providerStats: toProviderStats(json) };
    } finally {
      run.end();
    }
  }

  async cancel(runId: string): Promise<CancelResult> {
    return this.registry.cancel(runId);
  }

  async measure(_scope: MeasureScope): Promise<MeasureResult> {
    return SENSORS_UNSUPPORTED;
  }
}
