# Typing-aware replies (`REASON_TYPING_AWARE`)

`off | owner | on`, default `off`. Code: `src/typingaware.js`; the one hook is where a text's hold is
taken in `src/channels/router.js` (`typingHeld`, `#typingHold`). Tests: `test/typing-aware.test.js`.

## What it does

| Situation | off (today) | owner / on |
| --- | --- | --- |
| A text arrives, no typing event from this person in the last 30 s (webhook missing or down, forged events, a pasted text) | fixed pause (`REASON_BURST_QUIET_MS`, 1.0 s live) | the same fixed pause, exactly |
| They were heard typing that text | fixed pause | up to `REASON_TYPING_GRACE_MS` (default 300 ms, never more than 1000) for a new "typing" to arrive, then the turn starts |
| A "typing" arrives after the text, before the turn starts | fixed pause | turn held for their next text, which joins it; asked again after it |
| A "typing" arrives while the turn is working | reply sent when ready | the SEND is held for their next text, which the mid-turn read folds into the same reply |
| Typing stops, nothing sent | n/a | turn starts / reply is sent at once |
| Still "typing" after 15 s (30 s in all for one turn, start and send together) | n/a | reply anyway |
| The turn started early and the reply is ready within 3 s of their text | n/a | sent no sooner than today's pause would have sent it |
| More arrives while a turn is running | folded mid-turn (`src/onethought.js`) | unchanged |

A "typing" heard **before** a text is taken to be that text being written and never holds a reply:
Sendblue's docs do not say whether a "stopped" event is sent when a message is sent, so only a
"typing" that arrives after the newest text counts as the next one. One that arrives after it but
that Sendblue stamped before the text was sent is that text too, arriving late, and holds nothing.

Reason's own "…" bubble is unchanged: it already goes up when a text is held and stays through the
turn (`src/typing.js`, `POST /api/send-typing-indicator`, renewed in 30 s chunks, stopped after the
reply). Sendblue's account-level "auto typing indicator" setting is not used and not needed.

## Replay of real traffic (2026-11-12): is quality the same or better?

`scripts/typing-replay-extract.py` reads timing only from the live database, read-only (when each
text arrived, when each outbound was created and sent; no words, no addresses, conversation ids
replaced by a salted hash). `scripts/typing-replay.mjs` runs those timelines through each policy.
30 days, 16 conversations, 1,184 texts. A **burst** is a follow-up within 60 s with nothing sent in
between; words are not read, so every one is counted as if it continued or corrected the text
before it (the worst case for a faster policy). **Split** = a reply had already been SENT when the
follow-up arrived. Held or folded mid-turn = one reply.

Texts: 1184 in 16 conversations. Bursts (a follow-up within 60 s with nothing sent in between): 122. Follow-ups after a reply (not counted): 202. Lone texts: 630. Median turn: 19752 ms.

| policy | bursts: held / folded / SPLIT | answered as one reply | lone text wait, median / p90 | waited to the cap | quality vs today |
| --- | --- | --- | --- | --- | --- |
| today: fixed 1.0 s | 0 / 121 / **1** | 121/122 (99.2%) | 1000 / 1000 ms | 0 | — |
| fixed 0.3 s (other open change) | 0 / 119 / **3** | 119/122 (97.5%) | 300 / 300 ms | 0 | WORSE (+2 split) |
| typing-aware AS FIRST PUSHED, signals missing | 0 / 118 / **4** | 118/122 (96.7%) | 0 / 0 ms | 0 | WORSE (+3 split) |
|   " signals 0.3 s late | 0 / 119 / **3** | 119/122 (97.5%) | 300 / 300 ms | 0 | WORSE (+2 split) |
|   " signals 1 s late | 0 / 119 / **3** | 119/122 (97.5%) | 300 / 300 ms | 0 | WORSE (+2 split) |
|   " signals 2 s late | 0 / 119 / **3** | 119/122 (97.5%) | 300 / 300 ms | 0 | WORSE (+2 split) |
| typing-aware NOW, signals missing | 0 / 121 / **1** | 121/122 (99.2%) | 1000 / 1000 ms | 0 | same |
|   " signals 0.3 s late, 300 ms window | 0 / 121 / **1** | 121/122 (99.2%) | 300 / 300 ms | 1 (11248 ms) | same |
|   " signals 1 s late, 300 ms window | 0 / 121 / **1** | 121/122 (99.2%) | 300 / 300 ms | 1 (11948 ms) | same |
|   " signals 2 s late, 300 ms window | 0 / 121 / **1** | 121/122 (99.2%) | 300 / 300 ms | 1 (12948 ms) | same |
|   " signals 0.3 s late, no window | 0 / 121 / **1** | 121/122 (99.2%) | 0 / 0 ms | 1 (11548 ms) | same |
|   " signals 1 s late, no window | 0 / 121 / **1** | 121/122 (99.2%) | 0 / 0 ms | 1 (12248 ms) | same |
|   " signals 2 s late, no window | 0 / 121 / **1** | 121/122 (99.2%) | 0 / 0 ms | 1 (13248 ms) | same |
|   " signals 1 s late, 1000 ms window | 0 / 121 / **1** | 121/122 (99.2%) | 1000 / 1000 ms | 1 (11248 ms) | same |
|   " typing only in the last 6 s, 1 s late, 300 ms window | 0 / 121 / **1** | 121/122 (99.2%) | 300 / 300 ms | 0 | same |

