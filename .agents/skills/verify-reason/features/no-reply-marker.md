# NO_REPLY never reaches a person

`NO_REPLY` is how the model says "stay silent". Whatever it wrote, the word itself is never texted,
shown on Web, or kept in a history row.

## What a person sees

- A reply whose only content is the marker: nothing at all.
- A real reply with the marker anywhere in it — its own last line (#265), a middle line, inside a
  sentence (#272): the reply without it. A list item that was only the marker goes, number and all.
- A link, an address, an identifier or code that contains the token (`…/NO_REPLY/…`,
  `NO_REPLY@BANK.COM`, `REASON_NO_REPLY`, `` `NO_REPLY` ``, a fenced block): exactly as written.

## Where it is decided

One function, `withoutNoReply` in `src/plain.js`, called at every outbound choke point, each with a
path name in its `{"no_reply_stripped":"<path>"}` log line (never the message):
`reply` (`src/deliver.js`), `outbox` / `outbox_parts` (`src/outbox.js`, before the row is written,
so history is clean too), `send_now` and `media_url` (`src/channels/router.js`). Only markers left:
deliver returns `silent` and the turn ends the way a held-back turn does (`silent_reply` log, said
record with an empty reply); a reminder is not retried for it. A queued row that is only markers is
`skipped` (`db.markOutboundSkipped`), never `failed` — no failure notice, and a part queued behind it
still goes. Calls are separate: `withoutSilenceMarker` in `src/calls/voice.js` (#68, #265) on GPT-Live,
and on Cartesia calls (live `REASON_CALL_CARTESIA=on`) `forVoice` in `src/calls/cartesia.js` (#564):
`VOICE_MARKERS` — `NO_REPLY`, `[silence]`, `[no reply]`, spoken skip sentences, tool names — come out
of Reason's words before the voice gets them; other snake_case words are said as words. Pinned in
`test/call-cartesia-feel.test.js`.

## Drive

Offline: `node --import ./test/paid-key-guard.js --test test/no-reply-midtext.test.js test/no-reply-sanitizer.test.js`
(20; every outbound path asserted on what the channel was handed).

Caged, real Sendblue adapter against `bin/fake-sendblue.mjs` (loopback only):

```bash
node bin/fake-sendblue.mjs 8834 /tmp/nr/capture.jsonl ok &        # check its "fake sendblue on" line; under an agent runner a bare `&` dies with the command — start it under setsid (perl POSIX::setsid) and lsof the port
REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:8834 bin/caged.sh start
eval "$(bin/caged.sh env | sed 's/^/export /')"
# from the repo: db.enqueueOutbound rows on channel sendblue to the owner —
#   "booked for 7\nNO_REPLY\nsee you there", "**NO_REPLY** — NO_REPLY", "the real words" (afterId = the
#   previous one), "…/settings/NO_REPLY/off and `NO_REPLY` stays" — then wait a few sweeps (~60 s: the rows behind the skipped one went a sweep later, 2026-10-30)
bin/peek.sh sql "SELECT id, state, last_error FROM outbox ORDER BY id"
```

End state (2026-10-30, #272): capture POSTs `booked for 7\nsee you there`, the link line unchanged,
`the real words`; rows sent / **skipped** ("only NO_REPLY: nothing to send") / sent / sent; serve.log
`{"no_reply_stripped":"send_now"}`, `{"no_reply_stripped":"send_now","dropped":true}`,
`{"outbox":2,"skipped":"only NO_REPLY"}`. Then `bin/caged.sh stop` and stop the fake.
Same end state 2026-11-14 at `7d5b5f54` (rows 1–4 sent/skipped/sent/sent, the three capture bodies
exactly as above, the three log lines).
