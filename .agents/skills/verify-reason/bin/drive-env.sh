#!/bin/bash
# Keys for a drive without putting them on a command line (2026-11-08: a drive run as
# `env -i … OPENAI_API_KEY=<key> node …` showed both keys to every user via `ps`).
# Copies only the named variables from an env file (default /opt/reason/.env, override with
# REASON_ENV_FILE) into a new 0600 file owned by whoever runs this, and prints its path.
# Values pass through grep's stdout into the file, never argv. Run as the user the drive runs as:
#
#   E=$(sudo -u reason .agents/skills/verify-reason/bin/drive-env.sh OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN)
#   sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason REASON_DB_PATH=$(sudo -u reason mktemp -d)/q.db \
#     node --env-file="$E" .agents/skills/verify-reason/bin/<drive>.mjs …; rm -f "$E"
set -euo pipefail
SRC=${REASON_ENV_FILE:-/opt/reason/.env}
[ $# -gt 0 ] || { echo "usage: drive-env.sh NAME [NAME…]  (names only, never values)" >&2; exit 2; }
for n in "$@"; do [[ "$n" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "not a variable name: $n" >&2; exit 2; }; done
OUT=$(umask 077; mktemp "${TMPDIR:-/tmp}/drive-env.XXXXXX")
pat="^($(IFS='|'; echo "$*"))="
grep -E "$pat" "$SRC" > "$OUT" || true
for n in "$@"; do grep -q "^$n=" "$OUT" || echo "drive-env: $n not in $SRC" >&2; done
echo "$OUT"
