# Localfirst.sh — backend

Implementation of [`BACKEND_PRD.md`](docs/product/BACKEND_PRD.md) **Phase 1 (P0): the
agent-native project registry**, **Phase 2 (P1): local testing**, and the
**Phase 3 (P2) community backend**. The
registry stores and serves portable project specifications over REST and a
hosted MCP adapter, with immutable versions, explicit human approval of the
exact published artifact, source provenance, and conservative compatibility
assessment. The `localfirstdotsh` runner (`packages/runner/`) runs bounded declarative
tests and fixed agent workflows against a local Ollama or LM Studio runtime and submits sanitized reports
for review.

## What is and is not implemented

| | Status |
| --- | --- |
| Publish/retrieve `localfirst/project/v0.2` and `/v0.3` specifications via REST and hosted MCP | Implemented |
| Direct text submission **and** bounded public GitHub import | Implemented |
| Immutable versions, content digests, author attribution, source provenance | Implemented |
| Task/model/runtime/hardware/OS/evidence search and reference catalogs | Implemented |
| Scoped OAuth for agents, GitHub human sign-in, exact-artifact approval | Implemented |
| Moderation, claims, audit, durable jobs, outbox, idempotency | Implemented |
| Five curated Jetson/edge entries plus a documentation-only hardware entry | Implemented (seed) |
| Local runner, Ollama/LM Studio adapters, local test execution | Implemented (`packages/runner/`, package `localfirstdotsh`, not yet published to npm) |
| Build/test-result submission, operator evidence review, compatibility reports | Implemented |
| Comparison groups, independent verification, derivatives, relationship views, collections, troubleshooting notes | Implemented (Phase 3) |
| Fixed multi-agent environments, workflow fixtures, private local inputs and sanitized workflow evidence | Implemented; environment handoff and workflow writes default off |
| LangGraph creator module with pinned dependencies and an isolated local Docker broker | Implemented for `langgraph-docker/v0.1`; separate setup approval and feature gate |
| Arbitrary tools, parallel/dynamic graphs, multiple models per workflow, richer modalities | Unsupported |

Consequences that the API states for itself rather than implying:

- **No hosted inference.** The backend never calls a local runtime, hosts no
  model weights, and has no execution scope, route, tool, or queue job. Tests
  run only on the user's machine, through the runner, after local approval.
- **Evidence levels above `documented` need an operator.** A submitted report
  is private and pending; `community_reported` and `reproducible_test` are
  reached only after operator acceptance, and `independently_verified` only
  through a separate operator-recorded claim under the published independence
  policy.
- **A declared harness is not always runnable.** `runner_available` is true
  only for test definitions the first-party runner can execute.
- **Publication needs a person.** An agent prepares, edits, validates, and
  publishes, but the approval of the exact payload digest happens in a browser
  session and is single use with a short expiry.

## Layout

```text
apps/web/               All public/private browser UI; Next.js routes and shared design system
packages/contracts/     Shared project, test and environment schemas, canonical digests, safety scanners
packages/runner/        The `localfirstdotsh` CLI: local runtimes, consent, tests and reports
docs/product/           Product specification: BACKEND_PRD.md, FRONTEND_PRD.md, RESEARCH.md
docs/operations/        Runbook and tested-client matrix
apps/api/src/
  app.ts, server.ts     Hono composition and the Node entry point
  auth/                 Better Auth composition, product scopes, actor resolution, guards
  api/v1/               REST adapters (+ phase.ts for documented-but-unimplemented routes)
  api/service.ts        Health, schemas, OpenAPI, metrics, resource metadata
  mcp/                  Hosted MCP tools, resources, and transport
  services/             Drafts, publication, search, moderation, jobs, outbox, idempotency
  domain/               Versioning, approval, compatibility, slug, policy versions
  sources/              Allowlisted fetch policy and the GitHub import adapter
  db/                   Drizzle schema (auth tables generated from Better Auth) and migrations
  jobs/                 Metadata-only worker and handlers
  api/browser/          Session-only JSON read models for browser pages
  seed/                 Curated catalog seed, published through the real approval path
```

Project v0.3 adds environment v0.1 and workflow test/build/result v0.2 contracts;
legacy project and component-test readers remain supported. See
[`BACKEND_PRD.md` §21.1](docs/product/BACKEND_PRD.md)
for the bounded execution profiles and feature gates.

The original sample set contains five fictional small-business projects:

| Sample key | Workflow |
| --- | --- |
| `bakery` | Extract an order, check production capacity and calculate a draft quote |
| `florist` | Prepare a pickup request with flower/options pricing and daily capacity |
| `print-shop` | Normalize a print job, check daily workload and calculate a draft quote |
| `bike-repair` | Prepare a service intake request with known-service pricing and daily capacity |
| `pet-grooming` | Prepare a grooming request with service pricing and daily request capacity |

