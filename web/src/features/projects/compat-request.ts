import {
  CPU_ARCHITECTURES,
  OPERATING_SYSTEMS,
  RUNTIME_FAMILIES,
  compatibilityRequestSchema,
  type CompatibilityRequest,
} from '@localfirst/contracts';

/**
 * Turns the voluntary "Check requirements" form into a registry request
 * (FRONTEND_PRD section 6.3). Nothing is detected from the browser: every field
 * defaults to unknown, and only what the person enters is sent. Memory is
 * entered in GiB (binary) and converted to bytes.
 */

const BYTES_PER_GIB = 1024 ** 3;
const MAX_GIB = 100_000;

export interface CompatibilityFields {
  projectVersionId: string;
  cpuArchitecture: string;
  os: string;
  memoryGib: string;
  vramGib: string;
  unifiedMemory: string;
  runtimeFamily: string;
  requireLocal: boolean;
  requireOffline: boolean;
}

export type BuildResult =
  | { ok: true; request: CompatibilityRequest }
  | { ok: false; field: string; message: string };

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function gibToBytes(raw: string, field: string): { ok: true; bytes: number | null } | { ok: false; field: string; message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, bytes: null };
  const gib = Number(trimmed);
  if (!Number.isFinite(gib) || gib <= 0 || gib > MAX_GIB) {
    return { ok: false, field, message: `Enter a number of GiB between 0 and ${MAX_GIB.toLocaleString('en-US')}, or leave it blank.` };
  }
  return { ok: true, bytes: Math.round(gib * BYTES_PER_GIB) };
}

export function buildCompatibilityRequest(fields: CompatibilityFields): BuildResult {
  const memory = gibToBytes(fields.memoryGib, 'memory_gib');
  if (!memory.ok) return memory;
  const vram = gibToBytes(fields.vramGib, 'vram_gib');
  if (!vram.ok) return vram;

  const cpu = oneOf(fields.cpuArchitecture, CPU_ARCHITECTURES);
  const os = oneOf(fields.os, OPERATING_SYSTEMS);
  const unified = fields.unifiedMemory === 'yes' ? true : fields.unifiedMemory === 'no' ? false : null;
  const knownHardware = cpu !== null || os !== null || memory.bytes !== null || vram.bytes !== null || unified !== null;

  const family = oneOf(fields.runtimeFamily, RUNTIME_FAMILIES);

  const parsed = compatibilityRequestSchema.safeParse({
    project_version_id: fields.projectVersionId || null,
    requirements: {
      inference: fields.requireLocal ? 'local_required' : 'any',
      offline: fields.requireOffline,
      accelerator: null,
    },
    hardware: knownHardware
      ? { cpu_architecture: cpu, os, memory_bytes: memory.bytes, vram_bytes: vram.bytes, unified_memory: unified }
      : null,
    runtime: family ? { family } : null,
  });
  if (!parsed.success) {
    return { ok: false, field: 'form', message: 'Those values could not be checked. Review the form and try again.' };
  }
  return { ok: true, request: parsed.data };
}

export function readFields(form: FormData): CompatibilityFields {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  return {
    projectVersionId: text('project_version_id').slice(0, 64),
    cpuArchitecture: text('cpu_architecture'),
    os: text('os'),
    memoryGib: text('memory_gib').slice(0, 20),
    vramGib: text('vram_gib').slice(0, 20),
    unifiedMemory: text('unified_memory'),
    runtimeFamily: text('runtime_family'),
    requireLocal: form.get('require_local') === 'on',
    requireOffline: form.get('require_offline') === 'on',
  };
}
