#!/usr/bin/env bash
# One inbound message, down the real road: POST /channels/sendblue/webhook on the caged instance.
#
# This is the user path. The adapter verifies the shared secret, parses the payload, the router
# hands it to the runtime, the harm gate screens it, the real model takes a turn, real tools run,
# and the reply is queued for a channel that is not connected — so it is written down and goes
# nowhere. Every one of those steps is the production one.
#
# Usage:
#   inbound.sh text "where's the nearest coffee"     a plain text from the owner
#   inbound.sh file payload.json                     a payload you wrote (location, picture, card…)
#   inbound.sh -                                     the same, from stdin
#
# Refuses to run against port 8787: that instance can text a real person.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"
[ -f "$RUN/port" ] || { echo "no caged instance — run bin/caged.sh start first" >&2; exit 1; }
PORT="$(cat "$RUN/port")"
SECRET="$(cat "$RUN/secret")"
OWNER="$(cat "$RUN/owner")"
[ "$PORT" = "8787" ] && { echo "refusing: 8787 is the live instance and it texts real people" >&2; exit 1; }

HANDLE="verify-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

case "${1:-}" in
  text)
    [ -n "${2:-}" ] || { echo "usage: inbound.sh text \"...\"" >&2; exit 2; }
    body="$(node -e 'console.log(JSON.stringify({
      content: process.argv[1], number: process.argv[2], from_number: process.argv[2],
      is_outbound: false, status: "RECEIVED", message_type: "message",
      message_handle: process.argv[3], date_sent: process.argv[4],
    }))' "$2" "$OWNER" "$HANDLE" "$NOW")"
    ;;
  file)
    [ -f "${2:-}" ] || { echo "usage: inbound.sh file <path>" >&2; exit 2; }
    # A fresh handle every time: a repeated message_handle is deduped and no turn runs.
    body="$(node -e '
      const fs = require("node:fs");
      const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      o.message_handle ??= process.argv[2];
      if (o.message_handle === "REPLACE_ME") o.message_handle = process.argv[2];
      o.number ??= process.argv[3]; o.from_number ??= process.argv[3];
      o.date_sent ??= process.argv[4];
      o.is_outbound ??= false; o.status ??= "RECEIVED";
      console.log(JSON.stringify(o));
    ' "$2" "$HANDLE" "$OWNER" "$NOW")"
    ;;
  -)  body="$(cat)" ;;
  *)  echo "usage: inbound.sh text \"...\" | file <path> | -" >&2; exit 2 ;;
esac

echo "--- POST http://127.0.0.1:$PORT/channels/sendblue/webhook"
echo "--- body: $body"
code="$(curl -s -o "$RUN/last-response.json" -w '%{http_code}' -m 180 \
  -X POST "http://127.0.0.1:$PORT/channels/sendblue/webhook" \
  -H 'content-type: application/json' \
  -H "sb-signing-secret: $SECRET" \
  --data-binary "$body")"
echo "--- HTTP $code"
cat "$RUN/last-response.json"; echo
# 200 with delivered:1 means a turn ran. 200 with "ignored" means the adapter dropped it on
# purpose; 401 means the secret header is wrong.
