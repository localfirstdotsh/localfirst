# npm release security audit: `localfirstdotsh` 0.1.0

| | |
|---|---|
| Package | `localfirstdotsh` (source `packages/runner/`), version `0.1.0` on `dev`; `0.1.0-beta.0` on the unmerged `chore/npm-beta-release` branch |
| Audited code | `origin/dev` at `155f1c7`, plus the release branch `origin/chore/npm-beta-release` at `c1f0a23` (reviewed read-only) |
| Fixes | Branch `fix/npm-release-security-audit` (from `origin/dev`); merged into `dev` in #48 and promoted to `staging` in #52 (2026-10-23) |
| Date | 2026-10-23 |
| Later change | The approval device was retired after this audit (`refactor/retire-approval-device`, BACKEND_PRD ADR-014): `auth approver-login` and `contribution approve` no longer exist. That resolves R-1, and LF-01's fix now protects `contribution review` output and registry errors only. |
| Method | Source review of every runner module and the contracts it vendors, tarball inspection, adversarial regression tests, a clean-consumer install, dependency audit, git-history credential scan, and a read-only review of GitHub and npm settings |

## 1. Executive summary

**Overall posture: strong for a pre-1.0 CLI.** The runner is built around deterministic controls rather than model judgment:

- Every side effect needs an interactive approval bound to an exact digest, and there is no `--yes`.
- Subprocesses always get argument vectors and never a shell.
- Runtime traffic is pinned to loopback, and the connected peer is checked as well.
- Registry content is verified against digests.
- Project code runs only in a locked-down Docker container.
- Secrets live only in the OS keychain and are passed on stdin.

No critical findings came up, and no command injection, path traversal, or secret exposure in the published artifact.

**Most significant risks**

1. **The release pipeline is not yet protected (LF-04, High, open).** Nothing in the one-time setup is applied: the `npm` GitHub environment and its required reviewer, the tag ruleset, the trusted publisher, and the token lockdown. Once it is applied, the only control that stops a tag on an unreviewed branch from publishing is the environment's required reviewer. The workflow's own "commit must be on staging/main" check does not stop it, because an attacker who can push a tag can edit that check.
2. **The approval screen could be spoofed through terminal control characters (LF-01, Medium, fixed).** Agent-authored draft text containing `\r`, C1 or zero-width characters passed registry validation and was printed raw by `contribution approve`. A line could then visually overwrite the part of the content the person was approving.
3. **The approval device was weaker than the browser (R-1, resolved by removal).** The TTY check is not proof that a person is present: piping `yes` through the stock `script` utility satisfies it (verified). The device has since been retired; a person approves in the browser or delegates publication to one connection.

**Release readiness:** the package code passes the gate. The published manifest and release pipeline do not yet: LF-07 is still present on `dev`, and LF-04 is configuration that has not been applied.

**Decision: NO-GO for publishing today.** This flips to **CONDITIONAL GO** once the release blockers in section 7 are done. None of them needs further code changes to the runner.

## 2. Attack surface

**Distribution.** The package is unscoped (`localfirstdotsh`) with one `bin`, `localfirstdotsh` (`dist/cli/bin.js`). Its library entry point is `dist/index.js`. Runtime dependencies are `zod@4.6.6` and `yaml@2.9.1`, both exact. It declares no install, preinstall, postinstall or prepare scripts, so `npm install` and `npx` run nothing until the person invokes a command. The contracts package is vendored into `dist/contracts` at build time.

**Entry points.** The `bin.ts` command line is dispatched through a fixed command table (`main.ts`) and parsed with `node:util` `parseArgs` in strict mode, so unknown flags are usage errors. There is no network listener, no MCP server, no daemon, no telemetry, and no update check: grep for `createServer`, `listen`, `net` and the MCP SDK finds nothing in `src/`.

