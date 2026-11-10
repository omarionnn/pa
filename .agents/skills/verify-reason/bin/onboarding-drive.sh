#!/usr/bin/env bash
# The first-chat onboarding (src/onboarding.js, REASON_ONBOARDING), driven end to end on the cage:
# brand-new numbers' texts down the real webhook, the real router, the real outbox, the real model's
# read on the subscription (claude-cli — a handful of haiku reads and ONE full turn for the request),
# every send landing on bin/fake-sendblue.mjs on this Mac. Nothing reaches a phone.
#
#   bin/onboarding-drive.sh [outdir]          → transcript.txt (two people: one says hey, one opens with
#                                               a request and goes by a nickname), sends.jsonl, account.json, card.vcf; "all ok"
#   bin/onboarding-drive.sh <outdir> before   → the first person's texts with REASON_ONBOARDING off (the
#                                               prompt-led welcome: full turns), transcript only
#
# Starts and stops its own fake Sendblue and cage (refuses if a cage is already up). The new
# people are pre-approved test numbers (REASON_TEST_NUMBERS), so their first text makes their
# account exactly as auto-admit does on live, and REASON_ONBOARDING=test covers only them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$(dirname "$HERE")"
RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"
OUT="${1:-$(mktemp -d)/onboarding}"
MODE="${2:-after}"
FLAG=test; [ "$MODE" = before ] && FLAG=off
mkdir -p "$OUT"
[ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null && { echo "a cage is already up — bin/caged.sh stop first" >&2; exit 1; }

NEW="+12125550188"
NEW2="+12125550189"
OWNER_N="+12025551234"
SBPORT="${REASON_VERIFY_SB_PORT:-18941}"
CAP="$OUT/sends.jsonl"; : > "$CAP"
: > "$OUT/said.jsonl"

perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node "$HERE/fake-sendblue.mjs" "$SBPORT" "$CAP" ok \
  </dev/null >"$OUT/fake-sendblue.log" 2>&1 & echo $! > "$OUT/sb.pid"
sleep 1
grep -q 'fake sendblue on' "$OUT/fake-sendblue.log" || { echo "fake sendblue did not start (port $SBPORT taken?)" >&2; exit 1; }

cleanup() { (cd "$SKILL" && bin/caged.sh stop >/dev/null 2>&1) || true; kill "$(cat "$OUT/sb.pid")" 2>/dev/null || true; }
trap cleanup EXIT

cd "$SKILL"
REASON_VERIFY_FAKE_SENDBLUE="http://127.0.0.1:$SBPORT" REASON_VERIFY_BACKEND=claude-cli \
REASON_TEST_NUMBERS="$OWNER_N,$NEW,$NEW2" REASON_ONBOARDING="$FLAG" REASON_ONBOARDING_NUMBERS="$NEW,$NEW2" \
REASON_ONBOARDING_GAP_MS=1100 REASON_PUBLIC_URL="https://cage.example.test" \
  bin/caged.sh start > "$OUT/cage-start.txt"
cp "$RUN/serve.log" "$OUT/serve-start.log"
grep -q 'model: the claude CLI' "$RUN/serve.log" || { echo "cage is not on the CLI backend — refusing to drive" >&2; grep 'model:' "$RUN/serve.log" >&2; exit 1; }
grep -q 'sendblue: live' "$OUT/cage-start.txt" && grep -q "fake sendblue on 127.0.0.1:$SBPORT" "$OUT/fake-sendblue.log" \
  || { echo "sendblue is not the fake one — refusing to drive" >&2; exit 1; }

# Doctor before the first drive (the skill's rule): a cage that is not worth driving is not driven.
bin/doctor.sh "$(cat "$RUN/port")" > "$OUT/doctor.txt" 2>&1 || { echo "doctor says the cage is not worth driving" >&2; cat "$OUT/doctor.txt" >&2; exit 1; }
DB="$RUN/reason.db"
q() { node -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(JSON.stringify(d.prepare(process.argv[2]).all()))' "$DB" "$1"; }
sends() { grep -c '"POST"' "$CAP" || true; }
hooks() { grep -c '"webhook":"sendblue"' "$RUN/serve.log" || true; }
# One text from a new number; then wait for the webhook's own end line (the turn, or the
# onboarding's bubbles, have finished — src/http.js logs it after the work, not after the 200),
# and for 3 s with no new send.
say() {
  local body want who="${2:-$NEW}"; want=$(( $(hooks) + 1 ))
  body="$(node -e 'console.log(JSON.stringify({ content: process.argv[1], number: process.argv[2], from_number: process.argv[2], to_number: "+12025550101", is_outbound: false, status: "RECEIVED", message_type: "message", service: "iMessage" }))' "$1" "$who")"
  echo "$body" > "$OUT/payload.json"
  node -e 'console.log(JSON.stringify({ at: new Date().toISOString(), you: process.argv[1], who: process.argv[2] }))' "$1" "$who" >> "$OUT/said.jsonl"
  bin/inbound.sh file "$OUT/payload.json" >> "$OUT/inbound.log" 2>&1
  local quiet=0 last; last=$(sends)
  for _ in $(seq 1 600); do
    sleep 1
    local now; now=$(sends)
    if [ "$now" = "$last" ] && [ "$(hooks)" -ge "$want" ]; then quiet=$((quiet + 1)); else quiet=0; last=$now; fi
    [ "$quiet" -ge 3 ] && return 0
  done
  echo "timed out waiting on: $1" >&2; return 1
}

TEXTS=("hey" "wait who made you?" "kofi" "jarvis")
[ "$MODE" = before ] && TEXTS=("hey" "kofi" "i'm a nursing student")
for t in "${TEXTS[@]}"; do
  say "$t"
done
# The second person opens with a real request: it is done first, then the name is asked. They go by
# a nickname (Bubba): met warmly, no meaning looked up (owner, 2026-11-07), then the same ask.
if [ "$MODE" != before ]; then
  for t in "remind me to drink water at 3pm today" "bubba" "whatever is fine"; do
    say "$t" "$NEW2"
  done
fi
cp "$RUN/serve.log" "$OUT/serve.log"

for who in "$NEW" "$NEW2"; do
  node "$HERE/onboarding-transcript.cjs" "$CAP" "$OUT/said.jsonl" "$who"
done > "$OUT/transcript.txt"
q "SELECT conversation_id, name, onboarding, onboarding_steers, onboarding_name_asked_at IS NOT NULL AS name_asked, contact_card_sent_at IS NOT NULL AS card_sent, contact_card_name FROM accounts WHERE address IN ('$NEW', '$NEW2') ORDER BY address" > "$OUT/account.json"
q "SELECT id, note, label, fire_at, cancelled_at, fired_at FROM timers WHERE conversation_id IN ('dm:sendblue:$NEW', 'dm:sendblue:$NEW2')" > "$OUT/timers.json"
# The card the first person was sent, as the cage serves it (its address, on this Mac's port).
CARD_PATH="$(grep -o 'cage\.example\.test/reason-[0-9a-f]*-[A-Za-z0-9_-]*\.vcf' "$OUT/transcript.txt" | head -1 | sed 's#cage\.example\.test##' || true)"
if [ -n "$CARD_PATH" ]; then curl -s "http://127.0.0.1:$(cat "$RUN/port")$CARD_PATH" | grep -v '^PHOTO\|^ ' > "$OUT/card.vcf" || true; else : > "$OUT/card.vcf"; fi
grep -E 'onboarding' "$RUN/serve.log" > "$OUT/serve-onboarding.log" || true
cat "$OUT/transcript.txt"; echo; cat "$OUT/account.json"; echo; cat "$OUT/card.vcf"; echo
[ "$MODE" = before ] && exit 0

node "$HERE/onboarding-checks.cjs" "$OUT"
