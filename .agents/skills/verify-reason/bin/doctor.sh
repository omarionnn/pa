#!/usr/bin/env bash
# Is this Reason worth driving? Read-only: nothing here writes, sends or restarts.
#
# Usage:  doctor.sh            the LIVE instance — Hetzner, over ssh (same as `doctor.sh live`)
#         doctor.sh 8796       a local port, normally the caged one
#         doctor.sh 8787       a local dev instance on the Mac, if somebody started one
#
# THE LIVE REASON IS HETZNER (https://reason.tail3753c7.ts.net, ssh root@91.98.19.150 or
# root@100.100.152.2 over Tailscale, systemd unit `reason`, rsync copy at /opt/reason). The
# hostname `reason.tail3753c7.ts.net` moved from the Mac to Hetzner on 2026-10-12 and the old
# `ubuntu-4gb-nbg1-2.tail3753c7.ts.net` no longer resolves — this script answered "NO USABLE
# ANSWER" for a healthy instance until the default below was changed (2026-10-13). The Mac's 8787
# stopped being live on 2026-10-12; a process there is a dev checkout somebody launched, not what
# people are texting.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
TARGET="${1:-live}"
fail=0
say() { printf '%-22s %s\n' "$1" "$2"; }

read_health() {
  # $1 = the health JSON. Prints the lines that mean "driving this will go nowhere".
  node -e '
const h = JSON.parse(process.argv[1]);
const say = (k, v) => console.log(k.padEnd(22) + v);
say("GET /health", "ok · " + h.now + " · owner " + h.owner);
say("sweeping", h.sweeping ? "yes" : "NO — timers, tasks and held messages will never fire");
for (const c of h.channels ?? []) say("channel " + c.name, c.status + (c.missing?.length ? " (missing " + c.missing.join(", ") + ")" : "") + (c.number ? " · " + c.number : ""));
say("outbox", "sent " + (h.outbox?.sent ?? 0) + " · failed " + (h.outbox?.failed ?? 0));
const due = (h.holding ?? []).filter(r => r.due);
say("held inbound", (h.holding ?? []).length + " waiting" + (due.length ? " · " + due.length + " OVERDUE (sweep stuck?)" : ""));
say("tasks", "open " + h.open_tasks + " · due " + h.due_tasks);
say("timers", "pending " + h.pending_timers + " · retrying " + h.retrying_timers + " · gave up " + h.missed_timers);
say("threads", String(h.threads));
if (!h.sweeping) process.exitCode = 1;
' "$1"
}

