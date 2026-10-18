import { describe, expect, it } from 'vitest';
import { buildCompatibilityRequest, readFields, type CompatibilityFields } from './compat-request';

const blank: CompatibilityFields = {
  projectVersionId: 'v1',
  cpuArchitecture: '',
  os: '',
  memoryGib: '',
  vramGib: '',
  unifiedMemory: '',
  runtimeFamily: '',
  requireLocal: false,
  requireOffline: false,
};

describe('buildCompatibilityRequest', () => {
  it('sends nothing about the machine when every field is unknown', () => {
    const result = buildCompatibilityRequest(blank);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.hardware).toBeNull();
    expect(result.request.runtime).toBeNull();
    expect(result.request.selected_models).toEqual([]);
    expect(result.request.project_version_id).toBe('v1');
    expect(result.request.requirements).toEqual({ inference: 'any', offline: false, accelerator: null });
  });

  it('converts GiB to exact binary bytes and keeps VRAM separate from system memory', () => {
    const result = buildCompatibilityRequest({ ...blank, memoryGib: '16', vramGib: '8', cpuArchitecture: 'arm64', os: 'macos', unifiedMemory: 'yes' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.hardware).toMatchObject({
      memory_bytes: 16 * 1024 ** 3,
      vram_bytes: 8 * 1024 ** 3,
      cpu_architecture: 'arm64',
      os: 'macos',
      unified_memory: true,
    });
  });

  it('treats an unknown unified-memory answer as null, not false', () => {
    const result = buildCompatibilityRequest({ ...blank, memoryGib: '8' });
    expect(result.ok && result.request.hardware?.unified_memory).toBeNull();
  });

  it('maps the two requirement checkboxes', () => {
    const result = buildCompatibilityRequest({ ...blank, requireLocal: true, requireOffline: true });
    expect(result.ok && result.request.requirements).toMatchObject({ inference: 'local_required', offline: true });
  });

  it('rejects non-positive, non-numeric, and absurd memory values', () => {
    for (const memoryGib of ['0', '-4', 'abc', '1e12', '100001']) {
      const result = buildCompatibilityRequest({ ...blank, memoryGib });
      expect(result.ok, memoryGib).toBe(false);
      if (!result.ok) expect(result.field).toBe('memory_gib');
    }
  });

  it('ignores unsupported selections instead of passing them through', () => {
    const result = buildCompatibilityRequest({ ...blank, cpuArchitecture: 'mips', os: 'templeos', runtimeFamily: 'madeup' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.hardware).toBeNull();
    expect(result.request.runtime).toBeNull();
  });
});

describe('readFields', () => {
  it('reads only the form fields, truncates long input, and never trusts types', () => {
    const form = new FormData();
    form.set('project_version_id', 'v'.repeat(200));
    form.set('memory_gib', '9'.repeat(50));
    form.set('require_local', 'on');
    const fields = readFields(form);
    expect(fields.projectVersionId).toHaveLength(64);
    expect(fields.memoryGib).toHaveLength(20);
    expect(fields.requireLocal).toBe(true);
    expect(fields.requireOffline).toBe(false);
    expect(fields.os).toBe('');
  });
});
