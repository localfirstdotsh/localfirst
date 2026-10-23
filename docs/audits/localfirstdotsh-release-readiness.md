# localfirstdotsh release readiness

> Superseded by [`npm-release-security-audit.md`](npm-release-security-audit.md) (2026-10-23). This report is kept as the 2026-10-16 record.

Audit of `localfirstdotsh` 0.1.0 (`packages/runner/`) on branch `chore/localfirstdotsh-release-audit`, run 2026-10-16
on macOS (Apple Silicon, Darwin 25.5), Node.js 26.8.1, pnpm 12.4.1. Nothing was published, pushed to
`staging`/`main`, or changed in a live environment.

## A. Executive summary

The package is close to releasable. Its design is conservative: no default registry, no telemetry, no
shell, no `--yes` flag, every state change gated by an interactive exact-digest approval. The packed
tarball installs into a clean directory and the CLI works from it.

The audit found no P0. The blockers on `dev` (P1) were that `packages/runner/package.json` was `private: true`
with a workspace-only `@localfirst/contracts` dependency, so the package could not be published or
installed. The unmerged `chore/npm-package-preparation` branch already fixes this (vendored contracts,
license, README, a tarball smoke test); this branch merges it, then fixes the findings below.

**Decision: CONDITIONALLY READY** (section J).

## B. Architecture overview

- `localfirstdotsh` is a CLI (`bin`: `dist/cli/bin.js`), ESM, Node >= 22. Runtime deps: `zod`, `yaml`.
  `@localfirst/contracts` is compiled into `dist/contracts` at build (`scripts/vendor-contracts.mjs`).
- **The npm package does not host an MCP server.** The MCP server is the hosted registry backend
  (`apps/api/src/mcp`, `POST /mcp`, OAuth-protected). `mcp add --client claude-code|codex|github-copilot|gemini-cli|cursor|vscode|opencode|windsurf|cline` reads the
  registry's `/.well-known/oauth-protected-resource/mcp`, prints the client's native `mcp add` command,
  and runs it (no shell, argv vector) only after an interactive `yes`. No token passes through the CLI.
  Consequently there is no stdio protocol stream for logs to contaminate.
- Other commands: `runtime discover` (Ollama/LM Studio on loopback), `project export`, `test plan|run`,
  `environment ...`, `framework prepare` (Docker), `report ...`, `contribution ...`, `auth ...`.
- Network: only to the user-configured registry (https, or http on loopback), `redirect: 'error'`,
  30 s timeout, 4 MiB bounded bodies, and loopback runtime endpoints. No registry default, no hardcoded
  URLs in `src`.
- Secrets: OS keychain only (macOS `security`, Linux `secret-tool`), via stdin, never a file.

## C. Findings