if [ "$TARGET" = "live" ]; then
  HOST="${REASON_LIVE_SSH:-root@91.98.19.150}"
  URL="${REASON_LIVE_URL:-https://reason.tail3753c7.ts.net}"
  say "target" "LIVE · $URL · ssh $HOST"

  # 1. The service, the process, and when it started.
  remote="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" '
    systemctl is-active reason 2>/dev/null || echo inactive
    systemctl show reason -p MainPID -p ExecMainStartTimestamp --value 2>/dev/null
    md5sum /opt/reason/src/tools.js /opt/reason/src/http.js /opt/reason/src/agentcard.js /opt/reason/src/channels/sendblue.js /opt/reason/src/serve.js 2>/dev/null | cut -d" " -f1
    grep -c "^AGENTCARD_" /opt/reason/.env 2>/dev/null || echo 0
  ' 2>/dev/null)" || { say "ssh" "COULD NOT REACH $HOST — not provable from here"; exit 1; }
  active="$(echo "$remote" | sed -n 1p)"; pid="$(echo "$remote" | sed -n 2p)"; started="$(echo "$remote" | sed -n 3p)"
  say "service reason" "$active · pid $pid"
  say "process started" "$started"
  [ "$active" = "active" ] || fail=1

  # 2. Whether the code there is the code in front of you. /opt/reason is an rsync copy, not a
  #    checkout, so this compares the five files most likely to be what you just changed: the
  #    tools, the routes, AgentCard, the Sendblue adapter and the startup sequence.
  i=4
  for f in src/tools.js src/http.js src/agentcard.js src/channels/sendblue.js src/serve.js; do
    theirs="$(echo "$remote" | sed -n ${i}p)"; mine="$(md5 -q "$REPO/$f" 2>/dev/null || md5sum "$REPO/$f" | cut -d' ' -f1)"
    if [ "$theirs" = "$mine" ]; then say "$f" "same as this tree"; else say "$f" "DIFFERS from this tree — deploy, or you are reading code that is not running"; fi
    i=$((i+1))
  done
  say "AGENTCARD_* in .env" "$(echo "$remote" | sed -n 9p) of 3"
  say "repo HEAD" "$(git -C "$REPO" log -1 --format='%h %s' | cut -c1-70)"
  say "repo dirty" "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') uncommitted file(s) — do not rsync the tree blind"

  # 3. Health over the public address, the way phones and webhooks reach it.
  h="$(curl -s -m 8 "$URL/health" || true)"
  if [ -z "$h" ] || ! echo "$h" | grep -q '"ok":true'; then
    say "GET /health" "NO USABLE ANSWER from $URL — not provable"; echo "$h" | head -c 300; exit 1
  fi
  read_health "$h" || fail=1
  say "agentcard webhook" "$(curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST "$URL/agentcard/webhook" -H 'content-type: application/json' -d '{}') on an unsigned POST (401 = route up, failing closed)"

  echo
  echo "VERDICT  this is the LIVE instance people are texting. Read-only only: /health, GET /p/<id>,"
  echo "         journalctl -u reason, reading /opt/reason/data/reason.db over ssh. Any POST here"
  echo "         can run a real turn and TEXT A REAL PHONE. To drive anything: bin/caged.sh start"
  exit "$fail"
fi

PORT="$TARGET"
# 1. Somebody is listening, and it is a node process we can name.
line="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2')"
if [ -z "$line" ]; then say "listener" "NOBODY on 127.0.0.1:$PORT — not running"; exit 1; fi
pid="$(echo "$line" | awk '{print $2}')"
say "listener" "pid $pid on 127.0.0.1:$PORT"
say "command" "$(ps -p "$pid" -o command= | cut -c1-90)"
say "uptime" "$(ps -p "$pid" -o etime= | tr -d ' ')"

# 2. Which checkout it is serving, and whether that checkout has moved under it. A process started
#    before the last commit is running code nobody has in front of them.
cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
say "cwd" "${cwd:-unknown}"
say "repo HEAD" "$(git -C "$REPO" log -1 --format='%h %s' | cut -c1-70)"
say "repo dirty" "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') uncommitted file(s)"
started="$(ps -p "$pid" -o lstart= | xargs)"
committed="$(git -C "$REPO" log -1 --format=%cd --date=format:'%a %b %e %T %Y')"
say "process started" "$started"
say "HEAD committed" "$committed"

# 3. Health answers, and says the things that mean "driving this will go nowhere".
h="$(curl -s -m 5 "http://127.0.0.1:$PORT/health" || true)"
if [ -z "$h" ] || ! echo "$h" | grep -q '"ok":true'; then
  say "GET /health" "NO USABLE ANSWER — do not drive this"; echo "$h" | head -c 300; exit 1
fi
read_health "$h" || fail=1

# 4. The one thing that decides HOW you may drive it.
echo
if echo "$h" | grep -q '"name":"sendblue","status":"live"'; then
  echo "VERDICT  this local instance holds LIVE texting credentials — a POST to its webhook texts a"
  echo "         real phone, and if its number is the Hetzner number it is a DUPLICATE of the live"
  echo "         Reason. It is not what people are texting (that is Hetzner: bin/doctor.sh live)."
  echo "         Do not drive it. To drive anything: bin/caged.sh start"
  fail=1
else
  echo "VERDICT  both texting channels read not_connected above — if bin/caged.sh start brought it"
  echo "         up, it cannot text anyone and is safe to drive."
fi
exit "$fail"
