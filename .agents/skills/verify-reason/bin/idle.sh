#!/usr/bin/env bash
# Is live Reason idle enough to restart? Read-only. Exit 0 = idle, 1 = busy (with why), 2 = could not tell.
#
# Busy is not only a call that is up. Call 57 (2026-10-31) ended at 19:33:54 and a deploy restarted the
# service at 19:34:06: the line was down, so it looked idle, but the turn sending the summary and the
# audio was still running and died with the process. So a call is busy until its after-call steps are
# finished: live (placing/ringing/in_progress), ended under 2 minutes ago, or begun and not finished
# (settle_started_at without settled_at, under 10 minutes old).
#
# Usage:  idle.sh            once
#         idle.sh --wait     poll every 15 s until idle (gives up after 20 minutes, exit 1)
set -u
HOST="${REASON_LIVE_SSH:-root@91.98.19.150}"

check() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" 'cd /opt/reason/data && NOW=$(($(date +%s%3N))) && \
    HAS=$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM pragma_table_info(\"calls\") WHERE name=\"settled_at\"") && \
    if [ "$HAS" = "1" ]; then SETTLING="OR (settle_started_at IS NOT NULL AND settled_at IS NULL AND settle_started_at > $NOW - 600000)"; JUST="AND settled_at IS NULL"; else SETTLING=""; JUST=""; fi && \
    sqlite3 -readonly reason.db "SELECT id, provider, state, CASE
        WHEN state IN (\"placing\",\"ringing\",\"in_progress\") THEN \"live call\"
        WHEN ended_at > $NOW - 120000 $JUST THEN \"ended \" || (($NOW - ended_at) / 1000) || \"s ago, after-call steps may be running\"
        ELSE \"after-call steps begun, not finished\" END
      FROM calls WHERE state IN (\"placing\",\"ringing\",\"in_progress\")
        OR (ended_at > $NOW - 120000 $JUST) $SETTLING"' 2>/dev/null
}

deadline=$(( $(date +%s) + 1200 ))
while :; do
  out="$(check)" || { echo "COULD NOT TELL (ssh/sqlite failed) — treat as busy"; exit 2; }
  if [ -z "$out" ]; then echo "IDLE — no live call and no call still settling"; exit 0; fi
  echo "BUSY:"; echo "$out" | sed 's/^/  call /'
  [ "${1:-}" = "--wait" ] || exit 1
  [ "$(date +%s)" -lt "$deadline" ] || { echo "still busy after 20 minutes — do not restart; ask"; exit 1; }
  sleep 15
done
