# Inbound message handling

Somebody texts Reason and gets an answer. Everything else in the product sits on top of this: if a
message does not arrive, is answered twice, or is answered on behalf of the wrong person, nothing
else matters.

Source: `src/channels/sendblue.js` (`verify`, `receive`, `describe`), `src/channels/router.js`,
`src/runtime.js` (`handle`), `src/agent.js` (`runTurn`), `src/harm.js`.
Tests: `test/channels.test.js`, `test/sendblue.test.js`, `test/burst.test.js`, `test/parts.test.js`,
`test/harm.test.js`.

## Sub-features

- **Authentication.** A shared secret in the `sb-signing-secret` header, compared in constant time.
  Wrong, missing or short → 401 and no turn.
- **Dropping what is not somebody talking.** Nine webhook types share one account-level URL. Our own
  outbound echo (`is_outbound`), delivery status callbacks, typing indicators, call logs, inbound
  calls, profile and contact events — each acknowledged with 200 and dropped, so Sendblue stops
  retrying and no turn is spent.
- **Groups are never treated as one person's DM.** A non-empty `group_id` → 200, logged as ignored.
  Every account, ledger row and confirmation in Reason belongs to one person.
- **Deduplication.** A retried webhook with a `message_handle` already seen is answered once.
- **Who is the sender.** The `number` field, which the docs define as the end user — not
  `from_number`, even when they match. Normalised to E.164.
- **Non-text parts.** Pictures arrive as pictures the model can see; audio is transcribed; video
  (`.mov`, `.mp4`, `.m4v`, `.avi`, `.webm`, `.mkv`, `.3gp`) is uploaded to Gemini and watched; a
  vCard is downloaded and parsed; a file nobody can open is *described* rather than arriving as an
  empty message. See `attachmentOf`, `cannotReadContactLine`, and [location-share.md](location-share.md).
- **The burst window.** A message waits `REASON_BURST_QUIET_MS` (default 2500ms) to see whether more
  of the same thought is coming, then the whole burst takes one turn.
- **Threading.** A reply threads to the right message across several texts — `reply_to` /
  `thread_root`, and `thread_originator` rather than the newest message.
- **The harm gate.** Every message is screened before the model sees a word of it. A harmful one
  gets no turn, no tool, and a refusal in code's own words.
- **Access.** Who gets served at all: `REASON_AUTO_ADMIT`, `REASON_TEST_NUMBERS` (the `claude-cli`
  backend only), the master's approval queue. `REASON_AUTO_ADMIT=1` on this install, so a stranger
  is admitted on the spot, gets an account row and an onboarding turn that asks their name — and
  `REASON_TEST_NUMBERS` is ignored entirely when auto-admit is on (`src/config.js:231`), despite
  the startup banner still announcing the number list.
- **The owner is told when a stranger turns up.** Added 2026-10-11: the `auto_admitted` branch
  texts the master *"heads up — <who> just texted me for the first time. i don't have them on your
  list yet."* (`src/channels/router.js:447`). See the gotcha below — this one cannot be proved on
  the caged instance and has no test.

## How to get to it (user POV)

Text the Sendblue line in Messages. That is the whole interface. Sendblue POSTs the message to
`/channels/sendblue/webhook`; the reply arrives back in the same iMessage thread.

## Driving it with the harness

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start
bin/doctor.sh 8796

bin/inbound.sh text "what time is it in lisbon"      # expect 200 {"ok":true,"delivered":1}
bin/inbound.sh file features/payloads/group.json     # expect 200 {"ok":true,"ignored":"group",…}

