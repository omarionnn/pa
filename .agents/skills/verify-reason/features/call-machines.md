# Call machines — a recording, a menu or a mailbox is not a person

On a call Reason places for somebody (not the owner's own call), the line opens silent: ElevenLabs is
sent `first_message: ""`, which their docs define as "the agent waits for the user to start". Reason
hears what answered before it says a word. A recorded message, a phone menu, hold music or a mailbox
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

Source: `src/calls/elevenlabs.js` (`place`: `waits`, `openingWaits`), `src/tools.js` (`call_place`
writes `opening_waits`; `settleCall` keeps a machine row's own outcome — `recording`),
`src/calls/hold.js` (`MACHINE_TOOL`, `noteMachineLine`, `openingOwed`, `notePerson`, `WAITING_RULES`),
`src/calls/voice.js` (`holdBack` / `QUIET_ON_A_MACHINE` / `openingIfOwed` in `voiceTurn`, `LINE_OPENED`,
`case "machine_on_the_line"` in `runCallTool`, `endNow`), `src/calls/voice-prompt.js`
(`thirdPartyFrame` `openingOwed`), `src/calls/outcome.js` (`machine_menu`, `machine_recording`,
`machine_dead_end`, `voicemail_full`, `onAMachine`, `answeredByMachine`, `callSummary`),
`src/calls/postcall.js` (`thirdPartyEvent` machine line; no memory extraction from a machine),
`src/db.js` (`calls.opening_waits`, `calls.machine_heard`).

Tests: `test/call-machines.test.js` (14), `test/elevenlabs.test.js` (first message is "" on a
third-party call), `test/call-voice.test.js` (tool list).

Drive (real model, claude-cli, no phone): `bin/call-machines-drive.mjs` — five cases from the real
call-45 words: the Strand's recording → silent `end_call`, `machine_dead_end`, email kept; a person →
disclosure verbatim then the question; a menu → presses 2, `machine_menu`; a voicemail greeting → one
`end_call` message; a hold queue → `skip_turn`, `machine_recording`. 2026-10-27: 5/5 ok.

What the cage and the drive cannot prove: that ElevenLabs really waits silently on `first_message: ""`
for an outbound Twilio call and then hands the first turn over (the agent's own `turn_timeout` is 7 s,
`initial_wait_time` unset), and how its turn detection splits a long recording into turns. Only a real
call shows that — and Reason never places one to test.