Each example includes three agent roles, business data and eight fixtures.
Service examples do not reserve appointments or establish time-slot availability.
To try any example from this unpublished runner:

```bash
pnpm build
node packages/runner/dist/cli/bin.js environment samples
node packages/runner/dist/cli/bin.js environment prepare --sample bakery --out ./bakery
node packages/runner/dist/cli/bin.js environment plan ./bakery --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model>
node packages/runner/dist/cli/bin.js environment run <saved-plan-path> --offline
node packages/runner/dist/cli/bin.js report trace <saved-report-path> --workspace ./bakery --out ./bakery-trail.html
```

Each stage requests its own local approval. The sample uses three agent roles
sharing one installed model; trusted operations own capacity and pricing. Private
customer messages and dataset overrides stay in local plans/reports and cannot
be exported as public fixture evidence. Model accuracy is measured by fixtures;
an owner reviews every generated order draft. The SDK variant additionally needs
the declared creator module, the installed pinned Node base image, and a local
Linux Docker engine; dependency setup is a separate approved command.

### Try a workflow remix

`bakery-holiday` derives from the original bakery sample. It preserves the
three original roles and trusted operations, raises November 6 capacity from
80 to 100 cupcakes, changes chocolate/vanilla prices to USD 3.00/2.50 plus
USD 0.75 for blue icing, and appends a fourth `pickup-checklist` agent.
All four roles share one installed model. The new agent prepares advice for
the owner and cannot override the trusted decision status.

```bash
node packages/runner/dist/cli/bin.js environment prepare --sample bakery-holiday --out ./bakery-holiday
node packages/runner/dist/cli/bin.js environment plan ./bakery-holiday --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model>
node packages/runner/dist/cli/bin.js environment run <saved-remix-plan-path> --offline
node packages/runner/dist/cli/bin.js report trace <saved-remix-report-path> --workspace ./bakery-holiday --out ./bakery-holiday-trail.html
```

Try: “90 cupcakes: 45 chocolate and 45 vanilla, blue icing. Pickup
2026-11-06 at 10:00.” The original fixture reports insufficient capacity;
the remix should produce a USD 315.00 draft requiring owner review and a
pickup checklist. Its separate six-case fixture also covers a standard order,
over-capacity requests, a missing date, an unsupported decoration, and attempted
customer instruction injection. Inspect actual assertions and outputs: model
accuracy and checklist quality still require evaluation.

The bundle preserves original attribution/license and records declared parent
key/version plus the parent bundle digest. It has new environment/test identities
and no inherited test evidence or execution approval. This source-runner example
does not publish either project or create a registry lineage relationship.
First-class published lineage requires actual parent project/version IDs and
the enabled community derivative-draft/review flow.

### Ecommerce stock replenishment example

`stock-replenishment` uses fictional incoming-order history, inventory, open
purchase orders, pending proposals and dated supplier quotes to prepare an owner
proposal. Four local agent roles explain demand, vendor availability, purchasing
constraints and the proposal. The trusted `replenishment_v1` operation controls
net unit demand, stock coverage, pack-rounded quantities, supplier selection and
integer merchandise costs; agent outputs cannot override its status or quantity.

```bash
node packages/runner/dist/cli/bin.js environment prepare --sample stock-replenishment --out ./stock-replenishment
node packages/runner/dist/cli/bin.js environment plan ./stock-replenishment --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model>
node packages/runner/dist/cli/bin.js environment run <saved-stock-plan-path> --offline
node packages/runner/dist/cli/bin.js report trace <saved-stock-report-path> --workspace ./stock-replenishment --out ./stock-replenishment-trail.html
```

The baseline fixture has 112 net units sold over 14 completed days, 64 available
units, and a supplier with a five-day lead time. At a three-day safety buffer,
the reorder threshold is reached. The proposed 80 units cost **USD 480.00 before
shipping/tax**, bringing the inventory position to an 18-day demand target.
The 12 fixtures also cover healthy stock, duplicate events/cancellations/returns,
existing inbound orders, pending proposals, stale or unconfirmed quotes,
insufficient supplier stock, demand spikes, budget limits, delivery risk and
missing sales history. Stock history and quote timestamps are fictional.

This runs against complete snapshots, not live business systems. Inspect
`DATA/integration-requirements.json` for the required store/vendor connections,
trigger, persistent state and approval/notification work. These are requirements,
not registered MCP tools or permissions. Localfirst MCP retrieves the versioned
bundle; actual store and vendor connections are separate adapters requiring
development. Nothing monitors continuously, contacts a vendor, sends an owner
message, or places a purchase order. Private snapshots can replace declared data
through the existing local override mechanism; those runs cannot become public
fixture evidence. Use the updated source runner; older runners do not recognize
the added trusted operation. The five-example verification drivers below retain
their original scope and do not include this separate replenishment fixture.

