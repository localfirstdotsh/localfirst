import { boundedJson, digestOfBytes, type AgentEnvironment } from '@localfirst/contracts';
import { WorkflowError } from './state.js';

/** Private JSON data may replace declared datasets, never prompts, code, paths or permissions. */
export function applyPrivateData(original: AgentEnvironment, source: Map<string, string>, raw: unknown) {
  const environment = structuredClone(original), files = new Map(source);
  if (raw == null) return { environment, files };
  if (!boundedJson(raw) || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowError('invalid_private_data');
  for (const [key, value] of Object.entries(raw)) {
    const declaration = environment.data.find(d => d.key === key);
    if (!declaration || !boundedJson(value)) throw new WorkflowError('private_data_key_unknown');
    const content = JSON.stringify(value);
    declaration.digest = digestOfBytes(content);
    files.set(declaration.path, content);
  }
  return { environment, files };
}
