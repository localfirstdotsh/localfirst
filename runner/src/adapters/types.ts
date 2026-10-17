/**
 * Minimal inference seam used by the harness. The full provider-neutral
 * adapter contract (BACKEND_PRD section 7.3: probe, list_models, inspect_model,
 * preflight, infer, cancel, measure) is implemented per runtime in later
 * milestones; the harness depends only on `infer`.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferSettings {
  temperature: number;
  max_output_tokens: number;
  context_tokens: number;
  concurrency: 1;
  stream: boolean;
  seed: number | null;
  reasoning: 'default' | 'disabled';
}

export interface InferRequest {
  messages: ChatMessage[];
  /** Declared response schema; the adapter maps it, it is not copied verbatim. */
  responseSchema: unknown;
  settings: InferSettings;
}

/** Raw provider statistics keep the provider's own units. */
export type ProviderStats = Record<string, number | string | boolean | null>;

export interface InferResponse {
  content: string;
  providerStats: ProviderStats;
}

export interface InferenceAdapter {
  infer(request: InferRequest, options: { signal: AbortSignal; onFirstContent?: () => void }): Promise<InferResponse>;
}

/** An adapter failure with a stable machine-readable code. */
export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}
