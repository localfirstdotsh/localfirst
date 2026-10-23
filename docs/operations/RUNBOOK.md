# Operations runbook

Covers the deliverables in BACKEND_PRD sections 16.4, 19.4, and 22.2.

## Deployment shape

Three units from one codebase:

| Unit | Entry point | Notes |
| --- | --- | --- |
| API | `node dist/server.js` | Horizontally scalable; never migrates |
| Metadata worker | `node dist/jobs/worker.js` | Metadata only. No inference or test job exists in this queue |
| Migration job | `node dist/db/migrate.js` | Exactly one per release, with the isolated migration credential |

All three run from one image, built from the repository root with
`docker build -f apps/api/Dockerfile .`. It runs as the non-root `node` user,
listens on `0.0.0.0` (`HOST`), and starts the API by default. The worker and
the migration job override the command: `node dist/jobs/worker.js` and
`node dist/db/migrate.js`. The base image is pinned by digest. `.dockerignore`
keeps every `.env` file out of the build context.

### Client addresses behind proxies

Per-ingress quotas key on the client address, which the app resolves itself.
- **No `TRUSTED_PROXIES`:** the socket peer is the client, and
  `X-Forwarded-For` is ignored entirely.
- **With trusted proxies:** the chain (`X-Forwarded-For`, then the peer) is
  read from the right. Trusted proxies are skipped, and the first other address
  is the client. Entries a caller adds to the left of the last trusted hop are
  never believed.
- **On Render:** `TRUSTED_PROXIES=cloudflare,private`. Render's own edge runs
  on Cloudflare and reaches services through a private load balancer; there is
  no Cloudflare proxy of ours in front (DNS is in Vercel). A request that
  arrives another way is counted by its own address. Confirm the chain on the
  first deploy ("Staging on Render", step 5).
- **Better Auth:** it receives the resolved address in an internal header that
  the app overwrites on every auth request, so its own rate limits use the
  same rule.
- **Cloudflare's ranges** are built in (`src/http/client-ip.ts`). Refresh them
  when Cloudflare announces a change.

Separate issuers, OAuth apps, signing keys, databases, and callbacks per
environment. `AUTH_SECRET` must survive restarts: rotating it invalidates
sessions, and the JWKS rows are encrypted with it.

## Release

1. Build and typecheck: `pnpm build`.
2. Run `pnpm db:check` to confirm no undeclared schema drift.
3. Run the migration job with `MIGRATION_DATABASE_URL`. Additive changes and
   backfills ship before destructive ones. Phase 2 ships exactly one migration,
   `0002_p1_evidence_tables`, which only adds tables (builds, test definitions,
   run reports, evidence reviews, compatibility summaries) and touches nothing in
   `0000` or `0001`. It does not parse YAML: test definitions for versions that
   predate it are created lazily and idempotently on first read.
4. Roll the API and the worker, in either order.
   - **Schema wait:** the worker processes nothing until every migration
     bundled with its build is applied. It logs `waiting for migrations before
     processing jobs` while it waits, and `schema current; starting` when it
     begins. Hosts such as Render deploy the two services independently, and
     only the API runs the pre-deploy migration step.
   - **Shutdown:** both shut down gracefully on SIGTERM: in-flight requests
     finish and the pool closes. A job whose lease expires returns to the
     queue automatically.
5. Verify `GET /health/ready` reports `ready` with the expected table count and
   a low `outbox_oldest_pending_seconds`.

Rollback: redeploy the previous image. Migrations are forward-only; a release
that needs a destructive change ships the additive half first so the previous
version still runs against the new schema.

Exception: `0010_retire_approval_device` drops the approval-device tables and
`publication_approvals.approver_credential_id` in the same release that stopped
using them. An image older than that release fails on draft approval and
publication against the new schema, so roll forward instead of back past it.
Staging applied it on 2026-10-23; production starts from an empty database.

## npm package release (`localfirstdotsh`)

The runner in `packages/runner/` is published to npm as the unscoped package
`localfirstdotsh` (executable `localfirstdotsh`), owned by the `localfirstdotsh` npm
organization. `.github/workflows/release.yml` publishes it, and only when a
`localfirstdotsh-v<version>` tag is pushed:

