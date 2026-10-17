import { EXAMPLE_TEST_YAML, validateProjectBundle, type LocalPlanBody, type LocalReport } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { bindModel, buildLocalReport, compareReports, runTest, type InferenceAdapter, type ProviderStats } from '../src/index.js';
import { grant } from './support/conformance.js';
import { createLmStudioTarget } from './support/fake-lmstudio.js';
import { ollamaTarget } from './support/fake-ollama.js';
import { bundleWithTestYaml, exampleBundle, planFor } from './helpers.js';

const good = '{"label":"billing"}';
const HARDWARE = {
  platform: 'apple-silicon',
  os: { name: 'macos' as const, version: '26.0' },
  cpu_architecture: 'arm64' as const,
  cpu_model: null,
  memory_bytes: 17_179_869_184,
  unified_memory: true,
  accelerators: [],
};
const OLLAMA_STATS: ProviderStats = {
  provider: 'ollama_native_v1',
  derived_tokens_per_second: 250,
  load_duration: 0,
  prompt_eval_cached_count: 0,
};

interface Spec {
  id?: string;
  bundle?: ReturnType<typeof bundleWithTestYaml>;
  plan?: (body: LocalPlanBody) => void;
  reply?: string | (() => never);
  stats?: ProviderStats;
  hardware?: LocalReport['hardware'];
  modelStateBefore?: 'loaded' | 'available';
}

let counter = 0;
async function make(spec: Spec = {}): Promise<LocalReport> {
  counter += 1;
  const bundle = spec.bundle ?? exampleBundle;
  const manifest = validateProjectBundle(bundle).tests[0]!.manifest;
  const adapter: InferenceAdapter = {
    async infer() {
      if (typeof spec.reply === 'function') spec.reply();
      return { content: spec.reply ?? good, providerStats: spec.stats ?? OLLAMA_STATS };
    },
  };
  const run = await runTest({ manifest, adapter });
  return buildLocalReport({
    plan: planFor(bundle, spec.plan),
    manifest,
    run,
    clientRunId: spec.id ?? `run_compare_${String(counter).padStart(4, '0')}`,
    completedAt: '2026-10-11T20:00:00Z',
    hardware: spec.hardware === undefined ? HARDWARE : spec.hardware,
    observed: { modelStateBefore: spec.modelStateBefore ?? 'loaded' },
  });
}

const codes = (items: Array<{ code: string }>) => items.map((item) => item.code).sort();
const edited = (from: string, to: string) => {
  expect(EXAMPLE_TEST_YAML).toContain(from);
  return bundleWithTestYaml(EXAMPLE_TEST_YAML.replace(from, to));
};

