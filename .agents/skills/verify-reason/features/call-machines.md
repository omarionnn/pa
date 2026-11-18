# Call machines — a recording, a menu or a mailbox is not a person

On a call Reason places for somebody (not the owner's own call), the line opens silent: GPT-Live says no
greeting and `dialGptLive` returns `openingWaits` (the row gets `opening_waits=1`), with Twilio's async
answering-machine verdict on `/calls/gptlive/amd/<token>`. Reason hears what answered before it says a word. A recorded message, a phone menu, hold music or a mailbox
gets no disclosure and no talking: Reason names it with `machine_on_the_line`, presses the key that
reaches a person when the menu offers one, waits within the hold budget, and is hung up by code at once
when the recording says nobody can be reached by phone (or a mailbox takes no messages). What the
recording said that the owner can use (an email address, hours) is kept on the row and given to the
recap. The disclosure is put by code, word for word, in front of Reason's first words to the first
person who actually speaks; nothing it writes is streamed until the round's tools show it is talking to
somebody.

Why: live call 45 to the Strand, 2026-10-27 20:32 ET. The disclosure went out at pick-up over the
store's 90-second recorded hours message (cut off at 4 s); at 94 s Reason said "This is a recorded
message, and it says they aren't taking customer phone inquiries" out loud into it; no key was pressed;
the menu timed out into ext. 199 ("not accepting new messages"); the Strand hung up at 108 s; the row
said "they answered". Fixture: `test/fixture-call45.js`.

Source: `src/calls/gptlive.js` (`dialGptLive`: `openingWaits`, AMD; `GptLiveCall` line turns), `src/tools.js` (`call_place`
writes `opening_waits`; `settleCall` keeps a machine row's own outcome — `recording`),
`src/calls/hold.js` (`MACHINE_TOOL`, `noteMachineLine`, `openingOwed`, `notePerson`, `WAITING_RULES`),
`src/calls/voice.js` (`holdBack` / `QUIET_ON_A_MACHINE` / `openingIfOwed` in `voiceTurn`, `LINE_OPENED`,
`case "machine_on_the_line"` in `runCallTool`, src/calls/voice.js:1042, acting on `noteMachineLine`'s `endNow`, src/calls/hold.js:183,201), `src/calls/voice-prompt.js`
(`thirdPartyFrame` `openingOwed`), `src/calls/outcome.js` (`machine_menu`, `machine_recording`,
`machine_dead_end`, `voicemail_full`, `onAMachine`, `answeredByMachine`, `callSummary`),
`src/calls/postcall.js` (`thirdPartyEvent` machine line; no memory extraction from a machine),
`src/db.js` (`calls.opening_waits`, `calls.machine_heard`).

## Mailbox not set up or full → one text (#379, 2026-11-07)

Calls 62/63 (2026-11-01): "…has not been set up yet. Goodbye", 6 s, and the owner heard nothing useful.
Now the after-call read's `how: voicemail_not_set_up` moves the row to `voicemail_full`
([call-goal-met.md](call-goal-met.md)), and `tellTheOwner` (src/calls/postcall.js:225) hands an errand
row with that kind to `tellUnreached` (src/calls/postcall.js:283): code's words, not the model recap, so
the daily proactive cap cannot swallow it; claimed on `calls.unreached_told_at` (src/db.js:2278) before
anything is queued, outbox key `call:<id>:unreached`, `toOwner`. Body: "i rang (646) 858-0667 to ask
about … but it went to a voicemail box that isn't set up or is full — so it didn't reach anyone and no
message was left. want me to try again later, or text them instead?" (`about` = `calls.pickup_about`,
see [gptlive-calls.md](gptlive-calls.md) "Pickup opener"). Log `call_unreached_told`. A second settle
answers `already told`; no texting channel on the conversation → nothing.

Driven 2026-11-07 (no model, no network, throwaway DB, rel-1107 `8bbcb96`): first `tellTheOwner` sent,
the model recap stub (which throws if called) never ran, the second answered "already told", exactly
one outbox row with the body above.

Tests: `test/call-pickup.test.js` (calls 62/63 → one text), `test/call-machines.test.js` (19 at `8113bcf`; 18 at `cc9538d`; 14 at first), `test/gptlive-thirdparty.test.js` (silent opening, AMD), `test/call-voice.test.js` (tool list).

Drive (real model, claude-cli, no phone; never on the cage, never the API): `bin/call-machines-drive.mjs` — five cases from the real
call-45 words: the Strand's recording → silent `end_call`, `machine_dead_end`, email kept; a person →
disclosure verbatim then the question; a menu → presses 2, `machine_menu`; a voicemail greeting → one
`end_call` message; a hold queue → `skip_turn`, `machine_recording`. 2026-10-27: 5/5 ok.

What the cage and the drive cannot prove: how GPT-Live's turn detection splits a long recording into
turns on a real line (`gptlive-line-drive.mjs` plays a synthetic one, with a real OpenAI key). Only a real
call shows that — and Reason never places one to test.