| # | Sev | Finding | Root cause | Resolution | Verification |
|---|---|---|---|---|---|
| 1 | P1 | Package not publishable/installable from `dev` (`private: true`, `workspace:*` dep, no license/README) | Packaging not merged to `dev` | Merged `origin/chore/npm-package-preparation` (`packages/runner/package.json`, `scripts/vendor-contracts.mjs`, `scripts/test-package.mjs`) | `pnpm test:package`: pack, `npm install` of the tarball in a temp dir, CLI, library types, framework assets |
| 2 | P1 | `mcp add` metadata fetch followed redirects and read the whole body unbounded (`packages/runner/src/cli/commands/mcp.ts`) | Used raw `env.fetch` and `response.json()`, unlike `RegistryClient` | `redirect: 'error'`, 64 KiB bounded read | New tests in `test/cli-mcp.test.ts`; the redirect test fails without the fix (checked) |
| 3 | P1 | Website setup example used `--client claude`, which the CLI rejects (`apps/web/src/lib/capabilities.ts` comment) | Stale example | Changed to `claude-code` | Web typecheck + 94 tests |
| 4 | P2 | `report show <missing file>` printed `Unexpected error: ENOENT...` | `rawReport` let `lstat`/`JSON.parse` errors escape | Wrapped as `CliError` (`packages/runner/src/cli/commands/report.ts`) | New test in `test/cli-report.test.ts`; re-run from packed tarball |
| 5 | P2 | Tarball shipped 804 KB of `.js.map` whose `src/` is not shipped | `files` included all of `dist` | `!dist/**/*.map` (303 kB to 197 kB, 331 to 0 map files) | `npm pack`, tarball listing |
| 6 | P2 | README did not state platform/client scope | n/a | Added verified/unsupported statement to `packages/runner/README.md` | Read-through; matches keychain code |
| 7 | P1 (external) | `repository`/`homepage`/`bugs` pointed at a private repository; the public snapshot points them at `localfirstdotsh/localfirst`, which takes effect once that repository is published | Repo visibility | **Not fixed** (needs owner decision) | `gh repo view` reports PRIVATE |
| 8 | P1 (external) | No release/publish workflow, no provenance; CI is suspended and billing-blocked | MVP phase | **Not fixed** (publishing config needs authorization) | `.github/workflows/` has only `ci.yml` (`workflow_dispatch`) |
| 9 | P2 | No `engines` runtime guard: `npx` on Node < 22 only warns | npm semantics | Not fixed; Node < 22 untested | n/a |
| 10 | P3 | `pnpm audit --prod` reports one moderate (esbuild, via backend `drizzle-kit`) | Backend dev tooling, not in the tarball | Recorded | `pnpm audit`; runtime deps `zod`, `yaml` and the langgraph shrinkwrap show none |

Also checked, no issue: no `postinstall`/lifecycle scripts; no `.env`/secrets/`src`/`test` in the tarball;
no absolute paths in output; argv-vector spawning only; `mcp add` refuses a cross-origin or
credential/query-bearing MCP URL; `--client` limited to tested clients; startup about 90 ms.

## D. Changes implemented

- Merged `chore/npm-package-preparation` into this branch (merge commit, no conflicts).
- `packages/runner/src/cli/commands/mcp.ts`: no redirects, bounded metadata body.
- `packages/runner/src/cli/commands/report.ts`: clean errors for unreadable/non-JSON reports.
- `packages/runner/package.json`: exclude source maps from the tarball.
- `apps/web/src/lib/capabilities.ts`: correct `claude-code` example.
- `packages/runner/README.md`: platform and client scope.
- `packages/runner/src/cli/commands/mcp.ts`: `--client gemini-cli` and `github-copilot` (native `mcp add`, same approval flow);
  `vscode`, `cursor`, `opencode`, `windsurf`, `cline` (print the vendor-format entry; run and write nothing).
  `apps/web/src/lib/mcp-setup.ts` and the connect page gain VS Code. Tests for each.
- Tests: 10 in `packages/runner/test/cli-mcp.test.ts` (redirect, 404, 500, malformed JSON, empty, non-string,
  unparseable and oversized body, credential/query URL, unreachable), 1 in `packages/runner/test/cli-report.test.ts`.

## E. Compatibility matrix

