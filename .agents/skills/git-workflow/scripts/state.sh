#!/usr/bin/env bash
# Read-only Git state report for the git-workflow skill. Changes nothing.
set -u
PERM="main staging dev"
echo "branch:   $(git branch --show-current)"
echo "upstream: $(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo none)"
echo "--- working tree"
git status --short | sed 's/^/  /'
[ -z "$(git status --porcelain)" ] && echo "  clean"
echo "--- worktrees"
git worktree list | sed 's/^/  /'
echo "--- permanent branches (remote)"
for b in $PERM; do
  git rev-parse --verify -q "origin/$b" >/dev/null || { echo "  $b: MISSING on origin"; continue; }
  echo "  $b @ $(git rev-parse --short "origin/$b")"
done
for pair in "dev staging" "staging main"; do
  set -- $pair
  git rev-parse --verify -q "origin/$1" >/dev/null && git rev-parse --verify -q "origin/$2" >/dev/null || continue
  read -r behind ahead < <(git rev-list --left-right --count "origin/$2...origin/$1")
  if [ "$behind" = 0 ] && [ "$ahead" = 0 ]; then rel="in sync"
  elif [ "$behind" = 0 ]; then rel="$1 is $ahead ahead (promotable)"
  elif [ "$ahead" = 0 ]; then rel="$1 is $behind behind (ancestor of $2)"
  else rel="DIVERGED ($ahead only in $1, $behind only in $2) - stop and ask"; fi
  echo "  $1 vs $2: $rel"
done
