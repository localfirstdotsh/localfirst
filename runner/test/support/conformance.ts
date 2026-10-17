import { MODEL_CAPABILITIES } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { AdapterError, type InferSettings, type RuntimeAdapter } from '../../src/index.js';

/**
 * Behaviour every runtime adapter must show, driven against a fake server for
 * that runtime. A target supplies the adapter plus three models (one local, one
 * remote/cloud, one that does not exist) and switches for misbehaviour.
 */
export interface ConformanceTarget {
  adapter: RuntimeAdapter;
  models: {
    /** Installed, local, text-chat capable. */
    local: string;
    /** Cloud or remote-linked: must never satisfy a local-only run. */
    remote: string;
    /** Not installed. */
    missing: string;
  };
  /** Whether this adapter profile maps `stream: true`. Otherwise it must refuse it explicitly. */
  streaming: boolean;
  /** A setting this adapter must refuse rather than drop (never `stream`). */
  unsupportedOption: Partial<InferSettings>;
  /** The next `infer` request never answers until aborted. */
  hangNext(): void;
  /** The next `infer` request answers with a body that violates the API. */
  malformNext(): void;
  close(): Promise<void>;
}

export interface Check {
  name: string;
  run(target: ConformanceTarget): Promise<void>;
}

export const grant = { plan_digest: `sha256:${'a'.repeat(64)}`, channel: 'interactive_tty' } as const;

export const settings: InferSettings = {
  temperature: 0,
  max_output_tokens: 32,
  context_tokens: 4096,
  concurrency: 1,
  stream: false,
  seed: null,
  reasoning: 'default',
};

const message = [{ role: 'user' as const, content: 'Reply with exactly: ok' }];

const requirements = (overrides: Partial<{ capabilities: never[]; stream: boolean }> = {}) => ({
  capabilities: (overrides.capabilities ?? ['chat']) as never,
  locality: 'local_required' as const,
  settings: { ...settings, stream: overrides.stream ?? false },
  structured_output: false,
});

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error, `expected rejection with ${code}`).toBeInstanceOf(AdapterError);
  expect((error as AdapterError).code).toBe(code);
}

