# Implementation status against BACKEND_PRD v0.2

Scope delivered: **Phase 1 / P0** (the vertical registry slice of section 21,
extended to the full P0 route and tool inventory) and **Phase 2 / P1** (local
testing: the `localfirstdotsh` runner, the Ollama and LM Studio adapters, the
build/test-result contracts, and the backend evidence surface), and the
**Phase 3 / P2** community backend (comparison groups, independent
verification, derivative lineage, model/hardware relationship views,
collections, and troubleshooting notes, migration `0004`). Custom or workflow
harnesses, richer modalities, executable setup, and multi-agent execution stay
gated and disabled.

The Phase 2 exit criterion (section 21) is proven by the acceptance suite in
`apps/api/test/acceptance/` against the real backend, the real CLI, the real
adapters on fake runtimes, and the real contracts; `coverage.test.ts` maps every
section 20.2 bullet to its proof, and `coverage-p2.test.ts` does the same for
section 20.3; both fail if a cited test disappears. What
that suite cannot prove is listed under *Known gaps*.

## Functional requirements

| ID | Requirement | Status |
| --- | --- | --- |
| FR-01 | Create, validate, export, review, publish portable `PROJECT.md` via API/MCP | Done |
| FR-02 | Public repository references or direct specifications with documentation/hardware sources | Done |
| FR-03 | Immutable versions, attribution, explicit unknown fields, source provenance | Done |
| FR-04 | Task/model/runtime/hardware search and conservative compatibility assessment | Done |
| FR-05 | GitHub human sign-in; resource-scoped OAuth credentials for agents | Done; real GitHub sign-in verified on staging (2026-10-13) |
| FR-06 | Exact-artifact approval or per-connection publication delegation, ownership checks, moderation, idempotency, audit | Done in API/MCP; website delegation controls pending |
| FR-07 | Five attributed Jetson/edge entries with no execution or endorsement claim | Done (seed) |
| FR-08 | Public schema/spec retrieval and honest setup instructions | Done; the CLI package is declared unreleased |
| FR-09 | Open-source local runner with separate Ollama and LM Studio adapters | Done (`packages/runner/`, package `localfirstdotsh`, unpublished); verified on macOS arm64 only |
| FR-10 | Declarative text tests, execution preview, explicit consent, local result files | Done: exact-plan approval, no `--yes`, private 0600 reports |
| FR-11 | Select installed models, detect unsupported capabilities, record substitutions | Done: read-only preflight, fail-closed locality; a changed model is a new build |
| FR-12 | Private build + sanitized report; optional publication after review | Done: one reviewed upload digest, private and pending on arrival, exact-projection human approval to publish |
| FR-13 | Method-tagged metrics with unavailable reasons | Done for client latency, provider token rate, and streaming time-to-first-token (Ollama and LM Studio's OpenAI-compatible profile); peak memory and utilization are null with reasons |
| FR-14 | Report validation, reviewed evidence, failure history, withdrawal/reaggregation | Done; operator review is the only path to an evidence level |
| FR-15 … FR-17 | Independent verification, comparison groups, remixes, collections, custom harnesses | Done for the community backend (`FEATURE_COMMUNITY_NETWORK`, `FEATURE_INDEPENDENT_VERIFICATION`); custom harnesses are **not implemented** and stay gated |

## Section coverage

| PRD section | Status |
| --- | --- |
| 2 Architecture and execution boundary | Done. No execution path, route, scope, tool, or job exists |
| 3 Domain model and lifecycle | Done for P0 entities and states |
| 4 Portable project specification | Done: `localfirst/project/v0.2`, bundle limits, safe YAML, section and semantic rules |
| 5 Minimal test manifest | Done: immutable test definitions with independent manifest/fixture/evaluator digests; `runner_available` is true only for definitions the first-party runner can execute |
| 6 Build/configuration contract | Done: `localfirst/build/v0.1` and `build-report/v0.1`; server-derived reproducibility; hardware optional |
| 7 Local runner and adapters | Done in `packages/runner/` (separate package); see *Known gaps* for what was not exercised live |
| 8 Test results and measurements | Done: `localfirst/test-result/v0.1` allowlist, idempotent submission, comparison eligibility with reasons (no score) |
| 9 Evidence and compatibility policy | Done for P0 and P1: `claimed`/`documented`, plus `community_reported` and `reproducible_test` only after operator acceptance; `evidence_match` needs an exact accepted match at component scope (settings, engine, adapter profile, quantization, and disclosed platform included). P2: `independently_verified` only through a separate human-operator claim under policy `localfirst/independence/v0.1`, revoked on withdrawal or drift |
| 10 Authentication, scopes, consent | Done: audience-separated tokens, phase-gated scopes (`builds:*`, `tests:*` now advertised), exact-artifact approval, human-only boundary |
| 11 Shared API conventions | Done: envelope, cursors, idempotency, `If-Match`, 202 + operations, status mapping |
| 12 REST route inventory | All P0, P1, and P2 routes implemented, including `/comparisons`, `/verification-policy`, derivatives, model/hardware relationships, collections, troubleshooting notes, and operator verification/community review; nothing answers `PHASE_UNAVAILABLE` any more |
| 13 MCP tools and resources | Eight P0, seven P1, and seven P2 tools, evidence resources, stateless profile, POST-only; no hosted execution or runtime-discovery tool. All §13.4 resources are registered; `localfirst://models/{model_reference_id}` and `localfirst://hardware/{hardware_descriptor_id}` list only visible current projects that declare the reference and answer not-found when none does |
| 14 Publishing, versioning, remixes | Publication and versioning done for projects, builds, results, collections, and troubleshooting notes. Derivatives pin an immutable parent version, preserve its authors and source licenses, reject cycles, and inherit no evidence |
| 15 Ingestion, provenance, source tracking | Done: direct submission, bounded GitHub import, provenance records, SSRF controls, drift observations, curated seed |
| 16 Persistence, queues, consistency | Done: P0 tables plus migration `0002` (builds, test definitions, run reports, evidence reviews, compatibility summaries), migration `0004` (`derivative_relationships`, `community_records`, `independent_verifications`), composite ownership FKs, outbox, lease-based queue, idempotency records, projections |
| 17 Security, privacy, moderation | Done for P0 and P1 threats; only an allowlisted sanitized result and a bounded build are accepted, never prompts, outputs, paths, or inventory. Every §17.1 row names the P1 tests that prove it in `test/acceptance/threats.test.ts`, which fails if a cited test disappears or the matrix changes. Fixed by that audit (2026-10-12): undeclared request bodies were buffered past the 4 MiB limit, MCP `build_save` and `test_submit_result` skipped the submission quota, the quota was per OAuth client rather than per account, MCP drafts, publications, and imports skipped the draft, publication, and concurrent-import limits, and the runner buffered whole registry responses before checking their size. Staging preparation (2026-10-12) fixed spoofable client addresses: anonymous quotas believed the first `X-Forwarded-For` entry, so a caller could rotate it to escape any per-ingress limit. They now read the chain from the right behind configured `TRUSTED_PROXIES`, and Better Auth uses the same address |
| 18 Search and human discovery | Done: strict filters, full-text, facets, phase support; the command-first front door reports the CLI as unreleased |
| 19 Nonfunctional requirements | Limits, logging, metrics, readiness, graceful shutdown, feature flags done. P0 and P1 routes load-tested (2026-10-12, `verify:load`, 10,000 projects, 1,000 of them with 10 accepted reports each, 20 concurrent, 400 requests per route, 0 errors). p95: list 28 ms, search 210 ms, filtered search 27 ms, detail 29 ms; compatibility check with evidence matching 21 ms (target 1 s); compatibility reports 7 ms; accepted results 17 ms; test definition 8 ms; plan 8 ms; result submission 30 ms; idempotent replay 11 ms. All are under target on a local loopback machine. Aggregation at scale checked (2026-10-12, `verify:aggregation`): 2,000 reviews on one project with 2 workers rebuild 7 times instead of 2,000, the queue drains in 1.5 s, and a review on another project reaches the public summaries in 1.5 s (118 s before this fix, over the 60 s target). Summaries equal a from-scratch rebuild. Lazy test definitions held under 2,000 racing reads and 20 concurrent bulk calls (no missing or duplicate rows), and no product query repeatedly scans a large table |
| 19.3.1 Usage counters | Done: migration `0008` (`project_usage_daily`, `site_counters`, and an `AFTER INSERT` trigger on `oauth_consent` that counts `connections_authorized`, because Better Auth writes consents through its raw adapter and its `databaseHooks` never see them). `services/usage.ts` buffers export and MCP-retrieval counts in process and flushes batched additive upserts every 10 s and at shutdown; a failed flush is dropped. Project summaries and detail carry `usage`, the facet counts carry `connections_authorized`, and `GET /projects/:id/usage` gives the manager and operators the per-day series. MCP calls are charged against the caller's authenticated-read allowance (a batch pays per call) so a refused read is never counted, the public `/privacy` page explains the counters, and `test/usage-limits.test.ts` proves it. Counts are approximate request counts with no per-person dedupe; `connections_active` is the live `oauth_consent` row count. Not wired to any ranking |
| Owner usage screen | Done: `/account/projects` lists the caller's projects with lifetime request totals and `/account/projects/:project_id/usage` shows a manager their per-day requests (30 or 90 days) as two SVG charts and a table. SVG uses attributes and classes only because the page CSP blocks inline styles. A stranger gets the same not-found as a missing project. Server-rendered, no script. Covered by `test/owner-usage-page.test.ts` and checked by eye on a rendered page |
| 20 Acceptance criteria | §20.1 and §20.2 covered (see the map in `test/acceptance/coverage.test.ts` and the gaps below); §20.3 mapped bullet by bullet in `test/acceptance/coverage-p2.test.ts`, with caveats on reviewer independence and custom harnesses. Every §20.4 release gate names its proof in `test/acceptance/release-gates.test.ts` (in `pnpm check`, an opt-in `verify:*` script, the live runner suite, or `CLIENT_MATRIX.md`); six gates carry caveats, repeated below |
| 21 Delivery phases | Phases 1 and 2 delivered; the Phase 2 exit flow is the acceptance suite. Phase 3 community backend delivered; richer modalities, custom harness isolation, and multi-agent support are not started |
| 22 Configuration and organization | Layout follows §22.1, including `packages/runner/` with `adapters/`, `harnesses/`, `consent/`, `reports/`, `sensors/`; adapter fixtures are version-labelled captures under `packages/runner/test/fixtures/` |

## Decisions taken during implementation

1. **Better Auth composition.** `@better-auth/mcp` *is* the OAuth provider in
   1.7.x, so it is registered once alongside `jwt()`. The REST adapter is a
   second protected resource with its own audience, declared through the
   provider's `resources` option. Root discovery paths are mounted explicitly,
   since the `/api/auth/*` handler cannot serve them.
2. **Generated auth schema.** `src/db/schema/auth.ts` is generated from Better
   Auth's own `getSchema()` output and committed for review, with a test that
   fails when it drifts. Hand-writing those tables would have risked silent
   mismatches.
3. **MCP protocol version.** The pinned SDK supports up to `2025-11-25`, not the
   PRD's candidate `2026-07-28`. See `CLIENT_MATRIX.md`.
4. **Compatibility with no shared environment returns `unknown`.** Saying
   `candidate` about an unknown machine would be a guess; the response lists the
   declared requirements and says what was not assessed.
5. **Declared-but-empty `dependencies` is valid.** `{state: declared, items: []}`
   means "no dependencies", which is a real statement, unlike an empty
   `declared` model or runtime list. The PRD's own example relies on this.
6. **Export re-normalizes through the schema.** JSONB does not preserve key
   order, so exports are rebuilt in schema order. Content digests are computed
   over canonical (sorted) bytes, so they are unaffected either way.
7. **Search projection is written synchronously and reconciled by a job.** The
   projection is one row, so writing it in the publication transaction keeps
   search immediately useful, while `publication_index` remains the single
   idempotent path that moderation, visibility changes, and drift converge on.
8. **Development header identity.** `DEV_AUTH_ENABLED` plus `X-Dev-User`,
   `X-Dev-Scopes`, and `X-Dev-Actor` makes the session/token and human/agent
   boundaries testable locally. Configuration validation refuses the flag in
   production.

## Known gaps and untested areas

- **Phase 3 limits.** Independence between a verifier and a project's authors
  is checked by account only; author aliases and external affiliations depend
  on operator review, and reviewer staffing is an operational decision. No
  custom or workflow harness is enabled, and the isolation, device, network,
  and credential gates that §20.3 requires before one is are not designed.
  The P2 MCP tools are exercised through the SDK in tests, not yet in a real
  client application.

- **GitHub sign-in reached real GitHub on staging once** (2026-10-13). It
  exposed a launch-blocking bug: no profile was ever created for a person who
  signs in, so every real user was refused with "This identity has no
  Localfirst profile".
  - **The fix:** a profile is created at sign-in, with the GitHub login as the
    handle (a suffix is added on collision) and `github:<login>` as the
    external identity.
  - **The test:** `test/github-sign-in.test.ts` runs the full OAuth flow
    against simulated GitHub endpoints.
  - **Still unverified:** the live GitHub API for source imports.
- **Load numbers are local and synthetic** (see section 19 above). One accepted
  report goes through the real REST, validation, publication and review path;
  the other 10,000 are identity-remapped copies of it, aggregated by the real
  aggregator. The run uses 10,000 reports, not the 100,000 that §19.1 names
  (`LOAD_EVIDENCE_PROJECTS` and `LOAD_REPORTS_PER_PROJECT` scale it). The
  heavily-used-project and lazy-definition cases are in `verify:aggregation`,
  not in the latency run. Staging was measured over the network once
  (2026-10-13, `verify:remote-latency`, from one client in the US, 40 paced
  sequential requests per route, 0 failures). Network round trip p50: 92 ms.
  p95 minus that: list 31 ms, search 33 ms, detail 79 ms, by slug 19 ms,
  compatibility check 39 ms. Staging holds one project, so this measures the
  deployed path (edge, host, pooled database), not catalog scale or capacity.
  It was measured again after the Phase 3 deploy (2026-10-13, staging at
  `86dd575`, through the Render URL because the custom domain did not
  connect; same method, 0 failures). p95 minus network: list 27 ms, search
  141 ms, detail 108 ms, by slug 18 ms, compatibility check 38 ms, all within
  target. The `/health/live` median was not captured; the other routes put
  the round trip at about 86 ms. No production measurement exists.
- **Aggregation still rebuilds a project in full.** A rebuild of the
  2,010-report project takes about 110 ms and grows linearly with its
  accepted reports. Measured on `dev` (2026-10-14, `verify:aggregation`, 2,000
  reviews on one project, 2 workers): 7 rebuilds, 1,994 jobs standing down,
  queue drained 1.56 s after the reviews, a bystander project projected after
  1.56 s.
  - **Outbox dispatch is batched** (measured 2026-10-14, same drill and
    machine: 3 rebuilds, 1,998 jobs standing down, queue drained 1.38 s after
    the reviews against 1.56 s before). Before, the worker dispatched 10 events
    per cycle with about three statements each, and two workers read the same
    oldest events without locking, so they repeated each other's work. Now a
    cycle claims up to 100 events with `for update skip locked` and uses three
    statements for the batch (claim, one multi-row job insert, one update). If
    the batch fails as a whole, events are delivered one at a time so a bad event
    cannot block the rest. Still one job per event. The local gain is small
    because the database round trip here is far below a hosted one; the effect
    on Neon and Render has not been measured.
  - **Tried and not adopted** (same drill, same machine):
    - Claiming one reaggregation job per project per batch and completing the
      project's other queued jobs inside the rebuild transaction: 24 rebuilds,
      drained in 1.63 s, bystander 1.53 s. No gain.
    - Coalescing at dispatch (queue a job only if none is queued and due for
      the project): 199 rebuilds, drained in 15.4 s, bystander 15.3 s. Worse,
      because each dispatch cycle (10 events then) ran its own rebuild; the current one
      job per event with timestamp stand-down already throttles rebuilds.
  - **If it is revisited:** delay the job (a short debounce window) so a burst
    shares a rebuild; tests that drain the worker without waiting would need to
    allow for the delay. Not needed at the measured scale.
  - **The drill's sequential-scan audit was unstable, and is now size-aware.**
    It flagged `project_version_tests` (22 to 23 scans reading about 32,000
    rows) in two of three runs on 2026-10-14, including on unmodified `dev`.
    The table is 520 to 606 kB with an index on `project_version_id`: for one
    version the planner uses an index-only scan, for ten a bitmap scan, and for
    the drill's 100-version bulk lookup a single sequential pass (65 buffers
    against 50 for the forced index plan), which statistics timing can flip. The
    rule now also requires the table to be at least 2 MiB. After the change the
    drill passed (2026-10-14); that run did not reproduce the sequential plan,
    so the fix rests on the table size and the plans above.