Reading it:

- Today's 1.0 s pause holds none of the 122 bursts at the start; all are caught by the mid-turn
  fold. (The one split is a text that never got a reply; it is the same under every policy.)
- The 0.3 s pause alone loses 2 bursts today's pause catches: follow-ups that landed in the last
  0.7 s before the reply went out. 2 of 122 in 30 days.
- Typing-aware as first pushed was worse than today (3 more with no signals, 2 more with them): it
  started the turn before a "typing" could arrive and never looked again. Fixed by (a) keeping
  today's pause when nothing has been heard from the person, (b) asking again before the send,
  (c) the 3 s send floor. With those it is the same as today at every signal delay and with
  signals missing, and a lone text starts 0.7 s sooner when the person was heard typing it.
- "Better than today" cannot be shown from stored data: a burst today already split looks, in
  timing, like an answer to Reason's reply (202 such follow-ups, not counted either way).
- The cost side: one turn in 30 days would have waited 11-13 s at the cap for a text that came
  later. With real signals that depends on how long people type without sending, which is unknown.
- With the 2.5 s pause that was in force for part of the month (`--real-hold=2500`) the verdicts
  hold: 0.3 s same, typing-aware with signals 6 fewer split, with signals missing the same.

What only real signals can show (the hourly line, after the webhook is registered): whether events
arrive at all, how late, whether "stopped" is sent on send or on a deleted draft, whether a
"typing" is repeated while somebody keeps typing (one that is not expires after 30 s), and how
often a reply waits to the cap for nothing.

## What is kept about typing

- In memory only, in this process: per person, whether they are typing and when the last event and
  text arrived. Keyed by a per-process keyed hash of the address, so the map holds no phone number.
  Gone 30 s after the last event.
- Never written to the database or a file. No journal line per event. Not used for anything but
  timing a reply.
- Logged: one line an hour of counts and medians (`typing_aware`, only when there was anything to
  count), and one line per reply that was actually held: `{typing_hold: <why>, waited_ms[, at: "send"]}`
  with `<why>` one of `more | not_typing | stopped | cap`. Neither says who typed or when.

## Step 1: observe before turning it on

With the switch **off**, a verified typing webhook is accepted and only counted. After the webhook
is registered, one line an hour appears in the journal:

```
{"typing_aware":"off","window_ms":…,"events":…,"starts":…,"stops":…,"refused":…,
 "messages":…,"messages_after_typing":…,"typing_still_on_at_message":…,
 "median_typing_to_message_ms":…,"median_message_to_typing_ms":…,"median_event_lag_ms":…,
 "holds":0,…}
```

How to read it:

- `events` 0 after the phone test → the account is not delivering typing webhooks; leave the switch off.
- `refused` > 0 with `events` 0 → they arrive but do not verify (secret mismatch); leave it off.
- `median_event_lag_ms` → how far behind Sendblue's own timestamp an event arrives.
- `median_message_to_typing_ms` → how soon after a text the next "typing" shows up. This is what
  `REASON_TYPING_GRACE_MS` should be set from (set it to 0 if events are quick and you want no window).
- `typing_still_on_at_message` vs `messages_after_typing` → whether Sendblue sends "stopped" on send.

### Registering the webhook (owner's word needed; nothing in this change registers anything)

Checked read-only on 2026-11-12 (`GET /api/account/webhooks`): the account has one `receive` webhook
(`https://app.heyreason.com/channels/sendblue/webhook`), a `globalSecret`, and **no**
`typing_indicator` webhook. The docs list `typing_indicator` as a webhook type with no plan
restriction (the plan note on that page is about the separate auto-typing setting).

Run on the live host, from `/opt/reason`, with the keys read from `.env` (never echoed):

```sh
set -a; . ./.env; set +a
curl -sS -X POST https://api.sendblue.com/api/account/webhooks \
  -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \
  -H "sb-api-secret-key: $SENDBLUE_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhooks":["https://reason.tail3753c7.ts.net/channels/sendblue/webhook"],"type":"typing_indicator"}'
```

- `POST` appends. Do **not** use `PUT`: it replaces every webhook on the account, the `receive` one included.
- No per-webhook secret is given on purpose: the account's `globalSecret` applies, and it is the one
  this machine already verifies `receive` deliveries with (`SENDBLUE_WEBHOOK_SECRET`). An event that
  does not verify is answered 401 and ignored.
- It is the same path texts arrive on; the handler tells the two apart by `is_typing`. The `receive`
  webhook is registered on `app.heyreason.com`; either host reaches the same listener.
- To undo: the same call with `-X DELETE`.
- Confirm with `curl -sS https://api.sendblue.com/api/account/webhooks -H … ` (prints the global
  secret: do not paste the output anywhere).

### The phone test (owner, on iMessage, after registering; switch still off)

1. Type a text to Reason for a few seconds, send it.
2. Start typing another, wait five seconds, delete it without sending.
3. Send two texts a couple of seconds apart, typing the second straight after the first.

Then read the next hourly `typing_aware` line (or restart-free: wait for the hour). Expect
`starts` ≥ 3, `stops` ≥ 1, `refused` 0. If it looks right: `REASON_TYPING_AWARE=owner`, restart,
repeat the three steps and look for `typing_hold` lines (`more` for step 3, `stopped` for step 2)
and `hold_ms` near 0–300 in `reply_timing` for step 1.
