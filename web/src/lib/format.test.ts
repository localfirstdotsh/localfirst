import { describe, expect, it } from 'vitest';
import {
  checkStatus,
  compatibilityLabel,
  evidenceLabel,
  formatBytes,
  humanize,
  safeExternalUrl,
  shortDigest,
  testSupportSummary,
  meaningfulUsage,
  usageSummary,
} from './format';

describe('labels', () => {
  it('uses the exact evidence vocabulary and never invents a stronger level', () => {
    expect(evidenceLabel('claimed')).toBe('Claimed');
    expect(evidenceLabel('independently_verified')).toBe('Independently verified');
    expect(evidenceLabel('something_new')).toBe('Unknown evidence level');
  });

  it('humanizes controlled values', () => {
    expect(humanize('hardware_build')).toBe('Hardware build');
    expect(humanize('lmstudio')).toBe('LM Studio');
  });
});

describe('testSupportSummary', () => {
  it('never implies a runnable test from a declaration alone', () => {
    expect(testSupportSummary({ declared_kind: 'none', runner_available: false })).toBe('No supported harness');
    expect(testSupportSummary({ declared_kind: 'manual', runner_available: false })).toBe('Manual reproduction steps');
    expect(testSupportSummary({ declared_kind: 'declarative_task_v1', runner_available: false })).toBe(
      'Test declared · local runner not available',
    );
    expect(testSupportSummary({ declared_kind: 'declarative_task_v1', runner_available: true })).toBe(
      'Supported component test',
    );
  });
});

describe('usageSummary', () => {
  it('omits usage entirely when the API returned none', () => {
    expect(usageSummary(undefined)).toBeNull();
  });

  it('labels counts as requests with correct plurals', () => {
    expect(usageSummary({ spec_exports: 1, agent_retrievals: 0, since: null })).toBe('1 export · 0 agent retrievals');
    expect(usageSummary({ spec_exports: 1204, agent_retrievals: 1, since: '2026-10-15' })).toBe(
      '1,204 exports · 1 agent retrieval',
    );
  });
});

describe('compatibility labels', () => {
  it('uses the PRD vocabulary and treats unknown outcomes as needing information, not failure', () => {
    expect(compatibilityLabel('evidence_match')).toBe('Matching test evidence');
    expect(compatibilityLabel('candidate')).toBe('Candidate configuration');
    expect(compatibilityLabel('incompatible')).toBe('Requirement failed');
    expect(compatibilityLabel('unknown')).toBe('More information needed');
    expect(compatibilityLabel('weird')).toBe('More information needed');
  });

  it('gives every check status a symbol and a word', () => {
    expect(checkStatus('pass')).toEqual({ symbol: '✓', label: 'Pass' });
    expect(checkStatus('fail').label).toBe('Failed');
    expect(checkStatus('nonsense').label).toBe('Unknown');
  });
});

describe('digests and links', () => {
  it('shortens a long digest but keeps its scheme', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(shortDigest(digest)).toBe('sha256:aaaaaaaa…aaaaaa');
    expect(shortDigest('sha256:abc')).toBe('sha256:abc');
  });

  it('links only http(s) sources and leaves other schemes inert', () => {
    expect(safeExternalUrl('https://example.org/x')).toEqual({ href: 'https://example.org/x', host: 'example.org' });
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('uses binary units with the unit in the label', () => {
    expect(formatBytes(8 * 1024 ** 3)).toBe('8 GiB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GiB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MiB');
  });

  it('keeps missing, zero, and invalid values unknown, never zero', () => {
    expect(formatBytes(null)).toBe('Unknown');
    expect(formatBytes(undefined)).toBe('Unknown');
    expect(formatBytes(0)).toBe('Unknown');
    expect(formatBytes(Number.NaN)).toBe('Unknown');
    expect(formatBytes(null, 'Not supplied')).toBe('Not supplied');
  });
});

describe('meaningfulUsage', () => {
  it('hides zeros and keeps real counts', () => {
    expect(meaningfulUsage(undefined)).toBeNull();
    expect(meaningfulUsage({ spec_exports: 0, agent_retrievals: 0, since: null })).toBeNull();
    expect(meaningfulUsage({ spec_exports: 0, agent_retrievals: 3, since: null })).toBe('3 agent retrievals');
    expect(meaningfulUsage({ spec_exports: 1, agent_retrievals: 2, since: null })).toBe('1 export · 2 agent retrievals');
  });
});

describe('compatibility labels', () => {
  it('names architectures and runtimes without implying a platform', () => {
    expect(humanize('arm64')).toBe('Arm64');
    expect(humanize('x86_64')).toBe('x86-64');
    expect(humanize('llamacpp')).toBe('llama.cpp');
  });
});
