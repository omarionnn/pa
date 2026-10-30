#!/usr/bin/env bash
# The first-chat onboarding (src/onboarding.js, REASON_ONBOARDING), driven end to end on the cage:
# a brand-new number's texts down the real webhook, the real router, the real outbox, the real
# model's read on the subscription (claude-cli — a handful of haiku reads and ONE full turn for the
# to-do list), every send landing on bin/fake-sendblue.mjs on this Mac. Nothing reaches a phone.
#
#   bin/onboarding-drive.sh [outdir]          → transcript.txt, sends.jsonl, account.json; "all ok"
#   bin/onboarding-drive.sh <outdir> before   → the same first texts with REASON_ONBOARDING off (the
#                                               old prompt-led welcome: three full turns), transcript only
#
# Starts and stops its own fake Sendblue and cage (refuses if a cage is already up). The new
# person is a pre-approved test number (REASON_TEST_NUMBERS), so their first text makes their
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
OWNER_N="+12025551234"
SBPORT="${REASON_VERIFY_SB_PORT:-18941}"
CAP="$OUT/sends.jsonl"; : > "$CAP"

perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node "$HERE/fake-sendblue.mjs" "$SBPORT" "$CAP" ok \
  </dev/null >"$OUT/fake-sendblue.log" 2>&1 & echo $! > "$OUT/sb.pid"
sleep 1
grep -q 'fake sendblue on' "$OUT/fake-sendblue.log" || { echo "fake sendblue did not start (port $SBPORT taken?)" >&2; exit 1; }

cleanup() { (cd "$SKILL" && bin/caged.sh stop >/dev/null 2>&1) || true; kill "$(cat "$OUT/sb.pid")" 2>/dev/null || true; }
trap cleanup EXIT

cd "$SKILL"
REASON_VERIFY_FAKE_SENDBLUE="http://127.0.0.1:$SBPORT" REASON_VERIFY_BACKEND=claude-cli \
REASON_TEST_NUMBERS="$OWNER_N,$NEW" REASON_ONBOARDING="$FLAG" REASON_ONBOARDING_NUMBERS="$NEW" \
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
# One text from the new number; then wait for the webhook's own end line (the turn, or the
# onboarding's bubbles, have finished — src/http.js logs it after the work, not after the 200),
# and for 3 s with no new send.
say() {
  local body want; want=$(( $(hooks) + 1 ))
  body="$(node -e 'console.log(JSON.stringify({ content: process.argv[1], number: process.argv[2], from_number: process.argv[2], to_number: "+12025550101", is_outbound: false, status: "RECEIVED", message_type: "message", service: "iMessage" }))' "$1" "$NEW")"
  echo "$body" > "$OUT/payload.json"
  node -e 'console.log(JSON.stringify({ at: new Date().toISOString(), you: process.argv[1] }))' "$1" >> "$OUT/said.jsonl"
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

TEXTS=("hey" "wait who made you?" "kofi" "i'm a nursing student" "laundry, email my prof about the essay extension, book a dentist appointment")
[ "$MODE" = before ] && TEXTS=("hey" "kofi" "i'm a nursing student")
for t in "${TEXTS[@]}"; do
  say "$t"
done
cp "$RUN/serve.log" "$OUT/serve.log"

node - "$CAP" "$OUT/said.jsonl" "$NEW" > "$OUT/transcript.txt" <<'EOF'
const fs = require("fs");
const [cap, saidFile, who] = process.argv.slice(2);
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const sent = lines(cap).filter(r => r.method === "POST" && /send-message/.test(r.path) && r.body?.number === who)
  .map(r => ({ at: Date.parse(r.at), reason: r.body.media_url ? `[contact card ${r.body.media_url}]` : (r.body.content ?? "") }));
const said = lines(saidFile).map(r => ({ at: Date.parse(r.at), you: r.you }));
let prev = null;
for (const m of [...sent, ...said].sort((a, b) => a.at - b.at)) {
  if (m.you != null) { console.log(`\nThem              ${m.you}`); prev = m.at; continue; }
  const gap = prev ? `+${((m.at - prev) / 1000).toFixed(1)}s` : "";
  prev = m.at;
  console.log(`Reason ${gap.padStart(8)}  ${m.reason}`);
}
EOF
q "SELECT conversation_id, name, onboarding, onboarding_steers, onboarding_name_asked_at IS NOT NULL AS name_asked, contact_card_sent_at IS NOT NULL AS card_sent FROM accounts WHERE address = '$NEW'" > "$OUT/account.json"
q "SELECT id, note, label, fire_at, cancelled_at, fired_at FROM timers WHERE conversation_id = 'dm:sendblue:$NEW'" > "$OUT/timers.json"
q "SELECT fact FROM person_facts" > "$OUT/facts.json"
grep -E 'onboarding' "$RUN/serve.log" > "$OUT/serve-onboarding.log" || true
cat "$OUT/transcript.txt"; echo; cat "$OUT/account.json"; echo
[ "$MODE" = before ] && exit 0

node - "$OUT" <<'EOF'
const fs = require("fs"); const out = process.argv[2];
const t = fs.readFileSync(`${out}/transcript.txt`, "utf8");
const acct = JSON.parse(fs.readFileSync(`${out}/account.json`, "utf8"))[0] ?? {};
const checks = [
  ["one opener", (t.match(/I'm Reason/g) ?? []).length === 1],
  ["steered back to the name", /I didn't get your name/.test(t)],
  ["nice to meet you, Kofi", /nice to meet you, Kofi/i.test(t)],
  ["the card right after its line", /save my contact card so my links open properly\n.*\[contact card https:\/\/cage\.example\.test\/reason-[0-9a-f]{8}\.vcf\]\n.*so what do you do\?/.test(t)],
  ["the closing line, word for word", t.includes("or better yet, send me a picture of your to-do list and I'll knock them out right now.")],
  ["name saved", acct.name === "Kofi"],
  ["flow complete after the list", acct.onboarding === "complete"],
  ["card marked sent", acct.card_sent === 1],
  ["occupation remembered", /nurs/i.test(fs.readFileSync(`${out}/facts.json`, "utf8"))],
  ["the to-do list got a real reply", (t.split("laundry, email my prof")[1] ?? "").includes("Reason ")],
  ["the first text got no card line of its own", !/save me as a contact/.test(t)],
];
let bad = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) bad++; }
console.log(bad ? `${bad} failed` : "all ok");
process.exit(bad ? 1 : 0);
EOF
