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
# And work inside a person's account or their saved logins (2026-11-13). Each is read from the database
# or busy.json, never the app's memory; a table, column or kind that is not there yet is nothing to wait for.
#   - An account job (src/accountjobs.js, account_jobs): a state in OPEN_STATES, or its run (shop_runs,
#     mode job_*) still running. The run is resumed after a restart, but the step in flight (an emailed
#     code being read, an answer being sent) is not. Stale after 36 minutes with nothing touched (the
#     job's start/confirm/payment or its run's updated_at): shopconnect.js OUTAGE_MS, the longest the
#     app itself follows a run on which nothing moves before giving it up. A job's run is said once, as
#     the job, not again as a checkout.
#   - A save page (src/loginintake.js, login_intake): issued in the last 10 minutes, unused, not expired.
#     The link lives 30 minutes (INTAKE_TTL_MS) and its row survives a restart; only a submit landing
#     while the service is down is lost, and a page is filled in a minute or two. So a link nobody used
#     in 10 minutes does not hold a deploy.
#   - A Face ID approval for a sign-in (src/loginuse.js): kept only in memory, so a restart drops it and
#     they tap again. Seen as the person's login_log row (signin, needs_face_id) with no later signin row
#     for that site, for 15 minutes: the link lives 10 (ASK_TTL_MS) and a yes is good 5 more (YES_TTL_MS).
#     filler.js also writes that row when it refuses an event turn (no link is sent); that can hold a
#     deploy for up to 15 minutes for nothing, never longer.
#   - A saved-login sign-in (src/filler.js signIn) holding the person's browser: busy.json kinds
#     saved_login (in the browser) and saved_login_code (waiting for their code) once the app writes
#     them, each ignored after 10 minutes (a page load 30 s, two fills, an emailed-code read 90 s
#     MAIL_WAIT_MS, a texted-code wait 5 min REPLY_WAIT_MS: under 8 minutes). Before that, the wait for
#     a code is seen as a login_log row (signin, needs_code_sms|needs_code_email, written when the wait
#     begins) with no later signin row for that site, for 7 minutes (the 5-minute wait, the code typed,
#     the ending written).
#   - An emailed-code sign-in (src/signinemail.js startEmailSignin) is busy.json kind signin_email.
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
HASJOBS=$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'account_jobs'") || { echo "ERR sqlite"; exit 3; }
if [ "$HASRUNS" = "1" ]; then
  # An account job's run is said below, as the job.
  NOTJOB=""; [ "$HASJOBS" = "1" ] && NOTJOB="AND NOT (substr(mode, 1, 4) = 'job_' AND run_id IN (SELECT run_id FROM account_jobs))"
  sqlite3 -readonly reason.db "SELECT 'checkout ' || substr(run_id,1,8) || ' ' || store || ' — running, touched ' || (($NOW - updated_at) / 1000) || 's ago'
    FROM shop_runs WHERE status = 'running' AND updated_at > $NOW - 1800000 $NOTJOB" || { echo "ERR sqlite"; exit 3; }
fi
if [ "$HASJOBS" = "1" ]; then
  OPEN="'running','needs_page','needs_code','needs_answer','needs_confirm','confirming','needs_approval','paid'"
  if [ "$HASRUNS" = "1" ]; then JOIN="LEFT JOIN shop_runs r ON r.run_id = j.run_id AND j.run_id <> ''"; RUNAT="coalesce(r.updated_at, 0)"; RUNNING="OR r.status = 'running'"
  else JOIN=""; RUNAT="0"; RUNNING=""; fi
  TOUCH="max(j.created_at, coalesce(j.confirmed_at, 0), coalesce(j.paid_at, 0), $RUNAT)"
  sqlite3 -readonly reason.db "SELECT 'account job ' || j.id || ' (' || j.kind || ') — ' || CASE WHEN j.state IN ($OPEN) THEN j.state ELSE 'its run still going' END
      || ', touched ' || (($NOW - $TOUCH) / 1000) || 's ago'
    FROM account_jobs j $JOIN WHERE (j.state IN ($OPEN) $RUNNING) AND $TOUCH > $NOW - 2160000 ORDER BY j.id" || { echo "ERR sqlite"; exit 3; }
fi
if [ "$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'login_intake'")" = "1" ]; then
  sqlite3 -readonly reason.db "SELECT 'save page open — issued ' || (($NOW - created_at) / 1000) || 's ago, not used yet'
    FROM login_intake WHERE claimed_at IS NULL AND expires_at > $NOW AND created_at > $NOW - 600000 ORDER BY created_at" || { echo "ERR sqlite"; exit 3; }
fi
CODEWAIT=""
if [ "$(sqlite3 -readonly reason.db "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'login_log'")" = "1" ]; then
  LATEST="l.event = 'signin' AND NOT EXISTS (SELECT 1 FROM login_log m WHERE m.conversation_id = l.conversation_id AND m.site = l.site AND m.event = 'signin' AND m.id > l.id)"
  sqlite3 -readonly reason.db "SELECT 'Face ID for a saved-login sign-in — asked ' || (($NOW - l.at) / 1000) || 's ago, link open or approval not used yet'
    FROM login_log l WHERE l.outcome = 'needs_face_id' AND l.at > $NOW - 900000 AND $LATEST ORDER BY l.id" || { echo "ERR sqlite"; exit 3; }
  CODEWAIT=$(sqlite3 -readonly reason.db "SELECT 'saved-login sign-in — waiting for a code (' || CASE l.outcome WHEN 'needs_code_sms' THEN 'texted' ELSE 'emailed, asked of them' END || '), ' || (($NOW - l.at) / 1000) || 's'
    FROM login_log l WHERE l.outcome IN ('needs_code_sms', 'needs_code_email') AND l.at > $NOW - 420000 AND $LATEST ORDER BY l.id") || { echo "ERR sqlite"; exit 3; }
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
  HELD=$(node -e 'const b=JSON.parse(require("fs").readFileSync("busy.json","utf8"));const now=Date.now();
    const what = { signin_link: "sign-in link (sent, not opened yet)", signin: "sign-in (open)", relay: "sign-in (native page)", signin_email: "emailed-code sign-in" };
    // The saved-login sign-in: no site named, and ignored after 10 minutes (see the top).
    const saved = { saved_login: "saved-login sign-in — in the browser", saved_login_code: "saved-login sign-in — waiting for a code" };
    for (const i of b.items) {
      const s = Math.round((now - i.since) / 1000);
      if (saved[i.kind]) { if (s <= 600) console.log(`${saved[i.kind]}, ${s}s`); continue; }
      console.log(`${what[i.kind] ?? i.kind} ${i.site} ${i.id} — ${s}s`);
    }') || { echo "ERR busy.json"; exit 3; }
  [ -n "$HELD" ] && echo "$HELD"
  # The code wait from login_log only when busy.json does not already say it.
  grep -q '^saved-login sign-in' <<<"$HELD" || { [ -n "$CODEWAIT" ] && echo "$CODEWAIT"; }
  true
else
  [ -n "$CODEWAIT" ] && echo "$CODEWAIT"
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
  if [ -z "$out" ]; then echo "IDLE — no live call or call still settling, no sign-in in progress, no checkout or account job running, no save page or Face ID approval open, no timer running or due within 60 s"; exit 0; fi
  echo "BUSY:"; echo "$out" | sed 's/^/  /'
  [ "${1:-}" = "--wait" ] || exit 1
  [ "$(date +%s)" -lt "$deadline" ] || { echo "still busy after 20 minutes — do not restart; ask"; exit 1; }
  sleep 15
done