describe('compareReports: eligible pairs', () => {
  it('matches two independent runs of the same configuration on every protocol dimension', async () => {
    const result = compareReports(await make(), await make());
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.confounders).toEqual([]);
    expect(result.varies).toEqual([]);
    expect(result.dimensions.every((entry) => entry.status === 'match')).toBe(true);
    expect(result.metrics.find((entry) => entry.metric === 'latency_ms')).toMatchObject({ comparable: true });
    expect(result.metrics.find((entry) => entry.metric === 'tokens_per_second')).toMatchObject({ comparable: true });
    expect(codes(result.caveats)).toEqual([]);
  });

  it('records the declared variable instead of calling it a confounder', async () => {
    const other = (body: LocalPlanBody) => {
      body.model.runtime_model_id = 'qwen3.6:27b';
      body.model.artifact_identity = { scheme: 'ollama_manifest_sha256', digest: `sha256:${'7'.repeat(64)}`, reference: null };
    };
    const varied = compareReports(await make(), await make({ plan: other }), { intentionallyVaries: ['model'] });
    expect(varied.eligible).toBe(true);
    expect(varied.varies).toEqual(['model']);
    expect(varied.confounders).toEqual([]);
    expect(varied.dimensions.find((entry) => entry.dimension === 'model')?.status).toBe('differs');
    expect(codes(varied.caveats)).toContain('tokenizer_differs_across_models');

    const undeclared = compareReports(await make(), await make({ plan: other }));
    expect(undeclared.eligible).toBe(true);
    expect(codes(undeclared.confounders)).toEqual(['model_differs']);
    expect(undeclared.varies).toEqual([]);
  });

  it('treats differing known settings, runtime versions, and hardware as confounders unless declared', async () => {
    const a = await make();
    const b = await make({
      plan: (body) => {
        body.settings.temperature = 0.7;
        body.runtime.application_version = '0.36.0';
      },
      hardware: { ...HARDWARE, memory_bytes: 8_589_934_592 },
    });
    const undeclared = compareReports(a, b);
    expect(undeclared.eligible).toBe(true);
    expect(codes(undeclared.confounders)).toEqual(['hardware_differs', 'runtime_differs', 'settings_differ']);

    const declared = compareReports(a, b, { intentionallyVaries: ['settings', 'runtime', 'hardware'] });
    expect(declared.confounders).toEqual([]);
    expect([...declared.varies].sort()).toEqual(['hardware', 'runtime', 'settings']);
  });

  it('flags an unknown application version because a version match cannot be confirmed', async () => {
    const result = compareReports(await make({ plan: (body) => (body.runtime.application_version = null) }), await make({ plan: (body) => (body.runtime.application_version = null) }));
    expect(result.eligible).toBe(true);
    expect(codes(result.confounders)).toEqual(['runtime_version_unknown']);
    expect(result.dimensions.find((entry) => entry.dimension === 'runtime')?.status).toBe('unknown');
  });

  it('makes no hardware claim when hardware was not collected', async () => {
    const result = compareReports(await make({ hardware: null }), await make());
    expect(result.eligible).toBe(true);
    expect(result.dimensions.find((entry) => entry.dimension === 'hardware')).toMatchObject({ status: 'unknown', a: null });
    expect(codes(result.caveats)).toEqual(['hardware_unknown']);
  });

  it('is symmetric in eligibility and reason codes', async () => {
    const a = await make();
    const b = await make({ bundle: edited('Please explain the charge on my invoice.', 'Cancel my account.') });
    const forward = compareReports(a, b);
    const backward = compareReports(b, a);
    expect(forward.eligible).toBe(false);
    expect(backward.eligible).toBe(false);
    expect(codes(forward.reasons)).toEqual(codes(backward.reasons));
  });

  it('returns reasons and facts only, never a score', async () => {
    const result = compareReports(await make(), await make());
    expect(Object.keys(result).sort()).toEqual(['caveats', 'confounders', 'dimensions', 'eligible', 'metrics', 'reasons', 'varies']);
    expect(JSON.stringify(result)).not.toMatch(/score|rank|better/i);
  });

  it('notes when both reports are the same run', async () => {
    const same = await make({ id: 'run_compare_same' });
    expect(codes(compareReports(same, same).caveats)).toContain('same_run');
  });
});

