#!/usr/bin/env bash
# A caged Reason, for verification.
#
# Reason's primary surface is somebody's real iMessage thread. Driving the LIVE instance means
# texting a real phone. So verification runs its own instance with:
#
#   - its own port and its own SQLite file, so nothing touches data/reason.db
#   - every texting credential blanked, so both channel adapters report not_connected and a send
#     fails loudly in the log instead of reaching a person
#   - every call credential blanked, so no tool can ring anybody; the two ElevenLabs INBOUND secrets
#     (custom-LLM bearer, post-call webhook) are set to the cage's own secret instead, so
#     bin/call-turn.sh can drive a call turn here and nothing signed for the live install gets in
#
# It runs serve.js with `--log`, which is the only thing that turns the router's own decision log
# on (src/serve.js:33). Without it `log` is a no-op and every routing decision is invisible —
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
  mkdir -p "$RUN" "$RUN/images" "$RUN/profiles" "$RUN/shots" "$RUN/data"
  cd "$REPO"
  # Its own session, so it outlives the shell that started it. An agent's command runner kills the
  # whole process group when one command ends: on 2026-10-23 the cage came up, answered doctor, and
  # was gone by the next command, and every drive after it was ECONNREFUSED. macOS has no setsid(1);
  # perl's POSIX::setsid then exec keeps the pid, so $! below is still the server's — but only because
  # every step execs: the backgrounded function's subshell into perl, perl into env, env into node.
  # The API backend, not the CLI, unless REASON_VERIFY_BACKEND says otherwise. This Mac's `claude` is
  # logged in to the SAME subscription live Reason runs on; on 2026-10-20 sixteen verification turns
  # through it spent the shared 5-hour limit and live Reason was down from 10:58 AM to 3 PM ET.
  # Reason's paid API key is blanked too (2026-10-25, #115: no verification spends it), so a model
  # turn here has no model unless REASON_VERIFY_ALLOW_API=1 says, on purpose, to spend the key.
  KEY=(ANTHROPIC_API_KEY=); [ "${REASON_VERIFY_ALLOW_API:-}" = 1 ] && KEY=()
  # REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:<port>: sendblue reads `live` with fake keys and
  # every Sendblue request goes to bin/fake-sendblue.mjs on this Mac — the only way to drive the
  # outbox's own failure paths (features/ops-alerts.md). Loopback only; nothing leaves the machine.
  FAKE_SB=()
  if [ -n "${REASON_VERIFY_FAKE_SENDBLUE:-}" ]; then
    [[ "$REASON_VERIFY_FAKE_SENDBLUE" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] \
      || { echo "REASON_VERIFY_FAKE_SENDBLUE must be http://127.0.0.1:<port>" >&2; exit 1; }
    FAKE_SB=(SENDBLUE_API_KEY_ID=cage-fake SENDBLUE_API_SECRET_KEY=cage-fake SENDBLUE_FROM_NUMBER=+12025550101
             SENDBLUE_API_BASE="$REASON_VERIFY_FAKE_SENDBLUE")
  fi
  # A checkout with no REASON_MASTER_NUMBER in .env (a fresh worktree has no .env at all) has no owner,
  # so bin/inbound.sh's text — sent as REASON_VERIFY_OWNER — landed as a stranger and became an access
  # request (`asked_master_about`, 2026-11-06). The cage's owner is then the documentation number
  # owner_number falls back to. A .env that names one is left alone.
  MASTER=(); grep -qE '^REASON_MASTER_NUMBER=.' "$REPO/.env" 2>/dev/null || MASTER=(REASON_MASTER_NUMBER="$(owner_number)")
  detach() { if command -v setsid >/dev/null 2>&1; then exec setsid "$@"; else exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' "$@"; fi; }
  detach env ${KEY[@]+"${KEY[@]}"} \
    REASON_PORT="$PORT" \
    REASON_HOST=127.0.0.1 \
    REASON_BACKEND="${REASON_VERIFY_BACKEND:-api}" \
    REASON_DATA_DIR="$RUN/data" \
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
    ELEVENLABS_LLM_SECRET="$SECRET" \
    ELEVENLABS_WEBHOOK_SECRET="$SECRET" \
    REASON_USAGE_INGEST_SECRET="$SECRET" \
    BLAND_API_KEY= \
    AGENTCARD_CLIENT_ID= \
    AGENTCARD_CLIENT_SECRET= \
    AGENTCARD_WEBHOOK_SECRET= \
    REASON_TOKEN_KEY="$(cat "$RUN/token-key" 2>/dev/null || (umask 077; openssl rand -hex 32 | tee "$RUN/token-key"))" \
    UBER_CLIENT_ID= \
    UBER_CLIENT_SECRET= \
    ${FAKE_SB[@]+"${FAKE_SB[@]}"} \
    ${MASTER[@]+"${MASTER[@]}"} \
    node --env-file-if-exists=.env src/serve.js --log < /dev/null > "$RUN/serve.log" 2>&1 &
  echo $! > "$RUN/pid"
  echo "$PORT" > "$RUN/port"
  # Where this cage's Sendblue really goes, so doctor can tell the loopback fake from real keys.
  if [ -n "${REASON_VERIFY_FAKE_SENDBLUE:-}" ]; then echo "$REASON_VERIFY_FAKE_SENDBLUE" > "$RUN/fake-sendblue"; else rm -f "$RUN/fake-sendblue"; fi
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
  # The data dir too: page cards, previews and illustrations are written under it (src/pages/card.js,
  # preview.js), and without this a caged page landed in the checkout's real data/cards.
  echo "REASON_DATA_DIR=$RUN/data"
  echo "REASON_DB_PATH=$RUN/reason.db"
  echo "REASON_IMAGEN_OUTPUT=$RUN/images"
  echo "REASON_PROFILE_ROOT=$RUN/profiles"
  echo "REASON_SHOT_ROOT=$RUN/shots"
  echo "REASON_PORT=$(cat "$RUN/port" 2>/dev/null || echo "$PORT")"
  echo "REASON_VERIFY_SECRET=$(cat "$RUN/secret" 2>/dev/null || echo "$SECRET")"
  echo "REASON_VERIFY_OWNER=$(cat "$RUN/owner" 2>/dev/null || owner_number)"
  # The cage's own throwaway token key (src/secretbox.js). Without it an in-process drive takes
  # REASON_TOKEN_KEY from .env, and a cage database holding sealed token rows will not open.
  [ -f "$RUN/token-key" ] && echo "REASON_TOKEN_KEY=$(cat "$RUN/token-key")"
  for v in SENDBLUE_API_KEY_ID SENDBLUE_API_SECRET_KEY SENDBLUE_FROM_NUMBER LINQ_API_KEY LINQ_WEBHOOK_SECRET \
           ELEVENLABS_API_KEY BLAND_API_KEY AGENTCARD_CLIENT_ID AGENTCARD_CLIENT_SECRET AGENTCARD_WEBHOOK_SECRET \
           UBER_CLIENT_ID UBER_CLIENT_SECRET; do
    echo "$v="
  done
  # Reason's paid API key, as the server above (#115): an in-process drive spends nothing either.
  [ "${REASON_VERIFY_ALLOW_API:-}" = 1 ] || echo "ANTHROPIC_API_KEY="
  # The cage's own secrets for the two ElevenLabs inbound routes, never the real ones: bin/call-turn.sh
  # drives the custom-LLM endpoint with this bearer, and a request signed for the live install fails.
  echo "ELEVENLABS_LLM_SECRET=$(cat "$RUN/secret" 2>/dev/null || echo "$SECRET")"
  echo "ELEVENLABS_WEBHOOK_SECRET=$(cat "$RUN/secret" 2>/dev/null || echo "$SECRET")"
  # And for the Mac's subscription push (POST /ops/usage): signed with the cage's secret, never live's.
  echo "REASON_USAGE_INGEST_SECRET=$(cat "$RUN/secret" 2>/dev/null || echo "$SECRET")"
  ;;

*)
  echo "usage: caged.sh start | stop | status | env" >&2
  exit 2
  ;;
esac