| Trust boundary | Untrusted input | Where it goes | Controls verified |
|---|---|---|---|
| Registry (user-chosen origin) | JSON responses, `PROJECT.md`, bundle files, draft review content, error messages | Terminal output, files on disk, plans | Origin must be https, or http on loopback only; no path, credentials, query, or fragment (`registry.ts:27`). Redirects are refused, there is a 30 s timeout and a 4 MiB body cap. Bundle files must match their digests and pass `validateProjectBundle`. Paths are checked by `isSafeBundlePath` and contracts `bundlePath`. Files are written `wx`, `0600`, in `0700` directories. Terminal output from registry content goes through `terminalSafe` (LF-01). |
| MCP setup (`mcp add`) | `resource` from `/.well-known/oauth-protected-resource/mcp` | argv of `claude`, `codex`, `gemini` or `copilot` `mcp add` | Same-origin resource only, no credentials, query or fragment; redirects refused; 64 KiB cap. `--name` must match `^[a-z0-9][a-z0-9-]{0,39}$`. The full command is shown and runs only after an interactive yes, through `spawn` with `shell: false`. No token passes through the CLI. |
| Local runtimes (Ollama, LM Studio) | Model lists and model output | Plans and reports | Loopback endpoint schema in plans; `node:http` with `agent: false` (no proxy); redirects rejected; the connected peer must be a loopback address, which defeats DNS rebinding; bounded bodies. The LM Studio bearer token is sent only to the endpoint it was stored for. |
| Project code (`FRAMEWORK/*.mjs`) | Creator JavaScript from a bundle | Docker container only | A separate approval for image build. Dependencies are a digest-pinned shrinkwrap from `registry.npmjs.org`, verified with SHA-512, installed with `--ignore-scripts`, and the build runs with `--network=none`. The container runs with no network, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, a non-root user, pids/memory/CPU caps, and a `noexec` `/tmp`. Only a unix-socket Docker endpoint is allowed, with a clean environment. The broker accepts only `ready`, `step` and `done` messages. |
| Local files the person passes | Plans, reports, workspaces, private JSON | Execution and export | Plans are sealed by digest and re-verified against the bundle before and after approval. Symlinks and special files are refused in bundles. Report and JSON inputs must be bounded regular files (`lstat`). |
| OS keychain | Tokens | `security`, `secret-tool` | Secrets travel on stdin only, never in argv. Account names are validated against injection into `security -i`. There is no plaintext fallback. |
| Model output | Untrusted text | Evaluators, the workflow broker, reports | No tools; the harness refuses `allow_tools`, `allow_project_code` and `allow_downloads`. Workflow operations come from a fixed allowlist. Output is never executed by the host. |

**What runs automatically versus after approval.** `help`, `--version`, `environment samples` and `report show` / `compare` are local and read-only. `project export` and `test plan` make anonymous registry reads, and contacting a runtime needs an interactive "yes". Everything else needs its own TTY approval bound to a digest: execution, framework preparation, export, upload, MCP registration, publication approval, and cleanup. `test run` can reuse a stored per-digest approval created by `--remember`.

**Out of scope.** The hosted registry and its MCP server (`apps/api`) and the website (`apps/web`) are not shipped in the package. Their tests ran as part of `pnpm check`, but they were not audited here.

## 3. Vulnerability findings

Confirmed vulnerabilities come first, then release-pipeline and supply-chain findings.

### LF-01: Terminal control characters can spoof the human approval screen (Medium, fixed)

