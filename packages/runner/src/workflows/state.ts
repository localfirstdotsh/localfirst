import { boundedJson, pointerSchema, type StateRef } from '@localfirst/contracts';

export class WorkflowError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WorkflowError'; }
}
export function readPointer(value: unknown, path: string): unknown {
  if (!pointerSchema.safeParse(path).success) throw new WorkflowError('invalid_pointer');
  let current = value;
  for (const part of path === '' ? [] : path.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new WorkflowError('state_field_missing');
    current = (current as Record<string, unknown>)[key];
  }
  return structuredClone(current);
}
export function mapInputs(refs: Record<string, StateRef>, state: Map<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, ref] of Object.entries(refs)) {
    if (!state.has(ref.source)) throw new WorkflowError('state_source_missing');
    out[key] = readPointer(state.get(ref.source), ref.path);
  }
  if (!boundedJson(out)) throw new WorkflowError('state_limit');
  return out;
}
/** Validate the actual reply, not merely the provider's requested output format. */
export function validateOutput(value: unknown, raw: unknown, depth = 0): boolean {
  if (depth > 12 || !boundedJson(value) || raw === null || typeof raw !== 'object') return false;
  const schema = raw as { type: string; enum?: unknown[]; properties?: Record<string, unknown>; required?: string[]; items?: unknown; additionalProperties?: boolean };
  if (schema.enum && !schema.enum.some(v => v === value)) return false;
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      if (schema.required?.some(k => !Object.hasOwn(object, k))) return false;
      return Object.entries(object).every(([k, v]) => Object.hasOwn(props, k) ? validateOutput(v, props[k], depth + 1) : schema.additionalProperties !== false);
    }
    case 'array': return Array.isArray(value) && value.every(v => validateOutput(v, schema.items, depth + 1));
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    default: return false;
  }
}
