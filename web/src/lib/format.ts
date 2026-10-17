import type { ProjectSummary, Usage } from './schemas';

/** Evidence labels and meanings (FRONTEND_PRD section 9.1). Enum values stay internal. */
export const EVIDENCE: Record<string, { label: string; description: string }> = {
  claimed: { label: 'Claimed', description: 'Author or user declaration; not established by a run.' },
  documented: {
    label: 'Documented',
    description: 'The source supports the stated requirements. No Localfirst run is implied.',
  },
  community_reported: {
    label: 'Community reported',
    description: 'An authenticated contributor reported an outcome; review status still matters.',
  },
  reproducible_test: {
    label: 'Reproducible test',
    description: 'An accepted bounded protocol and a sufficiently identified configuration. Not independent verification.',
  },
  independently_verified: {
    label: 'Independently verified',
    description: 'A separate reviewed reproduction for the exact claim and scope.',
  },
};

export function evidenceLabel(level: string): string {
  return EVIDENCE[level]?.label ?? 'Unknown evidence level';
}

const SPECIAL_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  arm64: 'Arm64',
  x86_64: 'x86-64',
  riscv64: 'RISC-V 64',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  mlx: 'MLX',
  tensorrt_llm: 'TensorRT-LLM',
  onnxruntime: 'ONNX Runtime',
  declarative_task_v1: 'Declarative test',
};

/** Human label for a controlled value; the raw value is never used as a query value. */
export function humanize(value: string): string {
  const special = SPECIAL_LABELS[value];
  if (special) return special;
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function listOrUnknown(values: readonly string[], label = 'Not supplied'): string {
  return values.length > 0 ? values.map(humanize).join(' · ') : label;
}

/** What a project's test declaration actually allows (FRONTEND_PRD section 6.4). */
export function testSupportSummary(support: ProjectSummary['test_support']): string {
  switch (support.declared_kind) {
    case 'none':
      return 'No supported harness';
    case 'manual':
      return 'Manual reproduction steps';
    case 'declarative_task_v1':
      return support.runner_available
        ? 'Supported component test'
        : 'Test declared · local runner not available';
    default:
      return 'Test support unknown';
  }
}

const COUNT = new Intl.NumberFormat('en-US');
export function formatCount(value: number): string {
  return COUNT.format(value);
}

/** "since" is only shown when the API returned it; counts are requests, not people. */
export function usageSummary(usage: Usage | undefined): string | null {
  if (!usage) return null;
  const parts = [
    `${formatCount(usage.spec_exports)} ${usage.spec_exports === 1 ? 'export' : 'exports'}`,
    `${formatCount(usage.agent_retrievals)} agent ${usage.agent_retrievals === 1 ? 'retrieval' : 'retrievals'}`,
  ];
  return parts.join(' · ');
}

/** Only counts above zero: a row of zeros says nothing about a project, so it is left out. */
export function meaningfulUsage(usage: Usage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.spec_exports > 0) parts.push(`${formatCount(usage.spec_exports)} ${usage.spec_exports === 1 ? 'export' : 'exports'}`);
  if (usage.agent_retrievals > 0) {
    parts.push(`${formatCount(usage.agent_retrievals)} agent ${usage.agent_retrievals === 1 ? 'retrieval' : 'retrievals'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toISOString().slice(0, 10);
}

/** Compatibility outcome labels (FRONTEND_PRD section 9.2). An unknown outcome is not a failure. */
export const COMPATIBILITY_OUTCOMES: Record<string, string> = {
  evidence_match: 'Matching test evidence',
  candidate: 'Candidate configuration',
  incompatible: 'Requirement failed',
  unknown: 'More information needed',
};

export function compatibilityLabel(outcome: string): string {
  return COMPATIBILITY_OUTCOMES[outcome] ?? 'More information needed';
}

/** Requirement check status: a symbol and a word, never color alone. */
export const CHECK_STATUS: Record<string, { symbol: string; label: string }> = {
  pass: { symbol: '✓', label: 'Pass' },
  fail: { symbol: '✕', label: 'Failed' },
  unknown: { symbol: '?', label: 'Unknown' },
  not_applicable: { symbol: '–', label: 'Not applicable' },
};

export function checkStatus(status: string): { symbol: string; label: string } {
  return CHECK_STATUS[status] ?? CHECK_STATUS.unknown!;
}

/** Readable short form of a digest; the full value stays available to inspect and copy. */
export function shortDigest(digest: string): string {
  const [scheme, value] = digest.includes(':') ? (digest.split(':', 2) as [string, string]) : ['', digest];
  if (value.length <= 16) return digest;
  return `${scheme ? `${scheme}:` : ''}${value.slice(0, 8)}…${value.slice(-6)}`;
}

/**
 * Only http(s) source links are rendered as links. Anything else, such as a
 * javascript: or data: URL from a specification, is shown as inert text.
 */
export function safeExternalUrl(raw: string | null): { href: string; host: string } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { href: url.toString(), host: url.host };
  } catch {
    return null;
  }
}

/** Binary units, explicit in the label (FRONTEND_PRD section 8.4). Null stays unknown, never zero. */
export function formatBytes(bytes: number | null | undefined, unknown = 'Unknown'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return unknown;
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}