- **Local restore drill passed, P1 data included** (2026-10-12,
  `verify:restore`): 10,000 projects, 43 tables, and all evidence tables
  non-empty (201 definitions, 2,041 builds, 2,021 reports, 2,001 reviews,
  201 summaries).
  - Row counts and content fingerprints are equal, and so are all 479
    constraint and 120 index definitions, migration 0003 included.
  - Seven forbidden evidence writes are each refused by the named constraint on
    the restored copy, including `reproducible_test` without acceptance, a
    manual report above `community_reported`, and a report on another user's
    build.
  - 80 P1 answers are identical before and after.
  - It took 7.8 s. It is a local logical backup; it says nothing about
    production PITR/RPO or deployed RTO.
- **Neon point-in-time restore passed on staging** (2026-10-13,
  `verify:pitr`):
  - The staging database restored to an exact moment, as a new branch, in
    2.3 s.
  - All 42 tables unchanged during the drill match the source at that moment;
    only `jobs` changed. All 479 constraints and 120 indexes match.
  - A restore one second before the newest publication does not contain it,
    and the restore at the snapshot does.
  - The API served the restored copy: readiness, the catalog, and every
    version digest.
  - **Repeated after the Phase 3 deploy** (restore point
    2026-10-14T06:25Z, staging at `86dd575`, migration `0004` included):
    ready in 2.5 s; all 46 tables compared, none changed, none differ; all
    524 constraints and 129 indexes match; the API served the restored copy.
    The one-second precision check was **skipped**: the newest publication
    was about 9.7 hours old, beyond the 6-hour history, so Neon refused that
    restore. All drill branches were deleted.
  - **Limit:** both Neon projects are on the free plan, with 6 hours of
    history. The 15-minute RPO holds, but anything noticed after 6 hours
    cannot be restored. Production needs a plan with a longer window before
    launch. Existing sessions and signing keys were not exercised on the
    restored copy.
