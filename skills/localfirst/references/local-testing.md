# Run a test locally and share the result

The CLI is the npm package `localfirstdotsh` (`runner/` in this repository). It is not yet
published to npm, so build it from the repository unless the user says it is installed. Run
`localfirstdotsh help` for the current command list; it is the source of truth. The registry comes
from `--registry` or `LOCALFIRST_REGISTRY`; there is no default.

## Flow

1. `localfirstdotsh runtime discover --runtime ollama|lmstudio` finds the local runtime and its
   installed models. Endpoints must be loopback.
2. `localfirstdotsh test plan <project-id> --test <key> --runtime <family> --model <id>` builds a
   plan from the registry's public test definition. `test_plan_local` over MCP returns the same
   requirements without touching the machine.
3. `localfirstdotsh test run <plan-file>` shows the exact plan, model, settings, data class and
   resource effects, then waits for the user's approval. **Never answer that prompt for the user.**
4. `localfirstdotsh report show <report>` to read the outcome. `report compare` compares two reports.
5. To share: `report export <report> --review`, let the user read the exported file, then
   `report submit <export-file>`. Upload is off by default. A submitted report is private and
   pending until an operator accepts it.

## Agent environments (v0.3 projects)

`environment samples`, `environment prepare`, `environment plan`, `environment run` and
`environment remove` handle fixed multi-agent environments in a prepared workspace. The same
approval rule applies, and handoff and workflow writes may be disabled on a deployment.

## Rules

- The CLI sends no telemetry, makes no update checks and runs no background service. Do not add any.
- A failed or partial run is still a result: report it as it is.
- Sanitise before export. Private inputs and model outputs stay local unless the user includes them
  deliberately (`--include-private` on a trace is a separate choice).
