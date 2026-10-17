import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  EXAMPLE_BUILD_RECORD,
  EXAMPLE_BUILD_REPORT,
  EXAMPLE_TEST_RESULT,
  EXAMPLE_TEST_YAML,
  buildInputSchema,
  buildJsonSchema,
  buildRecordSchema,
  buildReportJsonSchema,
  buildReportSchema,
  computePlanDigest,
  exportSanitizedResult,
  localPlanSchema,
  localReportSchema,
  measurementsSchema,
  nanosecondsToMilliseconds,
  sealLocalPlan,
  testDigests,
  testManifestSchema,
  testResultJsonSchema,
  testResultSchema,
  testResultSubmissionSchema,
  tokensPerSecond,
  type LocalPlanBody,
} from './index.js';

const clone = <T>(value: T): T => structuredClone(value);
const manifest = testManifestSchema.parse(parseYaml(EXAMPLE_TEST_YAML));

function serverFieldsRemoved() {
  const { id: _id, visibility: _visibility, reproducibility: _reproducibility, ...input } = EXAMPLE_BUILD_RECORD;
  void _id;
  void _visibility;
  void _reproducibility;
  return input;
}

describe('PRD examples', () => {
  it('parses the saved build, including server-only fields', () => {
    const record = buildRecordSchema.parse(EXAMPLE_BUILD_RECORD);
    expect(record.runtime.cli_version).toBeNull();
    expect(record.model_bindings[0]?.artifact_identity?.scheme).toBe('ollama_manifest_sha256');
  });

  it('accepts the build as client input only without server-only fields', () => {
    expect(buildInputSchema.safeParse(serverFieldsRemoved()).success).toBe(true);
    expect(buildInputSchema.safeParse(EXAMPLE_BUILD_RECORD).success).toBe(false);
    for (const field of ['id', 'visibility', 'reproducibility']) {
      expect(buildInputSchema.safeParse({ ...serverFieldsRemoved(), [field]: 'x' }).success).toBe(false);
    }
  });

  it('parses the sanitized test result and the manual report', () => {
    expect(testResultSchema.parse(EXAMPLE_TEST_RESULT).outcome).toBe('pass');
    expect(buildReportSchema.parse(EXAMPLE_BUILD_REPORT).outcome).toBe('partial');
  });

  it('accepts an inline manual report on a build', () => {
    const build = { ...serverFieldsRemoved(), manual_report: EXAMPLE_BUILD_REPORT };
    expect(buildInputSchema.parse(build).manual_report?.client_run_id).toBe('manual_example_001');
  });

  it('keeps keys, cases, settings, and roles consistent across the examples', () => {
    const build = buildRecordSchema.parse(EXAMPLE_BUILD_RECORD);
    const result = testResultSchema.parse(EXAMPLE_TEST_RESULT);
    const caseKeys = manifest.cases.map((testCase) => testCase.key);

    expect(result.test_key).toBe(manifest.key);
    expect(result.scope).toBe(manifest.scope);
    expect(result.fixture_kind).toBe(manifest.fixture_kind);
    expect(result.runner.contract).toBe(manifest.runner_contract);
    expect(build.configuration_key).toBe(manifest.configuration_key);
    expect(build.model_bindings.map((binding) => binding.role)).toContain(manifest.model_role);
    expect(build.effective_settings).toEqual(manifest.inference);
    expect(build.project_id).toBe(result.project_id);
    expect(build.project_version_id).toBe(result.project_version_id);
    expect(result.build_id).toBe(build.id);
    for (const entry of result.case_results) expect(caseKeys).toContain(entry.key);
    expect(result.counts.defined).toBe(manifest.cases.length * manifest.measurement.repetitions);
    expect(result.measurement_context.repetitions).toBe(manifest.measurement.repetitions);
    expect(result.measurement_context.warmup_runs).toBe(manifest.measurement.warmup_runs);
    expect(new Set(manifest.cases.map((testCase) => testCase.evaluation.kind))).toEqual(
      new Set([result.evaluator.kind]),
    );
  });

  it('uses placeholder digests in the PRD result that are well formed but not derived', () => {
    const derived = testDigests(manifest);
    expect(derived.manifest_digest).not.toBe(EXAMPLE_TEST_RESULT.test_manifest_digest);
    expect(derived.fixture_digest).not.toBe(EXAMPLE_TEST_RESULT.fixture_digest);
  });
});

