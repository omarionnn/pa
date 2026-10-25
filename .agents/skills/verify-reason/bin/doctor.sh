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

  # 1. The service, the process, and when it started. Sections are split by marker lines, so a
  #    missing file or an empty answer cannot shift what follows into the wrong field.
  remote="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" '
    echo "@@service"; systemctl is-active reason 2>/dev/null || echo inactive
    systemctl show reason -p MainPID --value 2>/dev/null
    systemctl show reason -p ExecMainStartTimestamp --value 2>/dev/null
    echo "@@src"; cd /opt/reason && find src -type f | LC_ALL=C sort | xargs md5sum 2>/dev/null
    echo "@@agentcard"; grep -c "^AGENTCARD_" /opt/reason/.env 2>/dev/null || echo 0
    echo "@@backups"; ls -1 /opt/reason/data 2>/dev/null | grep -E "\.bak" || true
    echo "@@envbak"; ls -1a /opt/reason 2>/dev/null | grep -E "^\.env\.bak" || true
    echo "@@timer"; systemctl show reason-backup.timer -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime 2>/dev/null
  ' 2>/dev/null)" || { say "ssh" "COULD NOT REACH $HOST — not provable from here"; exit 1; }
  section() { echo "$remote" | awk -v s="@@$1" '$0 ~ /^@@/ { on = ($0 == s); next } on'; }
  active="$(section service | sed -n 1p)"; pid="$(section service | sed -n 2p)"; started="$(section service | sed -n 3p)"
  say "service reason" "$active · pid $pid"
  say "process started" "$started  (after a deploy this must be later than the copy finished)"
  [ "$active" = "active" ] || fail=1

  # 2. Whether the code there is the code in front of you. /opt/reason is an rsync copy, not a
  #    checkout, so every file under src/ is compared by checksum against this tree (until
  #    2026-10-24 only five files were, and src/purchasesnote.js or src/linechange.js could have been
  #    missing on live with doctor still reading "same").
  theirs="$(section src | awk '{print $2"  "$1}')"
  mine="$(cd "$REPO" && find src -type f | LC_ALL=C sort | while read -r f; do echo "$f  $(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)"; done)"
  differs="$(diff <(echo "$mine") <(echo "$theirs") | grep -E '^[<>]' | awk '{print $2}' | LC_ALL=C sort -u || true)"
  if [ -z "$differs" ]; then
    say "src/ checksums" "$(echo "$mine" | grep -c .) files, all same as this tree"
  else
    say "src/ checksums" "$(echo "$differs" | grep -c .) file(s) DIFFER or exist on one side only — deploy, or you are reading code that is not running:"
    echo "$differs" | head -20 | sed 's/^/                       /'
  fi
  say "AGENTCARD_* in .env" "$(section agentcard | head -1) of 3"
  baks="$(section backups)"
  say "data/ backups" "$(echo "$baks" | grep -c .) file(s): $(echo "$baks" | tr '\n' ' ')"
  [ "$(echo "$baks" | grep -c .)" -le 1 ] || say "" "MORE THAN ONE — only reason.db.bak-rolling stays; delete a pre-deploy copy once its deploy is proven"
  envbak="$(section envbak)"
  [ -z "$envbak" ] && say ".env.bak*" "none (good — never make one)" || say ".env.bak*" "PRESENT: $(echo "$envbak" | tr '\n' ' ')— a copy of every secret; remove it"
  say "backup timer" "$(section timer | tr '\n' ' ')"
  say "repo HEAD" "$(git -C "$REPO" log -1 --format='%h %s' | cut -c1-70)"
  say "repo dirty" "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') uncommitted file(s) — deploy only from a fresh checkout of origin/main"

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
# `caged` = the port `caged.sh start` wrote down. Anything else that isn't a number used to die
# silently here (lsof fails under pipefail), which read as "doctor passed nothing, exit 1".
if [ "$PORT" = "caged" ]; then
  PORT="$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port" 2>/dev/null || echo "${REASON_VERIFY_PORT:-8796}")"
fi
case "$PORT" in ''|*[!0-9]*) echo "usage: doctor.sh [live|caged|<port>]" >&2; exit 2 ;; esac
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
