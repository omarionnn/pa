# Record a call on request, with notice (REASON_CALL_RECORD_ASK, #590)

A call Reason places for somebody to a business or another person is recorded only when that person
asked for that one call to be, in their own words. On the call the first words to a person say whose
assistant this is and that the call is recorded; afterwards they get the audio.

**Live: `REASON_CALL_RECORD_ASK=owner`** (read 2026-11-18): the operator's calls only
(`recordAskFor`, `src/calls/manner.js:113-118`, `isOperator`). Default off. Everybody else's
`call_place` is exactly as before (no `record_said`).

Source: `src/calls/manner.js` (the offer `RECORD_ASK_OFFER`, `HOLD_RECORD_OFFER`, `RECORD_TIP_LINE`,
`recordNoticeLine`), `src/calls/gptlive.js` (`recordAskTape`, `openingOwed`, `checkRenotice`),
`src/calls/postcall.js` (what of the tape is kept), `src/tools.js` (`callPlaceWithRecording`: `call_place`
gains `record_said`, checked against what they wrote; `call_recording_delete`), `src/db.js` (`calls.record_asked`,
`record_said`, `record_offer`; `accounts.record_tip_told_at`, `call_record_asks`).

## What a person sees

- The offer rides in the same message as "want me to call?" ("I can record it and send you the audio if
  you like; I'd tell them at the start that it's recorded."), never a second round trip. A call that went
  with no question before it adds the offer to the "calling … in 30s" line. Once per person, ever, after a
  call with nowhere to offer it: the tip for next time.
- On the call: the notice is the first thing a person hears; no audio from before it is kept; Spanish when
  the call switches to Spanish. After a long quiet (hold, transfer) or a menu/mailbox and then a person
  again, the notice is owed again; not said → nothing from the quiet on is kept.
- They object → recording stops and everything captured so far is deleted. Words that could not be read
  for an objection are never kept (fails closed).

## Drive

- Offline: `test/call-record-ask.test.js`, `test/call-record-ask-review.test.js` → 35/35 at 18b47891
  (fake Twilio stream, fake GPT-Live).
- In process, no model, no phone (2026-11-18, evidence `*-callrec-video`): under `caged.sh env` with
  `REASON_CALL_RECORD_ASK=owner`, the owner's `call_place` schema carries `record_said` and the owner has
  `call_recording_delete`; another person's `call_place` has no `record_said`.
- Not provable here: a real recorded call (Twilio + GPT-Live, owner-run). Live read (2026-11-18): 6 calls
  since 11-15, none with `record_asked` — the feature has not been used on live yet.
