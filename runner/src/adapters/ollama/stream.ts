import { AdapterError, type InferResponse } from '../types.js';
import { isRecord, sameModel, toProviderStats } from './mapping.js';

const malformed = (what: string) => new AdapterError('malformed_response', `Ollama stream ${what}`);

/**
 * Collects Ollama's NDJSON chat stream. Every line is one JSON chunk with the
 * model and a content fragment; the last has `done: true` and the native
 * counters. `onFirstContent` fires on the first non-empty content fragment only:
 * headers, empty keep-alive fragments, and reasoning (`thinking`) chunks are not
 * the first token.
 */
export function ollamaStreamCollector(requested: string, onFirstContent: (() => void) | undefined) {
  const parts: string[] = [];
  let final: Record<string, unknown> | null = null;
  let announced = false;
  return {
    push(line: string): void {
      if (line.trim().length === 0) return;
      if (final !== null) throw malformed('continued after its final chunk');
      let chunk: unknown;
      try {
        chunk = JSON.parse(line);
      } catch {
        throw malformed('line was not valid JSON');
      }
      if (!isRecord(chunk)) throw malformed('chunk was not an object');
      if (typeof chunk.error === 'string') throw new AdapterError('provider_error', 'Ollama reported an error mid-stream');
      if (typeof chunk.model !== 'string' || !sameModel(requested, chunk.model)) throw malformed('named a different model');
      const message = chunk.message;
      if (!isRecord(message) || typeof message.content !== 'string') throw malformed('chunk had no message');
      if (message.content.length > 0) {
        parts.push(message.content);
        if (!announced) {
          announced = true;
          onFirstContent?.();
        }
      }
      if (chunk.done === true) final = chunk;
    },
    finish(): InferResponse {
      if (final === null) throw malformed('ended before its final chunk');
      return { content: parts.join(''), providerStats: toProviderStats(final) };
    },
  };
}
