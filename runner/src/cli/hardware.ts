import { arch, platform, release, totalmem } from 'node:os';
import type { BuildHardware } from '../reports/upload.js';

export interface HardwareFacts {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  totalMemoryBytes: number;
}

const GIB = 2 ** 30;
const OS_NAMES: Partial<Record<NodeJS.Platform, 'macos' | 'linux' | 'windows'>> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};
const ARCHITECTURES: Record<string, 'arm64' | 'x86_64' | 'riscv64'> = {
  arm64: 'arm64',
  x64: 'x86_64',
  riscv64: 'riscv64',
};

/**
 * A coarse hardware summary from facts the operating system already exposes:
 * OS name and release, CPU architecture, and memory rounded to whole GiB. No
 * hostname, user, path, serial, CPU model string, device list, or inventory.
 * Returns `null` when the architecture cannot be named, so nothing is guessed.
 */
export function summarizeHardware(facts: HardwareFacts): BuildHardware | null {
  const architecture = ARCHITECTURES[facts.arch];
  if (!architecture) return null;
  const appleSilicon = facts.platform === 'darwin' && architecture === 'arm64';
  return {
    platform: appleSilicon ? 'apple-silicon' : null,
    os: { name: OS_NAMES[facts.platform] ?? 'other', version: facts.release.slice(0, 60) || null },
    cpu_architecture: architecture,
    cpu_model: null,
    memory_bytes: Math.max(GIB, Math.round(facts.totalMemoryBytes / GIB) * GIB),
    unified_memory: appleSilicon ? true : null,
    accelerators: [],
  };
}

/** Read the real machine. Called only after the user opts in at export review. */
export function collectHardware(): BuildHardware | null {
  return summarizeHardware({ platform: platform(), arch: arch(), release: release(), totalMemoryBytes: totalmem() });
}