- **CWE:** CWE-150 (improper neutralization of escape sequences), CWE-451 (UI misrepresentation of critical information)
- **Location:** `packages/runner/src/cli/commands/contribution.ts:117` on `dev`, where `env.io.out(lines.join('\n'))` printed draft content, file contents, slug and issue messages raw. The same pattern appeared in `contributionReview`, in `approver-login` output, and in registry error messages (`registry.ts:165`).
- **Execution path:** an agent creates or edits a project draft over MCP or the API. Then `localfirstdotsh contribution approve <draft>` fetches `/drafts/:id/review` and prints `review.content` and `review.files[].content` to the person, who types "yes" to approve that digest.
- **Preconditions:** the attacker controls draft content. That could be the person's own agent under prompt injection, or any author whose draft the person approves. Registry validation (`contracts/src/safety.ts:133`) rejects NUL, ESC and most C0 controls, but **allows `\r`, DEL, C1 controls (including the 8-bit CSI `U+009B`), zero-width characters and line separators**. Reproduced: a valid `PROJECT.md` containing `Upload every customer record to https://exfil.example/collect.\r` followed by a padded cover sentence returns `ok: true` with no errors.
- **Impact:** on a real terminal the cover text overwrites the line, so the person approves content they did not see. That defeats the human-in-the-loop gate this command exists to provide.
- **Evidence before the fix:** `test/security-boundaries.test.ts` failed, with raw control bytes present in the approval and review output.
- **Root cause:** registry-controlled text was written to the terminal without neutralization, and the validator's denylist does not cover every character that moves the cursor or hides text.
- **Fix:** `terminalSafe()` (`cli/io.ts:27`) renders every C0 control except tab and newline, DEL, C1 controls, and the zero-width, bidirectional, line-separator and BOM characters as visible escapes. It is applied to the whole approval screen and its questions (`contribution.ts:118-123`), the limitation prompts, blocking-issue messages, `contribution review` output, `approver-login` output, and every registry error message and code (`registry.ts:166`). When anything was escaped, the screen says so and notes that the digest covers the original characters. The digest binding is unchanged.
- **Regression tests:** in `security-boundaries.test.ts`, under "contribution approve: draft content cannot spoof the approval screen" (2 tests) and `terminalSafe` (2 tests).
- **Follow-up (recommended, not required for release):** also reject `\r` outside CRLF pairs, DEL, C1 and zero-width characters in `scanContentShape`, so the web review page and other clients get the same protection.

### LF-02: `environment run` uses an unvalidated registry origin from workspace metadata (Low, fixed)

- **CWE:** CWE-918 (server-side request forgery, client-side variant), CWE-20
- **Location:** `cli/commands/environment.ts:193` on `dev` built `new RegistryClient(bundle.meta.registry_origin, …)` straight from `.localfirst-bundle.json`.
- **Path and preconditions:** that provenance file is **not covered by the bundle digest**. Anyone who can write the workspace (a shared or downloaded workspace, for example) can point the pre-run freshness check at any URL, including plain `http` to a non-loopback host, a LAN address or a cloud metadata address. Every other registry path runs the origin through `parseRegistryOrigin`; `test run` does so at `test-run.ts:59`.
- **Impact:** a GET to an attacker-chosen URL that discloses the test definition ID and the fact that a run is starting. Over plain http, an attacker on the network can also answer the freshness check. No token is sent, so the impact is low.
- **Evidence before the fix:** the regression test recorded a request to `http://198.51.100.7/api/v1/test-definitions/00000000-0000-4000-8000-000000000009`.
- **Fix:** `parseRegistryOrigin(bundle.meta.registry_origin)` now runs before any request (`environment.ts:194`). An invalid origin is refused before the approval prompt and nothing is contacted.
- **Regression test:** "environment run: the workspace cannot redirect the freshness check".

### LF-03: Writing bundle metadata follows a planted symlink (Low, fixed)

- **CWE:** CWE-59 (link following)
- **Location:** `cli/bundle.ts:121` on `dev` wrote `.localfirst-bundle.json` without `wx`, unlike `PROJECT.md` and the test files.
- **Path and preconditions:** `project export --out <dir>` or `test plan --out <dir>` into an existing directory where someone has planted `.localfirst-bundle.json` as a symlink, such as a cloned repository.
- **Impact:** the symlink target, anywhere the user can write, is overwritten with bundle JSON.
- **Evidence before the fix:** the export exited 0 through the symlink.
- **Fix:** the file is written with `flag: 'wx'` (`bundle.ts:122`), which uses `O_EXCL` and never follows a link. The `project export` conflict message now names all three possible files.
- **Regression test:** "refuses to write bundle metadata through a symlink in the output directory".

