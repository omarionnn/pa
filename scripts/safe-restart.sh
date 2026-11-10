#!/usr/bin/env bash
# The ONE way a deploy restarts live Reason. Run on the server as root:
#   /root/reason-restart.sh            wait (up to 20 min) for idle, then restart, then health
#   /root/reason-restart.sh --now-if-idle   check once; busy = exit 1, nothing restarted
#   /root/reason-restart.sh --force    rollback only: restart even when busy (say so in the report)
#
# Idle = verify-reason/bin/idle.sh (installed at /root/reason-idle.sh): no call up or settling, no
# sign-in link in progress (data/busy.json, src/busy.js), no checkout running. On 2026-11-10 a deploy
# restart at 22:38:55 UTC killed a live Notion sign-in mid-flow; this gate is why that cannot recur.
set -u
IDLE="${REASON_IDLE_SH:-/root/reason-idle.sh}"
mode="${1:---wait}"
if [ "$mode" != "--force" ]; then
  [ -x "$IDLE" ] || { echo "NO IDLE GATE at $IDLE — not restarting"; exit 2; }
  if [ "$mode" = "--now-if-idle" ]; then REASON_LIVE_SSH=local "$IDLE" || exit 1
  else REASON_LIVE_SSH=local "$IDLE" --wait || exit 1; fi
else
  echo "FORCED restart (rollback) — idle gate said:"; REASON_LIVE_SSH=local "$IDLE" || true
fi
systemctl restart reason
for i in $(seq 1 20); do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/health || true)
  [ "$code" = "200" ] && { echo "restarted, pid $(systemctl show reason -p MainPID --value), health 200"; exit 0; }
done
echo "restarted but health is not 200 after 40 s"; exit 3
