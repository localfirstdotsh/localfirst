# Author and publish a project

A project is `PROJECT.md`: YAML frontmatter plus a Markdown body. The frontmatter is parsed
defensively: no anchors, aliases, custom tags or merge keys, bounded nesting, and timestamps must
be quoted strings.

## Workflow

1. **Inspect with permission.** Read only the project files and hardware notes the user has
   authorised. Propose the spec; mark unknown or conflicting facts as unknown.
2. **Read the live schema** (see SKILL.md) and the closest published project through `project_get`.
3. **Create the draft** with `contribution_create_draft`: either the `PROJECT.md` and files
   directly, or a bounded import descriptor for a public GitHub source. Pass an idempotency key.
   The result carries the draft ID, revision and a review URL.
4. **Validate.** `draft_validate` with the current `expected_revision`. Fix every issue with
   `draft_update`, which returns a new revision and digest. Validation only inspects; nothing runs.
5. **Hand over for approval, unless delegated.** `draft_get` returns `publication_delegated`. If it
   is true, the user lets this connection publish without asking: go to step 6. Otherwise give the
   user the review URL to approve in their browser
   (`localfirstdotsh contribution review <draft-id> --open` opens it from a terminal). Wait. Do not poll for approval in a loop and do not ask the user to approve on your
   behalf.
6. **Publish.** `contribution_publish` with the draft ID, approval ID, revision, digest and a new
   idempotency key. Approval is single use and short lived; if it has expired or the revision
   changed, return to step 5. Under delegation, omit the approval ID and pass
   `acknowledged_warning_codes` with every warning on the draft, then tell the user what you
   published, which warnings you accepted, and that they can unpublish it.

## Rules

- Versions are immutable. A change is a new version, and a derived work is a new project through
  `project_create_derivative_draft`, with attribution and no inherited evidence.
- Do not claim a test result in the spec's `evidence` field. Evidence comes from submitted,
  operator-reviewed reports.
- Every limitation the validator warns about needs the user's explicit acknowledgement at approval.
  Under delegation you acknowledge them yourself, so only do so for limitations the user would
  accept, and report each one.
- Scopes: drafts need `projects:draft`, publishing `projects:publish`, updates `projects:update`.
  Request the minimum for the operation.
