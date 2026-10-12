#!/usr/bin/env bash
# A caged Reason, for verification.
#
# Reason's primary surface is somebody's real iMessage thread. Driving the LIVE instance means
# texting a real phone. So verification runs its own instance with:
#
#   - its own port and its own SQLite file, so nothing touches data/reason.db
#   - every texting credential blanked, so both channel adapters report not_connected and a send
#     fails loudly in the log instead of reaching a person
#   - every call credential blanked, so no tool can ring anybody
#
# It runs serve.js with `--log`, which is the only thing that turns the router's own decision log
# on (src/serve.js:25). Without it `log` is a no-op and every routing decision is invisible —
# `auto_admitted`, `duplicate`, `not_served`, `blocked`, `asked_master_about` — so a drive that
# took a different branch than you think looks identical to one that worked. It does NOT set
# REASON_LOG_CONTENT: message bodies stay out of the log, and `bin/peek.sh thread` is where to
# read them.
#
# The model is NOT faked: the real brain runs, the real tool loop runs, the real database is
# written. Only the ways out of the machine are cut.
#
# Usage:  caged.sh start | stop | status | env
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"
PORT="${REASON_VERIFY_PORT:-8796}"
SECRET="${REASON_VERIFY_SECRET:-probe-secret}"

# The owner's own number, read from .env rather than written down here — this skill lives in a
# public repo. Falls back to a documentation number if .env has none.
owner_number() {
  local n=""
  [ -f "$REPO/.env" ] && n="$(grep -E '^REASON_MASTER_NUMBER=' "$REPO/.env" | head -1 | cut -d= -f2- | tr -d '"'\''' | tr -d '[:space:]')"
  echo "${n:-+12025551234}"
}

case "${1:-}" in

start)
  if [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then
    echo "already running: pid $(cat "$RUN/pid") on port $(cat "$RUN/port")" >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT is taken by something else — set REASON_VERIFY_PORT and retry" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
    exit 1
  fi
  rm -rf "$RUN"
  # The images dir has to exist before anything writes into it. The real Imagen providers mkdir it
  # themselves (src/imagen.js:94), so a real generation is fine — but the fake-provider recipe in
  # features/page-images.md writes straight to REASON_IMAGEN_OUTPUT and died with ENOENT on a clean
  # cage until this line existed. Create every root caged.sh names, not just $RUN.
  mkdir -p "$RUN" "$RUN/images" "$RUN/profiles" "$RUN/shots"
  cd "$REPO"
  env \
    REASON_PORT="$PORT" \
    REASON_HOST=127.0.0.1 \
    REASON_DB_PATH="$RUN/reason.db" \
    REASON_PROFILE_ROOT="$RUN/profiles" \
    REASON_SHOT_ROOT="$RUN/shots" \
    REASON_IMAGEN_OUTPUT="$RUN/images" \
    REASON_BURST_QUIET_MS=0 \
    SENDBLUE_API_KEY_ID= \
    SENDBLUE_API_SECRET_KEY= \
    SENDBLUE_FROM_NUMBER= \
    SENDBLUE_WEBHOOK_SECRET="$SECRET" \
    LINQ_API_KEY= \
    LINQ_WEBHOOK_SECRET= \
    ELEVENLABS_API_KEY= \
    BLAND_API_KEY= \
    AGENTCARD_CLIENT_ID= \
    AGENTCARD_CLIENT_SECRET= \
    AGENTCARD_WEBHOOK_SECRET= \
    node --env-file-if-exists=.env src/serve.js --log > "$RUN/serve.log" 2>&1 &
  echo $! > "$RUN/pid"
  echo "$PORT" > "$RUN/port"
  echo "$SECRET" > "$RUN/secret"
  owner_number > "$RUN/owner"

  # Ready is the log line, not a sleep.
  for _ in $(seq 1 60); do
    if grep -q "listening on http://127.0.0.1:$PORT" "$RUN/serve.log" 2>/dev/null; then
      echo "caged Reason up · pid $(cat "$RUN/pid") · port $PORT · data $RUN"
      grep -E "^  (sendblue|linq|console|calls):" "$RUN/serve.log" | sed 's/^/  /'
      exit 0
    fi
    if ! kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then
      echo "it died on startup:" >&2; cat "$RUN/serve.log" >&2; exit 1
    fi
    sleep 0.25
  done
  echo "no 'listening on' line after 15s:" >&2; cat "$RUN/serve.log" >&2; exit 1
  ;;

stop)
  # Kills the pid this script started and nothing else. Never by process name: the owner's live
  # Reason is the same command line.
  if [ ! -f "$RUN/pid" ]; then echo "nothing to stop (no $RUN/pid)"; exit 0; fi
  pid="$(cat "$RUN/pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  port="$(cat "$RUN/port" 2>/dev/null || echo "$PORT")"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 \
    && { echo "port $port still held after kill:" >&2; lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2; exit 1; }
  rm -rf "$RUN"
  echo "caged Reason stopped (pid $pid), port $port free, $RUN removed"
  echo "evidence under .agents/skills/verify-reason/evidence/ is untouched"
  ;;

status)
  if [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then
    echo "running · pid $(cat "$RUN/pid") · port $(cat "$RUN/port") · db $RUN/reason.db"
  else
    echo "not running"
    exit 1
  fi
  ;;

env)
  # For driving tools directly in-process against the caged database.
  #
  # The blanks are here too, and they are not optional. `node --env-file-if-exists=.env` never
  # overrides a variable that is already in the environment — even an empty one — which is the
  # same rule the server above relies on. Without them an in-process `runTool` reads the real
  # .env: on 2026-10-12 a caged `vault_enroll` driven this way minted a REAL production AgentCard
  # session, and a caged `purchase` would have reached a real shop. `export` every line.
  echo "REASON_DB_PATH=$RUN/reason.db"
  echo "REASON_IMAGEN_OUTPUT=$RUN/images"
  echo "REASON_PROFILE_ROOT=$RUN/profiles"
  echo "REASON_SHOT_ROOT=$RUN/shots"
  echo "REASON_PORT=$(cat "$RUN/port" 2>/dev/null || echo "$PORT")"
  echo "REASON_VERIFY_SECRET=$(cat "$RUN/secret" 2>/dev/null || echo "$SECRET")"
  echo "REASON_VERIFY_OWNER=$(cat "$RUN/owner" 2>/dev/null || owner_number)"
  for v in SENDBLUE_API_KEY_ID SENDBLUE_API_SECRET_KEY SENDBLUE_FROM_NUMBER LINQ_API_KEY LINQ_WEBHOOK_SECRET \
           ELEVENLABS_API_KEY BLAND_API_KEY AGENTCARD_CLIENT_ID AGENTCARD_CLIENT_SECRET AGENTCARD_WEBHOOK_SECRET; do
    echo "$v="
  done
  ;;

*)
  echo "usage: caged.sh start | stop | status | env" >&2
  exit 2
  ;;
esac
