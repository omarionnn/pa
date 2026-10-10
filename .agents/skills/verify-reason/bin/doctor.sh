#!/usr/bin/env bash
# Is this Reason worth driving? Read-only: nothing here writes, sends or restarts.
#
# Usage:  doctor.sh [port]      default 8787, the owner's live instance
#         doctor.sh 8796        the caged one
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
PORT="${1:-8787}"
fail=0
say() { printf '%-22s %s\n' "$1" "$2"; }

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
' "$h" || fail=1

# 4. The one thing that decides HOW you may drive it.
if [ "$PORT" = "8787" ]; then
  echo
  echo "VERDICT  this is the owner's LIVE instance. Read-only only: /health, GET /p/<id>, reading"
  echo "         data/reason.db. A POST to /channels/sendblue/webhook here runs a real turn and"
  echo "         TEXTS A REAL PHONE. To drive anything, start the caged one: bin/caged.sh start"
else
  echo
  echo "VERDICT  non-default port — if bin/caged.sh start brought it up, it cannot text anyone"
  echo "         (both channels read not_connected above) and is safe to drive."
fi
exit "$fail"
