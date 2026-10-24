# Tested client and runtime matrix

BACKEND_PRD section 13.1 requires an *actual* matrix rather than a compatibility
claim, and section 20.1 requires that unsupported clients get an honest
fallback. This file records only what has been exercised in this repository.

## MCP

| Client | Version | Protocol negotiated | Auth | Resources | Result |
| --- | --- | --- | --- | --- | --- |
| `@modelcontextprotocol/client` (official SDK) | 2.3.1 | `2025-11-25` ↔ server default negotiation | Bearer, audience `…/mcp`, JWKS verified | templates + read | `initialize`, `tools/list`, `tools/call`, `resources/templates/list`, `resources/read` all pass (`test/mcp-client.test.ts`) |
| Raw JSON-RPC over HTTP POST | n/a | `2025-06-18` | Bearer, audience `…/mcp` | read | passes (`test/mcp.test.ts`) |
| Claude Code (native model session) | 2.1.300 | `2025-11-25` after native negotiation | Signed, audience-bound test bearer in an ephemeral private config | tool discovery; resource reads remain separate SDK coverage | Exact `claude-sonnet-5-5`, medium effort, invokes `project_search`, `project_get`, `environment_get`, `test_get`, and `environment_plan_local` through the real CLI in `verify:cli-examples`; packet assertions require exact project/version IDs and successful responses |
| Codex CLI (`codex mcp add --url --bearer-token-env-var`) | 0.153.4 | — | Accepts a streamable HTTP server with a bearer token from an environment variable | — | **Configuration only.** `codex mcp list` and `get` read the configuration and never contact the server (observed 2026-10-12 against a recording server); Codex connects only inside a model session, which was not run, so no connection is claimed |
| Claude Desktop, Cursor, Zed, other applications | — | — | — | — | **not tested here.** No claim is made. |

The Claude Code row proves transport connection, discovery and read-only tool
invocation in a real model session. It does not prove browser OAuth by that
application or human approval in the automated verifier. The human approval between an agent's draft and its publication is
proven in a real browser by `verify:browser-consent` (see Authorization).

### Protocol version finding

The PRD treats the MCP `2026-07-28` stateless profile as a candidate. The pinned
server SDK (`@modelcontextprotocol/server@2.3.1`) advertises
`2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07` and does **not**
include `2026-07-28`. The deployment therefore runs the stateless Streamable
HTTP profile at the versions that release actually supports, and a test asserts
this so an upgrade that changes it fails loudly rather than silently.

### Transport decisions

- Stateless: one `McpServer` and one `WebStandardStreamableHTTPServerTransport`
  per request, `sessionIdGenerator: undefined`.
- `enableJsonResponse: true`: a complete JSON body per request. The profile has
  no server-initiated stream, so there is no SSE lifecycle to manage.
- `POST /mcp` executes. `OPTIONS` answers 204 with `Allow: POST, OPTIONS`.
  `GET` and `DELETE` answer 405. Session-oriented clients need an explicitly
  tested adapter (`FEATURE_LEGACY_MCP_SESSIONS`, off) or the REST fallback.
- DNS rebinding protection is on, with the configured API host allowlisted.
- Tool scope denials carry an RFC 6750 `insufficient_scope` challenge through
  the SDK's `scopeChallenge`, and every handler re-checks the scope itself,
  because annotations never enforce authorization.

## Authorization