describe('compareReports: hard exclusions', () => {
  it('excludes different fixtures, manifests, and evaluators with their own codes', async () => {
    const a = await make();
    const fixture = compareReports(a, await make({ bundle: edited('Please explain the charge on my invoice.', 'Cancel my account.') }));
    expect(fixture.eligible).toBe(false);
    expect(codes(fixture.reasons)).toEqual(expect.arrayContaining(['fixture_digest_differs', 'test_digest_differs']));
    expect(codes(fixture.reasons)).not.toContain('evaluator_differs');

    const evaluator = compareReports(a, await make({ bundle: edited('equals: billing', 'equals: support'), reply: '{"label":"support"}' }));
    expect(codes(evaluator.reasons)).toEqual(expect.arrayContaining(['evaluator_differs', 'test_digest_differs']));
    expect(codes(evaluator.reasons)).not.toContain('fixture_digest_differs');
  });

  it('excludes private local runs', async () => {
    const result = compareReports(await make(), await make({ plan: (body) => (body.data_class = 'private_local') }));
    expect(result.eligible).toBe(false);
    expect(codes(result.reasons)).toEqual(['private_fixture']);
  });

  it('excludes partial, skipped, and errored reports', async () => {
    const a = await make();
    const partial: LocalReport = { ...a, execution_state: 'cancelled_partial', outcome: 'cancelled' };
    expect(codes(compareReports(a, partial).reasons)).toEqual(['incomplete_report']);
    const skipped: LocalReport = { ...a, counts: { ...a.counts, skipped: 1, evaluated: 0, passed: 0 } };
    expect(codes(compareReports(skipped, a).reasons)).toEqual(['incomplete_report']);
    const errored = await make({ reply: (() => { throw new Error('boom'); }) as () => never });
    expect(errored.counts.errors).toBe(1);
    expect(codes(compareReports(a, errored).reasons)).toEqual(['case_errors']);
  });

  it('excludes unknown effective settings but treats an unseeded run as known', async () => {
    const a = await make();
    expect(a.plan.settings.seed).toBeNull();
    for (const edit of [
      (body: LocalPlanBody) => (body.settings.temperature = null),
      (body: LocalPlanBody) => (body.settings.context_tokens = null),
      (body: LocalPlanBody) => (body.settings.reasoning = 'unknown'),
    ]) {
      const result = compareReports(a, await make({ plan: edit }));
      expect(result.eligible).toBe(false);
      expect(codes(result.reasons)).toEqual(['settings_unknown']);
    }
    expect(compareReports(a, await make({ plan: (body) => (body.settings.seed = 7) })).eligible).toBe(true);
  });

  it('excludes a missing model artifact identity', async () => {
    const noIdentity = await make({ plan: (body) => (body.model.artifact_identity = null) });
    expect(codes(compareReports(await make(), noIdentity).reasons)).toEqual(['artifact_identity_missing']);
  });

  it('excludes a different runner contract, scope, or measurement protocol', async () => {
    const a = await make();
    expect(codes(compareReports(a, { ...a, runner: { ...a.runner, contract: 'localfirst/runner/v9' as never } }).reasons)).toEqual(['runner_contract_differs']);
    const workflow = { ...a, scope: 'workflow' as const };
    expect(codes(compareReports(a, workflow).reasons)).toEqual(['scope_differs', 'unsupported_scope']);
    const repeats = { ...a, measurement_context: { ...a.measurement_context, repetitions: 3 } };
    expect(codes(compareReports(a, repeats).reasons)).toEqual(['measurement_protocol_differs']);
    const warmups = { ...a, measurement_context: { ...a.measurement_context, warmup_runs: 2 } };
    expect(codes(compareReports(a, warmups).reasons)).toEqual(['measurement_protocol_differs']);
  });

  it('refuses a declared hardware comparison when hardware was not collected', async () => {
    const result = compareReports(await make({ hardware: null }), await make(), { intentionallyVaries: ['hardware'] });
    expect(result.eligible).toBe(false);
    expect(codes(result.reasons)).toEqual(['hardware_unknown']);
  });

  it('rejects an unknown comparison variable', async () => {
    expect(() => compareReports({} as LocalReport, {} as LocalReport, { intentionallyVaries: ['speed' as never] })).toThrow(RangeError);
  });
});

