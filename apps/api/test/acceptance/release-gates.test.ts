/**
 * BACKEND_PRD section 20.4 (operational release gates), gate by gate.
 *
 * Each gate names what proves it and how that proof runs:
 *   - `check`: a test in `pnpm check`, on every change
 *   - `verify`: an opt-in `verify:*` script against disposable local resources;
 *     its dated result is recorded in docs/product/IMPLEMENTATION_STATUS.md
 *   - `live`: the runner's opt-in suite against a real local runtime
 *   - `doc`: a recorded matrix in docs/operations/CLIENT_MATRIX.md
 *
 * The test fails if the PRD's gate list changes or a cited proof disappears.
 * A caveat states what is not proven, so the status document can repeat it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const B = 'apps/api/test';
const V = 'apps/api/src/verification';
const R = 'packages/runner/test';

interface Proof {
  kind: 'check' | 'verify' | 'live' | 'doc';
  file: string;
  /** A test title, a verification name, or a heading that must appear in the file. */
  marker: string;
}
interface Gate {
  gate: string;
  proofs: Proof[];
  caveat?: string;
}

const GATES: Gate[] = [
  {
    gate: 'Schema/contract tests',
    proofs: [
      { kind: 'check', file: 'packages/contracts/src/contracts.test.ts', marker: 'rejects unknown manifest fields' },
      { kind: 'check', file: `${B}/evidence-builds.test.ts`, marker: 'rejects server-only and unknown fields instead of stripping them' },
      { kind: 'check', file: `${B}/evidence-schema.test.ts`, marker: 'refuses malformed digests and unknown states on builds and definitions' },
      { kind: 'check', file: `${B}/evidence-migration.test.ts`, marker: 'applies every migration and matches the Drizzle schema column for column' },
    ],
  },
  {
    gate: 'PostgreSQL ownership/constraint/transaction-race tests',
    proofs: [
      { kind: 'check', file: `${B}/evidence-schema.test.ts`, marker: 'refuses a report that names another account’s build' },
      { kind: 'check', file: `${B}/evidence-schema.test.ts`, marker: 'holds the evidence policy in the database' },
      { kind: 'check', file: `${B}/evidence-publication.test.ts`, marker: 'consumes an approval exactly once under concurrent publication' },
      { kind: 'check', file: `${B}/evidence-results.test.ts`, marker: 'creates one row and one contributor under concurrent identical submissions' },
      { kind: 'check', file: `${B}/evidence-aggregation.test.ts`, marker: 'converges when a withdrawal races an aggregation' },
    ],
  },
  {
    gate: 'fresh/upgrade migrations',
    proofs: [
      { kind: 'check', file: `${B}/evidence-migration.test.ts`, marker: 'applies every migration and matches the Drizzle schema column for column' },
      { kind: 'check', file: `${B}/evidence-migration.test.ts`, marker: 'keeps P0 data intact, adds empty evidence tables, and backfills definitions lazily' },
    ],
  },
  {
    gate: 'outbox/queue crash and replay checks',
    proofs: [
      { kind: 'check', file: `${B}/worker.test.ts`, marker: 'returns an expired lease to the queue' },
      { kind: 'check', file: `${B}/worker.test.ts`, marker: 'delivers events once and tolerates duplicate delivery' },
      { kind: 'check', file: `${B}/worker.test.ts`, marker: 'fails a stranded operation so a caller stops waiting forever' },
      { kind: 'check', file: `${B}/evidence-aggregation.test.ts`, marker: 'stands down only when a rebuild that started after the change already covers it' },
      { kind: 'verify', file: `${V}/aggregation.ts`, marker: 'p1-aggregation-and-lazy-definitions' },
    ],
  },
  {
    gate: 'source quota/SSRF fixtures',
    proofs: [
      { kind: 'check', file: `${B}/import.test.ts`, marker: 'allows only https allowlisted hosts' },
      { kind: 'check', file: `${B}/import.test.ts`, marker: 'stops reading a chunked body at the cap and cancels the upstream stream' },
      { kind: 'check', file: `${B}/contribution-quotas.test.ts`, marker: 'applies the two-concurrent-imports cap to MCP imports' },
      { kind: 'check', file: `${B}/evidence-abuse.test.ts`, marker: 'never fetches a source or model URL a build names' },
      { kind: 'check', file: `${R}/registry-source.test.ts`, marker: 'stops an endless undeclared body at the cap and cancels it' },
      { kind: 'verify', file: `${V}/github.ts`, marker: 'VERIFY_GITHUB_REPOSITORY_URL' },
    ],
    caveat: 'Successful import of a valid public bundle and live GitHub rate limiting are not verified against the real API.',
  },
  {
    gate: 'browser consent flow',
    proofs: [
      { kind: 'verify', file: `${V}/browser-consent.ts`, marker: 'browser-consent-flow' },
      { kind: 'check', file: `${B}/web.test.ts`, marker: 'requires a signed-in person for the review page' },
      { kind: 'check', file: `${B}/publication.test.ts`, marker: 'refuses an agent token at the human approval boundary' },
      { kind: 'check', file: 'apps/web/e2e/account.spec.ts', marker: 'serves a nonce-based CSP and no third-party resources' },
      { kind: 'check', file: `${B}/github-sign-in.test.ts`, marker: 'gives a first-time person a profile named after their GitHub login' },
      { kind: 'check', file: `${B}/github-sign-in.test.ts`, marker: 'repairs a person who signed in before profiles were created' },
    ],
    caveat: 'The repeatable check simulates GitHub and mints the session; real GitHub sign-in and the OAuth consent page with real third-party clients were verified by hand on staging, not by a script.',
  },
  {
    gate: 'actual MCP client matrix',
    proofs: [
      { kind: 'check', file: `${B}/mcp-client.test.ts`, marker: 'fails to connect without a token' },
      { kind: 'verify', file: `${V}/mcp-client.ts`, marker: 'p0-real-mcp-client' },
      { kind: 'doc', file: 'docs/operations/CLIENT_MATRIX.md', marker: '| Codex CLI' },
    ],
    caveat: 'Claude Code, Codex CLI, Claude Desktop, Cursor, and Zed were verified by hand; their versions and negotiated protocols are not yet recorded in CLIENT_MATRIX.md. The pinned SDK does not support the PRD candidate 2026-07-28 stateless profile.',
  },
  {
    gate: 'local runtime integration matrix',
    proofs: [
      { kind: 'live', file: `${R}/live/ollama.live.ts`, marker: 'runs the section 5.2 smoke test and records the exact outcome' },
      { kind: 'live', file: `${R}/live/lmstudio.live.ts`, marker: 'LIVE LM Studio' },
      { kind: 'check', file: `${R}/adapter-parity.test.ts`, marker: 'blocks a cloud or remote-linked model with the same code' },
      { kind: 'doc', file: 'docs/operations/CLIENT_MATRIX.md', marker: '## Local runtimes and the runner' },
    ],
    caveat: 'macOS arm64 only: Ollama 0.35.1 with two small models, and one LM Studio MLX run. Linux, the LM Studio llama.cpp engine, and real cloud models are not exercised.',
  },
  {
    gate: 'expected limits/load tests',
    proofs: [
      { kind: 'verify', file: `${V}/load.ts`, marker: 'p0-p1-load' },
      { kind: 'verify', file: `${V}/remote-latency.ts`, marker: 'remote-latency' },
      { kind: 'check', file: `${B}/web.test.ts`, marker: 'enforces a shared rate limit with Retry-After' },
      { kind: 'check', file: `${B}/evidence-abuse.test.ts`, marker: 'stops reading a chunked build upload at the body limit when no length is declared' },
      { kind: 'check', file: `${B}/contribution-quotas.test.ts`, marker: 'counts publication attempts over REST and MCP against one daily bucket' },
    ],
    caveat: 'Catalog-scale load is measured on local loopback with synthetic copies. Staging was measured over the network with one project; there is no production measurement.',
  },
  {
    gate: 'sanitized logs',
    proofs: [
      { kind: 'check', file: `${B}/evidence-logs.test.ts`, marker: 'carry no bearer token, cookie, or submitted build or result content' },
      { kind: 'check', file: `${B}/domain.test.ts`, marker: 'keeps secrets out of the logged summary' },
    ],
  },
  {
    gate: 'an isolated backup restore',
    proofs: [
      { kind: 'verify', file: `${V}/restore.ts`, marker: 'p0-p1-restore' },
      { kind: 'verify', file: `${V}/pitr.ts`, marker: 'neon-point-in-time-restore' },
      { kind: 'doc', file: 'docs/operations/RUNBOOK.md', marker: '## Backups and restore drill' },
    ],
    caveat: 'Neon point-in-time restore passed on staging, but both Neon projects keep only 6 hours of history; production needs a longer window before launch, and deployed recovery time is not demonstrated.',
  },
];

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('BACKEND_PRD section 20.4 release-gate map', () => {
  it('covers every gate the PRD lists, once and in order', () => {
    const prd = read('docs/product/BACKEND_PRD.md');
    const section = prd.slice(prd.indexOf('### 20.4'));
    const sentence = section.split('\n').find((line) => line.startsWith('Schema/contract tests'))!;
    const listed = sentence.replace(/\.$/, '').split(', ').map((item) => item.replace(/^and /, '').trim());
    expect(GATES.map((gate) => gate.gate)).toEqual(listed);
  });

  for (const gate of GATES) {
    it(`${gate.gate}: every cited proof exists`, () => {
      expect(gate.proofs.length).toBeGreaterThan(0);
      for (const proof of gate.proofs) {
        expect(read(proof.file), `${proof.file} must contain "${proof.marker}"`).toContain(proof.marker);
      }
    });
  }

  it('records which gates carry a caveat, so the status document can state it', () => {
    expect(GATES.filter((gate) => gate.caveat).map((gate) => gate.gate)).toEqual([
      'source quota/SSRF fixtures',
      'browser consent flow',
      'actual MCP client matrix',
      'local runtime integration matrix',
      'expected limits/load tests',
      'an isolated backup restore',
    ]);
  });
});
