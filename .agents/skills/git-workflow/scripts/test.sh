#!/usr/bin/env bash
# Non-destructive verification of the git-workflow rules. Builds a throwaway repo
# plus a bare "origin" in $TMPDIR and removes them on exit. Touches no real repo.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
expect() { local name=$1 want=$2; shift 2; "$@" >/dev/null 2>&1; [ $? -eq "$want" ] && ok "$name" || bad "$name"; }
g() { git -C "$W" "$@"; }

# --- fixture: origin with main ahead of staging, dev cut from main
git init -q --bare -b main "$T/origin.git"
W="$T/w"; git clone -q "$T/origin.git" "$W" 2>/dev/null
g config user.email t@t; g config user.name t
echo 1 > "$W/a"; g add a; g commit -qm "chore: init"; g push -q origin main
g branch staging; g push -q origin staging
echo 2 > "$W/a"; g commit -qam "feat: second"; g push -q origin main
g branch dev main; g push -q origin dev
cd "$W"

# --- state reporting
echo "$("$S/state.sh")" | grep -q "staging is 1 behind" && ok "state: staging ancestor of main detected" || bad "state: ancestry"
echo "$("$S/state.sh")" | grep -q "dev is 1 ahead (promotable)" && ok "state: dev promotable to staging" || bad "state: promotable"

# --- feature branch from dev, unrelated change detected, push
g switch -qc feature/x origin/dev; echo x > "$W/x"
echo "$("$S/state.sh")" | grep -q '?? x' && ok "state: detects unrelated/untracked change" || bad "state: dirty"
g add x; g commit -qm "feat: add x"; g push -q -u origin feature/x && ok "feature branch pushed from dev" || bad "push feature"

# --- parallel agent in an isolated worktree
g worktree add -q "$T/w2" -b fix/y origin/dev && echo "$("$S/state.sh")" | grep -q "w2" && ok "separate worktree listed" || bad "worktree"
expect "branch delete refused while a worktree uses it" 1 git -C "$W" branch -d fix/y

# --- promotion previews are computable without merging
[ "$(g rev-list --count origin/staging..origin/dev)" = 1 ] && ok "dev->staging release contents computed" || bad "dev->staging diff"
[ "$(g rev-list --count origin/main..origin/staging)" = 0 ] && ok "staging->main shows nothing to promote yet" || bad "staging->main empty release"

# --- conflict surfaces instead of being auto-resolved
g switch -q staging; echo s > "$W/a"; g commit -qam "fix: s"
g switch -q feature/x; echo f > "$W/a"; g commit -qam "fix: f"
g merge -q staging >/dev/null 2>&1
[ -n "$(g diff --name-only --diff-filter=U)" ] && ok "conflict surfaced, not auto-resolved" || bad "conflict"
g merge --abort
g push -q origin staging
echo "$("$S/state.sh")" | grep -q "staging vs main: DIVERGED" && ok "state reports real divergence" || bad "divergence report"
[ -n "$(g diff --stat origin/main...origin/staging)" ] && ok "staging->main release diff computed" || bad "staging->main diff"

# --- dev carries integrated work that production does not
g switch -q dev; echo d > "$W/d"; g add d; g commit -qm "feat: integrated on dev"; g push -q origin dev

# --- hotfix originates from production, not dev
g switch -qc hotfix/z origin/main; echo h > "$W/h"; g add h; g commit -qm "fix: h"
g merge-base --is-ancestor origin/main HEAD && ok "hotfix branch based on main" || bad "hotfix base"
g merge-base --is-ancestor origin/dev HEAD && bad "hotfix must not contain unreleased dev work" || ok "hotfix excludes unreleased dev work"

# --- a missing permanent branch is reported, never silently created
g push -q origin --delete dev
echo "$("$S/state.sh")" | grep -q "dev: MISSING on origin" && ok "state reports a missing permanent branch" || bad "missing branch"
g push -q origin dev

# --- a merge-commit promotion diverges once dev moves on; a back-merge restores ancestry
git init -q --bare -b main "$T/origin3.git"
W3="$T/w3"; git clone -q "$T/origin3.git" "$W3" 2>/dev/null
h() { git -C "$W3" "$@"; }
h config user.email t@t; h config user.name t
echo 1 > "$W3/a"; h add a; h commit -qm "chore: init"; h push -q origin main
h push -q origin main:staging main:dev
h switch -qc dev origin/dev; echo 2 > "$W3/b"; h add b; h commit -qm "feat: b"; h push -q origin dev
h switch -qc staging origin/staging; h merge -q --no-ff -m "Merge dev into staging" origin/dev; h push -q origin staging
h switch -q dev; echo 3 > "$W3/c"; h add c; h commit -qm "feat: c"; h push -q origin dev
(cd "$W3" && "$S/state.sh") | grep -q "dev vs staging: DIVERGED" && ok "promotion merge commit + later dev work reports DIVERGED" || bad "promotion divergence"
[ -z "$(h diff --stat origin/dev...origin/staging)" ] && ok "the upper-only commit changes no files (three-dot)" || bad "promotion merge changed files"
[ -n "$(h diff --stat origin/dev origin/staging)" ] && ok "a two-dot diff still shows dev's newer work, so it is not the check" || bad "two-dot diff"
h merge -q --no-ff -m "Merge staging into dev" origin/staging; h push -q origin dev
(cd "$W3" && "$S/state.sh") | grep -q "dev vs staging: dev is .* ahead (promotable)" && ok "back-merge restores ancestry (dev promotable again)" || bad "back-merge"
cd "$W"

# --- guard refuses destructive permanent-branch operations
for c in "push --force origin main" "push -f origin staging" "push origin :dev" "push origin --delete main" \
         "push --force-with-lease origin dev" "branch -D main" "branch -d staging" "push origin +dev:dev" \
         "branch -m main trunk"; do
  expect "guard refuses: git $c" 1 "$S/guard.sh" $c
done
# --- and allows the same operations on a task branch
for c in "push -u origin feature/x" "push --force-with-lease origin feature/x" "branch -d feature/x" \
         "push origin --delete feature/x" "push origin dev"; do
  expect "guard allows: git $c" 0 "$S/guard.sh" $c
done
g switch -q main
expect "guard refuses hard reset on main" 1 "$S/guard.sh" reset --hard HEAD~1
g switch -q feature/x
expect "guard allows hard reset on a task branch" 0 "$S/guard.sh" reset --hard HEAD~1

echo "== $pass passed, $fail failed"; [ "$fail" = 0 ]
