#!/usr/bin/env bash
# Is live Reason idle enough to restart? Read-only. Exit 0 = idle, 1 = busy (with why), 2 = could not tell.
# EVERY deploy kit runs this right before `systemctl restart reason` and stops unless it says IDLE.
#
# Busy is not only a call that is up. Call 57 (2026-10-31) ended at 19:33:54 and a deploy restarted the
# service at 19:34:06: the line was down, so it looked idle, but the turn sending the summary and the
# audio was still running and died with the process. So a call is busy until its after-call steps are
# finished: live (placing/ringing/in_progress), ended under 2 minutes ago, or begun and not finished
# (settle_started_at without settled_at, under 10 minutes old).
#
# Busy is also a sign-in somebody is in the middle of. On 2026-11-10 a restart at 22:38:55 UTC killed
# a live Notion sign-in mid-flow: those sessions (and their browsers) live only in the process, not in
# the database. The process writes what it holds to data/busy.json (src/busy.js) under its own pid;
# when that file is missing or was written by another pid (code from before it), the journal of the
# running pid is read instead: a sign-in link made or started and not ended, in the last 35 minutes.
#
# And a checkout being driven (shop_runs status running, touched in the last 30 minutes): the run
# itself survives in the database, but the browser step in flight does not.
#
# And a timer (the timers table; Runtime.tick/_fireTimer in src/runtime.js). On 2026-11-12 at 22:26 ET
# a restart passed this gate and cut timer 537 mid-turn; it was retried and went out 44 s late. A try
# is counted BEFORE its turn runs (db.claimTimerAttempt: attempts + 1, next_try_at = now + the retry
# gap, which is (attempts - 1) x 60 s) and the row is finished only after (fired_at or cancelled_at
# set). So a timer is busy while a try is claimed and not finished, and while one not tried yet is due
# within the next 60 s or due and not picked up yet. A try that failed and is waiting for its retry
# reads like one that is running; its retry is at most a minute or two off, so it is busy either way.
# Ten minutes on is stale and ignored: a timer turn gets 5 minutes on the CLI (REASON_CLI_TIMEOUT_MS)
# and the app calls a sweep pass stuck after 10 (config.sweepStuckMs), so a claim that old belongs to
# a process that died, and a due timer nobody picked up in 10 minutes is being held (a pause, a lapsed
# trial) rather than about to run. Neither can keep a deploy waiting for ever.
#
# Usage:  idle.sh            once
#         idle.sh --wait     poll every 15 s until idle (gives up after 20 minutes, exit 1)
# Host: REASON_LIVE_SSH (default the live OVH box). On the server itself: REASON_LIVE_SSH=local.
# REASON_IDLE_DATA (local only): another data dir, for proving the gate on a scratch database.
set -u
HOST="${REASON_LIVE_SSH:-root@15.204.113.250}"

read -r -d '' REMOTE <<'SH'
set -u
cd "${REASON_IDLE_DATA:-/opt/reason/data}" || { echo "ERR no data dir"; exit 3; }
NOW=$(($(date +%s%3N)))
HAS=$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM pragma_table_info('calls') WHERE name='settled_at'") || { echo "ERR sqlite"; exit 3; }
if [ "$HAS" = "1" ]; then SETTLING="OR (settle_started_at IS NOT NULL AND settled_at IS NULL AND settle_started_at > $NOW - 600000)"; JUST="AND settled_at IS NULL"; else SETTLING=""; JUST=""; fi
sqlite3 -readonly reason.db "SELECT 'call ' || id || ' ' || provider || ' ' || state || ' — ' || CASE
    WHEN state IN ('placing','ringing','in_progress') THEN 'live call'
    WHEN ended_at > $NOW - 120000 $JUST THEN 'ended ' || (($NOW - ended_at) / 1000) || 's ago, after-call steps may be running'
    ELSE 'after-call steps begun, not finished' END
  FROM calls WHERE state IN ('placing','ringing','in_progress')
    OR (ended_at > $NOW - 120000 $JUST) $SETTLING" || { echo "ERR sqlite"; exit 3; }
HASRUNS=$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM sqlite_master WHERE name='shop_runs'")
if [ "$HASRUNS" = "1" ]; then
  sqlite3 -readonly reason.db "SELECT 'checkout ' || substr(run_id,1,8) || ' ' || store || ' — running, touched ' || (($NOW - updated_at) / 1000) || 's ago'
    FROM shop_runs WHERE status = 'running' AND updated_at > $NOW - 1800000" || { echo "ERR sqlite"; exit 3; }