describe('test digests', () => {
  it('hashes manifest, fixtures, and evaluator independently', () => {
    const base = testDigests(manifest);
    expect(new Set(Object.values(base)).size).toBe(3);

    const editedPrompt = clone(manifest);
    editedPrompt.cases[0]!.messages[1]!.content = 'Different request text.';
    const prompt = testDigests(editedPrompt);
    expect(prompt.fixture_digest).not.toBe(base.fixture_digest);
    expect(prompt.manifest_digest).not.toBe(base.manifest_digest);
    expect(prompt.evaluator_digest).toBe(base.evaluator_digest);

    const editedEvaluator = clone(manifest);
    editedEvaluator.cases[0]!.evaluation = {
      kind: 'json_assert_v1',
      assertions: [{ path: '/label', equals: 'support' }],
    };
    const evaluator = testDigests(editedEvaluator);
    expect(evaluator.evaluator_digest).not.toBe(base.evaluator_digest);
    expect(evaluator.fixture_digest).toBe(base.fixture_digest);
  });

  it('is stable regardless of key order', () => {
    expect(testDigests(manifest)).toEqual(testDigests(testManifestSchema.parse(parseYaml(EXAMPLE_TEST_YAML))));
  });
});

describe('test result allowlist', () => {
  const extras: Record<string, unknown> = {
    verified: true,
    badge: 'verified',
    review_state: 'accepted',
    evidence_level: 'independently_verified',
    submitter: 'someone',
    prompt: 'Please explain the charge on my invoice.',
    output_text: 'billing',
    model_path: '/Users/me/models/x.gguf',
    hostname: 'my-laptop',
  };

  for (const [field, value] of Object.entries(extras)) {
    it(`rejects the extra field \`${field}\``, () => {
      expect(testResultSchema.safeParse({ ...EXAMPLE_TEST_RESULT, [field]: value }).success).toBe(false);
    });
  }

  it('rejects extras nested in case results, runner, and checks', () => {
    const nested = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    nested.case_results[0].output = 'billing';
    expect(testResultSchema.safeParse(nested).success).toBe(false);
    const runner = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    runner.runner.path = '/usr/local/bin/x';
    expect(testResultSchema.safeParse(runner).success).toBe(false);
    const checks = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    checks.checks.verified = true;
    expect(testResultSchema.safeParse(checks).success).toBe(false);
  });

  it('accepts no verified offline claim, only a self-reported interface observation', () => {
    for (const offline of ['pass', 'fail', 'verified']) {
      const claim = { ...clone(EXAMPLE_TEST_RESULT), checks: { locality: 'pass', offline } };
      expect(testResultSchema.safeParse(claim).success).toBe(false);
    }
    const observed = { ...clone(EXAMPLE_TEST_RESULT), checks: { locality: 'pass', offline: 'no_route_observed' } };
    expect(testResultSchema.safeParse(observed).success).toBe(true);
  });

  it('rejects counts that hide skipped or errored cases', () => {
    const skipped = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    skipped.counts = { defined: 1, evaluated: 0, passed: 0, failed: 0, errors: 0, skipped: 1 };
    skipped.case_results = [{ key: 'billing-001', outcome: 'skipped', repetition: 1 }];
    skipped.outcome = 'pass';
    expect(testResultSchema.safeParse(skipped).success).toBe(false);
    skipped.outcome = 'cancelled';
    expect(testResultSchema.safeParse(skipped).success).toBe(true);

    const dropped = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    dropped.counts = { defined: 2, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 };
    expect(testResultSchema.safeParse(dropped).success).toBe(false);

    const mismatch = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    mismatch.case_results[0].outcome = 'fail';
    expect(testResultSchema.safeParse(mismatch).success).toBe(false);

    const failing = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    failing.outcome = 'fail';
    expect(testResultSchema.safeParse(failing).success).toBe(false);
  });

  it('rejects duplicate case executions and repetitions beyond the declared count', () => {
    const duplicate = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    duplicate.counts = { defined: 2, evaluated: 2, passed: 2, failed: 0, errors: 0, skipped: 0 };
    duplicate.case_results = [duplicate.case_results[0], duplicate.case_results[0]];
    expect(testResultSchema.safeParse(duplicate).success).toBe(false);

    const beyond = clone(EXAMPLE_TEST_RESULT) as Record<string, any>;
    beyond.case_results[0].repetition = 2;
    expect(testResultSchema.safeParse(beyond).success).toBe(false);
  });
});

