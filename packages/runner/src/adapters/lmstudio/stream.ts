import { AdapterError, type InferResponse, type ProviderStats } from '../types.js';
import { sameModel } from './models.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const malformed = (what: string) => new AdapterError('malformed_response', `LM Studio stream ${what}`);

const OPENAI_USAGE: Array<[string, string]> = [
  ['prompt_tokens', 'usage_prompt_tokens'],
  ['completion_tokens', 'usage_completion_tokens'],
  ['total_tokens', 'usage_total_tokens'],
];

/**
 * Collects the OpenAI-compatible server-sent-event stream. Only `data:` lines
 * carry chunks; blank lines and `:` comments are ignored and `[DONE]` ends the
 * stream. `onFirstContent` fires on the first non-empty `delta.content` only,
 * never on the role-only opening chunk or on reasoning deltas.
 */
export function openAiStreamCollector(requested: string, onFirstContent: (() => void) | undefined) {
  const parts: string[] = [];
  const stats: ProviderStats = { provider: 'lmstudio_openai_compat_v1' };
  let announced = false;
  let sawModel = false;
  let done = false;
  return {
    push(line: string): void {
      if (line.length === 0 || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      if (done) throw malformed('continued after [DONE]');
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw malformed('event was not valid JSON');
      }
      if (!isRecord(chunk)) throw malformed('event was not an object');
      if (chunk.error !== undefined) throw new AdapterError('runtime_error', 'the runtime reported an error mid-stream');
      if (typeof chunk.model !== 'string' || chunk.model.length === 0) throw malformed('event names no model');
      if (!sameModel(requested, chunk.model)) {
        throw new AdapterError('model_not_found', 'the runtime answered with a different model than requested');
      }
      sawModel = true;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (isRecord(choice)) {
        const delta = choice.delta;
        if (isRecord(delta) && typeof delta.content === 'string' && delta.content.length > 0) {
          parts.push(delta.content);
          if (!announced) {
            announced = true;
            onFirstContent?.();
          }
        }
        if (typeof choice.finish_reason === 'string') stats.finish_reason = choice.finish_reason;
      }
      if (isRecord(chunk.usage)) {
        for (const [from, to] of OPENAI_USAGE) {
          const value = chunk.usage[from];
          if (typeof value === 'number') stats[to] = value;
        }
      }
    },
    finish(): InferResponse {
      if (!sawModel || !done) throw malformed('ended before [DONE]');
      return { content: parts.join(''), providerStats: stats };
    },
  };
}
