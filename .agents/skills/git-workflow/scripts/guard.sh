#!/usr/bin/env bash
# Usage: guard.sh <git args...>  — exit 1 if the command would delete, force-push,
# or hard-reset a permanent branch. Never runs the command. Sanity check, not a gate.
cmd=" $* "
perm='(main|staging|dev)'
deny() { echo "REFUSED: $1" >&2; exit 1; }
case "$1" in
  push)
    if echo "$cmd" | grep -Eq -- ' (--force|-f|--force-with-lease[^ ]*|--mirror|--delete|-d) '; then
      echo "$cmd" | grep -Eq -- "(^| |:|\+|refs/heads/|origin/)$perm( |$)" && deny "force/delete push touching a permanent branch"
      echo "$cmd" | grep -Eq -- ' (--mirror|--force|-f) ' && [ "$#" -le 2 ] && deny "force push without an explicit task branch"
    fi
    echo "$cmd" | grep -Eq -- " :$perm | \+[^ ]*$perm " && deny "refspec delete/force of a permanent branch"
    ;;
  branch)
    echo "$cmd" | grep -Eq -- ' (-d|-D|--delete|-m|-M) ' && echo "$cmd" | grep -Eq -- " $perm " && deny "delete/rename of a permanent branch"
    ;;
  reset)
    echo "$cmd" | grep -q -- '--hard' && case "$(git branch --show-current 2>/dev/null)" in main|staging|dev) deny "hard reset on a permanent branch";; esac
    ;;
esac
exit 0