describe('metrics', () => {
  const unavailable = { value: null, reason: 'sensor_unavailable' };
  const base = {
    latency_ms: { value: 1200, method: 'client_monotonic_end_to_end_v1', samples: 1 },
    time_to_first_token_ms: unavailable,
    tokens_per_second: unavailable,
    peak_memory_bytes: unavailable,
    hardware_utilization: unavailable,
  };

  it('requires a reason for a null value and a method for a measured one', () => {
    expect(measurementsSchema.safeParse(base).success).toBe(true);
    expect(measurementsSchema.safeParse({ ...base, latency_ms: { value: null } }).success).toBe(false);
    expect(measurementsSchema.safeParse({ ...base, latency_ms: { value: 5 } }).success).toBe(false);
    expect(
      measurementsSchema.safeParse({ ...base, latency_ms: { value: null, reason: 'Some free text!' } }).success,
    ).toBe(false);
  });

  it('never accepts runner RSS as peak inference memory', () => {
    const rss = { value: 1024, method: 'runner_process_rss', samples: 1 };
    expect(measurementsSchema.safeParse({ ...base, peak_memory_bytes: rss }).success).toBe(false);
    const sensor = { value: 1024, method: 'device_memory_sensor_v1', samples: 1 };
    expect(measurementsSchema.safeParse({ ...base, peak_memory_bytes: sensor }).success).toBe(true);
  });

  it('rejects a zero or negative token rate and a method from the wrong metric', () => {
    const rate = (value: number, method = 'provider_ollama_eval_duration_v1') => ({
      ...base,
      tokens_per_second: { value, method, samples: 1 },
    });
    expect(measurementsSchema.safeParse(rate(40)).success).toBe(true);
    expect(measurementsSchema.safeParse(rate(0)).success).toBe(false);
    expect(measurementsSchema.safeParse(rate(-1)).success).toBe(false);
    expect(measurementsSchema.safeParse(rate(40, 'client_monotonic_end_to_end_v1')).success).toBe(false);
  });

  it('converts nanoseconds explicitly and rejects zero generation durations', () => {
    expect(nanosecondsToMilliseconds(1_469_404_167)).toBeCloseTo(1469.404167, 6);
    expect(() => nanosecondsToMilliseconds(-1)).toThrow(RangeError);
    // Captured Ollama 0.35.1 non-streaming response: 2 tokens in 7_130_000 ns.
    expect(tokensPerSecond(2, 7_130_000)).toBeCloseTo(280.5, 1);
    expect(tokensPerSecond(2, 0)).toBeNull();
    expect(tokensPerSecond(0, 1_000)).toBeNull();
    expect(tokensPerSecond(Number.NaN, 1_000)).toBeNull();
  });
});

describe('build', () => {
  it('rejects duplicate roles, non-https model sources, and an empty artifact identity', () => {
    const duplicate = clone(serverFieldsRemoved()) as Record<string, any>;
    duplicate.model_bindings.push(clone(duplicate.model_bindings[0]));
    expect(buildInputSchema.safeParse(duplicate).success).toBe(false);

    const source = clone(serverFieldsRemoved()) as Record<string, any>;
    source.model_bindings[0].source_url = 'http://example.org/model';
    expect(buildInputSchema.safeParse(source).success).toBe(false);

    const identity = clone(serverFieldsRemoved()) as Record<string, any>;
    identity.model_bindings[0].artifact_identity = { scheme: 'ollama_manifest_sha256', digest: null };
    expect(buildInputSchema.safeParse(identity).success).toBe(false);
  });

  it('keeps application, CLI, and engine versions as separate nullable fields', () => {
    const lmstudio = clone(serverFieldsRemoved()) as Record<string, any>;
    lmstudio.runtime = {
      family: 'lmstudio',
      application_version: '0.4.20+1',
      cli_version: '71bd99c',
      engine_version: 'mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0',
      adapter_profile: 'lmstudio-openai-compat/v0.1',
      backend: 'metal',
    };
    const parsed = buildInputSchema.parse(lmstudio);
    expect(parsed.runtime.cli_version).toBe('71bd99c');
    lmstudio.runtime.cli_version = null;
    lmstudio.runtime.engine_version = null;
    expect(buildInputSchema.safeParse(lmstudio).success).toBe(true);
  });

  it('allows unconfirmed effective settings only as explicit nulls', () => {
    const unknown = clone(serverFieldsRemoved()) as Record<string, any>;
    unknown.effective_settings.temperature = null;
    unknown.effective_settings.reasoning = 'unknown';
    expect(buildInputSchema.safeParse(unknown).success).toBe(true);
    delete unknown.effective_settings.temperature;
    expect(buildInputSchema.safeParse(unknown).success).toBe(false);
  });

  it('keeps manual reports free of test claims and credentials', () => {
    expect(buildReportSchema.safeParse({ ...EXAMPLE_BUILD_REPORT, test_definition_id: 'test_example' }).success).toBe(false);
    expect(buildReportSchema.safeParse({ ...EXAMPLE_BUILD_REPORT, evaluator: { kind: 'json_assert_v1' } }).success).toBe(false);
    expect(buildReportSchema.safeParse({ ...EXAMPLE_BUILD_REPORT, outcome: 'verified' }).success).toBe(false);
    const secret = { ...EXAMPLE_BUILD_REPORT, method: '-----BEGIN RSA PRIVATE KEY-----' };
    expect(buildReportSchema.safeParse(secret).success).toBe(false);
  });
});

