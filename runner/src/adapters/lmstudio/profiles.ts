/**
 * Tested API profiles (BACKEND_PRD section 7.5). A feature is used only for a
 * combination that a captured fixture or test evidences; anything else is
 * `profile_untested` and blocks the case instead of being guessed.
 */

export type ChatProfile = 'openai_compat_v1' | 'native_v1';

export const OPENAI_COMPAT_PROFILE = 'lmstudio-openai-compat/v1';
export const NATIVE_PROFILE = 'lmstudio-native/v1';

export interface TestedProfile {
  profile: ChatProfile;
  feature: 'json_schema_response_format';
  /** Model formats the feature was observed to work for. */
  modelFormats: readonly string[];
  evidence: string;
}

export const TESTED_PROFILES: readonly TestedProfile[] = [
  {
    profile: 'openai_compat_v1',
    feature: 'json_schema_response_format',
    // Only an MLX model was captured. GGUF is deliberately untested.
    modelFormats: ['mlx'],
    evidence: 'fixtures/lmstudio/chat-json-schema.json: google/gemma-3-1b (mlx 4bit), LM Studio 0.4.20+1',
  },
];

export function structuredOutputTested(profile: ChatProfile, format: string | null): boolean {
  if (format === null) return false;
  return TESTED_PROFILES.some(
    (entry) =>
      entry.profile === profile &&
      entry.feature === 'json_schema_response_format' &&
      entry.modelFormats.includes(format),
  );
}

/** The only endpoints the adapter may call: no load, unload, download, or config path. */
export const ALLOWED_REQUESTS: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: '/api/v1/models' },
  { method: 'GET', path: '/v1/models' },
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/api/v1/chat' },
];
