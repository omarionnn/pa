# Inbound message handling

Somebody texts Reason and gets an answer. Everything else in the product sits on top of this: if a
message does not arrive, is answered twice, or is answered on behalf of the wrong person, nothing
else matters.

Source: `src/channels/sendblue.js` (`verify`, `receive`, `describe`), `src/channels/router.js`,
`src/runtime.js` (`Runtime.inbound`), `src/agent.js` (`runTurn`), `src/harm.js`.
Tests: `test/channels.test.js`, `test/sendblue.test.js`, `test/burst.test.js`, `test/parts.test.js`,
`test/harm.test.js`.

## Sub-features

- **Authentication.** A shared secret in the `sb-signing-secret` header, compared in constant time.
  Wrong or short → 401 and no turn. **Missing** (#64) is not refused outright: `confirmUnsigned` in
  `src/channels/sendblue.js` asks Sendblue's API whether it has that message (same handle and words,
  last 15 minutes) and runs the turn only if it does; otherwise 401. On the cage Sendblue is not
  connected, so a missing header is always 401 (driven 2026-10-23: wrong 401, missing 401).
  Pinned in `test/sendblue.test.js` (the unsigned-webhook tests, ~line 1238).
- **Dropping what is not somebody talking.** Nine webhook types share one account-level URL. Our own
  outbound echo (`is_outbound`), delivery status callbacks, typing indicators, call logs, inbound
  calls, profile and contact events — each acknowledged with 200 and dropped, so Sendblue stops
  retrying and no turn is spent.
- **Groups are never treated as one person's DM.** A non-empty `group_id` → 200, logged as ignored.
  Every account, ledger row and confirmation in Reason belongs to one person.
- **Deduplication.** A retried webhook with a `message_handle` already seen is answered once.
- **Who is the sender.** The `number` field, which the docs define as the end user — not
  `from_number`, even when they match. Normalised to E.164.
- **Non-text parts.** Pictures arrive as pictures the model can see, are written down verbatim
  by a quiet pass alongside the turn (`src/looked.js`) and can be brought back with `photo_look`;
  audio is transcribed; video
  (`.mov`, `.mp4`, `.m4v`, `.avi`, `.webm`, `.mkv`, `.3gp`) is uploaded to Gemini and watched; a
  vCard is downloaded and parsed; a file nobody can open is *described* rather than arriving as an
  empty message. See `attachmentOf`, `cannotReadContactLine`, and [location-share.md](location-share.md).
- **The burst window.** A message waits `REASON_BURST_QUIET_MS` (default **4000ms**, capped by
  `REASON_BURST_MAX_MS` 10000ms; `src/config.js`) to see whether more of the same thought is coming,
  then the whole burst takes one turn.
