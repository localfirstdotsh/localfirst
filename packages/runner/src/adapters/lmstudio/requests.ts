import { AdapterError, type InferRequest } from '../types.js';
import { structuredOutputTested } from './profiles.js';

/** Refuse an option the profile cannot honour; never drop it silently. */
function unsupported(message: string): never {
  throw new AdapterError('option_unsupported', message);
}

function assertCommon(request: InferRequest): void {
  const { settings } = request;
  if (settings.reasoning !== 'default') {
    unsupported('no tested LM Studio mapping exists for reasoning: disabled');
  }
  if (settings.concurrency !== 1) unsupported('only concurrency 1 is supported');
}

/** `POST /v1/chat/completions` body for the OpenAI-compatible profile. */
export function mapOpenAiRequest(
  model: string,
  request: InferRequest,
  modelFormat: string | null,
): Record<string, unknown> {
  assertCommon(request);
  const { settings } = request;
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: settings.stream,
    temperature: settings.temperature,
    max_tokens: settings.max_output_tokens,
  };
  if (settings.stream) body.stream_options = { include_usage: true };
  if (settings.seed !== null) body.seed = settings.seed;
  if (request.responseSchema !== null && request.responseSchema !== undefined) {
    if (!structuredOutputTested('openai_compat_v1', modelFormat)) {
      unsupported('structured output is untested for this model format (profile_untested)');
    }
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: request.responseSchema },
    };
  }
  return body;
}

/**
 * `POST /api/v1/chat` body for the optional native instrumentation profile.
 * Storage is off and no integrations, tools, or previous chat are sent, so no
 * existing session or remote integration is inherited. Only the evidenced
 * subset is mapped: one user message, temperature, and an output limit.
 */
export function mapNativeRequest(model: string, request: InferRequest): Record<string, unknown> {
  assertCommon(request);
  const { settings } = request;
  if (settings.stream) unsupported('the native profile has no tested streaming mapping');
  if (request.messages.length !== 1 || request.messages[0]?.role !== 'user') {
    unsupported('the native profile is tested only for a single user message');
  }
  if (settings.seed !== null) unsupported('the native profile has no tested seed mapping');
  if (request.responseSchema !== null && request.responseSchema !== undefined) {
    unsupported('structured output is untested on the native profile (profile_untested)');
  }
  return {
    model,
    input: request.messages[0].content,
    store: false,
    temperature: settings.temperature,
    max_output_tokens: settings.max_output_tokens,
  };
}