| Flow | Status |
| --- | --- |
| Better Auth `1.7.7` + `@better-auth/mcp` + `@better-auth/oauth-provider` + `jwt` | Composed; the MCP plugin *is* the OAuth provider, so no duplicate provider is registered |
| Audience separation (`…/mcp` vs `…/api/v1`) | Tested: an MCP token is refused at REST and a REST token is refused at MCP |
| Issuer, expiry, signature, ID-token misuse, scheme | Tested, each refused |
| Invalid bearer with a valid session present | Tested: refused, never downgraded |
| GitHub sign-in end to end | Tested through the real Better Auth routes over HTTP, with GitHub's token, profile and email endpoints simulated, including expiring GitHub user tokens (`test/github-sign-in.test.ts`). It covers a first sign-in, a returning sign-in, the repair of a user who has no profile, and case-insensitive handle collisions. The first real sign-in, on staging (2026-10-13), found that no profile was ever created for a person who signs in; that is fixed and covered by this test |
| Human approval in a browser | Tested in Google Chrome `155.0.8059.40` (system install, headless) by `verify:browser-consent` (2026-10-12): an agent drafts over MCP; the backend's review page approves through its own inline script under the nonce CSP with no console errors or violations; an edit after approval blocks publication; the agent publishes the re-approved revision once. A visitor without a session gets 401, a page on another site cannot approve with the person's cookie, and an access token gets 403. The session cookie is minted with Better Auth's own session store and signature rather than through GitHub |
| Publication delegation ("Publish without asking") | Tested against the real API and database (`test/publication-delegation.test.ts`): only a browser session turns it on or off, and an agent token cannot grant it to itself. A delegated connection must still name the exact revision and digest and acknowledge every warning. Delegation is scoped to one connection and ends when turned off or when the connection is revoked. Approve-and-delegate on the review page applies only to the connection that created the draft. Build drafts are covered too, and delegated versions are labeled publicly. The website flow (confirmation, delegated publish, label, unpublish and republish, turning it off, approve-and-delegate) is tested in Playwright's Chromium at desktop and phone widths (`apps/web/e2e/account.spec.ts`). It was not exercised through a real MCP client session. There is no terminal approval: the linked approval device was retired (BACKEND_PRD ADR-014) |
| Dynamic client registration | Off by default (`FEATURE_DYNAMIC_CLIENT_REGISTRATION`). Any registered name is self-reported, so the consent screen shows where approval is sent (`apps/api/src/auth/client-identity.ts`): an app on this computer (loopback), an app on a host that belongs to Claude, ChatGPT or Cursor, or an unrecognized application with a warning, plus a flag when its name imitates a known app. "Recognized" means the callback host, not a verified registrant. When on, an MCP application registers itself without a session as a public PKCE client with no secret; one whose callbacks are all http loopback addresses (a CLI such as Claude Code) is registered as `native`. Verified in Chrome by `verify:browser-consent` (2026-10-13): registration, **Allow** on the consent page, the code reaching the application's loopback callback, the PKCE token exchange, and `tools/list` with the issued token. That run found and fixed a consent-page bug: the page expected `redirect_uri`, but Better Auth 1.7.7 answers `url`, so no application could finish connecting. On for staging; production undecided |

## Local runtimes and the runner

The first-party runner is the npm package `localfirstdotsh` (`packages/runner/`, not yet
published). It is the only client of the local runtimes; the hosted backend
never contacts a runtime. Versions below are what was captured or exercised, not
a compatibility promise.

| Runtime | Version captured | Platform | Evidence | Status |
| --- | --- | --- | --- | --- |
| Ollama | server `0.35.1` (`GET /api/version`) | macOS arm64 (Darwin 25.5.0) | Real responses captured as fixtures (`packages/runner/test/fixtures/ollama/0.35.1/`). Live runs (`pnpm test:live`, 2026-10-12) with `qwen2.5:1.5b` and `LiquidAI/lfm2.5-1.2b-instruct:q4_k_m`: the section 5.2 smoke test passed on both (`{"label":"billing"}`), and a required `audio_output` was refused before inference on both | Adapter profile `ollama-native/v0.1` |
| LM Studio | app `0.4.20+1`, CLI commit `71bd99c`, engines llama.cpp `2.51.0` and MLX `1.11.0` (selected) | macOS arm64 | Real responses captured as fixtures (`packages/runner/test/fixtures/lmstudio/`); one live smoke run on 2026-10-12 (MLX engine, `google/gemma-3-1b`); llama.cpp not run live | Profiles `lmstudio-openai-compat/v1` (chat) and `lmstudio-native/v1` (native discovery, and optional native chat instrumentation) |
| Either runtime | — | Linux | **Not verified.** No Linux host was available | No claim |