- **A text mid-turn is one thought, one answer (#105).** A text that lands while a request is being
  worked on is read by one small side call (`src/onethought.js`, `REASON_MIDTURN_MODEL` Haiku, CLI
  fallback on the claude-cli backend): a continuation is folded into the running turn — decision
  log `{"folded":<handle>,"into":<request>,…}` (`src/channels/router.js`) — and message-sending
  tools answer `not_sent` + `NEW_FROM_THEM` until the turn has seen it, so a stale draft is never
  sent. Claims and questions sent are kept in `sent_claims` / `open_questions` (`src/said.js`).
  Offline: `node --test test/onethought.test.js`; real model: `test/flow-onethought.test.js`.
- **Threading.** A reply threads to the right message across several texts — `reply_to` /
  `thread_root`, and `thread_originator` rather than the newest message.
- **The harm gate.** Every message is screened before the model sees a word of it. A harmful one
  gets no turn, no tool, and a refusal in code's own words.
- **Access.** Who gets served at all: `REASON_AUTO_ADMIT`, `REASON_TEST_NUMBERS` (the `claude-cli`
  backend only), the master's approval queue. `REASON_AUTO_ADMIT=1` on this install, so a stranger
  is admitted on the spot, gets an account row and an onboarding turn that asks their name — and
  `REASON_TEST_NUMBERS` is ignored entirely when auto-admit is on (`servesOnThisBackend` in
  `src/backends/guard.js` returns early on `config.autoAdmit`; the `testNumbers` comment in
  `src/config.js` says so too), despite the startup banner still announcing the number list.
- **What the harm gate is shown.** `contextLines()` in `src/harm.js` drops anything that was not
  said: `[event …]` lines, `NO_REPLY`, and (since PR #70, 2026-10-23) the call record code writes into
  the thread after a call — the `[stamp] [on a phone call with …]` header, the `[your own record of
  that call …]` lookup line — and any user line that is only dots (a silence). Before that, a plain
  "Hi" after the owner's call came back `crisis` and carried a 988 line. Prove it:
  `node --test test/harm.test.js` ("not shown a call's header…"); a real-model drive needs the API
  (`test/flow-harm.test.js` skips without a model). The screen asks the Anthropic API first; with no
  credit that returns `unscreened` (live, 2026-10-22 05:35 → 2026-10-23 13:06 UTC, every message).
  Since #72 (`askApiThenCli` in `src/harm.js`), an `unscreened` on a `REASON_BACKEND=claude-cli`
  install — which live is — is screened again by the CLI and tagged `via: "cli_fallback"`; a verdict
  the API did give is never overridden. `unscreened` is final only on an install without the CLI
  backend. Pinned in `test/harm.test.js` ("when the API cannot screen and the install has the CLI…").
  Check `harm_events` for runs of `unscreened` and for `cli_fallback`, not just `crisis`/`harm`.
- **The per-message side checks and money (2026-10-25).** The harm screen, purchase-topic
  (`src/purchasesnote.js`), the one-thought sorter and the said-ledger's pre-send check stay on the
  API on `claude-haiku-5-5` (a cold CLI start would slow every reply), with their instructions sent
  as a cached block (`spend.cachedSystem`) and the CLI behind each when the API cannot answer —
  purchase-topic on its own `REASON_PURCHASE_TOPIC_CLI_TIMEOUT_MS` (12 s), the pre-send check on
  `REASON_SAID_CHECK_CLI_TIMEOUT_MS` (15 s). After one "credit balance is too low" refusal the API is
  skipped for `REASON_API_OUT_PAUSE_MS` (10 min) and the checks go straight to the CLI. The
  said-ledger's *record* (after the reply) runs on the CLI only. Every call lands in `model_usage`
  (feature, via, tokens, est. $). Live proof with no credit on the key: `harm_events`/journal show
  `cli_fallback`, `purchases_topic … "via":"cli"`, `said_check` lines, and `model_usage` rows
  `via='cli'` for `harm`, `purchase_topic`, `said_check`.
  Since #102 the screen reads the person's **own words**: `ownWords()` (`src/harm.js`) rewrites
  code's own notes (burst headers, link-preview files) out of the message, and the screen's own
  refusal/withheld lines are left out of its context. A platform refusal of the thread is asked
  again on the message alone and comes back `borderline` with `context_refused: true` and no
  strike. A false strike can be voided (`scripts/void-strikes.mjs`, `db.voidHarmEvent`).
- **A brand-new person on the new line.** Website button → `sms:+16562167455&body=Hi` → first text →
  auto-admit (`#askForAccess`) → their own account, keyed on their number, plus the contact card sent
  once (`offerContactCard`; `admit()` returns no `autoAdmitted`, so the "wait for a name" branch in
  `deliver` never runs and the card goes out on the first text). The card (`/reason.vcf`) reads the line
  number at request time and shows +1 656… for texts and the 914 number as "call me". Proved
  2026-10-23 without texting anyone: `curl` the card, `GET /health` shows `sendblue … +16562167455`,
  `REASON_AUTO_ADMIT=1` in the live `.env`. Not proved: a real first text from a stranger (needs a real phone).
- **Somebody who knew the old number writes to the new one.** Added 2026-10-24 (`src/linechange.js`):
  a sendblue conversation with an inbound row from before `REASON_LINE_CHANGE_AT` (default
  2026-10-23T15:50:00Z, the switch off +1 808) gets, on its first text after it and only then, the
  card by `media_url` (`router.sendMediaUrl`, the same `/reason.vcf`), then the one line
  `LINE_CHANGE_LINE` ("…choose Add to Existing Contact → Reason…"), then the normal answer. Once is
  the `line_change_cards` row, claimed after `claimInbound` and before either send; a card that fails
  still sends the line and leaves `card_ok = 0`, never retried. The owner's row is written by the
  migration. Read-only check on live: `sqlite3 -readonly /opt/reason/data/reason.db "SELECT * FROM
  line_change_cards"`. Pinned in `test/linechange.test.js`; never driven against live — it would text
  a real person.
- **The owner is told when a stranger turns up.** Added 2026-10-11: the `auto_admitted` branch
  texts the master *"heads up — <who> just texted me for the first time. i don't have them on your
  list yet."* (`#askForAccess` in `src/channels/router.js` — re-grep `heads up`). See the gotcha below — this one cannot be proved on
  the caged instance and has no test.
- **A restart does not eat a text — but only the install Sendblue delivers to may recover it.**
  Added `3c45286` (2026-10-12): once the port is open, `serve.js` calls `SendblueChannel.catchUp()`,
  which pulls the last 90 s of inbound from `GET /api/v2/messages` and feeds anything unseen through
  `router.deliver`; the `inbound_messages` dedupe skips what was already answered. Guarded in
  `wt/catchup-guard`: `ownsWebhook()` first asks `GET /api/account/webhooks` and refuses unless the
  receive list names `${REASON_PUBLIC_URL}/channels/sendblue/webhook` — no public URL, a failed
  call or an unknown shape all count as no, and `serve.js` prints
  `catch-up: skipped for sendblue — <why>`. Why it exists is the gotcha below.

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

Auth, dedup, the dropped webhook types, groups, bursts, threading and the restart catch-up are all
proved offline, without a server, and that is where to assert on them:

```bash
cd ~/Desktop/pa
node --test test/channels.test.js test/sendblue.test.js test/burst.test.js test/parts.test.js test/harm.test.js
# 39 + 59 + 20 + 14 + 47 = 179 at f3669e8 (harm was 39, total 171, at 226ff17)
```

The catch-up on the cage is a **silence**: Sendblue is not connected there, so `catchUp()` returns
`skipped: "not connected"` and `serve.js` says nothing — `grep -c catch-up
$TMPDIR/reason-verify/serve.log` is `0` and that is the pass. On the live instance it is the journal
right after `systemctl restart reason`: `{"inbound":"<handle>","duplicate":true}` for a text it had
already answered (2026-10-12 23:52 ET, the a16z message), or `catch-up: recovered N message(s) from
sendblue restart gap`. The refusal branches are driven in `test/sendblue.test.js` ("catch-up on
restart"): a receive list naming another install, an empty list, no public URL, Sendblue not
answering, and slash/case normalisation.

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
  line** — `#askForAccess` discards tellMaster's return value (`.catch(() => {})` on the
  heads-up call; re-grep `heads up` in `router.js`), unlike the `ask_master` path a couple of
  dozen lines down which does `if (!r.ok) this.log({ could_not_ask_master })`.
  Driven 2026-10-11: the `auto_admitted` log line appears, the account row appears, the onboarding
  reply appears, and the heads-up leaves nothing whatsoever behind. **The prerequisite is a live
  texting channel**, which the cage exists to deny. Prove it offline against an injected `fetch`
  instead — and note there is currently no test for it at all: `grep -rl 'tellMaster\|handleUnknown'
  test/` is empty, so the whole access flow is unpinned.
- **Two installs with one set of Sendblue keys means somebody else answers your texts.** On
  2026-10-12 at 23:52 ET the idle Fly copy (`reason.fly.dev`, deployed by
  `.github/workflows/fly-deploy.yml` on every push to `main`) restarted, its catch-up read the
  owner's "Yeah" out of Sendblue's API, and it replied from a database three days stale — *"i went
  dark after the ghana news on friday…"*, then an Airbnb search nobody had asked for — a minute
  after Hetzner had answered the same text correctly. Sendblue's receive list was Hetzner only the
  whole time; the API, not the webhook, was the way in. How it was proved: Sendblue's own message
  list (`GET /api/v2/messages?created_at_gte=…`) carried the rogue sends, Hetzner's `outbox` did
  not, and `flyctl logs -a reason` showed `catch-up: recovered 1 message(s)`. Fly is scaled to
  zero; `.github/workflows/fly-deploy.yml` itself still triggers on push to `main`, so its
  disabled state lives only in GitHub's workflow settings, not in the repo. The guard is the code
  fix. If it ever happens again, compare the
  Sendblue list with the live `outbox` before blaming the model.
