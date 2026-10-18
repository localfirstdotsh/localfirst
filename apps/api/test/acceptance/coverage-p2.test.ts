/**
 * BACKEND_PRD section 20.3 (P2 compatibility and community), bullet by bullet.
 *
 * Each bullet is mapped to the deterministic tests that prove it. A bullet with
 * a caveat is not fully proven by automated tests; IMPLEMENTATION_STATUS.md
 * states the gap.
 *
 * The test below fails if a cited test title no longer exists or the PRD's
 * bullet list changes, so the map cannot silently drift from the suite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const B = 'apps/api/test';

interface Proof {
  file: string;
  title: string;
}
interface Bullet {
  n: number;
  requirement: string;
  proofs: Proof[];
  caveat?: string;
}

const BULLETS: Bullet[] = [
  {
    n: 1,
    requirement: 'Eligible comparison groups disclose varying dimension and all confounders; incompatible private/public fixtures and metric protocols are excluded.',
    proofs: [
      { file: `${B}/community-network.test.ts`, title: 'groups accepted exact protocols, discloses model variation, confounders, and distinct contributors without a score' },
      { file: `${B}/community-network.test.ts`, title: 'excludes unknown timing context, hidden hardware, withdrawn evidence and differing metric methods' },
      { file: `${B}/community-network.test.ts`, title: 'binds paged windows to the protocol query and excludes unreviewed reports' },
    ],
  },
  {
    n: 2,
    requirement: 'An exact component evidence match does not imply complete-project/offline/robotics success.',
    proofs: [
      { file: `${B}/evidence-aggregation.test.ts`, title: 'answers evidence_match only for an exact identity match, at component scope' },
      { file: `${B}/community-network.test.ts`, title: 'requires exact settings, engine, profile, quantization and memory for accepted evidence matching' },
      { file: `${B}/community-network.test.ts`, title: 'links a separate qualified run, scopes the claim, and immediately loses qualification on withdrawal' },
      { file: `${B}/domain.test.ts`, title: 'never reports offline as observed' },
    ],
  },
  {
    n: 3,
    requirement: 'Independent verification requires separate qualified evidence and reviewer criteria; self-report flags/signatures alone cannot create it.',
    proofs: [
      { file: `${B}/community-network.test.ts`, title: 'links a separate qualified run, scopes the claim, and immediately loses qualification on withdrawal' },
      { file: `${B}/community-network.test.ts`, title: 'rejects self-report reruns, author/submitter reviewers, conflicts, incomplete criteria and agent authority' },
      { file: `${B}/evidence-results.test.ts`, title: 'rejects any client assertion of verification, review, badges, or a submitter' },
    ],
    caveat: 'Author aliases and external affiliations cannot be detected from account IDs; the operator reviews them by hand.',
  },
  {
    n: 4,
    requirement: 'Accepted failures, conflicts, corrections, withdrawals, and source/model/runtime/test drift affect matching visibly.',
    proofs: [
      { file: `${B}/evidence-aggregation.test.ts`, title: 'includes accepted failures and flags a conflict instead of averaging' },
      { file: `${B}/evidence-aggregation.test.ts`, title: 'does not call exact accepted failures a match, and surfaces conflicts' },
      { file: `${B}/evidence-aggregation.test.ts`, title: 'stops matching after the evidence is withdrawn' },
      { file: `${B}/evidence-lifecycle.test.ts`, title: 'removes private evidence, withdraws public evidence, and reaggregates' },
      { file: `${B}/community-network.test.ts`, title: 'rejects model drift and revokes exact claims without resurrection' },
      { file: `${B}/community-network.test.ts`, title: 'publishes attributed troubleshooting corrections as new records and invalidates changed approvals' },
    ],
  },
  {
    n: 5,
    requirement: 'Remixes preserve parent attribution/licenses and reject cycles; no evidence transfers automatically.',
    proofs: [
      { file: `${B}/community-network.test.ts`, title: 'publishes an attributed immutable child without parent rights or transferred evidence' },
      { file: `${B}/community-network.test.ts`, title: 'blocks missing attribution/licenses and does not publish a draft after the parent is quarantined' },
      { file: `${B}/community-network.test.ts`, title: 'rejects a version update that would make a project derive from itself or its own descendant' },
    ],
  },
  {
    n: 6,
    requirement: 'New workflow/custom harness support passes documented isolation/device/network/credential gates before enablement.',
    proofs: [
      { file: `${B}/community-network.test.ts`, title: 'gates community schemas, scopes and direct calls without enabling custom execution' },
    ],
    caveat: 'No custom or workflow harness is enabled, and the isolation/device/network/credential gates are not yet designed; the proof is that nothing executes.',
  },
];

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('BACKEND_PRD section 20.3 coverage map', () => {
  it('covers every bullet the PRD lists, once and in order', () => {
    const prd = read('docs/product/BACKEND_PRD.md');
    const section = prd.slice(prd.indexOf('### 20.3'), prd.indexOf('### 20.4'));
    const listed = section.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
    expect(BULLETS.map((bullet) => bullet.requirement)).toEqual(listed);
  });

  for (const bullet of BULLETS) {
    it(`bullet ${bullet.n}: every cited proof exists`, () => {
      expect(bullet.proofs.length).toBeGreaterThan(0);
      for (const proof of bullet.proofs) {
        expect(read(proof.file), `${proof.file} must contain "${proof.title}"`).toContain(proof.title);
      }
    });
  }

  it('records which bullets carry a caveat, so the status document can state it', () => {
    expect(BULLETS.filter((bullet) => bullet.caveat).map((bullet) => bullet.n)).toEqual([3, 6]);
  });
});
