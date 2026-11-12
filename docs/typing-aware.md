# Typing-aware replies (`REASON_TYPING_AWARE`)

`off | owner | on`, default `off`. Code: `src/typingaware.js`; the one hook is where a text's hold is
taken in `src/channels/router.js` (`typingHeld`, `#typingHold`). Tests: `test/typing-aware.test.js`.

## What it does

| Situation | off (today) | owner / on |
| --- | --- | --- |
| A text arrives, no typing events from this person in the last 30 s | fixed pause (`REASON_BURST_QUIET_MS`, 1.0 s live) | turn starts at once |
| They typed that text (events are arriving) | fixed pause | up to `REASON_TYPING_GRACE_MS` (default 300 ms, never more than 1000) for a new "typing" to arrive, then the turn |
| A "typing" arrives after the text | fixed pause | reply held for their next text, which joins the same turn; asked again after it |
| Typing stops, nothing sent | fixed pause | reply at once to what there is |
| Still "typing" after 15 s (30 s in all for one held turn) | n/a | reply anyway |
| Webhook not registered, down, unsigned or forged | n/a | same as "no typing events": turn starts at once |
| More arrives while a turn is running | folded mid-turn (`src/onethought.js`) | unchanged |

A "typing" heard **before** a text is taken to be that text being written and never holds a reply:
Sendblue's docs do not say whether a "stopped" event is sent when a message is sent, so only a
"typing" that arrives after the newest text counts as the next one.

Reason's own "…" bubble is unchanged: it already goes up when a text is held and stays through the
turn (`src/typing.js`, `POST /api/send-typing-indicator`, renewed in 30 s chunks, stopped after the
reply). Sendblue's account-level "auto typing indicator" setting is not used and not needed.

## What is kept about typing

- In memory only, in this process: per person, whether they are typing and when the last event and
  text arrived. Keyed by a per-process keyed hash of the address, so the map holds no phone number.
  Gone 30 s after the last event.
- Never written to the database or a file. No journal line per event. Not used for anything but
  timing a reply.
- Logged: one line an hour of counts and medians (`typing_aware`, only when there was anything to
  count), and one line per reply that was actually held: `{typing_hold: <why>, waited_ms}`
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
