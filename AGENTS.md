# Agent instructions

## Git

Load the `git-workflow` skill (`.agents/skills/git-workflow/SKILL.md`) before any branch, commit,
push, PR, release, hotfix, or Git-status task. It is the authoritative Git workflow for this repo.
Claude Code finds the same file at `.claude/skills/git-workflow` (a symlink — one source, no copies).

Summary: permanent branches `main` (production) ← `staging` (preproduction) ← `dev` (integration).
Work on short-lived task branches cut from `dev` (`feature/`, `fix/`, `refactor/`, `chore/`,
`hotfix/`) and PR into `dev`. Never delete or force-push a permanent branch. Promotion to `staging`
or `main` happens only with explicit user authorization, never as part of finishing a task.

This repo lives in the `localfirstdotsh` GitHub organization (`localfirstdotsh/localfirst`), owned by the
`RidwanG206` account; run `gh auth switch --user RidwanG206` before remote operations if it is not the
active one.

## Checks

**GitHub Actions CI runs on every pull request and push to `main`, `staging` and `dev`**
(`.github/workflows/ci.yml`: `pnpm check` plus the packed-tarball smoke test on Linux, Node 22). Its
`check` job is a **required status check** on those branches, and a branch must be up to date with its base
before it can merge. Still run the local checks before opening a PR, and report what CI shows honestly.

`pnpm install --frozen-lockfile`, then `pnpm check` (= `pnpm build:contracts && pnpm -r typecheck &&
pnpm -r build && pnpm -r test`), or the filtered form for the package you touched:
`pnpm --filter @localfirst/<pkg> typecheck|build|test`. The runner and backend resolve
`@localfirst/contracts` from its build output, so run `pnpm build:contracts` first (and again after
editing contracts) before any filtered check; the root `typecheck`, `test` and `check` scripts do it.

Browser tests (`pnpm test:e2e`, Playwright against real servers) are separate from `pnpm check`: they need a
PostgreSQL server and a Chromium download (`pnpm --filter @localfirst/web exec playwright install chromium`),
create and drop their own `localfirst_web_e2e` database, and are not part of the required gate yet.

Backend integration tests require a dedicated PostgreSQL database via `TEST_DATABASE_URL`
(default: `postgres://localhost:5432/localfirst_test`); they migrate and truncate tables. Never
point tests at development or deployed data. Report each executed check honestly in the PR.
The skill's "Local checks" and "Restoring CI/CD" sections are authoritative.

## Documentation

Code and configuration are the source of truth. Record completed work in commits and PR
descriptions, not in Markdown status reports, change logs, or implementation plans. `BACKEND_PRD.md`,
`FRONTEND_PRD.md` and `RESEARCH.MD` are the product specification; update the relevant one in place
rather than adding a new document per feature, fix, or investigation.
