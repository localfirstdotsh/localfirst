import { describe, expect, it } from 'vitest';
import { buildInputSchema } from '@localfirst/contracts';
import { summarizeHardware } from '../src/cli/hardware.js';

const GIB = 2 ** 30;

describe('summarizeHardware', () => {
  it('summarizes only coarse facts and rounds memory to whole GiB', () => {
    const summary = summarizeHardware({ platform: 'darwin', arch: 'arm64', release: '25.5.0', totalMemoryBytes: 17.2 * GIB });
    expect(summary).toEqual({
      platform: 'apple-silicon',
      os: { name: 'macos', version: '25.5.0' },
      cpu_architecture: 'arm64',
      cpu_model: null,
      memory_bytes: 17 * GIB,
      unified_memory: true,
      accelerators: [],
    });
    // The summary is exactly the build contract's hardware shape and nothing more.
    expect(Object.keys(summary!).sort()).toEqual(['accelerators', 'cpu_architecture', 'cpu_model', 'memory_bytes', 'os', 'platform', 'unified_memory']);
  });

  it('does not claim what it cannot know', () => {
    const linux = summarizeHardware({ platform: 'linux', arch: 'x64', release: '6.8.0', totalMemoryBytes: 31.6 * GIB });
    expect(linux).toMatchObject({ platform: null, os: { name: 'linux' }, cpu_architecture: 'x86_64', unified_memory: null, accelerators: [] });
    expect(summarizeHardware({ platform: 'linux', arch: 'ppc64', release: '6', totalMemoryBytes: GIB })).toBeNull();
    expect(summarizeHardware({ platform: 'freebsd', arch: 'arm64', release: '14', totalMemoryBytes: GIB })?.os.name).toBe('other');
  });

  it('is accepted by the build contract', () => {
    const hardware = summarizeHardware({ platform: 'darwin', arch: 'arm64', release: '25.5.0', totalMemoryBytes: 16 * GIB });
    expect(hardware).not.toBeNull();
    expect(buildInputSchema.shape.hardware.safeParse(hardware).success).toBe(true);
  });
});