bin/peek.sh inbound    # the row the adapter accepted
bin/peek.sh thread     # what the model was handed, and what it said back
bin/peek.sh outbox     # what was queued, and why it could not go
```

Which branch the router actually took is in `serve.log`, because `caged.sh` runs `serve.js --log`.
Diff the line count around a drive rather than reading the whole file:

```bash
LOG="${TMPDIR:-/tmp}/reason-verify/serve.log"; BEFORE=$(wc -l < "$LOG")
bin/inbound.sh text "what time is it in lisbon"
tail -n +$((BEFORE+1)) "$LOG"
```

For the access path, drive a number that is **not** the owner — `inbound.sh` always sends as
`REASON_MASTER_NUMBER`, so this one is a hand-rolled curl with a fresh handle:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port"); S=$(cat "${TMPDIR:-/tmp}/reason-verify/secret")
curl -s -X POST "http://127.0.0.1:$P/channels/sendblue/webhook" \
  -H 'content-type: application/json' -H "sb-signing-secret: $S" \
  -d '{"content":"hey is this reason?","number":"+12125550199","from_number":"+12125550199",
       "is_outbound":false,"status":"RECEIVED","message_type":"message",
       "message_handle":"stranger-'"$(date +%s)"'"}'
bin/peek.sh sql "select conversation_id, address, name, is_operator from accounts"
```

A pass is `{"inbound":…,"auto_admitted":"+12125550199","conversationId":"dm:sendblue:+12125550199"}`
in the log, an `accounts` row for that number with `is_operator = 0`, and a thread whose assistant
reply asks their name. Driven 2026-10-11: *"yep, it's reason 👋 i'm ur assistant, right here in ur
texts. what's ur name?"*

Auth is the one sub-feature no helper drives — `inbound.sh` always sends the right secret. One curl
covers it:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$P/channels/sendblue/webhook" \
  -H 'content-type: application/json' -H 'sb-signing-secret: nope' \
  -d '{"content":"hi","number":"+10000000000","message_handle":"probe-401"}'   # → 401
```

**End state that proves it.** An `inbound_messages` row with the right `conversation_id`; a
`conversations` transcript whose last `user` message is the text stamped with the local date and the
owner's name, followed by an `assistant` reply that answers it; and `could not send over sendblue:
... not connected` in `$TMPDIR/reason-verify/serve.log` — the reply was produced and the cage held.

Auth, dedup, the dropped webhook types, groups, bursts and threading are all proved offline, without
a server, and that is where to assert on them:

```bash
cd ~/Desktop/pa
node --test test/channels.test.js test/sendblue.test.js test/burst.test.js test/parts.test.js
```

## Gotchas

- **Reusing a `message_handle` silently proves nothing.** It is deduped, you get a 200, and no turn
  runs. `bin/inbound.sh text` and `bin/inbound.sh file` stamp a fresh one — **`bin/inbound.sh -`
  does not**, because stdin is posted verbatim (`bin/inbound.sh:51`). Piping the same payload twice
  looks like two drives and is one. If you hand-roll a curl, stamp it yourself.
- **A 200 is not a turn.** Read the body. `{"ok":true,"ignored":"..."}` means a drop rule caught it,
  and `src/channels/sendblue.js:receive` says which.
- **The send path is unproven on the caged instance** — by design, because that is the cage. Assert
  request shape in `test/sendblue.test.js`, where the adapter's `fetch` is injected. `docs/unverified.md`
  is the standing list of what has never touched the real API.
- **The model is real and not deterministic.** Assert on rows, never on wording.
- `caged.sh` sets `REASON_BURST_QUIET_MS=0` so one webhook answers immediately. If you are testing
  bursts, set it back on purpose.
- The reply is written to `outbox` only when the channel can take it. On the caged instance the
  send fails at dispatch, so an empty `outbox` after a turn is expected — the proof is in
  `conversations`, not `outbox`.
- **The heads-up to the owner on auto-admit is unreachable on the cage — verified-unreachable, not
  verified.** `Router.tellMaster` ends in `this.send(...)`, and `send` opens with
  `#ready(channel)`, which returns not-connected *before* anything is attempted. So on a caged
  instance the heads-up produces no `outbox` row, no adapter call, and **not even a `could not send`
  line** — `#askForAccess` discards tellMaster's return value (`router.js:448`), unlike the
  `ask_master` path twenty lines down which does `if (!r.ok) this.log({ could_not_ask_master })`.
  Driven 2026-10-11: the `auto_admitted` log line appears, the account row appears, the onboarding
  reply appears, and the heads-up leaves nothing whatsoever behind. **The prerequisite is a live
  texting channel**, which the cage exists to deny. Prove it offline against an injected `fetch`
  instead — and note there is currently no test for it at all: `grep -rl 'tellMaster\|handleUnknown'
  test/` is empty, so the whole access flow is unpinned.