fi
# CLAIMED = when the last try began (or, for one waiting on its retry, ended): next_try_at less its gap.
CLAIMED="(next_try_at - (attempts - 1) * 60000)"
sqlite3 -readonly reason.db "SELECT 'timer ' || id || ' — ' || CASE
    WHEN attempts > 0 AND last_error IS NULL THEN 'try ' || attempts || ' running, claimed ' || (($NOW - $CLAIMED) / 1000) || 's ago'
    WHEN attempts > 0 THEN 'try ' || attempts || ' running or waiting for its retry, last moved ' || (($NOW - $CLAIMED) / 1000) || 's ago'
    WHEN fire_at > $NOW THEN 'due in ' || ((fire_at - $NOW + 999) / 1000) || 's'
    ELSE 'due ' || (($NOW - fire_at) / 1000) || 's ago, not picked up yet' END
  FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL AND (
    (attempts > 0 AND $CLAIMED > $NOW - 600000)
    OR (attempts = 0 AND fire_at > $NOW - 600000 AND fire_at <= $NOW + 60000))
  ORDER BY id" || { echo "ERR sqlite"; exit 3; }
PID=$(systemctl show reason -p MainPID --value 2>/dev/null)
[ -n "$PID" ] && [ "$PID" != "0" ] || { echo "ERR reason is not running"; exit 3; }
FILEPID=$(node -e 'try{const b=JSON.parse(require("fs").readFileSync("busy.json","utf8"));process.stdout.write(String(b.pid))}catch{}' 2>/dev/null)
if [ "$FILEPID" = "$PID" ]; then
  node -e 'const b=JSON.parse(require("fs").readFileSync("busy.json","utf8"));const now=Date.now();
    const what = { signin_link: "sign-in link (sent, not opened yet)", signin: "sign-in (open)", relay: "sign-in (native page)" };
    for (const i of b.items) console.log(`${what[i.kind] ?? i.kind} ${i.site} ${i.id} — ${Math.round((now - i.since) / 1000)}s`)' || { echo "ERR busy.json"; exit 3; }
else
  # Code from before busy.json: the running pid's own journal.
  journalctl -u reason _PID="$PID" --since "-35min" --no-pager -o cat 2>/dev/null | grep -o '{"signin_remote":[^}]*}' | node -e '
    const open = new Map();
    for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e.conversation) continue;
      if (e.signin_remote === "ended") open.delete(e.conversation);
      else open.set(e.conversation, e.site);
    }
    for (const [, site] of open) console.log(`sign-in ${site} — made or started in the last 35 min, not ended (from the journal; live code predates busy.json)`);
  ' || { echo "ERR journal"; exit 3; }
  # A link made from a text (signin_link/signin_open) logs only its tool line, not the lines above.
  N=$(journalctl -u reason _PID="$PID" --since "-35min" --no-pager -o cat 2>/dev/null | grep -cE '"tool":"signin_(link|open)".*"out":\{"ok":true')
  [ "${N:-0}" -gt 0 ] && echo "sign-in link sent by a text in the last 35 min ($N; from the journal; live code predates busy.json)"
  true
fi
SH

check() {
  if [ "$HOST" = "local" ]; then bash -c "$REMOTE"; else ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "bash -s" <<<"$REMOTE"; fi
}

deadline=$(( $(date +%s) + 1200 ))
while :; do
  out="$(check 2>/dev/null)"; rc=$?
  if [ $rc -ne 0 ] || grep -q '^ERR' <<<"$out"; then echo "COULD NOT TELL ($(grep '^ERR' <<<"$out" | head -1 || true)) — treat as busy"; exit 2; fi
  if [ -z "$out" ]; then echo "IDLE — no live call or call still settling, no sign-in in progress, no checkout running, no timer running or due within 60 s"; exit 0; fi
  echo "BUSY:"; echo "$out" | sed 's/^/  /'
  [ "${1:-}" = "--wait" ] || exit 1
  [ "$(date +%s)" -lt "$deadline" ] || { echo "still busy after 20 minutes — do not restart; ask"; exit 1; }
  sleep 15
done
