---
name: localfirst
description: Work with the Localfirst.sh registry of portable local-AI projects. Use to search or read published projects, check whether a project fits a user's model, runtime and hardware, author and publish a PROJECT.md (localfirst/project spec), plan or run a local test, or submit a test report. Covers the hosted MCP tools, the localfirstdotsh CLI, and the human approval boundary.
---

# Localfirst

Localfirst is a registry of portable local-AI project specifications (`PROJECT.md`) with evidence
from tests that ran on real machines. You reach it through two separate surfaces:

| Surface | What it does | Where it runs |
|---|---|---|
| Hosted MCP server (`/mcp`) | Search, read, check compatibility, draft, validate, publish | The registry. It never runs inference or code. |
| `localfirstdotsh` CLI | Discover a local runtime, plan and run tests, export and submit reports, approve a draft | The user's machine, after local approval. |

The registry URL is deployment-specific. Take it from the user's MCP configuration or
`LOCALFIRST_REGISTRY`; do not guess one.

## Hard boundaries

These are enforced by the server and the CLI. Do not try to work around them, and tell the user
plainly when one blocks the task.

1. **A person authorizes publication.** You may prepare, edit, validate and publish a draft. Either
   the user approves the exact revision and digest in their browser, or they have turned on
   "Publish without asking" for this connection, which `draft_get` reports as `publication_delegated: true`. You cannot grant
   either, and there is no `--yes`. Any edit after approval revokes it.
2. **Nothing executes on the registry.** There is no hosted run, runtime-discovery or code tool.
   Tests run only through the local CLI, after the user approves the exact plan.
3. **Read access is not execution access.** A read scope never lets you run a model, change a
   runtime, or install anything.
4. **Never invent facts.** Mark an unknown or conflicting model, runtime, hardware or license fact
   as unknown in the spec. A declared claim is not tested evidence.
5. **Keep credentials local.** Runtime endpoint tokens and GitHub tokens are never registry
   bearer tokens. Do not put secrets, private paths or private data in a draft or report.

## Choose the task

| The user wants to | Read |
|---|---|
| Find a project, read its spec, or check fit for their machine | [references/discover.md](references/discover.md) |
| Write, validate and publish a project | [references/publish.md](references/publish.md) |
| Run a test locally and share the result | [references/local-testing.md](references/local-testing.md) |
| Connect an agent to the registry | [references/connect.md](references/connect.md) |

Read only the file for the task in front of you.

## Ground truth over memory

Do not rely on remembered field names or limits. Before authoring, read the live schema: the MCP
resource `localfirst://schemas/project/v0.2`, or `GET /schemas/project/v0.2.json` on the registry.
Version `localfirst/project/v0.3` adds agent environments and workflow tests; the registry states
which versions it accepts. Run `draft_validate` and fix every reported issue instead of guessing.

## Tool inventory

Tools are named with underscores. A tool that is absent from `tools/list` is disabled on that
deployment, so do not assume one exists.

- Read: `project_search`, `project_get`, `project_check_compatibility`, `test_get`, `test_plan_local`,
  `environment_get`, `environment_plan_local`, `build_get`, `build_get_evidence`, `test_get_result`
- Author: `contribution_create_draft`, `draft_get`, `draft_update`, `draft_validate`, `contribution_publish`
- Evidence: `build_save`, `test_submit_result`
- Community and lineage: `project_create_derivative_draft`, `project_get_derivatives`,
  `comparison_get_groups`, `reference_get_relationships`, `community_save`, `community_list`,
  `test_get_verifications`

Mutating calls take an idempotency key. A draft update takes `expected_revision`. Reuse the same
key only to retry the same request.

## Reporting

Report what happened, not what was intended: IDs returned, validation issues remaining, whether
approval is still pending, and which steps the user must perform themselves.
