export const WARNING_TITLES: Record<string, string> = {
  HARDWARE_FACTS_UNKNOWN: 'Hardware requirements are unknown',
  MODEL_FACTS_UNKNOWN: 'Model requirements are unknown',
  NO_TEST_SUPPORT: 'No test support is declared',
  EXECUTION_SOURCE_UNPINNED: 'Execution sources are not pinned',
  HARDWARE_MEMORY_IS_A_CLAIM: 'Memory requirements are author claims',
  OFFLINE_UNVERIFIED: 'Offline operation is unverified',
  RUNNER_UNAVAILABLE: 'The declared test harness has not run',
  RUNTIME_SUPPORT_DECLARED: 'Runtime support is author-declared',
  SOURCE_CONTENT_UNVERIFIED: 'Source content has not been fetched',
  SOURCE_LICENSE_UNKNOWN: 'Source licensing is unknown',
  TEST_SOURCE_DRIFT_POSSIBLE: 'Test sources may change',
  SOURCE_UNPINNED: 'A source is not pinned',
  EVIDENCE_CLAIMS_UNVERIFIED: 'Evidence claims are unverified',
  LICENSE_UNKNOWN: 'Project licensing is unknown',
  EXTERNAL_INFERENCE_ALLOWED: 'External inference is allowed',
  build_identity_incomplete: 'Build identity is incomplete',
  hardware_not_shared: 'Hardware detail stays private',
  model_source_not_shared: 'Model source stays private',
  model_alias_not_shared: 'Model name stays private',
  manual_report_not_shared: 'Manual report stays private',
  case_results_not_shared: 'Only aggregate test counts will be public',
};
export const WARNING_DESCRIPTION: Record<string, string> = {
  HARDWARE_FACTS_UNKNOWN:
    'The author has not specified hardware requirements for this project.',
  MODEL_FACTS_UNKNOWN:
    'Supported model requirements have not been established.',
  NO_TEST_SUPPORT:
    'This project declares no supported test mechanism. Publication provides documentation only.',
};