describe('local plan', () => {
  const body: LocalPlanBody = {
    schema: 'localfirst/local-plan/v0.1',
    created_at: '2026-10-11T20:00:00Z',
    runner: { version: '0.0.0-example', contract: 'localfirst/runner/v0.1' },
    project: { project_id: 'project_example', project_version_id: 'version_example', configuration_key: 'local-chat' },
    test: {
      key: 'request-label-v1',
      test_definition_id: 'test_example',
      scope: 'component',
      ...testDigests(manifest),
      bundle_digest: `sha256:${'5'.repeat(64)}`,
    },
    runtime: {
      family: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      application_version: '0.35.1',
      cli_version: null,
      engine_version: null,
      adapter_profile: 'ollama-native/v0.1',
    },
    model: {
      role: 'classifier',
      runtime_model_id: 'qwen2.5:1.5b',
      artifact_identity: { scheme: 'ollama_manifest_sha256', digest: `sha256:${'6'.repeat(64)}`, reference: null },
      execution_location: 'local',
      locality_method: 'adapter_preflight_and_user_confirmed_config',
    },
    settings: {
      temperature: 0,
      max_output_tokens: 32,
      context_tokens: 4096,
      concurrency: 1,
      stream: false,
      seed: null,
      reasoning: 'default',
    },
    data_class: 'public_fixture',
    effects: {
      may_load_model: true,
      inference_requests: 1,
      network: 'loopback_only',
      downloads: false,
      tools: false,
      project_code: false,
      writes_local_report: true,
    },
  };

  it('accepts a sealed plan and rejects a missing or wrong digest', () => {
    const plan = sealLocalPlan(body);
    expect(localPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.plan_digest).toBe(computePlanDigest(body));
    expect(localPlanSchema.safeParse(body).success).toBe(false);
    expect(localPlanSchema.safeParse({ ...plan, plan_digest: `sha256:${'0'.repeat(64)}` }).success).toBe(false);
  });

  it('is invalidated by any edit to source, fixtures, model, settings, data class, or effects', () => {
    const plan = sealLocalPlan(body);
    const edits: Array<(draft: Record<string, any>) => void> = [
      (draft) => (draft.test.fixture_digest = `sha256:${'7'.repeat(64)}`),
      (draft) => (draft.test.manifest_digest = `sha256:${'7'.repeat(64)}`),
      (draft) => (draft.test.evaluator_digest = `sha256:${'7'.repeat(64)}`),
      (draft) => (draft.test.bundle_digest = `sha256:${'7'.repeat(64)}`),
      (draft) => (draft.model.runtime_model_id = 'qwen3.6:27b'),
      (draft) => (draft.model.artifact_identity.digest = `sha256:${'7'.repeat(64)}`),
      (draft) => (draft.settings.temperature = 1),
      (draft) => (draft.data_class = 'private_local'),
      (draft) => (draft.effects.inference_requests = 2),
      (draft) => (draft.runtime.endpoint = 'http://127.0.0.1:9999'),
    ];
    for (const edit of edits) {
      const draft = clone(plan) as Record<string, any>;
      edit(draft);
      expect(localPlanSchema.safeParse(draft).success).toBe(false);
    }
  });

  it('allows only loopback endpoints and effects without network, downloads, tools, or code', () => {
    for (const endpoint of [
      'http://192.168.1.20:11434',
      'https://api.example.com',
      'http://user:pass@127.0.0.1:11434',
      'http://127.0.0.1:11434/?token=1',
      'file:///etc/passwd',
      'not a url',
    ]) {
      const draft = clone(body) as Record<string, any>;
      draft.runtime.endpoint = endpoint;
      expect(localPlanSchema.safeParse(sealLocalPlan(draft as LocalPlanBody)).success, endpoint).toBe(false);
    }
    for (const endpoint of ['http://127.0.0.1:1234', 'http://localhost:11434', 'http://[::1]:11434']) {
      const draft = clone(body) as Record<string, any>;
      draft.runtime.endpoint = endpoint;
      expect(localPlanSchema.safeParse(sealLocalPlan(draft as LocalPlanBody)).success, endpoint).toBe(true);
    }
    for (const effect of ['downloads', 'tools', 'project_code']) {
      const draft = clone(body) as Record<string, any>;
      draft.effects[effect] = true;
      expect(localPlanSchema.safeParse(sealLocalPlan(draft as LocalPlanBody)).success).toBe(false);
    }
  });

  it('rejects remote or unknown execution locations in a local plan', () => {
    for (const location of ['remote', 'unknown']) {
      const draft = clone(body) as Record<string, any>;
      draft.model.execution_location = location;
      expect(localPlanSchema.safeParse(sealLocalPlan(draft as LocalPlanBody)).success).toBe(false);
    }
  });
});