| Tag | npm dist-tag | Tagged commit must be on |
| --- | --- | --- |
| `localfirstdotsh-vX.Y.Z-beta.N` | `beta` | `staging` |
| `localfirstdotsh-vX.Y.Z` | `latest` | `main` |

The `plan` job refuses a tag that differs from `packages/runner/package.json`, any
other prerelease form, a commit outside the required branch, and a version already on
npm. `check` reruns `ci.yml` on the tagged commit. `publish` waits for the `npm`
environment's approval, packs once, runs `test-package.mjs` against that exact tarball,
publishes it with provenance through npm Trusted Publishing (GitHub OIDC; no npm token
exists), and confirms the dist-tag on the registry. Releases run one at a time and are
never cancelled midway.

**Accounts.** npm: a member of the `localfirstdotsh` org with two-factor
authentication (required by `npm trust` and by manual publishing) and npm ≥ 11.15.
GitHub: admin on `localfirstdotsh/localfirst` for the one-time settings, write access
to push tags.

### One-time setup

1. **GitHub environment.** Settings → Environments → New environment `npm`. Add
   required reviewers (`RidwanG206`), and under deployment branches and tags choose
   "Selected" with the tag pattern `localfirstdotsh-v*`.
2. **Tag protection (recommended).** Settings → Rules → New tag ruleset targeting
   `localfirstdotsh-v*`: restrict deletions and updates (and creation to admins if
   others get write access), so a published version's tag cannot be moved.
3. **First publish (bootstrap).** npm only accepts a trusted publisher for a package
   that already exists, so `0.1.0-beta.0` is published once by hand, from the staging
   commit that carries that version, after the release PR reaches `staging`:

   ```sh
   git fetch origin
   git worktree add --detach ../localfirst-release origin/staging
   cd ../localfirst-release && pnpm install --frozen-lockfile
   out="$(mktemp -d)"
   (cd packages/runner && pnpm pack --pack-destination "$out")
   node packages/runner/scripts/test-package.mjs "$out/localfirstdotsh-0.1.0-beta.0.tgz"
   npm publish "$out/localfirstdotsh-0.1.0-beta.0.tgz" --tag beta --access public
   ```

   This one version has no provenance statement (that needs CI); every later
   version does. Because the package has no `latest` yet, npm also points
   `latest` at this first version; check with `npm view localfirstdotsh dist-tags`.
   Later betas never move `latest`, and the first stable release takes it over.
4. **Org access, trusted publisher, token lockdown.**

   ```sh
   npm access grant read-write localfirstdotsh:developers localfirstdotsh
   npm trust github localfirstdotsh --file release.yml \
     --repository localfirstdotsh/localfirst --environment npm --allow-publish
   npm trust list localfirstdotsh
   ```

   The web equivalent is npmjs.com → `localfirstdotsh` → Settings → Trusted
   Publisher: GitHub Actions, organization `localfirstdotsh`, repository
   `localfirst`, workflow `release.yml`, environment `npm`. Then, on the same page,
   set Publishing access to "Require two-factor authentication and disallow tokens";
   trusted publishing keeps working.
5. Optionally record the bootstrap version with a tag
   (`git tag -a localfirstdotsh-v0.1.0-beta.0 origin/staging -m "localfirstdotsh 0.1.0-beta.0"`
   and push it). The Release run it starts stops at the already-published check, by design.

### Publish another beta

1. On a task branch from `dev`, bump the version and open a PR into `dev`:
   `cd packages/runner && npm version prerelease --preid beta --no-git-tag-version`
   (`0.1.0-beta.0` → `0.1.0-beta.1`). Promote `dev` → `staging` as usual (authorized).
2. Tag the staging commit and push the tag:

   ```sh
   git fetch origin
   git tag -a localfirstdotsh-v0.1.0-beta.1 origin/staging -m "localfirstdotsh 0.1.0-beta.1"
   git push origin localfirstdotsh-v0.1.0-beta.1
   ```