export const CHECKS: Check[] = [
  {
    name: 'probe reports reachability; observed versions name a source and unknown ones stay null',
    async run({ adapter }) {
      const probe = await adapter.probe();
      expect(probe.family).toBe(adapter.family);
      expect(probe.reachable).toBe(true);
      expect(probe.failure).toBeNull();
      for (const fact of Object.values(probe.versions)) {
        // An observed value names its source; an unobserved one has neither.
        if (fact.value !== null) expect(typeof fact.source).toBe('string');
        else expect(fact.source).toBeNull();
      }
    },
  },
  {
    name: 'list_models separates loaded from available and exposes every capability with a source',
    async run({ adapter, models }) {
      const entries = await adapter.list_models();
      const local = entries.find((entry) => entry.runtime_model_id === models.local);
      expect(local).toBeDefined();
      expect(['loaded', 'available']).toContain(local?.state);
      for (const name of MODEL_CAPABILITIES) {
        const capability = local?.capabilities[name];
        expect(capability, name).toBeDefined();
        if (capability?.value !== 'unknown') expect(capability?.source, name).not.toBeNull();
      }
      expect(local?.locality.value).toBe('local');
    },
  },
  {
    name: 'inspect_model never reports a remote model as local',
    async run({ adapter, models }) {
      const remote = await adapter.inspect_model(models.remote);
      expect(remote.locality.value).not.toBe('local');
      const local = await adapter.inspect_model(models.local);
      expect(local.locality.value).toBe('local');
      expect(local.capabilities.chat.value).toBe('supported');
    },
  },
  {
    name: 'preflight accepts a local chat model without running inference',
    async run({ adapter, models }) {
      const before = await adapter.list_models();
      const result = await adapter.preflight({ model: models.local, requirements: requirements() });
      expect(result.blockers).toEqual([]);
      expect(result.ok).toBe(true);
      expect(['loaded', 'available']).toContain(result.effects.model_state);
      expect(await adapter.list_models()).toEqual(before);
    },
  },
  {
    name: 'preflight blocks a local-only run on a cloud or remote-linked model',
    async run({ adapter, models }) {
      const result = await adapter.preflight({ model: models.remote, requirements: requirements() });
      expect(result.ok).toBe(false);
      expect(result.blockers.map((blocker) => blocker.code).some((code) => code === 'model_remote' || code === 'locality_unknown')).toBe(true);
    },
  },
  {
    name: 'preflight blocks a missing model',
    async run({ adapter, models }) {
      const result = await adapter.preflight({ model: models.missing, requirements: requirements() });
      expect(result.ok).toBe(false);
      expect(result.blockers.map((blocker) => blocker.code)).toContain('model_not_found');
    },
  },
  {
    name: 'preflight maps streaming where the profile supports it, blocks it where not, and blocks capabilities the model lacks',
    async run({ adapter, models, streaming: supported }) {
      const streaming = await adapter.preflight({ model: models.local, requirements: requirements({ stream: true }) });
      const codes = streaming.blockers.map((blocker) => blocker.code);
      if (supported) {
        expect(codes).not.toContain('stream_unsupported');
        expect(streaming.ok).toBe(true);
      } else {
        expect(streaming.ok).toBe(false);
        expect(codes).toContain('stream_unsupported');
      }

      const audio = await adapter.preflight({ model: models.local, requirements: requirements({ capabilities: ['audio_output'] as never }) });
      expect(audio.ok).toBe(false);
      expect(audio.blockers.map((blocker) => blocker.code).some((code) => code === 'capability_unsupported' || code === 'capability_unknown')).toBe(true);
    },
  },
  {
    name: 'infer returns content and raw provider statistics for the requested model',
    async run({ adapter, models }) {
      const response = await adapter.infer(
        { model: models.local, grant, messages: message, responseSchema: null, settings },
        { signal: new AbortController().signal },
      );
      expect(typeof response.content).toBe('string');
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.providerStats).toBe('object');
    },
  },
  {
    name: 'infer on a missing model fails with model_not_found rather than answering from another model',
    async run({ adapter, models }) {
      await rejectsWith(
        adapter.infer({ model: models.missing, grant, messages: message, responseSchema: null, settings }, { signal: new AbortController().signal }),
        'model_not_found',
      );
    },
  },
  {
    name: 'infer fails on unsupported critical options',
    async run({ adapter, models, unsupportedOption }) {
      await rejectsWith(
        adapter.infer(
          { model: models.local, grant, messages: message, responseSchema: null, settings: { ...settings, ...unsupportedOption } },
          { signal: new AbortController().signal },
        ),
        'option_unsupported',
      );
    },
  },
  {
    name: 'infer streams where supported (first content announced once, before the reply ends) and refuses streaming where not',
    async run({ adapter, models, streaming }) {
      const request = { model: models.local, grant, messages: message, responseSchema: null, settings: { ...settings, stream: true } };
      if (!streaming) {
        await rejectsWith(adapter.infer(request, { signal: new AbortController().signal }), 'option_unsupported');
        return;
      }
      const events: string[] = [];
      const response = await adapter.infer(request, { signal: new AbortController().signal, onFirstContent: () => events.push('first') });
      events.push('done');
      expect(events).toEqual(['first', 'done']);
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.providerStats.provider).toBe('string');
    },
  },
  {
    name: 'infer never announces first content for a non-streamed request',
    async run({ adapter, models }) {
      let announced = 0;
      await adapter.infer(
        { model: models.local, grant, messages: message, responseSchema: null, settings },
        { signal: new AbortController().signal, onFirstContent: () => (announced += 1) },
      );
      expect(announced).toBe(0);
    },
  },
  {
    name: 'a malformed stream is malformed_response and an unanswered stream honours the abort signal',
    async run(target) {
      if (!target.streaming) return;
      const request = { model: target.models.local, grant, messages: message, responseSchema: null, settings: { ...settings, stream: true } };
      target.malformNext();
      await rejectsWith(target.adapter.infer(request, { signal: new AbortController().signal }), 'malformed_response');
      target.hangNext();
      const started = Date.now();
      await expect(target.adapter.infer(request, { signal: AbortSignal.timeout(80) })).rejects.toBeInstanceOf(AdapterError);
      expect(Date.now() - started).toBeLessThan(3000);
    },
  },
  {
    name: 'infer turns a malformed provider response into malformed_response',
    async run(target) {
      target.malformNext();
      await rejectsWith(
        target.adapter.infer({ model: target.models.local, grant, messages: message, responseSchema: null, settings }, { signal: new AbortController().signal }),
        'malformed_response',
      );
    },
  },
  {
    name: 'infer honours an abort signal on a hung runtime',
    async run(target) {
      target.hangNext();
      const started = Date.now();
      const pending = target.adapter.infer(
        { model: target.models.local, grant, messages: message, responseSchema: null, settings },
        { signal: AbortSignal.timeout(80) },
      );
      await expect(pending).rejects.toBeInstanceOf(AdapterError);
      expect(Date.now() - started).toBeLessThan(3000);
    },
  },
  {
    name: 'cancel aborts an active run once and reports an unknown run as not cancelled',
    async run(target) {
      target.hangNext();
      const pending = target.adapter.infer(
        { model: target.models.local, grant, messages: message, responseSchema: null, settings },
        { signal: AbortSignal.timeout(5000), runId: 'run-under-test' },
      );
      const outcome = pending.then(() => null, (cause: unknown) => cause);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await target.adapter.cancel('run-under-test')).toEqual({ cancelled: true, detail: 'aborted_request' });
      expect(await outcome).toBeInstanceOf(AdapterError);
      expect(await target.adapter.cancel('run-under-test')).toEqual({ cancelled: false, detail: 'no_active_run' });
      expect(await target.adapter.cancel('never-started')).toEqual({ cancelled: false, detail: 'no_active_run' });
    },
  },
  {
    name: 'measure reports unsupported with a reason until a sensor exists',
    async run({ adapter }) {
      const result = await adapter.measure({ metric: 'peak_memory_bytes', intervalMs: 100 });
      expect(result.status).toBe('unsupported');
      if (result.status === 'unsupported') expect(result.reason.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'a whole session leaves the model inventory unchanged',
    async run({ adapter, models }) {
      const before = await adapter.list_models();
      await adapter.inspect_model(models.local);
      await adapter.preflight({ model: models.local, requirements: requirements() });
      expect(await adapter.list_models()).toEqual(before);
    },
  },
];

/** Register the shared suite for one adapter. Each check gets a fresh target. */
export function runAdapterConformance(name: string, create: () => Promise<ConformanceTarget>): void {
  describe(`${name} conforms to the runtime adapter contract`, () => {
    for (const check of CHECKS) {
      it(check.name, async () => {
        const target = await create();
        try {
          await check.run(target);
        } finally {
          await target.close();
        }
      });
    }
  });
}