LM Studio exposes no HTTP version endpoint, so its application, CLI, and engine
versions are separate fields from separate sources (`Info.plist`, `lms version`,
`lms runtime ls`) and stay `null` when not observed. Structured output is
evidenced for MLX models only; other formats are blocked as `profile_untested`.

Behaviour the adapters depend on, observed on the captured versions: LM Studio's
OpenAI-compatible `/v1/chat/completions` answers a request for an unknown model
with HTTP 200 from the *loaded* model (the adapter compares `response.model` and
fails with `model_not_found`); Ollama reports durations in nanoseconds.

## Runner CLI

Hosted CLI prompt evaluation uses a separate protocol from local-required runner
execution. `verify:cli-examples` records actual Claude Code commands, exact
observed canonical model and requested medium effort, system/user prompts,
structured outputs (including rejected claims), and independent fixture checks.
Fresh role sessions cannot read golden answers or the discovery session's
history. Sample-declared temperature/context/token settings are not asserted as
effective CLI settings. Requested model unavailability and fallback are explicit
failures, never an alias substitution. These artifacts cannot become local
inference evidence. Credentials and hidden thinking text are excluded.

The bounded environment path is exercised by
`apps/api/test/environments.test.ts` with the official SDK client: search,
immutable environment retrieval, local-plan handoff and resource read. It also
covers default-off gates and the separate SDK gate. This proves the protocol
path; no invocation from an untested desktop client is implied.

The opt-in `packages/runner/test/live/workflow.live.ts` exercises fresh bakery preparation,
actual per-role preflight, local approval and real inference on Ollama `0.35.1`
(`qwen2.5:1.5b`) and LM Studio `0.4.20+1` / MLX `1.11.0`
(`google/gemma-3-1b`) on macOS arm64. Fixture failures remain failures in the
local report; successful transport does not establish model accuracy.

`packages/runner/test/live/framework.live.ts` exercises LangGraph `1.5.0` on the local
Linux Docker engine `29.6.2` in Docker Desktop, invoked from macOS arm64. It checks real
SDK scheduling, local-model inference, full-size broker outputs, network and
host-file denial, capability/resource limits, undeclared-step refusal,
cancellation and teardown. The setup profile uses the local legacy builder with
an isolated credential configuration, an installed digest-pinned Node base,
and offline dependency installation. Other builders, Linux hosts and Windows
hosts remain unverified.

| Command | Network | Needs |
| --- | --- | --- |
| `mcp add --client claude-code\|codex\|github-copilot\|gemini-cli\|cursor\|vscode\|opencode\|windsurf\|cline\|claude-desktop\|chatgpt` | Registry, anonymous GET of `/.well-known/oauth-protected-resource/mcp` | Interactive approval of the exact native command; `--print` only prints it |
| `project export <id>` | Registry, anonymous GET | A registry URL; writes a digest-verified bundle |
| `runtime discover` | One approved loopback endpoint; may run `lms`/read `Info.plist` after its own approval | Interactive approval |
| `test plan <id> --test <key>` | Registry (anonymous) or `--bundle`; runtime preflight only | Interactive discovery approval; makes no inference request |
| `test run <plan>` | Loopback runtime; one anonymous registry status check (skip with `--offline`) | Interactive approval of the exact plan digest, or a stored approval from `--remember` |
| `environment prepare` | Registry GET, local bundle, or built-in fictional bakery sample | Interactive approval; exclusive new private workspace |
| `environment plan` | Approved runtime preflight; no inference | Interactive discovery approval; installed model bound to every role |
| `environment run <plan>` | Loopback runtime; immutable registry status check (skip with `--offline`) | Interactive exact-plan approval; prepared isolated artifact for SDK profile |
| `environment remove <workspace>` | None | Interactive approval; only unchanged prepared files may be removed |
| `framework prepare` | Local Unix Docker engine and pinned npm registry tarballs | Separate interactive setup approval; installed pinned base image |
| `report show|compare` | None | — |
| `report export --review` | None | Interactive review; hardware and model source are opt-in |
| `report submit` | Registry, authenticated POST | Separate upload approval; keychain token with `tests:submit` and `builds:write` |
| `contribution review <draft>` | Registry GET | Token; prints the browser approval URL (opens it only with `--open`) |

