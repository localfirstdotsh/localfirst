import { EXAMPLE_TEST_YAML, parseSafeYaml, testManifestSchema } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { AdapterError, bindModel, runTest, type RuntimeAdapter } from '../src/index.js';
import { grant, settings, type ConformanceTarget } from './support/conformance.js';
import { ollamaTarget, LOCAL as OLLAMA_LOCAL } from './support/fake-ollama.js';
import { createLmStudioTarget } from './support/fake-lmstudio.js';

/**
 * Cross-adapter parity: the same scenarios against both real adapters (each
 * talking to its fake runtime over loopback HTTP) must give the same
 * normalized contract-level answer. This catches drift the per-adapter
 * conformance suite cannot, such as one runtime using a different blocker code.
 */
interface Side {
  name: string;
  target: ConformanceTarget;
  /** Make successful chat replies carry this model message content. */
  reply(content: string): void;
}

async function sides(): Promise<Side[]> {
  const ollama = await ollamaTarget();
  const lmstudio = await createLmStudioTarget();
  return [
    {
      name: 'ollama',
      target: ollama,
      reply: (content) => {
        ollama.fake.chat = () => ({
          json: {
            model: OLLAMA_LOCAL,
            created_at: '2026-10-11T00:00:00Z',
            message: { role: 'assistant', content },
            done: true,
            done_reason: 'stop',
            total_duration: 1_000_000,
            load_duration: 0,
            prompt_eval_count: 10,
            prompt_eval_duration: 1_000_000,
            eval_count: 5,
            eval_duration: 1_000_000,
          },
        });
      },
    },
    {
      name: 'lmstudio',
      target: lmstudio,
      reply: (content) => lmstudio.fake.setContent(content),
    },
  ];
}

/** Run `scenario` on every side and require identical normalized results. */
async function sameEverywhere<T>(scenario: (side: Side) => Promise<T>): Promise<T> {
  const all = await sides();
  try {
    const results = await Promise.all(all.map(async (side) => [side.name, await scenario(side)] as const));
    const [first, ...rest] = results;
    for (const other of rest) expect(other[1], `${other[0]} differs from ${first![0]}`).toEqual(first![1]);
    return first![1];
  } finally {
    await Promise.all(all.map((side) => side.target.close()));
  }
}

const requirements = (capabilities: string[], overrides: Partial<typeof settings> = {}) => ({
  capabilities: capabilities as never,
  locality: 'local_required' as const,
  settings: { ...settings, ...overrides },
  structured_output: false,
});

const codesOf = (side: Side, model: 'local' | 'remote' | 'missing', caps = ['chat'], overrides: Partial<typeof settings> = {}) =>
  side.target.adapter
    .preflight({ model: side.target.models[model], requirements: requirements(caps, overrides) })
    .then((result) => ({ ok: result.ok, blockers: result.blockers.map((b) => b.code).sort() }));

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (cause: unknown) => (cause instanceof AdapterError ? cause.code : `other:${String(cause)}`),
  );

const ask = (adapter: RuntimeAdapter, model: string, overrides: Partial<typeof settings> = {}, signal = new AbortController().signal) =>
  adapter.infer(
    { model, grant, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], responseSchema: null, settings: { ...settings, ...overrides } },
    { signal },
  );

describe('preflight parity', () => {
  it('accepts a healthy local chat model identically', async () => {
    expect(await sameEverywhere((side) => codesOf(side, 'local'))).toEqual({ ok: true, blockers: [] });
  });

  it('blocks a cloud or remote-linked model with the same code', async () => {
    const result = await sameEverywhere((side) => codesOf(side, 'remote'));
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain('model_remote');
  });

  it('blocks a missing model with model_not_found', async () => {
    expect(await sameEverywhere((side) => codesOf(side, 'missing'))).toEqual({ ok: false, blockers: ['model_not_found'] });
  });

  it('accepts streaming identically', async () => {
    expect(await sameEverywhere((side) => codesOf(side, 'local', ['chat'], { stream: true }))).toEqual({ ok: true, blockers: [] });
  });

  it('blocks a context larger than any model can offer with the same code', async () => {
    const result = await sameEverywhere((side) => codesOf(side, 'local', ['chat'], { context_tokens: 1_000_000 }));
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain('context_exceeded');
  });

  it('treats a capability the model lacks the same way', async () => {
    const result = await sameEverywhere((side) => codesOf(side, 'local', ['chat', 'audio_output']));
    expect(result.ok).toBe(false);
  });
});