| Environment | Installation | MCP startup | Tool execution | Status |
|---|---|---|---|---|
| Claude Code 2.1.302 | Pass: `mcp add` registered the server (isolated `HOME`, fake registry) | Fail by design: fake registry is not an MCP server; Claude reports "Failed to connect" with a clear cause | Not tested | Registration verified; sign-in and tools unverified |
| Codex CLI 0.153.4 | Pass: config written, `codex mcp list` shows `enabled` | Not tested (Codex connects only in a model session) | Not tested | Registration verified; the rest unverified |
| Gemini CLI 0.64.0 | Pass: `gemini mcp add --transport http --scope user` (client id `gemini-cli`) wrote `~/.gemini/settings.json` (isolated `HOME`, fake registry) | Not tested: `gemini mcp list` shows the server `Disabled` in a headless, untrusted folder; connection and `/mcp auth` not exercised | Not tested | Registration verified; the rest unverified |
| GitHub Copilot CLI | Pass: `copilot mcp add --transport http` wrote `mcpServers.localfirst`; `copilot mcp list` shows it (isolated `HOME`, fake registry) | Not tested | Not tested | Registration verified; the rest unverified |
| VS Code, Cursor, OpenCode, Windsurf, Cline | Not tested: the CLI prints the vendor-documented entry and edits nothing; none of these apps is installed here (OpenCode's CLI was installed but its `mcp add` is interactive) | Not tested | Not tested | Configuration-only, unverified in the apps |

Server side, `apps/api/test/mcp-client.test.ts` (official MCP SDK client) and `apps/api/test/mcp.test.ts`
cover initialize, version negotiation, `tools/list`, `tools/call`, resources, scope denial, bad tokens, and
read-only annotations; they pass below. An OAuth-authenticated end-to-end run from a real client against a
deployed registry was **not** performed.

## F. Test results

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `TEST_DATABASE_URL=postgres://localhost:5432/localfirst_release_audit_test pnpm check` (throwaway DB, dropped afterwards) | pass: contracts 75, web 94, runner 494, backend 475 tests; typecheck and build clean |
| `pnpm --filter localfirstdotsh test:package` (run before and after the fixes) | pass |
| Packed tarball in a clean dir, `env -i`: `--version`, no args, unknown command, missing/invalid registry, unsupported client, unreachable registry, `report show` of a missing file | exit codes 0/0/2/2/2/2/2/1/1; no stack traces after fix #4 |
| `pnpm test:live`, Windows, Linux, Node < 22 | not run |

## G. Package verification

- `localfirstdotsh@0.1.0`, `localfirstdotsh-0.1.0.tgz`, 197 kB packed, MIT, Node >= 22, public access.
- Contents: `dist/` (JS + `.d.ts`, including `dist/contracts`), `frameworks/langgraph/*`, `README.md`,
  `LICENSE`, `package.json`. No `src`, tests, scripts, maps, or env files.
- Clean install: `npm install ./localfirstdotsh-0.1.0.tgz` added 3 packages (self, `zod`, `yaml`).
- Not on npm yet (`npm view` 404). Verified OS: macOS arm64, Node 26.8.1 only.

## H. Remaining risks

- Repo is private, so the package's repository/bugs links will 404 for users (finding 7).
- No automated, provenance-enabled publish pipeline; publishing would be manual from a developer machine.
- Linux, Windows and Node 22 to 25 are unverified. Windows is documented as unsupported.
- Sign-in and tool calls from Claude Code and Codex against a deployed registry are unverified.
- The package works only against a registry the user supplies; there is no default, so first-run users
  need the registry URL from the website. The website's setup variables (`LOCALFIRST_CLI_*`) must be set
  to match the published version.
- The website docs (`apps/web/src/app/docs/testing`, `docs/toolkit`) correctly say the package is unpublished and
  show a from-source command; they must be updated in the same change that publishes it.
- Backend/package coupling is by registry route shapes; there is no explicit compatibility error on version skew.

## I. Release checklist

- [x] Clean package installation (macOS, tarball)
- [x] Executable entry point verified
- [ ] MCP initialization verified end to end from a client (server side tested; client registration only)
- [ ] Core tool execution verified from a client
- [x] Public documentation accurate for what was tested (README, web example)
- [x] Security issues addressed (finding 2)
- [ ] Supported integrations tested beyond registration
- [ ] API compatibility confirmed against the deployed registry
- [ ] Cross-platform tests completed
- [ ] CI/CD checks passing (suspended)
- [x] npm artifact validated
- [ ] Publishing permissions reviewed
- [ ] Version and release notes prepared
- [x] No unresolved P0 issues
- [ ] No unresolved P1 issues (findings 7 and 8)
- [ ] Production publishing explicitly authorized

## J. Decision

**CONDITIONALLY READY.** Core install and CLI behavior are verified from the real tarball and the full
local suite passes. Before `npm publish`: make the repository public or correct its metadata, decide on
the publish process (ideally CI with `--provenance`), run one authenticated Claude Code or Codex session
against the deployed registry, and obtain explicit authorization to publish.
