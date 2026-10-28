# Call goal met — a call that did what it was for counts, with nothing to agree

Call 46 (2026-10-27 20:46 ET): "Reach Jeffrey and ask him to call Omari back." Jeff: "Yeah, this is me." …
"For sure. I will." Nothing to read back, so it settled `dropped_before_confirmation`, `isSuccess` was
false, and stamps (src/stamps.js) never saw a finished errand. Now, after a third-party outbound call
settles with a person reached and nothing agreed, the model reads the transcript against the goal
(claude-cli, `sonnet`, feature `call_goal`, never the API) and a met goal moves the row to `goal_met`
(success, redial "no", label "it got what it rang for"). Bookings still only become `confirmed` through
the read-back gate; the judge says met = false for any book/buy/agree goal. Asked in the background so
a webhook is never held; `call_status` awaits it before it reports.

Source: `src/calls/goalmet.js` (`judgeable`, `judgeGoal`, `settleGoal`, `goalPending`), `src/calls/outcome.js`
(`goal_met`), `src/tools.js` (`settleCall`, `fillLateDetails`, `call_status`, `callView` is_it_done),
`src/stamps.js` (`TALKED`).
Tests: `test/call-goalmet.test.js` (8), `test/call-handling.test.js` (the two-successes test).

## Drive

`REASON_BACKEND=claude-cli node bin/call-goal-drive.mjs calls.json` — real CLI over real rows (a read-only
`sqlite3 -json` of `calls`) plus three built-ins. 2026-10-27: 46 met ("identified himself as Jeffrey …
agreed"), 45 IVR not met, 44 line_silent not asked, wrong number not met, closing-time question met,
cut-off booking not met; ~5–6 s each.