describe('local report', () => {
  const planBody: LocalPlanBody = {
    schema: 'localfirst/local-plan/v0.1',
    created_at: '2026-10-11T19:00:00Z',
    runner: { version: '0.0.0-example', contract: 'localfirst/runner/v0.1' },
    project: { project_id: 'project_example', project_version_id: 'version_example', configuration_key: 'local-chat' },
    test: {
      key: 'request-label-v1',
      test_definition_id: 'test_example',
      scope: 'component',
      manifest_digest: EXAMPLE_TEST_RESULT.test_manifest_digest,
      fixture_digest: EXAMPLE_TEST_RESULT.fixture_digest,
      evaluator_digest: `sha256:${'5'.repeat(64)}`,
      bundle_digest: `sha256:${'5'.repeat(64)}`,
    },
    runtime: {
      family: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      application_version: '0.35.1',
      cli_version: null,
      engine_version: null,
      adapter_profile: 'ollama-native/v0.1',
    },
    model: {
      role: 'classifier',
      runtime_model_id: 'qwen2.5:1.5b',
      artifact_identity: { scheme: 'ollama_manifest_sha256', digest: `sha256:${'6'.repeat(64)}`, reference: null },
      execution_location: 'local',
      locality_method: 'adapter_preflight_and_user_confirmed_config',
    },
    settings: {
      temperature: 0,
      max_output_tokens: 32,
      context_tokens: 4096,
      concurrency: 1,
      stream: false,
      seed: null,
      reasoning: 'default',
    },
    data_class: 'public_fixture',
    effects: {
      may_load_model: true,
      inference_requests: 1,
      network: 'loopback_only',
      downloads: false,
      tools: false,
      project_code: false,
      writes_local_report: true,
    },
  };
  const plan = sealLocalPlan(planBody);
  const hardware = {
    platform: 'apple-silicon',
    os: { name: 'macos', version: '26' },
    cpu_architecture: 'arm64',
    cpu_model: null,
    memory_bytes: 17179869184,
    unified_memory: true,
    accelerators: [],
  };

  const local = {
    ...clone(EXAMPLE_TEST_RESULT),
    schema: 'localfirst/local-report/v0.1',
    plan_digest: plan.plan_digest,
    data_class: 'public_fixture',
    plan,
    hardware,
    execution_state: 'local_report_saved',
    case_details: [
      {
        key: 'billing-001',
        repetition: 1,
        outcome: 'pass',
        output_text: '{"label":"billing"}',
        error_code: null,
        started_at_monotonic_ms: 12.5,
        provider_stats: { eval_count: 7, eval_duration: 39123000, total_duration: 78543916 },
      },
    ],
  };

  it('keeps raw provider statistics and model output locally', () => {
    const parsed = localReportSchema.parse(local);
    expect(parsed.case_details[0]?.provider_stats.eval_duration).toBe(39123000);
  });

  it('applies the same count invariants as the sanitized result', () => {
    const broken = { ...clone(local), counts: { defined: 1, evaluated: 1, passed: 0, failed: 0, errors: 0, skipped: 0 } };
    expect(localReportSchema.safeParse(broken).success).toBe(false);
  });

  it('exports an allowlisted result that drops every local-only field', () => {
    const exported = exportSanitizedResult(localReportSchema.parse(local));
    expect(exported).toEqual(testResultSchema.parse(EXAMPLE_TEST_RESULT));
    expect(JSON.stringify(exported)).not.toContain('billing"}');
    expect('plan_digest' in exported).toBe(false);
    expect('data_class' in exported).toBe(false);
    expect('case_details' in exported).toBe(false);
    expect('plan' in exported).toBe(false);
    expect('hardware' in exported).toBe(false);
    expect(JSON.stringify(exported)).not.toContain('qwen2.5');
    expect(JSON.stringify(exported)).not.toContain('apple-silicon');
  });

  it('accepts a report without collected hardware but requires the field', () => {
    expect(localReportSchema.safeParse({ ...clone(local), hardware: null }).success).toBe(true);
    const { hardware: _omitted, ...without } = clone(local);
    void _omitted;
    expect(localReportSchema.safeParse(without).success).toBe(false);
  });

  it('requires the plan snapshot to agree with the report', () => {
    const edits: Array<(draft: Record<string, any>) => void> = [
      (draft) => (draft.plan_digest = `sha256:${'0'.repeat(64)}`),
      (draft) => (draft.project_id = 'project_other'),
      (draft) => (draft.test_key = 'other-test-v1'),
      (draft) => (draft.fixture_digest = `sha256:${'9'.repeat(64)}`),
      (draft) => (draft.data_class = 'private_local'),
      (draft) => (draft.runner.version = '9.9.9'),
      (draft) => (draft.plan.model.runtime_model_id = 'edited:latest'),
    ];
    for (const edit of edits) {
      const draft = clone(local) as Record<string, any>;
      edit(draft);
      expect(localReportSchema.safeParse(draft).success).toBe(false);
    }
  });
});

