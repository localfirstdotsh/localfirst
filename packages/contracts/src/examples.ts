/**
 * Reference examples from BACKEND_PRD sections 4.2 and 5.2.
 *
 * These are synthetic contract examples. The URL is illustrative, the memory
 * figure is a declared creator claim, and the test manifest has never been
 * executed by anything in this repository.
 */

export const EXAMPLE_PROJECT_FRONTMATTER = `---
schema: localfirst/project/v0.2
project:
  key: request-labeler
  name: Local Request Labeler
  summary: Classify a short request with a locally selected chat model.
  type: experiment
  categories: [text-classification]
  version: "0.1.0"
  license: {state: known, id: MIT, reference: "https://example.org/request-labeler/license"}
sources:
  - key: primary
    kind: documentation
    url: https://example.org/request-labeler
    revision: null
    content_digest: null
attribution:
  authors: [{name: Example Builder, url: "https://example.org/builder"}]
  relationship: original_author_claimed
models:
  state: declared
  roles:
    - key: classifier
      required_capabilities: [chat, json_output]
      minimum_context_tokens: 4096
      substitution: allowed_for_task_test
      preferred: null
runtimes:
  state: declared
  supported:
    - {family: ollama, version_constraint: null}
    - {family: lmstudio, version_constraint: null}
hardware:
  state: declared
  architectures: [arm64, x86_64]
  minimum_memory_bytes: 8589934592
  accelerator: optional
operating_systems:
  state: declared
  supported: [macos, linux]
dependencies:
  state: declared
  items: []
configurations:
  - key: local-chat
    model_roles: [classifier]
    setup_kind: manual
    workload: {context_tokens: 4096, concurrency: 1}
data_boundary:
  inference: local_required
  storage: local
  runtime_network: unknown
  external_services: []
test_support: declarative_task_v1
tests:
  - key: request-label-v1
    schema: localfirst/test/v0.1
    path: TESTS/request-label-v1.yaml
limitations:
  - One smoke-test case does not establish task accuracy.
  - Minimum RAM is a creator claim; actual model fit requires local assessment.
evidence: []
media: []
derivative_of: null
---`;

export const EXAMPLE_PROJECT_BODY = `## Purpose

Label a short customer request as billing, support, or other using a chat model
the reader already runs locally. The project exists to exercise one bounded
text-classification task end to end on owned hardware.

## Architecture and workflow

A single prompt is sent to one locally selected chat model and the reply is
parsed as a small JSON object. There is no retrieval step, no tool call, and no
service dependency.

## Setup

1. Install a supported local runtime (Ollama or LM Studio) yourself.
2. Pull or load any chat model that can return JSON and accepts a 4096-token
   context. No model is downloaded by this project.
3. Copy the system prompt from the test manifest into your own client, or wait
   for a supported runner release.

## Execution

Send the two messages from \`TESTS/request-label-v1.yaml\` to the selected model
with temperature 0 and a 32-token output limit, then read the \`label\` field of
the JSON reply.

## Test and evaluation

\`TESTS/request-label-v1.yaml\` declares one \`declarative_task_v1\` smoke case
evaluated with \`json_assert_v1\`. It is a declared fixture: no runner has
executed it, and no measurement in this listing came from a real run.

## Limitations

- One smoke-test case does not establish task accuracy on real billing requests.
- The minimum memory figure is a creator claim, not an observed model fit.
- Runtime network behaviour is unknown, so offline operation is not claimed.

## Sources and attribution

Documentation source: <https://example.org/request-labeler> (illustrative, not
fetched by the registry). Authored by Example Builder and submitted by the
original author under MIT.
`;

/** The full `PROJECT.md` text: frontmatter plus Markdown body. */
export const EXAMPLE_PROJECT_MD = `${EXAMPLE_PROJECT_FRONTMATTER}\n\n${EXAMPLE_PROJECT_BODY}`;

export const EXAMPLE_TEST_PATH = 'TESTS/request-label-v1.yaml';

export const EXAMPLE_TEST_YAML = `schema: localfirst/test/v0.1
key: request-label-v1
project_key: request-labeler
configuration_key: local-chat
scope: component
harness: declarative_task_v1
runner_contract: localfirst/runner/v0.1
model_role: classifier
required_capabilities: [chat, json_output]
fixture_kind: public_inline
fixture_license: CC0-1.0
inference:
  temperature: 0
  max_output_tokens: 32
  context_tokens: 4096
  concurrency: 1
  stream: false
  seed: null
  reasoning: default
response_schema:
  type: object
  properties:
    label: {type: string, enum: [billing, support, other]}
  required: [label]
  additionalProperties: false
cases:
  - key: billing-001
    messages:
      - {role: system, content: 'Return a JSON object with label billing, support, or other.'}
      - {role: user, content: 'Please explain the charge on my invoice.'}
    evaluation:
      kind: json_assert_v1
      assertions: [{path: /label, equals: billing}]
limits:
  max_cases: 1
  request_timeout_ms: 30000
  run_timeout_ms: 60000
  max_response_bytes: 65536
execution:
  locality: local_required
  allow_tools: false
  allow_project_code: false
  allow_downloads: false
measurement:
  repetitions: 1
  warmup_runs: 0
  load_state: observe
  cache_policy: observe
  timing: end_to_end_v1
sharing:
  default: local_only
  allow_public_fixture_case_ids: true
`;

