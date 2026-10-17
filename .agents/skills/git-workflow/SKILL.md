---
name: git-workflow
description: Git lifecycle for this repo — creating task branches, committing and pushing finished work, opening PRs to dev, promoting dev to staging and staging to main, hotfixes, resolving branch divergence, and verifying repo sync. Use whenever you commit, push, branch, open or update a PR, prepare a release, or check Git status. Authoritative for all Git operations here.
---

# Git workflow

Scope: Git lifecycle only. Nothing here describes how to write code, what to build, or how to deploy.

## Branches

| Branch | Role | Receives |
|---|---|---|
| `main` | Production (default branch) | `staging` via release PR; authorized hotfixes |
| `staging` | Preproduction / QA and integration checks | `dev` via release PR |
| `dev` | Integration branch for completed development work | task branches via PR |

`main`, `staging`, `dev` are permanent: never delete, reset, or force-push them. They map to the
development / staging / production environment separation required by `BACKEND_PRD.md` §
"Operational readiness" (separate issuers, OAuth apps, keys, databases and callbacks per environment).

Task branches are short-lived: `feature/`, `fix/`, `refactor/`, `chore/`, `hotfix/` + kebab-case
description (e.g. `feature/project-manifest-digest`).

Promote with PRs and ordinary merge commits — no rebase or force on promotions, so the three
permanent histories stay related and comparable.

## GitHub account

This repo lives in the `localfirstdotsh` GitHub organization (`localfirstdotsh/localfirst`) and is
owned by the **`RidwanG206`** account. Any other GitHub account gets "Repository not found" on
fetch/push/PR. Before any remote operation:

```sh
gh auth status                       # check the active account
gh auth switch --user RidwanG206     # if it is not active
```

Git over HTTPS uses `gh auth git-credential`, so one switch covers both `git` and `gh`.

## Start a task

1. `git fetch origin && .agents/skills/git-workflow/scripts/state.sh` — review branch, dirty files,
   ahead/behind, worktrees.
2. Branch from the latest `origin/dev`: `git switch -c feature/<desc> origin/dev`
   (hotfix only: from `origin/main`).
3. If another agent may be working — other worktrees listed, or a dirty tree that is not yours — use
   an isolated worktree instead of sharing the checkout:
   `git worktree add ../localfirst-<desc> -b feature/<desc> origin/dev`.
   Never touch, stage, stash, commit, or clean changes you did not make.

## Finish a task (commit → push → PR)