### LF-04: Publishing protections are not configured, and the workflow's branch check is not a security control (High, open, release blocker)

- **CWE:** CWE-284 (improper access control), CWE-693 (protection mechanism failure: the branch check lives in a file the attacker controls)
- **Location:** `.github/workflows/release.yml` on `chore/npm-beta-release` (lines 58, 78-81), and the repository settings.
- **Verified state (read-only API, 2026-10-23):**
  - No `npm` environment exists; the only environments are three staging deployments with no protection rules.
  - The only ruleset is `permanent-branches`, which covers branches, not tags.
  - `sha_pinning_required` is false.
  - The npm package does not exist yet (`npm view` returns 404), so no trusted publisher is configured.
- **Why it matters:** the `plan` job's `git merge-base --is-ancestor … origin/staging|main` check runs from **the tagged commit's own copy of `release.yml`**. Someone with write access can push a branch whose `release.yml` drops that check, then push a `localfirstdotsh-v*` tag on it. The npm trusted publisher validates repository, workflow file name and environment name, and all three still match. If the `npm` environment has no required reviewer, GitHub auto-creates it unprotected on first use and the job gets `id-token: write`, so arbitrary code is published under the package name with valid provenance. The tag pattern restriction in the runbook does not help, because the attacker's tag matches it.
- **Current exploitability:** none yet. The package does not exist and the workflow is unmerged. There is a single admin (`RidwanG206`), so the realistic attacker is someone holding a stolen write credential.
- **Required before the first CI publish:** apply runbook steps 1, 2 and 4 on `chore/npm-beta-release`:
  1. Create the `npm` environment with a required reviewer and the tag pattern policy. The reviewer is the control that matters.
  2. Make the tag ruleset on `localfirstdotsh-v*` mandatory rather than "recommended", and restrict creation, update and deletion.
  3. Configure the trusted publisher, then set the npm package to "require two-factor authentication and disallow tokens".
  4. State in the runbook that the ancestry check is a guard against mistakes, not an access control.

### LF-05: Release actions are pinned to mutable tags in the job that holds `id-token: write` (Low, open)

