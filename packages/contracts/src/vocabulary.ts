/**
 * Controlled vocabularies for schema `localfirst/project/v0.2`.
 *
 * These are small, extensible lists. Unknown values are rejected rather than
 * silently broadened (BACKEND_PRD section 4.1, section 18.1).
 */

export const SPEC_SCHEMA_ID = 'localfirst/project/v0.2' as const;
export const TEST_SCHEMA_ID = 'localfirst/test/v0.1' as const;
export const BUILD_SCHEMA_ID = 'localfirst/build/v0.1' as const;
export const BUILD_REPORT_SCHEMA_ID = 'localfirst/build-report/v0.1' as const;
export const TEST_RESULT_SCHEMA_ID = 'localfirst/test-result/v0.1' as const;
export const RUNNER_CONTRACT_ID = 'localfirst/runner/v0.1' as const;
export const CANONICAL_SERIALIZER_VERSION = 'localfirst/canonical/v0.1' as const;
export const COMPATIBILITY_RULES_VERSION = 'localfirst/compatibility/v0.1' as const;
export const EXPORT_REDACTION_VERSION = 'localfirst/export/v0.1' as const;

export const PROJECT_TYPES = [
  'application',
  'workflow',
  'demo',
  'robotics',
  'experiment',
  'hardware_build',
  'documentation',
] as const;

/** Initial task categories: a small extensible controlled vocabulary. */
export const TASK_CATEGORIES = [
  'text-classification',
  'text-generation',
  'chat-assistant',
  'summarization',
  'translation',
  'embeddings-retrieval',
  'code-assistant',
  'agent-workflow',
  'speech-to-text',
  'text-to-speech',
  'image-generation',
  'vision-language',
  'object-detection',
  'robotics-control',
  'model-serving',
  'benchmarking',
  'hardware-setup',
  'documentation',
] as const;

export const SOURCE_KINDS = [
  'repository',
  'documentation',
  'hardware_note',
  'media',
  'authored_specification',
] as const;

/** How the attributed authors relate to the submitting account. */
export const ATTRIBUTION_RELATIONSHIPS = [
  'original_author_claimed',
  'maintainer_claimed',
  'curator_submitted',
  'third_party_submitted',
  'unknown',
] as const;

/** Stored separately from author attribution (section 3.3). */
export const LISTING_ORIGINS = ['creator_submitted', 'curated_from_upstream'] as const;

/** `null` means unknown; a declaration state is explicit (section 4.1). */
export const DECLARATION_STATES = ['declared', 'unknown', 'not_applicable'] as const;
export const LICENSE_STATES = ['known', 'unknown', 'not_applicable'] as const;

export const MODEL_CAPABILITIES = [
  'chat',
  'completion',
  'json_output',
  'tool_calls',
  'vision',
  'audio_input',
  'audio_output',
  'embeddings',
  'reasoning',
] as const;

export const SUBSTITUTION_POLICIES = ['allowed_for_task_test', 'not_allowed', 'unknown'] as const;

export const RUNTIME_FAMILIES = [
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'mlx',
  'tensorrt_llm',
  'onnxruntime',
  'transformers',
  'other',
] as const;

export const CPU_ARCHITECTURES = ['arm64', 'x86_64', 'riscv64'] as const;
export const ACCELERATOR_REQUIREMENTS = ['required', 'optional', 'none', 'unknown'] as const;
export const OPERATING_SYSTEMS = ['macos', 'linux', 'windows', 'other'] as const;

export const SETUP_KINDS = [
  'manual',
  'script_documented',
  'container_documented',
  'unsupported',
] as const;

export const INFERENCE_BOUNDARIES = [
  'local_required',
  'local_preferred',
  'external_allowed',
  'unknown',
] as const;
export const STORAGE_BOUNDARIES = ['local', 'external', 'unknown'] as const;
export const NETWORK_BOUNDARIES = ['required', 'optional', 'none', 'unknown'] as const;

/** Declared harness support. A declaration never means a runner has shipped. */
export const TEST_SUPPORT_KINDS = ['none', 'manual', 'declarative_task_v1'] as const;
export const TEST_SUPPORT_KINDS_V3 = [...TEST_SUPPORT_KINDS, 'declarative_workflow_v1'] as const;

export const TEST_SCOPES = ['component', 'workflow', 'end_to_end'] as const;
export const EVALUATOR_KINDS = ['exact_match_v1', 'json_assert_v1'] as const;

/** Server-derived classifications; never client assertions (section 9.1). */
export const EVIDENCE_LEVELS = [
  'claimed',
  'documented',
  'community_reported',
  'reproducible_test',
  'independently_verified',
] as const;

export const COMPATIBILITY_OUTCOMES = [
  'evidence_match',
  'candidate',
  'incompatible',
  'unknown',
] as const;

export const PROJECT_VISIBILITY = ['published', 'unpublished', 'quarantined'] as const;

export const DRAFT_KINDS = ['project', 'build', 'test_result'] as const;
export const DRAFT_STATES = [
  'editable',
  'ready_for_review',
  'approved',
  'published',
  'ingesting',
  'ingestion_failed',
  'discarded',
] as const;

export const REVIEW_STATES = ['pending', 'accepted', 'rejected', 'withdrawn'] as const;

export const OPERATION_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type AttributionRelationship = (typeof ATTRIBUTION_RELATIONSHIPS)[number];
export type ListingOrigin = (typeof LISTING_ORIGINS)[number];
export type DeclarationState = (typeof DECLARATION_STATES)[number];
export type LicenseState = (typeof LICENSE_STATES)[number];
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export type RuntimeFamily = (typeof RUNTIME_FAMILIES)[number];
export type CpuArchitecture = (typeof CPU_ARCHITECTURES)[number];
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];
export type TestSupportKind = (typeof TEST_SUPPORT_KINDS)[number];
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export type CompatibilityOutcome = (typeof COMPATIBILITY_OUTCOMES)[number];
export type ProjectVisibility = (typeof PROJECT_VISIBILITY)[number];
export type DraftKind = (typeof DRAFT_KINDS)[number];
export type DraftState = (typeof DRAFT_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type OperationState = (typeof OPERATION_STATES)[number];