describe('inventory and inspection parity', () => {
  it('reports the same entry shape, capability table, and locality for the local model', async () => {
    const shape = await sameEverywhere(async (side) => {
      const entries = await side.target.adapter.list_models();
      const local = entries.find((entry) => entry.runtime_model_id === side.target.models.local)!;
      const details = await side.target.adapter.inspect_model(side.target.models.local);
      return {
        entryKeys: Object.keys(local).sort(),
        detailKeys: Object.keys(details).sort(),
        capabilityNames: Object.keys(local.capabilities).sort(),
        locality: local.locality.value,
        chat: details.capabilities.chat.value,
        states: [...new Set(entries.map((entry) => entry.state))].every((state) => state === 'loaded' || state === 'available'),
      };
    });
    expect(shape.locality).toBe('local');
    expect(shape.chat).toBe('supported');
    expect(shape.capabilityNames).toHaveLength(9);
  });

  it('never reports a remote model as local', async () => {
    const localities = await Promise.all(
      (await sides()).map(async (side) => {
        try {
          return (await side.target.adapter.inspect_model(side.target.models.remote)).locality.value;
        } finally {
          await side.target.close();
        }
      }),
    );
    for (const locality of localities) expect(locality).not.toBe('local');
  });

  it('answers measure and cancel identically', async () => {
    expect(
      await sameEverywhere(async (side) => ({
        measure: await side.target.adapter.measure({ metric: 'peak_memory_bytes', intervalMs: 100 }),
        cancel: await side.target.adapter.cancel('not-running'),
      })),
    ).toEqual({
      measure: { status: 'unsupported', reason: 'sensors_not_implemented' },
      cancel: { cancelled: false, detail: 'no_active_run' },
    });
  });
});

describe('infer error parity', () => {
  it('maps a missing model and a malformed reply to the same codes', async () => {
    const codes = await sameEverywhere(async (side) => {
      const { adapter, models } = side.target;
      const missing = await errorCode(ask(adapter, models.missing));
      side.target.malformNext();
      const malformed = await errorCode(ask(adapter, models.local));
      return { missing, malformed };
    });
    expect(codes).toEqual({ missing: 'model_not_found', malformed: 'malformed_response' });
  });

  it('streams the same way: first content announced once, before the end, and a malformed stream maps to the same code', async () => {
    const outcome = await sameEverywhere(async (side) => {
      const { adapter, models } = side.target;
      const events: string[] = [];
      const response = await adapter.infer(
        { model: models.local, grant, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], responseSchema: null, settings: { ...settings, stream: true } },
        { signal: new AbortController().signal, onFirstContent: () => events.push('first') },
      );
      events.push('end');
      side.target.malformNext();
      const malformed = await errorCode(ask(adapter, models.local, { stream: true }));
      return { events, hasContent: response.content.length > 0, malformed };
    });
    expect(outcome).toEqual({ events: ['first', 'end'], hasContent: true, malformed: 'malformed_response' });
  });

  it('aborts a hung runtime the same way', async () => {
    const code = await sameEverywhere(async (side) => {
      side.target.hangNext();
      return errorCode(ask(side.target.adapter, side.target.models.local, {}, AbortSignal.timeout(60)));
    });
    expect(code).toBe('aborted');
  });
});

describe('end-to-end parity through the harness', () => {
  const manifest = testManifestSchema.parse(parseSafeYaml(EXAMPLE_TEST_YAML));

  const outcomeFor = (content: string) =>
    sameEverywhere(async (side) => {
      side.reply(content);
      const run = await runTest({ manifest, adapter: bindModel(side.target.adapter, side.target.models.local, grant) });
      expect(Object.keys(run.cases[0]!.provider_stats).length).toBeGreaterThan(0);
      expect(typeof run.cases[0]!.provider_stats.provider).toBe('string');
      return { state: run.state, cases: run.cases.map((c) => [c.key, c.outcome, c.error_code]) };
    });

  it('passes the PRD example for a conforming reply', async () => {
    expect(await outcomeFor('{"label":"billing"}')).toEqual({ state: 'completed', cases: [['billing-001', 'pass', null]] });
  });

  it('fails it for a wrong label and for non-JSON, with the same evaluator codes', async () => {
    expect((await outcomeFor('{"label":"support"}')).cases).toEqual([['billing-001', 'fail', 'value_mismatch']]);
    expect((await outcomeFor('billing')).cases).toEqual([['billing-001', 'fail', 'invalid_json']]);
  });
});
