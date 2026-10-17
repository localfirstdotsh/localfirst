/**
 * BACKEND_PRD section 20.2 (P1 runtime/runner and privacy), bullet by bullet.
 *
 * Each bullet is mapped to the tests that prove it, grouped by how strong the
 * proof is:
 *   - `acceptance`: this directory, real backend + real CLI + real adapters on fake runtimes
 *   - `unit`: a deterministic test in `runner/test` or `backend/test`
 *   - `live`: only provable against a real runtime (`pnpm test:live`, not part of `pnpm check`)
 *   - `gap`: not proven by anything automated; recorded in IMPLEMENTATION_STATUS.md
 *
 * The test below fails if a cited test title no longer exists, so the map
 * cannot silently drift from the suite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const A = 'backend/test/acceptance';

interface Proof {
  file: string;
  title: string;
}
interface Bullet {
  n: number;
  requirement: string;
  proofs: Proof[];
  /** What is not proven by deterministic tests, if anything. */
  caveat?: string;
}

const BULLETS: Bullet[] = [
  {
    n: 1,
    requirement: 'Both adapters discover only an approved endpoint and the selected inventory, without cloud upload.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A1]' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A2]' },
      { file: 'runner/test/cli-flow.test.ts', title: 'contacts nothing and spawns nothing without an interactive yes' },
      { file: 'runner/test/cli-flow.test.ts', title: 'only ever connects to the approved runtime and the configured registry' },
      { file: 'runner/test/ollama-adapter.test.ts', title: 'only ever requests the allowed read and chat routes, never pull, create, delete, or copy' },
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'only ever requests read and chat endpoints across a full session' },
    ],
    caveat: 'Against fake servers shaped by captured fixtures; a real LM Studio server was not exercised.',
  },
  {
    n: 2,
    requirement: 'Available vs loaded state, identity scheme, versions, unsupported capabilities, and unknown metadata are preserved.',
    proofs: [
      { file: 'runner/test/ollama-adapter.test.ts', title: 'keeps loaded and available apart and carries the manifest digest as runtime identity' },
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'uses native discovery: loaded versus available, capabilities with sources, no embedding models' },
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'keeps application, CLI, and engine separate in the probe, defaulting to unobserved' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A2]' },
    ],
  },
  {
    n: 3,
    requirement: 'Selected cloud or unresolved delegated models fail local-only preflight; no silent cloud fallback.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F1] Ollama: a cloud model (synthetic fixture) fails local-only preflight' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F1] LM Studio: a remote-linked model (synthetic fixture) fails local-only preflight' },
      { file: 'runner/test/adapter-parity.test.ts', title: 'blocks a cloud or remote-linked model with the same code' },
    ],
    caveat: 'Cloud, remote-linked, and unknown-origin models are synthetic fixtures; none was installed to capture.',
  },
  {
    n: 4,
    requirement: 'The section 5 task executes on each supported adapter; unsupported JSON/context/settings fail or return unknown before unsafe execution.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A1]' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A2]' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F2] Ollama: an oversized context' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F2] LM Studio: an oversized context' },
    ],
    caveat: 'Deterministic runs use fake runtimes; the real Ollama smoke test is the live harness.',
  },
  {
    n: 5,
    requirement: 'Arbitrary-code, tool, multimodal, actuation, and custom-harness definitions stay non-executable.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F3]' },
      { file: 'runner/test/harnesses.test.ts', title: 'has no evaluator beyond the two trusted kinds' },
      { file: 'runner/test/verify.test.ts', title: 'rejects a bundle that turns on tools, project code, or downloads' },
      { file: 'runner/test/executability-parity.test.ts', title: 'agree' },
    ],
  },
  {
    n: 6,
    requirement: 'Local execution requires exact-plan approval; source/fixture edits invalidate it; downloads and config changes never happen implicitly.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A3]' },
      { file: 'runner/test/cli-flow.test.ts', title: 'refuses without a terminal or a stored approval, and never calls the model' },
      { file: 'runner/test/cli-flow.test.ts', title: 'a changed bundle invalidates even a stored approval' },
      { file: 'runner/test/verify.test.ts', title: 'is invalidated by an edit to a fixture prompt' },
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'contains no model-management endpoint in the adapter source' },
    ],
  },
  {
    n: 7,
    requirement: 'The anonymous public-spec/local-test flow works without an account; offline saved-bundle use states its revocation-freshness limit.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A1]' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A5]' },
      { file: 'runner/test/cli-flow.test.ts', title: 'does not contact the registry with --offline and states the freshness limit' },
    ],
  },
  {
    n: 8,
    requirement: 'A complete report is saved locally; upload, telemetry, and publication never happen without separate review and consent.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A1]' },
      { file: `${A}/contribution-flow.test.ts`, title: '[C1]' },
      { file: 'runner/test/consent.test.ts', title: 'binds upload and public approval to the exact reviewed export' },
    ],
  },
  {
    n: 9,
    requirement: 'A private-input run export excludes inputs, outputs, private hashes, paths, credentials, inventory, and machine identifiers.',
    proofs: [
      { file: `${A}/contribution-flow.test.ts`, title: '[C3]' },
      { file: 'runner/test/reports.test.ts', title: 'refuses private local runs' },
      { file: 'runner/test/cli-report.test.ts', title: 'shares hardware only when you opt in at review' },
    ],
    caveat: 'There is no private-input run path in P1; a private-local plan is refused at export instead.',
  },
  {
    n: 10,
    requirement: 'A changed model binding produces a new build/deviation, not a false reproduction of the original.',
    proofs: [{ file: `${A}/contribution-flow.test.ts`, title: '[C6]' }],
  },
  {
    n: 11,
    requirement: 'Unavailable sensor/version/time-to-first-token metrics are null with reasons; runner memory is not mislabeled as inference memory.',
    proofs: [
      { file: 'runner/test/measure.test.ts', title: 'reports peak memory and utilization as unavailable with their reasons' },
      { file: 'runner/test/measure.test.ts', title: 'accepts a real device sensor method and rejects runner RSS as inference memory' },
      { file: 'runner/test/measure.test.ts', title: 'is unavailable for a non-streaming run: there is no first-content event' },
      { file: 'runner/test/measure.test.ts', title: 'is unavailable, with a reason, when a streamed reply carried no content or an execution lacks the event' },
    ],
    caveat: 'Streaming time-to-first-token is measured on Ollama (live) and on LM Studio\'s OpenAI-compatible profile (fake runtime and a real capture only; not exercised live); its native profile blocks streaming. No memory sensor exists.',
  },
  {
    n: 12,
    requirement: 'Timeout, cancellation, and provider failure create an honest partial/error report; retries are user-controlled.',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A4]' },
      { file: 'runner/test/run.test.ts', title: 'stops at the run timeout and counts the remaining cases as skipped' },
      { file: 'runner/test/run.test.ts', title: 'makes one attempt per request and never retries a failure' },
    ],
  },
  {
    n: 13,
    requirement: 'Ollama duration conversion and LM Studio native/compatible measurement methods stay distinct and testable.',
    proofs: [
      { file: 'runner/test/ollama-adapter.test.ts', title: 'keeps native nanoseconds and adds clearly named derived values' },
      { file: 'runner/test/measure.test.ts', title: 'uses the LM Studio native rate with its own method' },
      { file: 'runner/test/measure.test.ts', title: 'reports the OpenAI-compatible profile as unexported rather than deriving a rate' },
    ],
  },
  {
    n: 14,
    requirement: 'Native LM Studio instrumentation disables storage/integrations for the harness; API/engine version unknowns are not guessed.',
    proofs: [
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'sends only the evidenced fields with storage off, and tags native statistics' },
      { file: 'runner/test/lmstudio-adapter.test.ts', title: 'parses the CLI commit and never reports it as an engine' },
    ],
    caveat: 'Verified against captured fixtures and a fake server; not against a live LM Studio.',
  },
  {
    n: 15,
    requirement: 'Report validation does not assign independent verification; duplicate submissions do not inflate independent counts.',
    proofs: [
      { file: `${A}/contribution-flow.test.ts`, title: '[C2]' },
      { file: `${A}/contribution-flow.test.ts`, title: '[C4]' },
      { file: 'backend/test/evidence-results.test.ts', title: 'rejects any client assertion of verification, review, badges, or a submitter' },
      { file: 'backend/test/evidence-results.test.ts', title: 'creates one row and one contributor under concurrent identical submissions' },
      { file: 'backend/test/evidence-publication.test.ts', title: 'cannot be told to assign a level, including independently_verified' },
    ],
  },
  {
    n: 16,
    requirement: 'A manual hardware/workflow build report can be saved, reviewed, and shared without a test definition; its level cannot exceed community_reported.',
    proofs: [
      { file: `${A}/contribution-flow.test.ts`, title: '[C7]' },
      { file: 'backend/test/evidence-publication.test.ts', title: 'caps an accepted manual build report at community_reported, in the service and in the database' },
    ],
  },
];

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('BACKEND_PRD section 20.2 coverage map', () => {
  it('covers every bullet once, in order', () => {
    expect(BULLETS.map((bullet) => bullet.n)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
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
    const caveated = BULLETS.filter((bullet) => bullet.caveat).map((bullet) => bullet.n);
    expect(caveated).toEqual([1, 3, 4, 9, 11, 14]);
  });
});