1. `scripts/state.sh`; confirm you are on your own task branch, not a permanent one.
2. `git status` + `git diff`: every change must belong to this task. Changes that do not (including
   another agent's in-flight files) are reported and left alone, not committed.
3. **Run the applicable local checks and record real results** — see "Local checks" below. CI does
   not run automatically while it is suspended, so this is the only gate that exists. A PR opened
   without them is incomplete.
4. Scan for secrets and junk: `.env`, `.env.local`, keys, tokens, `*.log`, `coverage/`, `dist/`,
   `node_modules/`. Never commit them; `.gitignore` is a safety net, not a substitute for looking.
5. Stage explicit paths only — `git add <paths>`, never `-A` or `.`. Review `git diff --cached --stat`.
6. Commit with a Conventional Commit message that says what actually changed:
   `feat|fix|refactor|perf|test|docs|ci|chore(scope): imperative summary`.
   Never "updates", "changes", "fix stuff".
7. `git push -u origin <branch>` — plain push. Never `--force` on a shared branch; `--force-with-lease`
   only on your own task branch and only when you rewrote it yourself.
8. Open or update the PR into `dev`: `gh pr create --base dev` (or `gh pr edit`). Body: summary, the
   checks you actually ran with their results, and risks.
9. Report: commit hash, branch pushed, each check as pass/fail/not-run, and the PR URL.

If a check fails, report the failure and stop — do not commit and push broken work. Commit anyway
only on explicit user approval, and say so in the commit body and the PR. Never state that a check
passed unless it ran and passed. Do not merge your own PR unless asked.

## Local checks

Run these from the repo root before every PR. Report each one as pass, fail, or not-run with the
reason — never as passing unless it ran and passed.

| Scope of your change | Run |
|---|---|
| Any code | `pnpm install --frozen-lockfile`, then the checks for the packages you touched |
| One package | `pnpm --filter @localfirst/<pkg> typecheck`, `... build`, `... test` |
| Multiple packages / unsure | `pnpm check` (= `pnpm build:contracts && pnpm -r typecheck && pnpm -r build && pnpm -r test`) |
| Docs, comments, workflow or skill files only | `pnpm typecheck`, plus `bash -n` on any shell script and `scripts/test.sh` if you changed this skill |

The backend integration suite requires a real PostgreSQL database. Set
`TEST_DATABASE_URL` to a dedicated test database (default:
`postgres://localhost:5432/localfirst_test`); tests apply migrations and truncate
their tables. Never point it at development data or a deployed database.

Record executed checks in commits and PR descriptions, not historical pass/fail
snapshots in this skill. The code and package scripts define the current suite.

There is no `lint` script; `tsc --noEmit` (`typecheck`) is the current static analysis.
When another required check is added, update the package scripts, this table, and
`.github/workflows/ci.yml` in the same change.

## Promotions (each needs separate, explicit authorization)

Finishing a task promotes nothing. `feature/* → dev` is the only flow an agent completes on its own.

**dev → staging** (release candidate)
```sh
git fetch origin
git log --oneline origin/staging..origin/dev      # everything in the release
git diff --stat origin/staging...origin/dev       # shape of the change
```
Call out DB migrations (`backend/drizzle`) and new/changed environment variables; confirm checks are
green on `dev`; then `gh pr create --base staging --head dev`. Merge only after the user authorizes
and required checks pass.

**staging → main** (production)
Confirm staging verification actually passed, review the same log/diff plus migration and env
requirements, then `gh pr create --base main --head staging`. Merge only on explicit authorization
with checks green. Tag `vX.Y.Z` only if the user asks.

**Back-merge** (immediately after every promotion, as part of it)
A promotion PR merges with a merge commit, which exists only on the receiving branch. Without a
back-merge, the next commit on the lower branch makes `state.sh` report `DIVERGED` although no
work differs. So bring the promotion merge commit back down by PR right away:
```sh
gh pr create --base dev --head staging       # after dev -> staging
gh pr create --base staging --head main      # after staging -> main, then staging -> dev again
```
A back-merge changes no files: check that `git diff --stat origin/<lower>...origin/<upper>` (three
dots: what the upper branch changed since the two last met) is empty before opening it, and say so in
the PR. A two-dot diff compares the trees and also shows the lower branch's newer work, so it is not
the check. It needs no separate authorization beyond the promotion it
completes. Afterwards `main` is an ancestor of `staging`, and `staging` is an ancestor of `dev`.

**Hotfix**
Branch `hotfix/<desc>` from `origin/main`, PR into `main` (authorization required), then open
follow-up PRs carrying the same fix into `staging` and `dev` — or merge `main` into them via PR — so
no permanent branch silently loses it.

## Divergence and conflicts

- `scripts/state.sh` reports each pair's relationship. "behind / ancestor" is normal and
  fast-forwardable by PR; real `DIVERGED` → stop, document both sides, ask. Never "fix" divergence by
  force-pushing or hard-resetting one branch onto another.
- A `DIVERGED` whose only commits on the upper branch are promotion merge commits that change no
  files is a missed back-merge, not divergent work: report it, and with the user's go-ahead open
  the back-merge PR (see Promotions).
- Update a task branch with `git merge origin/dev` (rebase only while unpushed).
- Resolve conflicts by reading both sides and keeping the intended change from each. Never
  `-X ours`/`-X theirs` wholesale, and never `checkout --ours/--theirs` or discard a file to make a
  conflict disappear. Re-run the checks after resolving.
- Failed CI: read it (`gh run view --log-failed`), fix on the task branch, push again. Never bypass,
  re-run to "get lucky", or relabel a required check.

## Prohibited

- Deleting or force-pushing `main`, `staging`, or `dev`.
- `git reset --hard`, `git clean`, `git checkout -- .`, `git stash drop`, or branch deletion that
  could lose work that is not safely merged, or that belongs to another worktree or agent.
- Committing another agent's unfinished changes.
- Auto-merging to `staging` or `main`, or promoting as part of finishing an ordinary task.
- Bypassing failed required checks, or `--no-verify`.
- Resolving merge conflicts by discarding changes.
- Changing the default branch or other GitHub settings without authorization.
- Committing secrets, credentials, build output, or unrelated files.

If an operation could destroy history or lose existing work, stop and offer a safe alternative: a new
branch, a revert commit, a PR, or `git stash` you created yourself.

`scripts/guard.sh <git args...>` exits non-zero for the prohibited permanent-branch operations
without running anything — use it to sanity-check a destructive-looking command.

Delete a task branch only after its PR is merged and no worktree still uses it: `git branch -d`
(never `-D`), and `git worktree remove` first.

## CI/CD status (suspended for MVP)

GitHub Actions is **suspended for the MVP development phase**. `.github/workflows/ci.yml` still
exists with its full `check` job, but its `pull_request` and `push` triggers are commented out, so
only `workflow_dispatch` is active:

```sh
gh workflow run ci.yml --ref <branch>     # manual run, when you want it
gh run watch                              # follow it
```

Consequences to respect:

- **No new automatic status check reports on a PR, and none may be required.** Historical failed
  checks can remain on older PRs; inspect their reason and run the local gate. Do not add a required
  status check, and do not wait for or claim a CI result that was never produced.
- The local checks above are the entire gate. Run them; report them honestly.
- Nothing else changes: feature branches still cut from `dev` and PR into `dev`, and promotion to
  `staging` or `main` still needs explicit authorization.

GitHub Actions also cannot execute on this account right now for a separate reason — runs are
rejected with "recent account payments have failed or your spending limit needs to be increased" —
so even a manual `workflow_dispatch` run will not start until billing is resolved.

### Restoring CI/CD

When the MVP is ready, in one PR:

1. Uncomment the `pull_request` and `push` blocks under `on:` in `.github/workflows/ci.yml`, keeping
   `workflow_dispatch`.
2. Resolve the account billing / spending-limit problem, or Actions still will not run.
3. Run `pnpm install --frozen-lockfile` and `pnpm check` against the dedicated test database.
   Keep the workflow's PostgreSQL service and `TEST_DATABASE_URL` configuration aligned with it.
4. Open the PR and confirm the `check` job actually goes green on it.
5. Only then require `check` as a status check and restore the "Local checks" step to its normal role
   as a pre-PR habit rather than the sole gate.
6. Remove the suspension notes from this section, the header comment in `ci.yml`, and `AGENTS.md`.

Deployment is a separate, later step: no deployment environments or deploy jobs exist in this repo,
so restoring CI restores checks only. Do not describe any merge as deploying anything.

## GitHub protection (current status)

`localfirstdotsh/localfirst` is a public repo with the ruleset **`permanent-branches` active** on `main`,
`staging` and `dev` (applied by the owner, 2026-10-17). It blocks deleting them, blocks non-fast-forward
(force) pushes, and requires a pull request with no bypass actors, so even the owner cannot push to them
directly. Only **merge commits** are allowed for PRs into these branches, because promotions must keep
the three histories related. Review count is 0 (a solo owner can merge), and **no status check is
required** while CI is suspended.

`reference/ruleset.json` is the intended ruleset including the `check` status check. To restore it as
step 5 of "Restoring CI/CD" above, edit the live ruleset to add the `check` required status check:

```sh
gh api repos/localfirstdotsh/localfirst/rulesets                # find the id of permanent-branches
gh api -X PUT repos/localfirstdotsh/localfirst/rulesets/<id> --input .agents/skills/git-workflow/reference/ruleset.json
```
