# localfirstdotsh

Connect Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, VS Code, Cursor, OpenCode, Windsurf, Cline, Claude Desktop, or ChatGPT to a Localfirst registry, discover local model
runtimes, and plan and run bounded local AI tests.

Version 0.1.0 is being prepared for its first npm release. The commands below
become available through npm after publication.

## Requirements

Node.js 22 or newer. For MCP setup, install the selected client (`claude`, `codex`, `gemini`, or `copilot`) and make sure its executable is on your PATH.
The other clients have no non-interactive command for this, so the CLI prints a configuration entry for you to paste.
Local inference requires
Ollama or LM Studio; framework execution additionally requires local Docker.

Verified on macOS (Apple Silicon) with Node.js 26. Linux is expected to work and
Windows is not supported: there is no Windows keychain backend, and the native
client launchers are not run through a shell. MCP clients: Claude Code, Codex CLI,
Gemini CLI and GitHub Copilot CLI were exercised through their own `mcp add`
(registration only; sign-in and tool calls need a deployed registry). VS Code,
Cursor, OpenCode, Windsurf and Cline are configuration-only: each entry follows
that client's documented format but was not tried in the application. Other MCP hosts
use the website's native configuration guides.

## Connect a client

Use the origin of the Localfirst registry you want to connect to:

```sh
npx localfirstdotsh@0.1.0 mcp add --client claude-code --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client codex --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client gemini-cli --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client github-copilot --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client vscode --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client cursor --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client opencode --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client windsurf --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client cline --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client claude-desktop --registry <registry-origin>
npx localfirstdotsh@0.1.0 mcp add --client chatgpt --registry <registry-origin>
```

The registry origin must use HTTPS, or HTTP on loopback for local development.
There is no built-in registry default. Set `LOCALFIRST_REGISTRY` to avoid passing
`--registry` every time.

The CLI reads the registry's MCP metadata and shows the exact native client
command. It changes configuration only after you type `yes` in an interactive
terminal. The selected client handles browser sign-in. With Claude Code, open
`/mcp` afterwards and sign in; Codex starts sign-in during setup. Gemini uses
`/mcp auth localfirst` inside the client after HTTP registration.

With `vscode`, `cursor`, `opencode`, `windsurf` and `cline` nothing is run or
written: the CLI prints the entry in that client's format and where it goes. For
`cursor` and `vscode` it also prints a one-click install link that the editor asks
you to confirm; the link carries only the server URL.
With `claude-desktop` and `chatgpt` (hosted apps with no file or command) it prints
the verified server URL and the steps to add it as a custom connector. These two
only connect if the registry has dynamic client registration turned on.
Gemini CLI signs in from `/mcp auth <name>`.

Add `--print` to show the native command without running it:

```sh
npx localfirstdotsh@0.1.0 mcp add --client codex --registry <registry-origin> --print
```

## Local testing

```sh
npx localfirstdotsh@0.1.0 help
npx localfirstdotsh@0.1.0 runtime discover --runtime ollama
npx localfirstdotsh@0.1.0 runtime discover --runtime lmstudio
```

Use `help` for project export, test planning, execution, reports, and environment
commands. Planning does not run inference. Execution and report submission have
separate approval steps.

## Build and package from the repository

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:contracts
pnpm --filter localfirstdotsh typecheck
pnpm --filter localfirstdotsh build
pnpm --filter localfirstdotsh test
pnpm --filter localfirstdotsh test:package
pnpm --dir runner pack --pack-destination /tmp
```

`prepack` rebuilds contracts and the runner. The compiled contracts are included
under `dist/contracts`; no separately published workspace package is required.
`test:package` packs and installs a tarball in a temporary directory with npm,
then checks the installed CLI, library types, and framework assets. It requires
access to the public npm registry for runtime dependencies.

## License

MIT. See [LICENSE](./LICENSE).
