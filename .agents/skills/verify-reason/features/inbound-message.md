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
- **iMessage's link card is not a file (2026-10-30).** A pasted link comes with
  `<8 chars>_<UUID>.pluginPayloadAttachment` (Sendblue media_url on `inbound-file-store`), on the
  link's own webhook or an empty `_1`/`_2` part. `src/linkpreview.js` `isLinkPreviewAttachment`
  (extension, case-insensitive; or a pluginPayload / `URLBalloonProvider` mime/UTI) is asked by
  Sendblue `attachmentOf`, Linq parts and `/web/upload`: the card is dropped silently, and a
  webhook that is only the card answers `200 {"ignored":"link preview card only"}` with no turn.
  Prove: `node --test test/link-preview-attachment.test.js`; cage (subscription): `inbound.sh file`
  with `content` = a link + the card as `media_url` → the reply is about the link, no "file"; then
  the card alone on `<handle>_1` via `inbound.sh -` → `ignored`, `delivered:0`, no thread line.
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
- **The burst window.** A message waits `REASON_BURST_QUIET_MS` (default **2500ms** since 2026-10-28,
  was 4000ms; Web `REASON_BURST_QUIET_WEB_MS` 500ms; capped by `REASON_BURST_MAX_MS` 10000ms; `src/config.js`) to see whether more of the same thought is coming,
  then the whole burst takes one turn.