describe('compareReports: per-metric comparability', () => {
  it('judges each metric separately and names the reason', async () => {
    const lm: ProviderStats = { provider: 'lmstudio_native_v1', 'provider_native.tokens_per_second': 263 };
    const result = compareReports(await make(), await make({ stats: lm }));
    expect(result.eligible).toBe(true);
    const byName = Object.fromEntries(result.metrics.map((entry) => [entry.metric, entry]));
    expect(byName.latency_ms).toMatchObject({ comparable: true });
    expect(byName.tokens_per_second).toMatchObject({ comparable: false, reason: 'method_differs', method_a: 'provider_ollama_eval_duration_v1', method_b: 'provider_lmstudio_native_stats_v1' });
    expect(byName.peak_memory_bytes).toMatchObject({ comparable: false, reason: 'metric_unavailable' });
    expect(byName.time_to_first_token_ms).toMatchObject({ comparable: false, reason: 'metric_unavailable' });
  });

  it('reports a metric available in only one report', async () => {
    const compat: ProviderStats = { provider: 'lmstudio_openai_compat_v1' };
    const result = compareReports(await make(), await make({ stats: compat }));
    expect(result.metrics.find((entry) => entry.metric === 'tokens_per_second')).toMatchObject({ comparable: false, reason: 'metric_unavailable_in_one_report' });
  });

  it('refuses to compare latency across a cold and a loaded model, but keeps the rest', async () => {
    const cold = await make({ modelStateBefore: 'available', stats: { ...OLLAMA_STATS, load_duration: 1_300_000_000 } });
    const loaded = await make();
    expect(cold.measurement_context.load_state).toBe('cold');
    const result = compareReports(cold, loaded);
    expect(result.eligible).toBe(true);
    expect(result.metrics.find((entry) => entry.metric === 'latency_ms')).toMatchObject({ comparable: false, reason: 'load_state_differs' });
    expect(result.metrics.find((entry) => entry.metric === 'tokens_per_second')).toMatchObject({ comparable: true });

    const warm = await make({ stats: { ...OLLAMA_STATS, prompt_eval_cached_count: 24 } });
    const coldCache = await make();
    expect(compareReports(warm, coldCache).metrics.find((entry) => entry.metric === 'latency_ms')).toMatchObject({ reason: 'cache_state_differs' });
  });

  it('notes unknown load and cache state without excluding the pair', async () => {
    const unknown = await make({ stats: { provider: 'lmstudio_openai_compat_v1' }, modelStateBefore: 'available' });
    const result = compareReports(unknown, unknown);
    expect(result.eligible).toBe(true);
    expect(codes(result.caveats)).toEqual(expect.arrayContaining(['cache_state_unknown', 'load_state_unknown', 'same_run']));
  });
});