describe('published JSON schemas', () => {
  it('generates build, build-report, and test-result documents', () => {
    const base = 'https://localfirst.example';
    expect(buildJsonSchema(base).$id).toBe(`${base}/schemas/build/v0.1.json`);
    expect(buildReportJsonSchema(base).$id).toBe(`${base}/schemas/build-report/v0.1.json`);
    const result = testResultJsonSchema(base);
    expect(result.$id).toBe(`${base}/schemas/test-result/v0.1.json`);
    expect(result.additionalProperties).toBe(false);
    const properties = result.properties as Record<string, unknown>;
    for (const forbidden of ['verified', 'badge', 'review_state', 'evidence_level', 'submitter']) {
      expect(properties).not.toHaveProperty(forbidden);
    }
  });
});

describe('hardware is optional on a build, and the submission is one object', () => {
  it('accepts a build that shares no hardware and still rejects a malformed one', () => {
    const shared = serverFieldsRemoved();
    expect(buildInputSchema.safeParse({ ...shared, hardware: null }).success).toBe(true);
    expect(buildInputSchema.safeParse({ ...shared, hardware: { os: { name: 'macos' } } }).success).toBe(false);
    const missing = { ...shared } as Record<string, unknown>;
    delete missing.hardware;
    expect(buildInputSchema.safeParse(missing).success).toBe(false);
  });

  it('pairs a sanitized result with an inline build and rejects extras', () => {
    const submission = { result: EXAMPLE_TEST_RESULT, build: { ...serverFieldsRemoved(), hardware: null } };
    expect(testResultSubmissionSchema.safeParse(submission).success).toBe(true);
    expect(testResultSubmissionSchema.safeParse({ ...submission, verified: true }).success).toBe(false);
    expect(testResultSubmissionSchema.safeParse({ result: EXAMPLE_TEST_RESULT }).success).toBe(false);
    expect(testResultSubmissionSchema.safeParse({ ...submission, build: EXAMPLE_BUILD_RECORD }).success).toBe(false);
  });
});