To capture the complete five-example path through a disposable local registry
and an already installed Ollama model:

```bash
LOCALFIRST_LIVE=1 \
LOCALFIRST_OLLAMA_ENDPOINT=http://127.0.0.1:11434 \
LOCALFIRST_OLLAMA_MODEL=qwen2.5:1.5b \
LOCALFIRST_EXAMPLE_OUTPUT=/tmp/localfirst-example-trails \
pnpm verify:environments
```

The destination must be new. This requires a running local PostgreSQL instance
with permission to create disposable databases (`VERIFICATION_DATABASE_URL`
defaults to `postgres://localhost:5432/postgres`). It never uses `DATABASE_URL`.
Open the generated `index.html` for scores and links to every project's setup,
MCP requests/responses, CLI transcripts, system/test prompts, expected versus
actual assertions, and local report. The verifier labels its synthetic account
and automated confirmations explicitly; it does not claim human approval.
Model errors remain visible. The artifacts stay private and are separate from
sanitized evidence uploads; no model download or external business action occurs.

To test these same examples through an authenticated installed Claude Code CLI,
using exact model `claude-sonnet-5-5` at medium effort:

```bash
LOCALFIRST_LIVE_CLI=1 \
LOCALFIRST_CLI_OUTPUT=/tmp/localfirst-cli-example-trails \
pnpm verify:cli-examples
```

This separately tests native CLI MCP retrieval and then evaluates each role in
a fresh CLI session, with expected answers held outside the model. It uses
hosted inference through the CLI; it does not satisfy the environments'
`local_required` execution contract or create local runner evidence. The CLI
can enforce its model/effort selection, but the sample's declared temperature,
context size and output-token settings are not asserted as effective CLI
settings. Inspect exact invocations, observed model identity, outputs and
assertion mismatches in the separate local trail. Global CLI settings and MCP
connections are not changed. The [Claude Code model reference](https://code.claude.com/docs/en/model-config)
documents explicit model selection and effort controls.

## Quickstart

Requires Node.js ≥ 22 (developed on 26), pnpm, and PostgreSQL ≥ 14 (developed
on 18).

```bash
pnpm install
createdb localfirst_dev
cp apps/api/.env.example apps/api/.env     # then edit
pnpm --filter @localfirst/contracts build
pnpm db:migrate                          # one migration job; replicas never auto-migrate
pnpm db:seed                             # curated catalog, via draft → approval → publish
pnpm dev                                 # API on http://127.0.0.1:8787
pnpm worker                              # metadata worker, deployed separately
```

Then:

```bash
curl localhost:8787/api/v1/projects | jq '.data.items[].slug'
curl localhost:8787/api/v1/catalog/facets | jq '.data.phase_support'
curl localhost:8787/openapi.json | jq '.info.summary'
curl localhost:8787/schemas/project/v0.2.json | jq '.title'
```

GitHub sign-in needs a real OAuth app (`GITHUB_CLIENT_ID` / `_SECRET`) with
identity scopes only. For local work without one, set `DEV_AUTH_ENABLED=true`
and pass `X-Dev-User: <user id>` (plus optional `X-Dev-Scopes` and
`X-Dev-Actor: token`). Configuration validation **refuses** that flag in
production.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm worker` | API and metadata worker, separately deployable |
| `pnpm build` / `pnpm typecheck` | Compile and typecheck every package |
| `pnpm test` | Contracts unit tests plus backend integration tests against PostgreSQL |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:check` | Migration authoring, release migration job, drift check |
| `pnpm --filter @localfirst/api db:auth-schema` | Regenerate the Better Auth Drizzle schema after an auth upgrade |
| `pnpm db:seed` / `pnpm db:seed --reset` | Seed or reseed the curated catalog |

Tests need a database: `createdb localfirst_test` (override with
`TEST_DATABASE_URL`). They apply migrations to a fresh schema on every run.

## Documentation

- [`apps/web/README.md`](apps/web/README.md) — public frontend ownership, design tokens, components, gallery and checks.

- [`docs/product/IMPLEMENTATION_STATUS.md`](docs/product/IMPLEMENTATION_STATUS.md) — PRD section coverage, decisions taken, and open items.
- [`docs/operations/CLIENT_MATRIX.md`](docs/operations/CLIENT_MATRIX.md) — what was actually tested, including the MCP protocol version this release negotiates.
- [`docs/operations/RUNBOOK.md`](docs/operations/RUNBOOK.md) — deploy, migrate, restore, and incident handling.

## License

MIT. See [LICENSE](./LICENSE). To report a security problem, see [SECURITY.md](./SECURITY.md).