describe('end to end through both fake runtimes', () => {
  async function ollamaReport(model: string, id: string, bundle = exampleBundle): Promise<LocalReport> {
    const target = await ollamaTarget();
    try {
      target.fake.chat = (body) => ({
        json: {
          model: body.model,
          created_at: '2026-10-11T00:00:00Z',
          message: { role: 'assistant', content: good },
          done: true,
          done_reason: 'stop',
          total_duration: 2_000_000,
          load_duration: 0,
          prompt_eval_count: 10,
          prompt_eval_duration: 1_000_000,
          eval_count: 5,
          eval_duration: 1_000_000,
        },
      });
      const gate = await target.adapter.preflight({
        model,
        requirements: { capabilities: ['chat'], locality: 'local_required', settings: validateProjectBundle(bundle).tests[0]!.manifest.inference, structured_output: false },
      });
      expect(gate.ok).toBe(true);
      const manifest = validateProjectBundle(bundle).tests[0]!.manifest;
      const run = await runTest({ manifest, adapter: bindModel(target.adapter, model, grant) });
      return buildLocalReport({
        plan: planFor(bundle, (body) => {
          body.runtime.family = 'ollama';
          body.model.runtime_model_id = model;
          body.model.artifact_identity = { scheme: 'ollama_manifest_sha256', digest: `sha256:${model.length.toString(16).padStart(64, 'a')}`, reference: null };
        }),
        manifest,
        run,
        clientRunId: id,
        completedAt: '2026-10-11T20:00:00Z',
        hardware: HARDWARE,
        observed: { modelStateBefore: gate.effects.model_state },
      });
    } finally {
      await target.close();
    }
  }

  async function lmStudioReport(id: string): Promise<LocalReport> {
    const target = await createLmStudioTarget();
    try {
      target.fake.setContent(good);
      const manifest = validateProjectBundle(exampleBundle).tests[0]!.manifest;
      const run = await runTest({ manifest, adapter: bindModel(target.adapter, target.models.local, grant) });
      return buildLocalReport({
        plan: planFor(exampleBundle, (body) => {
          body.runtime.family = 'lmstudio';
          body.runtime.application_version = '0.4.20+1';
          body.runtime.adapter_profile = 'lmstudio-openai-compat/v0.1';
          body.model.runtime_model_id = target.models.local;
          body.model.artifact_identity = { scheme: 'lmstudio_model_key', digest: null, reference: target.models.local };
        }),
        manifest,
        run,
        clientRunId: id,
        completedAt: '2026-10-11T20:00:00Z',
        hardware: HARDWARE,
        observed: { modelStateBefore: 'loaded' },
      });
    } finally {
      await target.close();
    }
  }

  it('Ollama twice on the same model: eligible, nothing differs, rate and latency comparable (cache evidence absent from the reply stays unknown)', async () => {
    const first = await ollamaReport('qwen2.5:1.5b', 'run_e2e_ollama_1');
    const second = await ollamaReport('qwen2.5:1.5b', 'run_e2e_ollama_2');
    expect(first.measurements.tokens_per_second).toMatchObject({ method: 'provider_ollama_eval_duration_v1', samples: 1 });
    expect(first.measurements.tokens_per_second.value).toBeCloseTo(5000, 3);
    const result = compareReports(first, second);
    expect(result.eligible).toBe(true);
    expect(result.confounders).toEqual([]);
    expect(result.dimensions.filter((entry) => entry.status !== 'match').map((entry) => entry.dimension)).toEqual(['cache_state']);
    expect(result.metrics.filter((entry) => entry.comparable).map((entry) => entry.metric)).toEqual(['latency_ms', 'tokens_per_second']);
  });

  it('two Ollama models with the model declared as the variable: eligible and varied', async () => {
    const small = await ollamaReport('qwen2.5:1.5b', 'run_e2e_model_1');
    const other = await ollamaReport('thinker:7b', 'run_e2e_model_2');
    const result = compareReports(small, other, { intentionallyVaries: ['model'] });
    expect(result.eligible).toBe(true);
    expect(result.varies).toEqual(['model']);
    expect(codes(result.caveats)).toContain('tokenizer_differs_across_models');
  });

  it('Ollama versus LM Studio with model and runtime declared: eligible, token rate only on one side', async () => {
    const ollama = await ollamaReport('qwen2.5:1.5b', 'run_e2e_cross_1');
    const lmstudio = await lmStudioReport('run_e2e_cross_2');
    expect(lmstudio.measurements.tokens_per_second).toEqual({ value: null, reason: 'generation_interval_not_exported' });
    const result = compareReports(ollama, lmstudio, { intentionallyVaries: ['model', 'runtime'] });
    expect(result.eligible).toBe(true);
    expect([...result.varies].sort()).toEqual(['model', 'runtime']);
    expect(result.metrics.find((entry) => entry.metric === 'tokens_per_second')).toMatchObject({ comparable: false, reason: 'metric_unavailable_in_one_report' });
    expect(result.metrics.find((entry) => entry.metric === 'latency_ms')).toMatchObject({ comparable: true });
  });

  it('a different fixture on one side makes the pair ineligible', async () => {
    const original = await ollamaReport('qwen2.5:1.5b', 'run_e2e_fixture_1');
    const changed = await ollamaReport('qwen2.5:1.5b', 'run_e2e_fixture_2', edited('Please explain the charge on my invoice.', 'Cancel my account.'));
    const result = compareReports(original, changed);
    expect(result.eligible).toBe(false);
    expect(codes(result.reasons)).toContain('fixture_digest_differs');
  });
});
