# Call goal met — a call that did what it was for counts, with nothing to agree

Call 46 (2026-10-27 20:46 ET): "Reach Jeffrey and ask him to call Omari back." Jeff: "Yeah, this is me." …
"For sure. I will." Nothing to read back, so it settled `dropped_before_confirmation`, `isSuccess` was
false, and stamps (src/stamps.js) never saw a finished errand. Now, after a third-party outbound call
settles with a person reached and nothing agreed, the model reads the transcript against the goal
(claude-cli, `sonnet`, feature `call_goal`, never the API) and a met goal moves the row to `goal_met`
(success, redial "no", label "it got what it rang for"). Bookings still only become `confirmed` through
the read-back gate; the judge says met = false for any book/buy/agree goal. Asked in the background so
a webhook is never held; `call_status` awaits it before it reports.

## The same read names how the call went (#379, 2026-11-07)

Before: 16 of 18 calls (ids 58–75) settled `dropped_before_confirmation` — mutual goodbyes, both
unset mailboxes (62, 63), a 4-second hang-up. The one read (still sonnet, side lane, same cost) now
also returns `how` (`HOW`, src/calls/goalmet.js:21): talked / hung_up_early / voicemail_not_set_up /
voicemail_greeting / recording / unsure, and `kindFrom` (src/calls/goalmet.js:77) maps it
(`KIND_FOR`, src/calls/goalmet.js:34): talked → `picked_up` (errand) or `talked` (their own call),
hung_up_early → `hung_up_early`, voicemail_not_set_up → `voicemail_full`, voicemail_greeting →
`voicemail_no_message`, recording → `machine_recording`, unsure → left as is. Machine answers win
first (`MACHINE_HOW`); **their own call is read too but is never `goal_met`** (no seal on the book for a
chat), even when `met` is true. A booking call (cleared to book, or with a commitment) is still settled
only by the read-back gate; only a machine answer can relabel it. New kinds in `src/calls/outcome.js`
(`picked_up` :61, `talked` :66, `hung_up_early` :71). `settleGptLive` (src/calls/gptlive.js:2417) waits up
to `GOAL_WAIT_MS` 30 s (src/calls/gptlive.js:2414) for the read before telling the owner; a
`voicemail_full` errand then gets one code-worded text instead of the recap — see
[call-machines.md](call-machines.md) "Mailbox not set up".

Source: `src/calls/goalmet.js` (`HOW`, `KIND_FOR`, `kindFrom`, `judgeable`, `judgeGoal` :92, `settleGoal` :120,
`goalPending`), `src/calls/outcome.js` (`goal_met` :38, `picked_up`, `talked`, `hung_up_early`, `isSuccess`
:358), `src/tools.js` (`settleCall`, `fillLateDetails`, `call_status`, `callView` is_it_done),
`src/stamps.js` (`TALKED`).
Tests: `test/call-goalmet.test.js` (8; updated in #379 for own calls and `how`),
`test/call-pickup.test.js` (outcome mapping), `test/call-handling.test.js` (the two-successes test).

## Drive

`REASON_BACKEND=claude-cli node bin/call-goal-drive.mjs calls.json` — real CLI over real rows (a read-only
`sqlite3 -json` of `calls`) plus three built-ins. 2026-10-27: 46 met ("identified himself as Jeffrey …
agreed"), 45 IVR not met, 44 line_silent not asked, wrong number not met, closing-time question met,
cut-off booking not met; ~5–6 s each (before #379; that drive predates `how` and reads only `met`).

No model, no network (2026-11-07, rel-1107 `8bbcb96`): `kindFrom` on a throwaway DB — errand
voicemail_not_set_up → `voicemail_full`, voicemail_greeting → `voicemail_no_message`, recording →
`machine_recording`, hung_up_early → `hung_up_early`; own talked → `talked`, own met → `talked` (not
`goal_met`); all ok. `node --test test/call-goalmet.test.js test/call-pickup.test.js` 23/23.
