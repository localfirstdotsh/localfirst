/**
 * Opt-in gate for the live runtime checks.
 *
 *   LOCALFIRST_LIVE=1                          required for any live check
 *   LOCALFIRST_LIVE_OLLAMA_ENDPOINT=http://127.0.0.1:11434
 *   LOCALFIRST_LIVE_OLLAMA_MODEL=qwen2.5:1.5b  an already installed model
 *
 *   LOCALFIRST_LIVE_LMSTUDIO=1                 additionally required for LM Studio
 *   LOCALFIRST_LIVE_LMSTUDIO_ENDPOINT=http://127.0.0.1:1234
 *   LOCALFIRST_LIVE_LMSTUDIO_MODEL=google/gemma-3-1b
 *
 * Endpoints are never guessed: nothing runs without them. These checks never
 * start a server, load a model by themselves, pull, or delete anything, and
 * the LM Studio checks skip unless its server is already reachable.
 */

export interface LiveTarget {
  endpoint: string;
  model: string;
}

export function ollamaTarget(env = process.env): LiveTarget | { skip: string } {
  if (env.LOCALFIRST_LIVE !== '1') return { skip: 'set LOCALFIRST_LIVE=1 to run live checks' };
  const endpoint = env.LOCALFIRST_LIVE_OLLAMA_ENDPOINT;
  const model = env.LOCALFIRST_LIVE_OLLAMA_MODEL;
  if (!endpoint || !model) return { skip: 'set LOCALFIRST_LIVE_OLLAMA_ENDPOINT and LOCALFIRST_LIVE_OLLAMA_MODEL' };
  return { endpoint, model };
}

export async function lmStudioTarget(env = process.env): Promise<LiveTarget | { skip: string }> {
  if (env.LOCALFIRST_LIVE !== '1') return { skip: 'set LOCALFIRST_LIVE=1 to run live checks' };
  if (env.LOCALFIRST_LIVE_LMSTUDIO !== '1') return { skip: 'LM Studio live checks need LOCALFIRST_LIVE_LMSTUDIO=1' };
  const endpoint = env.LOCALFIRST_LIVE_LMSTUDIO_ENDPOINT;
  const model = env.LOCALFIRST_LIVE_LMSTUDIO_MODEL;
  if (!endpoint || !model) return { skip: 'set LOCALFIRST_LIVE_LMSTUDIO_ENDPOINT and LOCALFIRST_LIVE_LMSTUDIO_MODEL' };
  try {
    const response = await fetch(new URL('/v1/models', endpoint), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { skip: `LM Studio at ${endpoint} answered ${response.status}; start its server yourself` };
  } catch {
    return { skip: `LM Studio is not reachable at ${endpoint}; this check never starts its server` };
  }
  return { endpoint, model };
}

export const isTarget = (value: LiveTarget | { skip: string }): value is LiveTarget => 'endpoint' in value;