- **Real MCP clients verified by hand** (reported 2026-10-13): Claude Code
  (browser OAuth and tool calls), Codex CLI, Claude Desktop, Cursor, and Zed,
  and the OAuth consent page with real third-party clients. Their versions and
  negotiated protocols are not yet recorded in `CLIENT_MATRIX.md`, which still
  shows the narrower 2026-10-12 results. The repeatable check remains
  `verify:mcp-client` (Claude Code CLI 2.1.296, protocol 2025-11-25,
  `initialize` and `tools/list`).
- **Browser consent flow passed in real Chrome** (2026-10-12,
  `verify:browser-consent`, Google Chrome 155, headless system install).
  - An agent drafts over MCP. The person approves on the backend's own review
    page, whose inline script runs under the nonce CSP with no console errors
    or violations.
  - An edit after approval stops publication. The re-approved revision
    publishes once.
  - A visitor without a session gets 401, a page on another site cannot
    approve with the person's cookie, and an access token gets 403.
  - The session cookie is minted with Better Auth's own store and signature.
  - Since 2026-10-13 it also connects an MCP application through OAuth, as
    Claude Code does: unauthenticated registration, **Allow** on the consent
    page, the code reaching the loopback callback, the PKCE token exchange,
    and an MCP tool call with the issued token.
  - That step found a consent-page bug: the page waited for `redirect_uri`,
    but Better Auth 1.7.7 answers `url`, so no MCP application could finish
    connecting. It also found that enabling dynamic registration still
    refused registration without a session. Both are fixed.
  - Passed again on staging's Phase 3 commit `86dd575` (2026-10-13). The
    drill always runs a local API on a throwaway loopback database, so it
    proves that code, not the deployed sign-in on staging.