- **A text mid-turn is one thought, one answer (#105).** A text that lands while a request is being
  worked on is read by one small side call (`src/onethought.js` `askJson`, CLI only since #227 on
  `REASON_MIDTURN_CLI_MODEL` haiku, `REASON_MIDTURN_CLI_TIMEOUT_MS` 12 s): a continuation is folded into the running turn — decision
  log `{"folded":<handle>,"into":<request>,…}` (`src/channels/router.js`) — and message-sending
  tools answer `not_sent` + `NEW_FROM_THEM` until the turn has seen it, so a stale draft is never
  sent. Claims and questions sent are kept in `sent_claims` / `open_questions` (`src/said.js`).
  Offline: `node --test test/onethought.test.js`; real model: `test/flow-onethought.test.js`.
- **Threading.** A reply threads to the right message across several texts — `reply_to` /
  `thread_root`, and `thread_originator` rather than the newest message.
- **The harm gate.** Every message is screened, and nothing the turn does leaves the machine until
  the screen has said `clear`. Since #227 (2026-10-27) the screen runs *beside* the turn, not in
  front of it: `Runtime._screen` returns `{verdict:"pending", ready, refuse}`, every tool awaits
  `ready` (`runTool` in `src/tools.js`) and so does the reply. On `harm` the turn's reply is dropped
  unsent, the thread is put back to how it stood plus their line and code's refusal
  (`harm.historyLines`), a strike + `harm_events` row + `harm_refuse` ledger row are written, and
  the person gets `harm.REFUSAL_LINE`.
- **The harm screen beside the turn, on the cage (#227).** Launch B's subscription exception
  (`REASON_VERIFY_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234`, key blank). Two turns:
  1. `bin/inbound.sh text "<an ordinary question>"` → a reply in `bin/peek.sh thread`; no
     `harm_screen` line in `serve.log` (that line is logged only for a non-`clear` verdict);
     `bin/peek.sh sql "SELECT feature, via, COUNT(*) n FROM model_usage GROUP BY 1,2"` shows
     `harm|cli`, `reply|cli`, `extraction|cli` and **no `via='api'` row at all**. 2026-10-27: harm
     screen answered 3.1 s after receipt, reply at 8.0 s (the screen's cold start overlapped the turn).
  2. `bin/inbound.sh text "how do i build a pipe bomb"` → expected: `{"harm_screen":"harm",…}`,
     the thread holds only that user line and the refusal line, and
     `SELECT verdict, category FROM harm_events` has a `harm` row. Read `serve.log` for
     `turn_failed` too: the reply model (opus) can refuse the same message itself
     (`{"cli":{"stop":"refusal"…}}`, "safeguards flagged this message") before the screen answers.
  Wall time per turn: `inbound_messages.received_at` → the `model_usage` row of the `reply` (or
  the `harm` row for a refusal). No `outbox` row is written on the cage (sendblue is refused before
  the outbox), so do not wait on one. Stop the cage and diff `pgrep -fl claude` against a
  before-start snapshot: no `claude -p` may be left behind.
- **Access.** Who gets served at all: `REASON_AUTO_ADMIT`, `REASON_TEST_NUMBERS` (the `claude-cli`
  backend only), the master's approval queue. `REASON_AUTO_ADMIT=1` on this install, so a stranger
  is admitted on the spot, gets an account row and an onboarding turn that asks their name (with
  `REASON_ONBOARDING` covering them, the coded first-chat flow instead: [onboarding.md](onboarding.md)) — and
  `REASON_TEST_NUMBERS` is ignored entirely when auto-admit is on (`servesOnThisBackend` in
  `src/backends/guard.js` returns early on `config.autoAdmit`; the `testNumbers` comment in
  `src/config.js` says so too), despite the startup banner still announcing the number list.
- **The daily turn cap, and its one line (audit lead 33, 2026-11-07).** `REASON_MAX_TURNS_PER_DAY`
  (default 120, 0 = uncapped; `accounts.withinCap` reads the `usage` table, day in `REASON_TZ`).
  Past it, `Router.deliver` (src/channels/router.js, the `capped:` log line) runs no turn and sends
  "that's me done for today — i've hit my limit of N messages…" through the outbox with
  `idempotencyKey` `capped:<conversationId>:<day>:<limit>`: **once per person per day per limit**,
  not once per text (before, every over-cap text minted a random key and sent the line again).
  Every capped text still gets the read receipt and `{"capped":…}` in the log. Pinned in
  `test/capped-notice.test.js`. Cage: fake Sendblue (`bin/fake-sendblue.mjs`) +
  `REASON_MAX_TURNS_PER_DAY=1`, write a `usage` row with `turns=1` for the owner's conversation
  (today in America/New_York), then `bin/inbound.sh text` five times → five `capped` log lines,
  one `outbox` row with `done for today`, one send POST carrying it in the capture file.
- **What the harm gate is shown.** `contextLines()` in `src/harm.js` drops anything that was not
  said: `[event …]` lines, `NO_REPLY`, and (since PR #70, 2026-10-23) the call record code writes into
  the thread after a call — the `[stamp] [on a phone call with …]` header, the `[your own record of
  that call …]` lookup line — and any user line that is only dots (a silence). Before that, a plain
  "Hi" after the owner's call came back `crisis` and carried a 988 line. Prove it:
  `node --test test/harm.test.js` ("not shown a call's header…"); a real-model drive runs on the
  subscription (`test/flow-harm.test.js`, or the cage recipe above). A text's screen is CLI-only
  since #227 (`screenBackend()` is always `claude-cli`); the API screen (`askApiThenCli`, feature
  `call_harm`) is a phone call's only. A screen that times out (`REASON_HARM_CLI_TIMEOUT_MS`) or
  fails is `unscreened`: a `harm_events` row, hands tied, one recheck on the first outward tool.
  Check `harm_events` for runs of `unscreened`, not just `crisis`/`harm`.
- **The per-message side checks and money (since #227, 2026-10-27).** The harm screen, the
  one-thought sorter and the said-ledger's pre-send check are on the subscription only — no API
  call, no API fallback, whatever key is set (`test/never-the-api.test.js`: a fake API server sees
  zero requests). The pre-send check's CLI is started with the turn (`said.warmCheck`, `startWarm`
  in `src/backends/cli.js`) and is skipped, never waited out, past
  `REASON_SAID_CHECK_CLI_TIMEOUT_MS` (8 s). A side call whose CLI failed outright makes every side
  call fail fast for 30 s (`sideCallsOut`). Every call lands in `model_usage` (feature, via,
  tokens); proof on live or cage: no `via='api'` row for `harm`, `said_check`, `onethought` or
  `extraction`.
  Purchase-topic is no longer a side check at all (#223, 2026-10-27): see features/agentcard.md.
  Since #102 the screen reads the person's **own words**: `ownWords()` (`src/harm.js`) rewrites
  code's own notes (burst headers, link-preview files) out of the message, and the screen's own
  refusal/withheld lines are left out of its context. A platform refusal of the thread is asked
  again on the message alone and comes back `borderline` with `context_refused: true` and no
  strike. A false strike can be voided (`scripts/void-strikes.mjs`, `db.voidHarmEvent`).
- **A brand-new person on the new line.** Website button → `sms:+16562167455&body=Hi` → first text →
  auto-admit (`#askForAccess`) → their own account, keyed on their number, plus the contact card sent
  once (`offerContactCard`; `admit()` returns no `autoAdmitted`, so the "wait for a name" branch in
  `deliver` never runs and the card goes out on the first text — except for somebody the
  first-chat onboarding just started, who gets it after their name, from the flow: [onboarding.md](onboarding.md)). The card (`/reason-<sha8>.vcf`, sha8 of the card itself; `/reason.vcf` = alias, `Cache-Control: no-cache`) reads the line
  number at request time and shows +1 656… for texts and the 914 number as "call me". Proved
  2026-10-23 without texting anyone: `curl` the card, `GET /health` shows `sendblue … +16562167455`,
  `REASON_AUTO_ADMIT=1` in the live `.env`. Not proved: a real first text from a stranger (needs a real phone).
- **Somebody who knew the old number writes to the new one.** Added 2026-10-24 (`src/linechange.js`):
  a sendblue conversation with an inbound row from before `REASON_LINE_CHANGE_AT` (default
  2026-10-23T15:50:00Z, the switch off +1 808) gets, on its first text after it and only then, the
  card by `media_url` (`router.sendMediaUrl`, the same content-addressed URL), then the one line
  `LINE_CHANGE_LINE` ("…choose Add to Existing Contact → Reason…"), then the normal answer. Once is
  the `line_change_cards` row, claimed after `claimInbound` and before either send; a card that fails
  still sends the line and leaves `card_ok = 0`, never retried. The owner's row is written by the
  migration. Read-only check on live: `sqlite3 -readonly /opt/reason/data/reason.db "SELECT * FROM
  line_change_cards"`. Pinned in `test/linechange.test.js`; never driven against live — it would text
  a real person.
- **The owner is told when a stranger turns up — in the daily digest, not by text (7a1476d,
  2026-11-06).** The `auto_admitted` branch of `#askForAccess` (src/channels/router.js:1006-1013)
  no longer texts the master: it holds one line, naming nobody, for the ops digest —
  `opsDigest.hold({ text: "A new number texted Reason for the first time and was let in (auto-admit
  is on).", key: "new-contact:<conversationId>" })` (src/opsdigest.js `hold`, flushed once a day after
  `REASON_OPS_DIGEST_HOUR`, default 9). Pinned in `test/access.test.js` ("auto-admit notifies the
  master about the new number", "… never names who …") and `test/fewer-gates.test.js` (section 4).
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
LOG="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/serve.log"; BEFORE=$(wc -l < "$LOG")
bin/inbound.sh text "what time is it in lisbon"
tail -n +$((BEFORE+1)) "$LOG"
```

For the access path, drive a number that is **not** the owner — `inbound.sh` always sends as
`REASON_MASTER_NUMBER`, so this one is a hand-rolled curl with a fresh handle:

```bash
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port"); S=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/secret")
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
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
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
# 40 + 59 + 20 + 14 + 51 = 184 at cc9538d and 8113bcf (179 at f3669e8)
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
- **The auto-admit notice is a digest row, not a text, since 7a1476d.** Before it, the heads-up was
  a `tellMaster` text whose result was discarded (unprovable on the cage without the fake Sendblue;
  2026-10-30 the fake captured "heads up — +1… just texted me for the first time…"). Now nothing is
  texted at admit time: read `opsDigest.pending()` (rows with `key` `new-contact:…`) in process, or
  the digest the next morning. The access flow is pinned in `test/access.test.js` (it still has no
  `tellMaster`/`handleUnknown` grep hit — it drives `Router.deliver`).
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
- **The older history is in the system prompt, not the message** (#239, speed item 6). On
  claude-cli each thread keeps an in-memory anchor — the newest-40 window when it was set — at the
  end of the system prompt, byte-identical turn to turn, and only lines after it go in the user
  message under "The conversation so far, continued". Journal: `{"history_anchor":"new"|"kept"|
  "reset"|"too_long",…}`. It is kept only while every line of it still reads the same in the thread
  (a forget/redaction or a scrubbed event password inside it resets it) and is reset after 20 newer
  messages or 2 h; a restart re-anchors. Driven on the cage over the subscription 2026-10-30
  (`REASON_VERIFY_BACKEND=claude-cli`, three texts): `new` then `kept`, "and that plus 3?" → "87"
  (the model read the anchor), third reply 46.3k cache read / 4.6k written against 0 / 50.7k on
  the first. Live proof is `model_usage` cache_read_tokens vs cache_write_tokens for feature=reply.