3. Approve the `npm` deployment in the Actions run.

### Stable release

Set the version to the plain `X.Y.Z` the betas led up to
(`npm version 0.1.0 --no-git-tag-version`), PR it into `dev`, promote through
`staging` to `main` with the usual authorization, then tag the `main` commit
(`localfirstdotsh-v0.1.0`) and approve the run. A stable version is always its own
publish from `main`; `latest` is not moved onto a beta.

### Verify a published version

```sh
npm view localfirstdotsh dist-tags
npm view localfirstdotsh@0.1.0-beta.1 version dist.integrity
npx -y localfirstdotsh@beta --version
```

The npm package page shows the provenance link to the workflow run. In a project
that installs it, `npm audit signatures` checks the signature and provenance.

### Recover from a failed publish

npm never accepts a version twice, even after unpublishing, so recovery moves forward.

- **Failed before the Publish step** (`plan`, `check`, pack or package test): nothing
  reached npm. Fix on a task branch. If `npm view localfirstdotsh@<version>` still
  404s, delete the tag (`git push origin :refs/tags/<tag>`) and tag the fixed commit;
  otherwise bump.
- **Publish succeeded, verification failed**: usually registry lag. Check
  `npm view`; do not publish again by hand.
- **A broken version was published**: bump to the next version and release it, then
  `npm deprecate localfirstdotsh@<bad> "Broken; use <good>"`. If `latest` is wrong:
  `npm dist-tag add localfirstdotsh@<good> latest`.
- Re-running a failed run is safe: `plan` refuses a version that is already published.

## Auth dependency upgrades

Better Auth owns its own tables. After changing its version or plugins:

```bash
pnpm --filter @localfirst/api db:auth-schema   # regenerate src/db/schema/auth.ts
pnpm db:generate                                   # review the emitted SQL
pnpm test                                          # test/schema.test.ts fails on drift
```

Never hand-edit `src/db/schema/auth.ts`.

## Staging on Render

`render.yaml` at the repository root defines one Render project, `localfirst`,
with two environments. Network isolation is on in both, so their private
networks cannot reach each other.

- **`staging`:** the API web service (migrations as its pre-deploy command),
  the metadata worker, the public website, and the `localfirst-staging`
  environment group. The API and worker build `apps/api/Dockerfile` and the
  website builds `apps/web/Dockerfile`, all from the `staging` branch in Render's
  Ohio region, next to Neon's AWS us-east-2. The website is not in the
  environment group: it holds no secrets.
- **`production`:** created empty, with protection enabled. Its services,
  environment group, database (a separate Neon project), GitHub OAuth app,
  and domain arrive in their own reviewed change once they exist, deploying
  from `main`. Nothing in staging is reused there.

To create it (once, after `render.yaml` is on `staging`):

1. **Create:** in Render, choose New → Blueprint, then this repository and
   the `staging` branch.