- **Account deletion** records the request, revokes grants, withdraws managed
  projects, public evidence, and public collections and troubleshooting notes
  (a quarantined record stays quarantined), removes private records, and states
  those effects. Identity, immutable version history, and audit metadata await
  the final retention policy, which is still an open decision; anonymizing the
  attribution on already-published versions is an operator duty.
- **Claim review** transfers management only on an explicit operator flag; the
  future GitHub App control proof is not implemented.
- **Linux is not verified.** Runtime versions and behaviour were captured on
  macOS arm64 only (Ollama 0.35.1; LM Studio app 0.4.20+1, CLI `71bd99c`). The
  supported-version table in `CLIENT_MATRIX.md` states this.
- **Ollama was exercised live with two models** (2026-10-12, Ollama 0.35.1,
  macOS arm64): `qwen2.5:1.5b` and `LiquidAI/lfm2.5-1.2b-instruct:q4_k_m` each
  passed the section 5.2 smoke test (`{"label":"billing"}`), and each refused a
  required `audio_output` before inference.
- **LM Studio was exercised live once** (2026-10-12, macOS arm64): app
  `0.4.20+1`, CLI `71bd99c`, engine `mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0`,
  model `google/gemma-3-1b`, server bound to loopback and started by the user.
  The section 5.2 smoke test passed (`{"label": "billing"}`) and a required
  `audio_output` was refused before inference. This is one run on one machine;
  llama.cpp, other models, and Linux remain unexercised.
