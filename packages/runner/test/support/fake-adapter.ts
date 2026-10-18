import {
  AdapterError,
  RunRegistry,
  SENSORS_UNSUPPORTED,
  capabilityTable,
  unobserved,
  type ModelEntry,
  type RuntimeAdapter,
} from '../../src/index.js';
import type { ConformanceTarget } from './conformance.js';

export interface FakeFlaws {
  /** Reports the remote model as local. */
  remoteAsLocal?: boolean;
  /** Answers a missing model from the loaded one instead of failing. */
  substituteMissing?: boolean;
  /** Silently drops stream:true. */
  dropStream?: boolean;
  /** Pulls the model during preflight. */
  mutatesInventory?: boolean;
}

/** In-memory adapter that satisfies the contract, with optional deliberate flaws. */
export function createFakeTarget(flaws: FakeFlaws = {}): ConformanceTarget {
  const models = { local: 'fake-local:1b', remote: 'fake-cloud:latest', missing: 'nope:0b' };
  let inventory: ModelEntry[] = [
    entry(models.local, 'loaded', 'local'),
    entry(models.remote, 'available', flaws.remoteAsLocal ? 'local' : 'remote'),
  ];
  let hang = false;
  let malformed = false;
  const registry = new RunRegistry();

  const adapter: RuntimeAdapter = {
    family: 'ollama',
    async probe() {
      return {
        family: 'ollama',
        api_profile: 'fake/v0',
        endpoint: 'http://127.0.0.1:1',
        reachable: true,
        versions: {
          application: { value: '0.0.0-fake', source: 'fake' },
          cli: unobserved(),
          engine: unobserved(),
        },
        failure: null,
      };
    },
    async list_models() {
      return structuredClone(inventory);
    },
    async inspect_model(model) {
      const found = inventory.find((item) => item.runtime_model_id === model);
      if (!found) throw new AdapterError('model_not_found', 'no such model');
      return { ...structuredClone(found), quantization: null, format: null, effective_options: {} };
    },
    async preflight({ model, requirements }) {
      if (flaws.mutatesInventory) inventory = [...inventory, entry('pulled:1b', 'available', 'local')];
      const blockers: Array<{ code: any; message: string }> = [];
      const found = inventory.find((item) => item.runtime_model_id === model);
      if (!found) blockers.push({ code: 'model_not_found', message: 'not installed' });
      else {
        if (found.locality.value === 'remote') blockers.push({ code: 'model_remote', message: 'cloud model' });
        for (const name of requirements.capabilities) {
          const capability = found.capabilities[name];
          if (capability.value === 'unsupported') blockers.push({ code: 'capability_unsupported', message: name });
          else if (capability.value === 'unknown') blockers.push({ code: 'capability_unknown', message: name });
        }
      }
      if (requirements.settings.stream && !flaws.dropStream) {
        blockers.push({ code: 'stream_unsupported', message: 'streaming not supported' });
      }
      return {
        ok: blockers.length === 0,
        blockers,
        unknowns: [],
        effects: { may_load_model: found?.state === 'available', model_state: found?.state ?? null },
      };
    },
    async infer(request, { signal, runId }) {
      if (request.settings.stream && !flaws.dropStream) {
        throw new AdapterError('option_unsupported', 'streaming not supported');
      }
      if (request.settings.context_tokens > 8192) {
        throw new AdapterError('option_unsupported', 'context window too large');
      }
      const exists = inventory.some((item) => item.runtime_model_id === request.model);
      if (!exists && !flaws.substituteMissing) throw new AdapterError('model_not_found', 'no such model');
      const run = registry.begin(runId, signal);
      try {
        if (hang) {
          hang = false;
          await new Promise<never>((_, reject) => {
            run.signal.addEventListener('abort', () => reject(new AdapterError('aborted', 'aborted')), { once: true });
          });
        }
        if (malformed) {
          malformed = false;
          throw new AdapterError('malformed_response', 'bad body');
        }
        return { content: 'ok', providerStats: { eval_count: 1 } };
      } finally {
        run.end();
      }
    },
    async cancel(runId) {
      return registry.cancel(runId);
    },
    async measure() {
      return SENSORS_UNSUPPORTED;
    },
  };

  return {
    adapter,
    models,
    hangNext: () => void (hang = true),
    malformNext: () => void (malformed = true),
    // The in-memory profile has no streaming mapping, so it must refuse it explicitly.
    streaming: false,
    unsupportedOption: { context_tokens: 1_000_000 },
    close: async () => undefined,
  };
}

function entry(id: string, state: ModelEntry['state'], locality: 'local' | 'remote'): ModelEntry {
  return {
    runtime_model_id: id,
    state,
    artifact_identity: null,
    capabilities: capabilityTable({
      chat: { value: 'supported', source: 'provider_metadata' },
      audio_output: { value: 'unsupported', source: 'provider_metadata' },
    }),
    context_tokens: 4096,
    size_bytes: 1,
    locality: { value: locality, method: 'adapter_preflight', reason: locality === 'remote' ? 'cloud_model' : null },
  };
}
