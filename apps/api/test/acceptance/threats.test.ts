/**
 * BACKEND_PRD section 17.1 (threat/control matrix), row by row, for the P1
 * surface: test definitions, builds, results, publication of evidence,
 * review, aggregation, and the local runner that produces results.
 *
 * Each row names the tests that prove its control on that surface. The test
 * below fails if a cited test title no longer exists, so the map cannot
 * silently drift from the suite. A caveat states what the cited tests do not
 * prove.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const B = 'apps/api/test';
const R = 'packages/runner/test';
const A = 'apps/api/test/acceptance';

interface Proof {
  file: string;
  title: string;
}
interface Row {
  threat: string;
  proofs: Proof[];
  caveat?: string;
}

const ROWS: Row[] = [
  {
    threat: 'Wrong-service/token passthrough',
    proofs: [
      { file: `${B}/auth.test.ts`, title: 'refuses an MCP-audience token at the REST resource' },
      { file: `${B}/mcp.test.ts`, title: 'refuses a REST-audience token at the MCP resource' },
      { file: `${B}/auth.test.ts`, title: 'refuses a wrong issuer, an expired token, and a tampered signature' },
      { file: `${R}/cli-units.test.ts`, title: 'sends the token only when given one' },
      { file: `${R}/ollama-adapter.test.ts`, title: 'never sends the credential anywhere but the approved endpoint and does not leak it in errors' },
      { file: `${R}/lmstudio-adapter.test.ts`, title: 'is sent as a bearer only to the approved endpoint and works when correct' },
    ],
  },
  {
    threat: 'Agent scope escalation',
    proofs: [
      { file: `${B}/evidence-builds.test.ts`, title: 'requires an Idempotency-Key and the builds:write scope' },
      { file: `${B}/evidence-results.test.ts`, title: 'needs builds:write as well as tests:submit to create a build inline' },
      { file: `${B}/evidence-mcp.test.ts`, title: 'needs tests:submit, and builds:write as well to create the build inline' },
      { file: `${B}/evidence-publication.test.ts`, title: 'requires the kind-specific write scope and never accepts read scopes' },
      { file: `${B}/evidence-publication.test.ts`, title: 'cannot be told to assign a level, including independently_verified' },
    ],
  },
  {
    threat: 'False human approval',
    proofs: [
      { file: `${B}/evidence-publication.test.ts`, title: 'requires every warning to be acknowledged and a human session to approve' },
      { file: `${B}/evidence-publication.test.ts`, title: 'invalidates the approval when the selection, and so the projection, changes' },
      { file: `${B}/evidence-publication.test.ts`, title: 'consumes an approval exactly once under concurrent publication' },
      { file: `${B}/evidence-publication.test.ts`, title: 'blocks publication when the record is withdrawn after approval' },
      { file: `${A}/contribution-flow.test.ts`, title: '[C4]' },
      { file: `${B}/publication-delegation.test.ts`, title: 'refuses publishing without an approval until the owner delegates, and only a browser session can delegate' },
    ],
  },
  {
    threat: 'Unwanted publication by a delegated agent',
    proofs: [
      { file: `${B}/publication-delegation.test.ts`, title: 'lets a delegated connection publish the exact artifact it names, with its own warning acknowledgements, and labels the version' },
      { file: `${B}/publication-delegation.test.ts`, title: 'is scoped to one connection, and ends when the owner turns it off or revokes the connection' },
      { file: `${B}/publication-delegation.test.ts`, title: 'can be enabled while approving, only for the connection that created the draft, atomically' },
    ],
  },
  {
    threat: 'False local-execution consent',
    proofs: [
      { file: `${R}/consent.test.ts`, title: 'binds execution to the reviewed plan digest' },
      { file: `${R}/cli-flow.test.ts`, title: 'contacts nothing and spawns nothing without an interactive yes' },
      { file: `${R}/cli-flow.test.ts`, title: 'refuses without a terminal or a stored approval, and never calls the model' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A3]' },
      { file: `${B}/evidence-results.test.ts`, title: 'rejects any client assertion of verification, review, badges, or a submitter' },
    ],
    caveat: 'The backend cannot observe a local run: an uploaded result is a reported assertion, and the server treats it as one.',
  },
  {
    threat: 'Local/cloud inference confusion',
    proofs: [
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F1] Ollama: a cloud model (synthetic fixture) fails local-only preflight' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F1] LM Studio: a remote-linked model (synthetic fixture) fails local-only preflight' },
      { file: `${R}/ollama-adapter.test.ts`, title: 'rejects cloud models for local-only runs, by marker and by name' },
      { file: `${B}/evidence-results.test.ts`, title: 'keeps an incomplete, cancelled, unverified-locality, or identity-poor report at community level' },
    ],
    caveat: 'Cloud, remote-linked, and unknown-origin models are synthetic fixtures.',
  },
  {
    threat: 'Localhost exposure or unsafe redirect',
    proofs: [
      { file: `${R}/cli-flow.test.ts`, title: 'rejects non-loopback endpoints without any prompt or request' },
      { file: `${R}/cli-flow.test.ts`, title: 'only ever connects to the approved runtime and the configured registry' },
      { file: `${R}/adapter-contract.test.ts`, title: 'does not follow redirects' },
      { file: `${R}/adapter-contract.test.ts`, title: 'refuses paths that could leave the origin' },
      { file: `${R}/cli-units.test.ts`, title: 'never follows redirects and reports transport failures without a stack' },
    ],
  },
  {
    threat: 'Untrusted fixture/prompt/model output',
    proofs: [
      { file: `${R}/harnesses.test.ts`, title: 'has no evaluator beyond the two trusted kinds' },
      { file: `${R}/harnesses.test.ts`, title: 'rejects very deep nesting without exhausting the stack' },
      { file: `${R}/harnesses.test.ts`, title: 'errors on oversized JSON before parsing it' },
      { file: `${R}/harnesses.test.ts`, title: 'never follows prototype properties or malformed array indices' },
      { file: `${R}/run.test.ts`, title: 'turns an oversized reply into an error without recording it' },
      { file: 'packages/contracts/src/contracts.test.ts', title: 'rejects YAML nested deeper than the limit, in frontmatter and in test manifests' },
    ],
  },
  {
    threat: 'Untrusted project/dependency code',
    proofs: [
      { file: `${R}/verify.test.ts`, title: 'rejects a bundle that turns on tools, project code, or downloads' },
      { file: `${R}/cli-flow.test.ts`, title: 'refuses a test that enables tools, project code, or downloads' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[F3]' },
      { file: `${B}/evidence-definitions.test.ts`, title: 'does not claim a runner for a declared test the runner cannot execute' },
      { file: `${B}/evidence-mcp.test.ts`, title: 'annotates tools honestly and offers no execution or discovery tool' },
    ],
  },
  {
    threat: 'Source or client-metadata SSRF',
    proofs: [
      { file: `${B}/evidence-abuse.test.ts`, title: 'never fetches a source or model URL a build names, through validation, publication, review, and aggregation' },
      { file: `${B}/evidence-abuse.test.ts`, title: 'stops reading a chunked build upload at the body limit when no length is declared' },
      { file: `${B}/evidence-abuse.test.ts`, title: 'rejects a deeply nested build body as invalid and keeps serving' },
      { file: `${R}/registry-source.test.ts`, title: 'stops an endless undeclared body at the cap and cancels it' },
      { file: `${R}/registry-source.test.ts`, title: 'refuses a body whose declared length exceeds the cap without reading it' },
      { file: `${R}/registry-source.test.ts`, title: 'refuses more than 20 bundled files' },
      { file: `${R}/registry-source.test.ts`, title: 'refuses a bundle larger than 2 MiB in total, even with matching digests' },
      { file: `${R}/registry-source.test.ts`, title: 'refuses traversal, absolute, and backslash paths' },
      { file: `${R}/registry-source.test.ts`, title: 'refuses a file whose content does not match its own digest' },
      { file: `${R}/cli-report.test.ts`, title: 'shares an upstream model source only when you declare one, and rejects anything but a public https address' },
    ],
    caveat: 'P1 adds no server-side fetch: build and model URLs are stored data. Source fetching is the P0 GitHub import, covered in import.test.ts.',
  },
  {
    threat: 'Secret/private content upload',
    proofs: [
      { file: `${A}/contribution-flow.test.ts`, title: '[C3]' },
      { file: `${R}/reports.test.ts`, title: 'exports only the allowlisted fields and a digest of the exact payload' },
      { file: `${R}/reports.test.ts`, title: 'refuses private local runs' },
      { file: `${B}/evidence-builds.test.ts`, title: 'rejects server-only and unknown fields instead of stripping them' },
      { file: `${B}/evidence-results.test.ts`, title: 'rejects any client assertion of verification, review, badges, or a submitter' },
    ],
  },
  {
    threat: 'Cross-user private record disclosure',
    proofs: [
      { file: `${B}/evidence-builds.test.ts`, title: 'answers 404 to anyone but the owner for a private build' },
      { file: `${B}/evidence-results.test.ts`, title: 'shows a private report only to its submitter' },
      { file: `${B}/evidence-mcp.test.ts`, title: 'shows a private build to its owner only' },
      { file: `${B}/evidence-mcp.test.ts`, title: 'shows a private result only to its submitter' },
      { file: `${B}/evidence-publication.test.ts`, title: 'refuses a draft for a record you do not own, with a 404' },
      { file: `${B}/evidence-results.test.ts`, title: 'refuses another account’s build, a foreign test definition, and mismatched bindings' },
      { file: `${B}/worker.test.ts`, title: 'keeps operation status private to its owner and operators' },
      { file: `${B}/evidence-lifecycle.test.ts`, title: 'lists published pending reports for operators and nothing private' },
    ],
  },
  {
    threat: 'Fake benchmark or manipulated counts',
    proofs: [
      { file: `${B}/evidence-aggregation.test.ts`, title: 'counts distinct contributors, so one creator’s reruns are one contributor' },
      { file: `${B}/evidence-results.test.ts`, title: 'creates one row and one contributor under concurrent identical submissions' },
      { file: `${B}/evidence-publication.test.ts`, title: 'assigns reproducible_test only after acceptance and passing server checks' },
      { file: `${B}/evidence-publication.test.ts`, title: 'rejects, can be re-decided, and forbids reviewing your own report' },
      { file: `${B}/evidence-schema.test.ts`, title: 'holds the evidence policy in the database' },
      { file: `${B}/evidence-aggregation.test.ts`, title: 'includes accepted failures and flags a conflict instead of averaging' },
    ],
  },
  {
    threat: 'Changed source/spec/evidence',
    proofs: [
      { file: `${B}/evidence-results.test.ts`, title: 'marks a report with a changed digest invalid, and keeps the observation' },
      { file: `${B}/evidence-aggregation.test.ts`, title: 'keeps evidence bound to the exact version' },
      { file: `${B}/evidence-aggregation.test.ts`, title: 'stops matching after the evidence is withdrawn' },
      { file: `${R}/cli-flow.test.ts`, title: 'refuses a definition whose digests changed' },
      { file: `${R}/verify.test.ts`, title: 'is invalidated by an edit to a fixture prompt' },
      { file: `${A}/anonymous-local-flow.test.ts`, title: '[A5]' },
    ],
  },
  {
    threat: 'Spam/abusive content',
    proofs: [
      { file: `${B}/evidence-abuse.test.ts`, title: 'counts builds and results over REST and every MCP client against one daily bucket per account' },
      { file: `${B}/contribution-quotas.test.ts`, title: 'counts project and record drafts over REST and every MCP client against one hourly bucket' },
      { file: `${B}/contribution-quotas.test.ts`, title: 'counts publication attempts over REST and MCP against one daily bucket' },
      { file: `${B}/contribution-quotas.test.ts`, title: 'applies the two-concurrent-imports cap to MCP imports' },
      { file: `${B}/web.test.ts`, title: 'enforces a shared rate limit with Retry-After' },
      { file: `${B}/evidence-lifecycle.test.ts`, title: 'lists published pending reports for operators and nothing private' },
      { file: `${B}/evidence-lifecycle.test.ts`, title: 'removes private evidence, withdraws public evidence, and reaggregates' },
    ],
  },
  {
    threat: 'Credential/log leakage',
    proofs: [
      { file: `${B}/evidence-logs.test.ts`, title: 'carry no bearer token, cookie, or submitted build or result content' },
      { file: `${B}/domain.test.ts`, title: 'keeps secrets out of the logged summary' },
      { file: `${R}/lmstudio-adapter.test.ts`, title: 'never appears in errors, serialization, or inspection' },
      { file: `${R}/cli-units.test.ts`, title: 'uses secret-tool on Linux with the secret on stdin and never in argv' },
      { file: `${R}/cli-report.test.ts`, title: 'stores a token for a registry or an LM Studio endpoint without echoing it' },
    ],
  },
];

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('BACKEND_PRD section 17.1 threat map (P1)', () => {
  it('covers every row of the matrix once, in order', () => {
    const prd = read('docs/product/BACKEND_PRD.md');
    const matrix = prd.slice(prd.indexOf('### 17.1'), prd.indexOf('### 17.2'));
    const threats = [...matrix.matchAll(/^\| ([^|]+?) \| [^|]+ \|$/gm)].map((match) => match[1]!.trim()).filter((name) => name !== 'Threat' && !name.startsWith('---'));
    expect(ROWS.map((row) => row.threat)).toEqual(threats);
  });

  for (const row of ROWS) {
    it(`${row.threat}: every cited proof exists`, () => {
      expect(row.proofs.length).toBeGreaterThan(0);
      for (const proof of row.proofs) {
        expect(read(proof.file), `${proof.file} must contain "${proof.title}"`).toContain(proof.title);
      }
    });
  }

  it('records which rows carry a caveat, so the status document can state it', () => {
    expect(ROWS.filter((row) => row.caveat).map((row) => row.threat)).toEqual([
      'False local-execution consent',
      'Local/cloud inference confusion',
      'Source or client-metadata SSRF',
    ]);
  });
});