- **Cloud, remote-linked, and unknown-origin models are synthetic fixtures**
  (none was installed to capture). LM Studio's real marker for a remote-linked
  model was never observed, so its detection is a conservative name/shape
  heuristic that fails closed.
- **The real macOS keychain was exercised once** (2026-10-12): missing item, round
  trip, in-place update, and special characters through the real `security` tool.
  It showed that `-w` reads non-ASCII values back as hex, so the runner now refuses
  to store non-ASCII tokens on macOS. The Linux `secret-tool` path is tested only
  through an injected command runner.
- **No verified offline claim exists.** The runner samples the machine's
  interface table (every 200 ms, plus at start and end of the run) and records
  `checks.offline: no_route_observed` only if no sample showed an address other
  than loopback or link-local; otherwise `not_run`. This covers the runtime and
  every other process because it asks whether the machine had any path off the
  local link, and it changes no network setting. It is self-reported and
  spoofable, so the backend stores it and issues no offline badge from it.
  Known limits: a path that appears and vanishes between samples is missed;
  link-local neighbours are not covered; the user must turn the network off
  themselves; the interface table is the only evidence (no per-process traffic).
  Per-process observation was tried and rejected: macOS `nettop` shows only live
  sockets, so a process that connected and closed leaves no trace. Exercised
  only on an online machine (reports `not_run`); a run with the network
  actually off has not been done.