There is no `--yes`, no telemetry, no update check, and no background service.

`mcp add` offers only clients whose native command was exercised (2026-10-14,
against staging, each with a throwaway configuration directory):

- **Claude Code 2.1.299:** `claude mcp add --transport http --scope user
  localfirst <url>` adds the server, and `claude mcp get` then reports it as
  needing authentication, so the application has found the registry's OAuth.
  The built CLI ran this end to end in a pseudo-terminal, with the interactive
  "yes". Signing in through `/mcp` was not exercised.
- **Codex CLI 0.153.4:** `codex mcp add localfirst --url <url>` writes the
  server and immediately starts its own OAuth sign-in: it registers a client
  through dynamic registration and waits for the browser. The CLI therefore
  runs client commands attached to the terminal, without a timeout. The
  sign-in itself was not completed.
- **Gemini CLI 0.64.0:** `gemini mcp add --transport http --scope user
  localfirst <url>` writes the server to `~/.gemini/settings.json` (isolated
  home, fake registry, 2026-10-16). Connection and `/mcp auth` were not
  exercised.

- **GitHub Copilot CLI (`@github/copilot`):** `copilot mcp add --transport http
  localfirst <url>` writes `mcpServers.localfirst` to the user config and
  `copilot mcp list` shows it (isolated home, fake registry, 2026-10-16). Sign-in
  and tool calls were not exercised.

VS Code, Cursor, OpenCode, Windsurf and Cline are not run: none has a
non-interactive command to add a remote server (OpenCode's `mcp add` is an
interactive wizard), so `mcp add --client <name>` prints the entry in that
client's documented format and edits nothing. The formats come from each
vendor's documentation (VS Code `servers` + `type: http`; Cursor `url`; OpenCode
`mcp` + `type: remote`; Windsurf `serverUrl`; Cline `type: streamableHttp`) and
were not tried in the applications. Windsurf documentation is migrating to
Devin Desktop, so its file location is not stated.

The Cursor and VS Code install links use the formats Stripe publishes at
`docs.stripe.com/mcp` (checked 2026-10-16); unit tests pin them to Stripe's own
links apart from the server name. Neither editor was opened to follow a link.

Claude (claude.ai and Claude Desktop) and ChatGPT are hosted apps with no file or
command: the person adds the server by URL in the app's settings, so
`mcp add --client claude-desktop|chatgpt` prints the verified URL and the steps
(from Anthropic's custom-connector page and OpenAI's custom MCP server page, read
2026-10-16) and changes nothing. **Both register themselves with dynamic client
registration, which is off by default (`FEATURE_DYNAMIC_CLIENT_REGISTRATION`),
and this backend does not publish a Client ID Metadata Document.** With the flag
on, `test/mcp-hosted-clients.test.ts` shows an https callback registers as a
public PKCE web client and a non-loopback http callback is refused. With it off,
these apps cannot connect. The apps themselves were not run, so sign-in and tool
calls are unverified.

The MCP URL is read from the registry's protected-resource metadata and must be
on the registry's origin. No token passes through the CLI. Claude Desktop
and Zed are not offered: they need their configuration files edited, which was
not verified.

## Source providers

| Provider | Status |
| --- | --- |
| `api.github.com` (public repositories) | Implemented and tested against an injected fake provider: ref resolution, commit pinning, per-file and total size caps, traversal refusal, secret refusal, private-repo refusal, 404/429 classification, binary refusal |
| Arbitrary documentation URLs | **Never fetched.** Stored as references with `source_visibility: not_checked` |

The opt-in `verify:github` check exercises real public GitHub responses:
`octocat/Hello-World` README refusal (`FRONTMATTER_MISSING`), a missing manifest
(404), and a `microsoft/vscode` directory refusal. Successful import of a valid
public contract bundle and live rate-limit behaviour remain unverified without
a public fixture/observed provider limit. Injected tests additionally cover
malformed metadata, symlinks, encoding/size/path inconsistencies, and chunked
response cancellation at the size cap.
