# Discover and check fit

1. `project_search` with the narrowest filters you know: task category, model, runtime, hardware,
   OS, `evidence_level`. Results are visible public records only and are paged by cursor.
2. `project_get` by ID or slug, optionally with a version. It returns the spec, provenance, links
   to models, runtimes and hardware, and whether a test is declared and runnable.
3. `project_check_compatibility` against what the user shares. Send only the minimal environment
   or model summary the user has agreed to share. It never probes the machine, and an
   "incompatible" assessment is a normal result, not an error.

## Reading the answer

- Evidence levels run `documented` < `community_reported` < `reproducible_test` <
  `independently_verified`. Only an operator can raise a level above `documented`. Say which level
  a claim has; do not describe a documented claim as tested.
- `runner_available` is true only for test definitions the first-party runner can execute. A
  declared harness may still be unrunnable.
- Hardware and model figures in a spec are creator claims until evidence says otherwise.
- Resources are available for citing exact content: `localfirst://projects/{project_id}/versions/{version_id}/manifest`
  and `.../documentation`.