- **Streaming time-to-first-token** is client-side: monotonic time from request
  start to the first non-empty content fragment, median over evaluated
  executions, method `client_monotonic_first_content_chunk_v1`. It is
  unavailable (null, with a reason) for a non-streaming run, a stream with no
  content, or an execution that lacks the event.
  - **Ollama:** exercised live (2026-10-14, Ollama 0.35.1, macOS arm64,
    `qwen2.5:1.5b`): first content at 27 ms, stream end at 34 ms, and the
    streamed text equalled the non-streamed text.
  - **LM Studio:** supported on the OpenAI-compatible profile only, and
    exercised live (2026-10-14, app `0.4.20+1`, engine
    `mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0`, macOS arm64,
    `google/gemma-3-1b`): the streamed text equalled the non-streamed text,
    first content arrived before the stream ended, and LM Studio honoured
    `stream_options.include_usage` (prompt 17, completion 3, total 20 tokens).
    The reply was three tokens, so first content (140 ms) and stream end were
    under a millisecond apart; a longer reply has not been timed. The native
    profile has no tested streaming mapping and blocks `stream: true`.
  - Peak memory and utilization have no sensor and are null.
- **Hardware is opt-in and coarse** (OS release, architecture, memory rounded to
  whole GiB). A build without it is only partially reproducible and its accepted
  evidence can never be an exact platform match.
- **A local model has no upstream identity.** A build whose model has neither a
  model version nor a declared source URL is `incomplete`, and its accepted
  report stays `community_reported`. `report export --model-source-url` lets a
  contributor who knows the model's origin share it, which is a claim the
  operator reviews, not a verified fact.
- **Operators review only reports their owner has published.** A private upload
  is never visible to the review queue.
- **Publication delegation has no website controls yet.** The API, MCP tools,
  migration `0009` and public version label are in place (BACKEND_PRD §10.4);
  the Connections toggle, the review page's "Approve and let <client> publish
  without asking" action, and the label on project pages are not built, so
  today delegation can only be turned on through the session-only REST route.
- **Local approval exists, with a weaker trust boundary than the browser.**
  `auth approver-login` links a terminal through a code approved in a signed-in
  browser; `contribution approve` then records the decision from that terminal
  (BACKEND_PRD §10.4). Verified end to end on 2026-10-14 (`verify:local-approval`:
  real runner CLI on a pseudo-terminal, real HTTP server, code approved in real
  Chrome, 14 steps passed, including refusal on every other route, one-time
  publication, and refusal after revocation). Limits:
  - An agent with shell access on the linked machine can drive a pseudo-terminal
    and answer the prompts, so the browser path stays the default.
  - The OS keychain was stubbed in the drill; the real macOS keychain path was
    exercised earlier, the Linux `secret-tool` path was not.
  - The credential can read the exact content of its owner's drafts (needed to
    show them); nothing else.
  - `verify:local-approval` needs `python3` for the terminal and macOS-style
    PATH stubs; it has not been run on Linux.
