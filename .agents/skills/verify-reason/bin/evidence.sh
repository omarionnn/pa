#!/usr/bin/env bash
# An evidence folder with its provenance already in it, and a way to run commands into it.
#
# Usage:
#   dir=$(bin/evidence.sh new location-share)      makes the folder, prints its path
#   bin/evidence.sh run "$dir" 03-peek-thread -- bin/peek.sh thread
#
# `run` writes the exact command, its stdout+stderr and its exit code side by side, so a proof says
# what was asked as well as what came back. Evidence is never removed by cleanup.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$SKILL/../../.." && pwd)"
RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"

case "${1:-}" in

new)
  slug="${2:-run}"
  dir="$SKILL/evidence/$(date -u +%Y%m%dT%H%M%SZ)-$slug"
  mkdir -p "$dir"
  {
    echo "slug:        $slug"
    echo "when (UTC):  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "repo:        $REPO"
    echo "HEAD:        $(git -C "$REPO" log -1 --format='%H %s')"
    echo "dirty:       $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') uncommitted file(s)"
    git -C "$REPO" status --porcelain | sed 's/^/             /'
    echo "node:        $(node -v)"
    echo "caged pid:   $(cat "$RUN/pid" 2>/dev/null || echo '(none)')"
    echo "caged port:  $(cat "$RUN/port" 2>/dev/null || echo '(none)')"
    echo "caged db:    $RUN/reason.db"
  } > "$dir/00-provenance.txt"
  echo "$dir"
  ;;

run)
  dir="${2:?usage: evidence.sh run <dir> <name> -- cmd…}"
  name="${3:?usage: evidence.sh run <dir> <name> -- cmd…}"
  shift 3
  [ "${1:-}" = "--" ] && shift
  [ -d "$dir" ] || { echo "no such evidence dir: $dir" >&2; exit 1; }
  printf '%q ' "$@" > "$dir/$name.cmd"; echo >> "$dir/$name.cmd"
  cd "$SKILL"
  set +e
  "$@" > "$dir/$name.out" 2>&1
  code=$?
  set -e
  echo "$code" > "$dir/$name.exit"
  echo "--- $name (exit $code) → $dir/$name.out"
  tail -40 "$dir/$name.out"
  exit 0
  ;;

*) echo "usage: evidence.sh new <slug> | evidence.sh run <dir> <name> -- cmd…" >&2; exit 2 ;;
esac