- **CWE:** CWE-829
- **Location:** `release.yml:86-93` (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`).
- **Impact:** if a third-party action's tag is compromised, it can mint the npm OIDC token in the publish job.
- **Recommendation:** pin all three to full commit SHAs, at least in `release.yml`, and let Dependabot update them.

### LF-06: The publish job installs the whole workspace (Low, open)

- **Location:** `release.yml:98` runs `pnpm install --frozen-lockfile`, which installs the API and web dependency trees (270 packages) in the job that can mint the OIDC token.
- **Mitigation already in place:** pnpm runs install scripts only for packages on the `allowBuilds` list (`esbuild`), and the lockfile passes pnpm's supply-chain policy.
- **Recommendation:** limit the install to the runner and contracts, for example with `--filter` on both packages, so the job's dependency set matches what is published.

### LF-07: The packed manifest names the unclaimed `@localfirst/contracts` (Low, open on `dev`, fixed on the release branch)

- **CWE:** CWE-427 (dependency confusion)
- **Evidence:** a `pnpm pack` of `dev` produces `"devDependencies": { "@localfirst/contracts": "0.3.0" }`, and `npm view @localfirst/contracts` returns 404, so the name is unclaimed. Consumers never install devDependencies. Anyone who runs `npm install` inside the extracted package, as some scanners and contributors do, would fetch whatever a third party publishes under that name.
- **Status:** `chore/npm-beta-release` removes the devDependency, and its `test-package.mjs` asserts that no `@localfirst/` name appears in the packed manifest. **That branch must be merged before release.** Separately, consider registering the `@localfirst` npm scope defensively.

### Verified non-issues (attack paths tested and found closed)

- **Command and argument injection.** No shell anywhere: every call uses `execFile` or `spawn` with `shell: false`. MCP names with `;`, `$()`, backticks, spaces, a leading `--` or a newline are rejected before any request or spawn (new test). The `--print` output is POSIX-quoted.
- **Path traversal.** Registry bundle paths containing `..`, absolute paths, backslashes, or other characters are refused and nothing is written (new test plus `registry-source.test.ts`). Saved bundles reject symlinks and special files (`cli-units.test.ts`).
- **Unsafe deserialization and dynamic code.** No `eval`, `new Function`, `vm` or dynamic `import()` in shipped code. YAML parses with no custom tags, no merge keys, no anchors or aliases, unique keys, and bounded depth (`contracts/src/project/document.ts:71`).
- **HTML output.** `report trace --format html` escapes every value and sets `default-src 'none'`.
- **Credential forwarding.** Tokens are keyed per origin and sent only to that origin. Registry, runtime and approver tokens are kept apart. Errors never include tokens (`ollama-adapter.test.ts:298`, `cli-approval.test.ts`).
- **Environment propagation.** The Docker calls use a clean environment (`PATH` and `HOME` only). Other child processes are the person's own tools (keychain, MCP clients, `lms`) and inherit the environment by design.

## 4. Dependency and supply-chain report

| Check | Result |
|---|---|
| `pnpm audit` (whole monorepo) | 1 moderate: `esbuild <=0.24.2`, GHSA-67mh-4wv8-2f99, development-server CORS. Reached only via `apps/api > better-auth > drizzle-kit > @esbuild-kit/*`. **Not in the npm package.** |
| `npm audit --omit=dev` in a clean consumer of the tarball | **0 vulnerabilities**. Tree: `localfirstdotsh`, `zod@4.6.6`, `yaml@2.9.1` |
| Lifecycle scripts | None in the package. None in its two runtime dependencies (checked in the consumer `node_modules`). The workspace allows builds for `esbuild` only. |
| Lockfile | `pnpm install --frozen-lockfile` succeeds, and the lockfile passes pnpm's supply-chain policy check. Runtime dependencies are pinned exactly. |
| Framework image dependencies | 128 or fewer entries, all `https://registry.npmjs.org` with SHA-512 integrity. The lock digest is pinned in contracts (`LANGGRAPH_LOCK_DIGEST`). Installed with `--ignore-scripts`, built with no network. |
| Name squatting | `localfirstdotsh` is unpublished, and `@localfirst/contracts` is unclaimed (see LF-07). |

**Publication surface.** `npm pack --dry-run --json` and a real `pnpm pack` both give 205 entries, 219 KB packed and 941 KB unpacked: compiled `dist/` without source maps, vendored contracts, four LangGraph framework files, `README.md`, `LICENSE` and `package.json`. There is no `src`, no tests, no `.env`, no key material, no fixtures, and no absolute local paths. A pattern scan for AWS, GitHub, npm, OpenAI/Anthropic-style, Slack and Google keys, private keys and database URLs with passwords found nothing. **All 202 shipped `dist`/`frameworks` files are byte-identical to a fresh `tsc` build of the audited source**, and `README.md` and `LICENSE` are identical too. The only bare-module imports in shipped code are `zod`, `yaml` and `node:*` built-ins; no `@localfirst/*` import remains.

**Git history.** All 92 commits on all refs were pattern-scanned. The only matches are deliberate test fixtures: the documented AWS example key `AKIAIOSFODNN7EXAMPLE`, dummy `ghp_abcd…` strings, and a `-----BEGIN RSA PRIVATE KEY-----` literal used to test rejection. The rest are the CI throwaway PostgreSQL password and placeholders in `.env.example` files (`replace-with-…`, `<role>:<password>`). **No rotation is needed.**

**Release pipeline.** CI (`ci.yml`) has `contents: read`, no secrets, and requires approval for pull requests from first-time contributors' forks. It does not use `pull_request_target` and does not interpolate untrusted event data into scripts.

`release.yml` on the release branch:

- triggers on tags only;
- passes `TAG` through the environment rather than interpolating it;
- validates the version strictly with a regular expression;
- allows only a stable version to reach `latest`, from `main`, and a `-beta.N` version to reach `beta`, from `staging`;
- refuses republishing;
- reruns CI on the tagged commit;
- packs once and smoke-tests that exact tarball;
- publishes with `--provenance` through OIDC, with no stored npm token;
- verifies the dist-tag afterwards.

The design is sound. Its gaps are LF-04, LF-05 and LF-06.

## 5. Remediation summary

Changes are on `fix/npm-release-security-audit`, in `packages/runner` only:

| File | Change |
|---|---|
| `src/cli/io.ts` | Adds `terminalSafe()` |
| `src/cli/commands/contribution.ts` | Neutralizes the approval screen, questions, limitations, blocking issues and review output, and notes when escapes were shown (LF-01) |
| `src/cli/registry.ts` | Neutralizes registry error messages and codes (LF-01) |
| `src/cli/commands/auth.ts` | Neutralizes `approver-login` output, and tells the person that a local agent can answer this terminal (R-1) |
| `src/cli/commands/environment.ts` | Validates the workspace's registry origin (LF-02) |
| `src/cli/bundle.ts`, `src/cli/commands/project.ts` | Exclusive metadata write, and an accurate conflict message (LF-03) |
| `test/security-boundaries.test.ts` | 10 new regression tests: the three findings, the disclosure, shell metacharacters in MCP names, end-to-end traversal of a registry bundle path, and the absence of install-time scripts |

No dependencies were added and no behavior changed beyond refusing the unsafe cases. Open items are LF-04 to LF-07; see section 7.

## 6. Test results

Final code, macOS (Apple Silicon), Node 26.12.0, pnpm 12.4.1:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm --filter localfirstdotsh test` on unmodified `dev` (baseline) | pass: 31 files, 504 tests |
| `test/security-boundaries.test.ts` on unmodified code | **4 failed**, 5 passed: LF-01 (2), LF-02, LF-03. These were the expected reproductions. |
| `pnpm check` with `TEST_DATABASE_URL` set to a dedicated throwaway database, created and dropped for this run | **pass.** contracts 75/75, web 164/164, runner **514/514** (32 files), api 490/490 |
| `pnpm --filter localfirstdotsh test:package` | pass: pack, npm install, CLI, three MCP clients, types, framework assets |
| Clean consumer: `npm install --ignore-scripts` of the fixed tarball, then `npm audit --omit=dev` | pass, 0 vulnerabilities |
| Installed CLI checks | `--version` and `help` exit 0. An unknown command and `--yes` give exit 2. A non-https registry, credentials in the registry URL, and a non-loopback runtime endpoint give exit 2. No TTY for discovery or `set-token` gives exit 3. An unreachable registry gives exit 1 with a clean message. No state directory is created by read-only or refused commands. |
| Pseudo-terminal bypass probe (R-1) | Confirmed: `printf 'yes\n' \| script -q /dev/null localfirstdotsh runtime discover …` is accepted as an interactive yes |
| Dependency audit | See section 4 |

**Not executed, with reasons:**

- There is no `lint` script; `tsc` typecheck is the static analysis.
- `pnpm test:live` was not run; it needs real Ollama, LM Studio or Docker runtimes, and the fakes cover the protocol.
- `pnpm test:e2e` was not run; it covers the website, which is not in the package.
- The Docker framework build was not run live: it downloads about 128 packages and builds an image. Its argument and lock invariants are unit-tested in `framework.test.ts`.
- The Linux `secret-tool` keychain was unit-tested only.
- `release.yml` was not executed, because that would publish. It was reviewed statically.
- No dedicated secrets scanner (gitleaks or trufflehog) is installed here, so the history scan used regular expressions.
- Windows is unsupported by design.

## 7. Release blockers

In priority order:

1. [ ] **LF-04:** create the `npm` GitHub environment with a required reviewer and a deployment policy for `localfirstdotsh-v*` tags. Add a mandatory tag ruleset for `localfirstdotsh-v*` that restricts creation, update and deletion. After the bootstrap publish, configure the npm trusted publisher (`release.yml`, environment `npm`) and set "require 2FA and disallow tokens". The repository-settings changes need the owner.
2. [ ] **LF-07:** merge `chore/npm-beta-release` through `dev` and `staging` before any publish, so the packed manifest no longer names `@localfirst/contracts`. That also brings `release.yml`, the version bump and the stricter `test-package.mjs`.
3. [ ] Merge this branch's fixes (LF-01 to LF-03) through `dev` and `staging` before the bootstrap publish (done: #48, #52), and rerun `pnpm check` and `test:package` on the commit that will be published (open).
4. [ ] For the bootstrap publish, made by hand in runbook step 3: use a clean detached worktree and an npm account with 2FA, then confirm the dist-tags with `npm view localfirstdotsh dist-tags`. npm points `latest` at the first beta.

Recommended before the first stable `latest` release (not blocking a beta): LF-05 (pin actions to SHAs) and LF-06 (narrow the publish-job install).

## 8. Residual risks

- **R-1: The approval device is not proof of a person (resolved: the device was retired after this audit).** `requireTty` can be satisfied by a pseudo-terminal (verified with `script`). Any process running as the user can also read the approval credential from the keychain through `security`, or forge a `--remember` approval file. So an agent with shell access on a machine linked with `auth approver-login` can approve its own drafts. `BACKEND_PRD.md` ("Linked approval device") records this and keeps browser approval as the default. The CLI now states it at link time. Possible hardening: on macOS, create the approver keychain item with an empty trusted-application list (`-T ""`), so every read raises a system dialog that only a person can answer; on Linux, document the device as unsuitable wherever agents run.
- **R-2: Stored execution approvals (`--remember`)** are unauthenticated files in the user's data directory. Forging one gives a same-user process no more power than it already has: it could call the loopback runtime directly. They are bound to one plan digest. Accepted.
- **R-3: Pre-existing symlinked directories inside an `--out` directory** are followed by `mkdir -p`. Writes stay exclusive (`wx`), new-file-only, `0600`, and limited to YAML, JSON, text, Markdown and `.mjs` names, and they require the person to choose an attacker-prepared output directory. Low; hardening would mean an `lstat` walk of each parent.
- **R-4: Project code isolation depends on Docker.** The container profile is strict (see section 2), but a container escape in the local Docker or VM is outside this package's control. Framework execution needs its own approval, and the plan states that it runs project code.
- **R-5: The registry is trusted for content once the person chooses it.** Digests prove integrity against what the registry names, not the author's intent. Prompts and fixtures from a malicious project reach only the local model, with no tools; their output is evaluated, never executed.
- **R-6:** `lms` and the MCP client executables are resolved from `PATH`. Controlling `PATH` already means controlling the user's shell. Accepted.
- **R-7:** The first, bootstrap version is published by hand and has no provenance statement. Every later version is built in CI with provenance.

## 9. Final release verdict

**NO-GO** for publishing `localfirstdotsh` today. The runner code has no unresolved critical or high exploitable vulnerability after the LF-01 to LF-03 fixes, and the actual tarball was validated: its contents, byte-identity with the source build, a clean install, 0 vulnerabilities, and the CLI behaviors above. However:

- the release pipeline that would publish it does not yet enforce authorization (LF-04);
- the publishable manifest on `dev` still names an unclaimed npm package (LF-07).

Once blockers 1 to 3 are done and verified, this becomes **CONDITIONAL GO** for the `beta` dist-tag, conditional on LF-05 and LF-06 before the first stable release and on acceptance of R-2 to R-7 (R-1 is resolved).