2. **Enter the values.** `apps/api/.env.staging.example` lists every value
   and where it is set.
   - **At creation:** Render prompts for `MIGRATION_DATABASE_URL` (Neon's
     **direct** string, on the API service) and for the website's three
     addresses: `LOCALFIRST_API_URL` (the API's **private** address,
     `http://localfirst-staging-api:<port>`, from the API's Connect menu),
     `LOCALFIRST_PUBLIC_API_URL` (the same value as `API_BASE_URL`), and
     `LOCALFIRST_SITE_URL` (the same value as `WEBSITE_URL`). It does **not** prompt for
     `sync: false` values inside the environment group, so the first deploy
     fails at the pre-deploy step with a `ConfigError` naming the missing
     variables. That failure is expected and harmless.
   - **After creation:** open the `localfirst-staging` environment group and
     enter `API_BASE_URL` and `WEBSITE_URL` (both the public website origin),
     `DATABASE_URL` (Neon's **pooled** string), and the staging GitHub OAuth
     app's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Then use Manual
     Deploy on both services.
   - **Connection strings:** use `sslmode=verify-full`.
   - **Generated secrets:** Render generates `AUTH_SECRET` and
     `METRICS_TOKEN` itself. Never regenerate `AUTH_SECRET` casually: it signs
     sessions and encrypts the stored signing keys.
3. **Custom domain:** DNS for `localfirst.sh` is managed in Vercel
   (nameservers `ns1.vercel-dns.com` and `ns2.vercel-dns.com`); only DNS is
   there, the staging website runs on Render.
   - Add `staging.localfirst.sh` to the **website** service only. The API gets
     no public domain: the website proxies API, auth and MCP requests to it over
     the private network.
   - In Vercel (Domains → `localfirst.sh` → DNS Records, or the CLI), create
     the CNAME `staging` → the website's `.onrender.com` hostname:
     `vercel dns add localfirst.sh staging CNAME localfirst-staging-web.onrender.com`.
     An explicit record overrides Vercel's default `*` record.
   - Render verifies the domain and issues the certificate itself; there is no
     proxy or TLS mode to set in Vercel.
   - Set `API_BASE_URL` and `WEBSITE_URL` (environment group) and
     `LOCALFIRST_PUBLIC_API_URL` and `LOCALFIRST_SITE_URL` (website) to
     `https://staging.localfirst.sh`, point the staging GitHub OAuth app's
     callback at `https://staging.localfirst.sh/api/auth/callback/github`, and
     redeploy the API, worker and website.
4. **Check the first deploy:**
   - **API:** the pre-deploy step logs `migrations applied`, `/health/ready`
     reports `ready`, and the startup log shows `env: production` and the
     expected `api_base_url`.
   - **Worker:** read its log, because Render marks a worker "live" as soon as
     the process starts, even if it then crash-loops on a configuration
     error. Expect `worker started`, then `schema current; starting` (or
     `waiting for migrations` until the API's migration finishes), then
     completed `operation_reconcile` jobs about once a minute.
   - **Website:** `/health` reports `ok`, and `/projects` lists projects, which
     proves it reached the API over the private network. Its sign-in, privacy,
     and export links must point at the **public website** origin (the configured API/auth/MCP origin).
5. **Confirm the proxies, and that rate limits are per visitor.** Confirm the
   client addresses Render presents, and narrow `TRUSTED_PROXIES` if Render's
   load balancer does not connect from a private range. Then confirm each
   website visitor gets their own allowance. Without it every visitor shares one
   (120 catalog reads and 30 compatibility checks a minute for the whole site),
   and nothing looks wrong until traffic arrives. From two different networks,
   load several distinct pages of the website in quick succession: neither
   should see "registry unavailable" caused by the other. If they do, the API is
   treating the website as one client: check that `LOCALFIRST_API_URL` is the
   private address (a public proxied address makes the proxy append the
   website's own address), that the header named by
   `LOCALFIRST_CLIENT_IP_HEADER` carries the visitor's address, and that the
   website's private address is covered by `TRUSTED_PROXIES`.
   - **Current state: forwarding is off.** A header is only safe if the edge
     overwrites a value the visitor sends. Render's does not for
     `cf-connecting-ip`: on 2026-10-18, 140 staging searches from one address
     were cut off after 120 with no header, and none of 141 were cut off when
     each carried a different made-up `cf-connecting-ip`. So
     `LOCALFIRST_CLIENT_IP_HEADER` is unset and visitors share the website's
     allowance. Before naming any other header, repeat that test with it: the
     spoofed run must be cut off just like the plain one.

Deploys then follow pushes to `staging` (`autoDeployTrigger: commit`), so merging
a promotion pull request into `staging` deploys it. Each
service rebuilds only when its own sources, contracts, workspace, or Blueprint
files change; test and documentation edits are ignored. The setup command on the
website stays hidden until the CLI is released and tested (see
`apps/web/.env.example`); do not set the `LOCALFIRST_CLI_*` variables before then.

## Backups and restore drill

Demonstrate a restore **before** any public launch (proposed RPO ≤ 15 minutes,
RTO ≤ 4 hours).

The repeatable local drill works as follows:

1. It creates two randomly named databases. It never uses the application's
   `DATABASE_URL`.
2. It seeds 10,000 synthetic projects. 200 of them get P1 evidence: accepted
   reports with reviews and summaries, private builds, and pending public
   reports.
3. It dumps and restores with PostgreSQL's native tools.
4. It compares every table's row count and content fingerprint, and every
   constraint and index definition.
5. On the restored copy, it tries writes the evidence policy forbids. Each must
   be refused by its named constraint, for example an evidence level without
   acceptance or a manual report above `community_reported`.
6. It checks readiness, project slugs and version digests through HTTP. It also
   checks that the P1 answers (compatibility reports, accepted results,
   definitions and compatibility checks) equal the answers before the backup.

It removes its databases and dump afterward.

```bash
# Requires loopback PostgreSQL with CREATE DATABASE permission and matching
# pg_dump/pg_restore clients. The optional URL is an administration connection.
VERIFICATION_DATABASE_URL=postgres://localhost:5432/postgres \
  pnpm --filter @localfirst/api verify:restore
```

This logical-backup drill does not prove the provider's point-in-time
recovery. `verify:pitr` does, against a Neon project:

1. In one read-only snapshot of the source branch, it records the moment and
   fingerprints every table, constraint and index.
2. Neon restores the branch to that moment as a new branch. The drill times
   how long it takes to answer queries.
3. Every table that did not change during the drill must match the snapshot
   exactly. Tables that did change, such as `jobs`, are listed and not compared.
4. A second restore, to one second before the newest publication, must not
   contain it.
5. A local API process serves the restored copy: readiness, the catalog, every
   published project by slug, and each version's content digest.

It deletes every branch it creates and only reads the source. The Neon CLI must
be signed in; connection strings are never printed.

```bash
NEON_PROJECT_ID=<project id> pnpm --filter @localfirst/api verify:pitr
```

Neon's free plan keeps 6 hours of history, so a restore can only reach that
far back. Production needs a plan with a longer window before launch.
Before launch, also repeat the drill against production. Keep the stable
`AUTH_SECRET` and signing keys, so that existing sessions on the restored copy
are exercised too.

## Load verification

```bash
pnpm --filter @localfirst/api verify:load
pnpm --filter @localfirst/api verify:aggregation
```

`verify:load` uses a disposable loopback database. It works as follows:

1. **Projects:** it seeds 10,000 copies of the seven validated seed shapes,
   with immutable versions and their relations.
2. **Evidence:** 1,000 of those projects get 10 accepted reports each. One
   report goes through the real REST, validation, publication and review path;
   the rest are copies, aggregated by the real aggregator.
   `LOAD_EVIDENCE_PROJECTS` and `LOAD_REPORTS_PER_PROJECT` scale this.
3. **Measurement:** after a warm-up, it sends 400 requests at concurrency 20
   through a real HTTP listener and PostgreSQL pool to each of these routes:
   - list, search, filtered search and detail;
   - compatibility check with evidence matching;
   - compatibility reports;
   - accepted results;
   - test definition and plan;
   - result submission and its idempotent replay.
4. **Pass criteria:** HTTP or response-shape errors fail the command, and so
   does a p95 over the route's §19.1 target (1 s for the compatibility check,
   500 ms otherwise).

`verify:aggregation` checks three things:

- **Lazy definitions:** lazy test-definition creation under racing first reads
  and concurrent bulk calls.
- **Review burst:** a 2,000-review burst on one project, drained by independent
  workers. It measures how long another project's evidence takes to reach the
  public summaries (60 s target) and compares the summaries with a full rebuild.
- **Scan audit:** the product's own queries must not repeatedly scan a large
  table.

Rate-limit accounting stays enabled, with quotas raised for both scripts. These
are synthetic local benchmarks.

`verify:remote-latency` measures a deployment over the network:

```bash
API_URL=https://<deployment origin> pnpm --filter @localfirst/api verify:remote-latency
```

It sends sequential, anonymous reads and compatibility checks, paced under the
public rate limits. `/health/live` does no work, so its median is the network
round trip. Each route passes when its p95 minus that round trip is within its
§19.1 target. It measures per-request latency, not capacity. Availability,
import latency and deployed capacity need separate measurements.

## External client and source checks

```bash
pnpm --filter @localfirst/api verify:mcp-client       # requires Claude Code
pnpm --filter @localfirst/api verify:browser-consent  # requires Google Chrome
pnpm --filter @localfirst/api verify:github          # makes bounded public GitHub GETs
```

**`verify:mcp-client`** uses an isolated Claude configuration and a short-lived
signed test token. It asserts initialization and records the actual protocol
calls.

**`verify:browser-consent`** requires a current web build (`pnpm --filter @localfirst/web build`). It starts the real Next.js website against its disposable backend, then drives the locally installed Google Chrome
(`playwright-core`, no browser download) through the human approval between an
agent's draft and its publication:

- The person approves on the review page, under its real CSP, with a session
  cookie minted by Better Auth.
- An edit after approval blocks publication.
- A visitor without a session, a page on another site, and an access token are
  each refused.

Neither check exercises GitHub browser sign-in.

**`verify:github`** covers non-manifest text, missing files and directories.
To exercise a public contract fixture as well, supply
`VERIFY_GITHUB_REPOSITORY_URL`, and optionally `VERIFY_GITHUB_REF` (default
`main`) and `VERIFY_GITHUB_MANIFEST_PATH` (default `PROJECT.md`).
`GITHUB_INGESTION_TOKEN` is optional and is never printed. These checks do not
deliberately exhaust GitHub quotas.

## Incident classes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `/health/ready` returns 503 with `database_unreachable` | Pool or database outage | Check PostgreSQL; the API keeps serving nothing rather than lying about readiness |
| `/health/ready` ready but `durable_work` missing | Worker cannot reach the queue | Restart the worker; durable work stays queued and is not lost |
| `outbox_oldest_pending_seconds` climbing | Worker stopped or wedged | Restart; `reclaimExpiredLeases` returns leased jobs on the next cycle |
| Many `jobs.state = failed` with `SOURCE_*` codes | Upstream provider outage or rate limit | Transient codes retry with capped backoff; terminal codes need a new user request |
| Imports stuck in `ingesting` | Worker crash mid-attempt | `operation_reconcile` fails them after ~10 minutes with `DEPENDENCY_UNAVAILABLE`; the user requests the import again |
| Publication conflicts (`APPROVAL_*`) spiking | Clients publishing stale artifacts | Expected behaviour, not an incident: the artifact changed after approval |
| Search results stale | Projection lag | Detail reads stay authoritative; re-enqueue `publication_index` for the affected project |

## Feature flags

Disabling a flag removes the capability from discovery *and* rejects direct
calls. Flags do not half-enable anything.

| Flag | Default | Effect |
| --- | --- | --- |
| `FEATURE_GITHUB_IMPORT` | on | Source import routes and the MCP import path |
| `FEATURE_TEST_DEFINITIONS` | on | Test definitions, builds, and the `builds:*` scopes (Phase 2) |
| `FEATURE_RESULT_SUBMISSION` | on | Result submission and the `tests:*` scopes (Phase 2); requires test definitions |
| `FEATURE_EVIDENCE_CLASSIFICATION` | on | Operator review and accepted-evidence matching (Phase 2); requires result submission |
| `FEATURE_EXECUTABLE_PLANS` | off | Executable setup plans (Phase 3) |
| `FEATURE_LEGACY_MCP_SESSIONS` | off | Session-oriented MCP adapter, only with a tested profile |
| `FEATURE_DYNAMIC_CLIENT_REGISTRATION` | off | OAuth dynamic registration, without a session, for MCP applications. They register as public PKCE clients, and a loopback-only CLI registers as native. On for staging |
| `DEV_AUTH_ENABLED` | off | Header identity for local tests; **refused in production** |

A deployment that wants the Phase 2 surface off sets the three Phase 2 flags to
`false`: the scopes disappear from OAuth metadata, the routes and MCP tools are
removed, and `runner_available` stays `false`.

## Evidence operations (Phase 2)

- **Submissions are private and `pending`.** `POST /test-results` stores a
  sanitized report, answers 202 with an operation, and queues a
  `report_validation` job. Nothing executes a test. Retries replay; a reused
  run ID with different content is a 409 `IDEMPOTENCY_CONFLICT`.
- **Review queue.** Operators see only reports whose owner has published them
  (`GET /api/v1/admin/reviews?kind=evidence`). Accept or reject with a reason
  code at `POST /api/v1/admin/test-results/:id/review`, or a manual build
  report at `POST /api/v1/admin/builds/:id/report-review`. A report whose server
  validation has not passed cannot be accepted. Accepting is the only way an
  evidence level is assigned: `reproducible_test` when every server check holds,
  otherwise `community_reported`. `independently_verified` cannot be assigned
  here; database constraints make it unrepresentable.
- **Aggregation.** Each review decision or withdrawal enqueues an
  `evidence_reaggregate` job for its project.
  - **What it computes:** it recomputes `compatibility_summaries` from
    accepted, public, non-withdrawn reports. It counts distinct submitters
    (a creator's reruns are one contributor), includes accepted failures, and
    flags conflicts.
  - **Bursts:** a job stands down when a rebuild that started after it was
    queued already covers it, so a burst of reviews on one project costs a few
    rebuilds, not one each. The `evidence.reaggregated` and
    `evidence.reaggregate_skipped` counters on `/metrics` show the split.
  - **Recovery:** it is idempotent and fully recomputable. If the worker is
    down, evidence is stale but never wrong in the unsafe direction, because
    detail reads exclude withdrawn and hidden records at read time.
- **Withdrawal.** An owner withdraws a report or a build (which withdraws its
  reports). Observed facts stay for the owner; the evidence leaves active
  matching and the project is reaggregated. Withdrawn content cannot be
  re-saved identically.
- **Hidden projects.** Evidence of an unpublished or quarantined project is
  excluded from every public read and from compatibility answers.

## Runner local state

The runner keeps its state under `$LOCALFIRST_HOME` (tests) or the XDG
locations `${XDG_CONFIG_HOME:-~/.config}/localfirstdotsh` and
`${XDG_DATA_HOME:-~/.local/share}/localfirstdotsh`. Directories are 0700 and
files 0600:

| Path (under the data directory) | Contents |
| --- | --- |
| `bundles/` | Digest-verified bundles saved by `test plan` for offline reuse |
| `plans/` | Sealed local plans |
| `reports/` | Complete local reports, including model output and raw provider statistics. Never uploaded; delete freely |
| `exports/` | Reviewed upload payloads |
| `approvals/` | Stored approvals, one file per plan digest (`--remember`); delete a file to revoke |

Registry and runtime tokens live in the OS keychain (`security` on macOS,
`secret-tool` on Linux), never in these directories.

## Live runtime checks

`pnpm test:live` runs the section 5.2 smoke test against a real runtime. It is
not part of `pnpm check`, does nothing without `LOCALFIRST_LIVE=1` and explicit
endpoint and model variables (see `packages/runner/test/live/gate.ts`), and never starts
a server, loads, pulls, or deletes anything. The LM Studio check also needs
`LOCALFIRST_LIVE_LMSTUDIO=1` and a server you started yourself.

## Moderation and account duties

- Operator roles are rows in `operator_roles`, assigned administratively. They
  are never inferred from an email address or profile field.
- Quarantine removes a project from discovery, blocks new versions and new
  drafts of the same content digest, and can only be lifted by an operator.
- `/account/delete` previews managed projects and retention effects. A confirmed
  request atomically withdraws those projects, removes private contribution
  records and credentials, and blocks account access across replicas. Quarantine
  is preserved. Final identity/history/audit erasure and attribution on projects
  managed by another account remain operator duties under the unresolved final
  legal retention policy.

## Logging and privacy

Logs carry request and job IDs, route or tool names, status, actor identifiers,
safe error classes, latency, and digests. They never carry manifests, bodies,
prompts, credentials, cookies, authorization codes, or token responses. The
metrics endpoint is internal and token-gated; it counts backend activity only
and cannot observe local test activity, which the backend never sees.
