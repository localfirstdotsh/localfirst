import {
  EXAMPLE_PROJECT_MD,
  EXAMPLE_TEST_PATH,
  EXAMPLE_TEST_YAML,
  parseSafeYaml,
  sealLocalPlan,
  testDigests,
  testManifestSchema,
  validateProjectBundle,
  type LocalPlan,
  type LocalPlanBody,
  type TestManifest,
} from '@localfirst/contracts';
import type { InferenceAdapter, InferRequest } from '../src/index.js';

export const exampleBundle = {
  project_md: EXAMPLE_PROJECT_MD,
  files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }],
};

export function bundleWithTestYaml(yaml: string) {
  return { project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: yaml }] };
}

export function exampleManifest(): TestManifest {
  return testManifestSchema.parse(parseSafeYaml(EXAMPLE_TEST_YAML));
}

/** The example manifest with edits applied to the raw object before parsing. */
export function manifestWith(edit: (raw: Record<string, any>) => void): TestManifest {
  const raw = structuredClone(parseSafeYaml(EXAMPLE_TEST_YAML)) as Record<string, any>;
  edit(raw);
  return testManifestSchema.parse(raw);
}

export function bodyFor(bundle = exampleBundle): LocalPlanBody {
  const validated = validateProjectBundle(bundle);
  if (!validated.ok || validated.content_digest === null || !validated.tests[0]) {
    throw new Error('example bundle must validate');
  }
  const manifest = validated.tests[0].manifest;
  return {
    schema: 'localfirst/local-plan/v0.1',
    created_at: '2026-10-11T20:00:00Z',
    runner: { version: '0.1.0', contract: 'localfirst/runner/v0.1' },
    project: {
      project_id: 'project_example',
      project_version_id: 'version_example',
      configuration_key: manifest.configuration_key,
    },
    test: {
      key: manifest.key,
      test_definition_id: 'test_example',
      scope: manifest.scope,
      ...testDigests(manifest),
      bundle_digest: validated.content_digest,
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
      role: manifest.model_role,
      runtime_model_id: 'qwen2.5:1.5b',
      artifact_identity: {
        scheme: 'ollama_manifest_sha256',
        digest: `sha256:${'6'.repeat(64)}`,
        reference: null,
      },
      execution_location: 'local',
      locality_method: 'adapter_preflight_and_user_confirmed_config',
    },
    settings: { ...manifest.inference },
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
}

export function planFor(bundle = exampleBundle, edit?: (body: LocalPlanBody) => void): LocalPlan {
  const body = bodyFor(bundle);
  edit?.(body);
  return sealLocalPlan(body);
}

/** Adapter that records requests and answers from a script. */
export function scriptedAdapter(
  respond: (request: InferRequest, call: number, signal: AbortSignal) => Promise<string> | string,
): InferenceAdapter & { calls: InferRequest[] } {
  const calls: InferRequest[] = [];
  return {
    calls,
    async infer(request, { signal }) {
      calls.push(request);
      const content = await respond(request, calls.length, signal);
      return { content, providerStats: { eval_count: 7, eval_duration: 39_123_000 } };
    },
  };
}

/** Resolves never until aborted; models a hung runtime. */
export const hang = (signal: AbortSignal) =>
  new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