const PRD_DIGEST_1 = `sha256:${'1'.repeat(64)}`;
const PRD_DIGEST_2 = `sha256:${'2'.repeat(64)}`;
const PRD_DIGEST_3 = `sha256:${'3'.repeat(64)}`;
const PRD_DIGEST_4 = `sha256:${'4'.repeat(64)}`;

/**
 * BACKEND_PRD section 6.1 saved build, including its server-only fields.
 * Synthetic: unknown upstream model and engine identity, illustrative hardware.
 */
export const EXAMPLE_BUILD_RECORD = {
  schema: 'localfirst/build/v0.1',
  id: 'build_example',
  project_id: 'project_example',
  project_version_id: 'version_example',
  configuration_key: 'local-chat',
  source: {
    kind: 'documentation',
    url: 'https://example.org/request-labeler',
    revision: null,
    project_manifest_digest: PRD_DIGEST_1,
  },
  model_bindings: [
    {
      role: 'classifier',
      runtime_model_id: 'example-local-chat:local',
      model_version_id: null,
      artifact_identity: { scheme: 'ollama_manifest_sha256', digest: PRD_DIGEST_2 },
      source_url: null,
      quantization: 'Q4_K_M',
      license_state: 'unknown',
      execution_location: 'local',
      locality_method: 'adapter_preflight_and_user_confirmed_config',
    },
  ],
  runtime: {
    family: 'ollama',
    application_version: '0.0.0-example',
    engine_version: null,
    adapter_profile: 'ollama-native/v0.1',
    backend: 'metal',
  },
  hardware: {
    platform: 'apple-silicon',
    os: { name: 'macos', version: 'example-os' },
    cpu_architecture: 'arm64',
    cpu_model: 'Example chip',
    memory_bytes: 17179869184,
    unified_memory: true,
    accelerators: [{ vendor: 'apple', backend: 'metal', memory_bytes: null }],
  },
  effective_settings: {
    temperature: 0,
    max_output_tokens: 32,
    context_tokens: 4096,
    concurrency: 1,
    stream: false,
    seed: null,
    reasoning: 'default',
  },
  changes: [{ kind: 'model_selection', role: 'classifier', note: 'Selected an already installed model.' }],
  parent_build_id: null,
  visibility: 'private',
  reproducibility: 'incomplete',
};

/** BACKEND_PRD section 8.1 sanitized result. Synthetic; the latency is not a benchmark. */
export const EXAMPLE_TEST_RESULT = {
  schema: 'localfirst/test-result/v0.1',
  client_run_id: 'run_example_001',
  project_id: 'project_example',
  project_version_id: 'version_example',
  build_id: 'build_example',
  test_key: 'request-label-v1',
  test_definition_id: 'test_example',
  test_manifest_digest: PRD_DIGEST_3,
  fixture_digest: PRD_DIGEST_4,
  fixture_kind: 'public_inline',
  evaluator: { kind: 'json_assert_v1', version: '1' },
  scope: 'component',
  runner: { version: '0.0.0-example', contract: 'localfirst/runner/v0.1' },
  outcome: 'pass',
  counts: { defined: 1, evaluated: 1, passed: 1, failed: 0, errors: 0, skipped: 0 },
  case_results: [{ key: 'billing-001', outcome: 'pass', repetition: 1 }],
  measurements: {
    latency_ms: { value: 1200, method: 'client_monotonic_end_to_end_v1', samples: 1 },
    time_to_first_token_ms: { value: null, reason: 'nonstreaming_run' },
    tokens_per_second: { value: null, reason: 'generation_interval_not_exported' },
    peak_memory_bytes: { value: null, reason: 'runtime_sensor_unavailable' },
    hardware_utilization: { value: null, reason: 'sensor_unavailable' },
  },
  measurement_context: { load_state: 'unknown', cache_state: 'unknown', repetitions: 1, warmup_runs: 0 },
  checks: { locality: 'pass', offline: 'not_run' },
  completed_at: '2026-10-11T20:00:00Z',
  redaction_version: 'localfirst/export/v0.1',
  diagnostic_codes: [],
  visibility_requested: 'private',
};

/**
 * Synthetic manual report for a project without a harness (section 6.2).
 * No test definition and no evaluator: it can only support `community_reported`.
 */
export const EXAMPLE_BUILD_REPORT = {
  schema: 'localfirst/build-report/v0.1',
  client_run_id: 'manual_example_001',
  outcome: 'partial',
  method: 'Followed the documented setup on a laptop and sent one request by hand.',
  changes: 'Used an already installed chat model instead of the suggested one.',
  checks: [
    { name: 'Server starts', result: 'reported_pass' },
    { name: 'JSON reply parses', result: 'reported_fail' },
  ],
  diagnostic_codes: ['json_parse_failed'],
  completed_at: '2026-10-11T20:30:00Z',
};
