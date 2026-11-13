# Account jobs — cancel a subscription, pay a bill, inside their own account; DARK

"Cancel my X subscription" and "pay this bill" finished by Reason itself, through Crossmint's Agent
Checkouts in the person's own browser profile. Design, Crossmint's documented limits and the sign-in
order: `docs/account-jobs.md`.

**It is DARK.** On for a person only with `REASON_ACCOUNT_JOBS` (off | owner | on; default off) AND the
shopping path on for them: `accountjobs.jobsAllowedFor(c)`.

Offline proof: `node --test test/account-jobs.test.js`. What it pins: tools shown only with the switch;
the cancel run's cap (`0.000001`, because the API refuses 0) and task; the yes pinned to job, plan,
site, run and question; a payment question on a cancel run declined with no payment row; each sign-in
route (saved, emailed code from mail, texted code asked once, the protected page texted once); the
merchant's block codes; "page says cancelled, no mail yet" is NOT done; the bill through the pay path
with the daily cap; every not-done line.

Live proof without side effects: import `/opt/reason/src/accountjobs.js` with `REASON_DB_PATH` on a
temp file and `fetch` stubbed; print the create body for a cancel (cap, `browser.profileId`, task).
`jobsAllowedFor(<owner>)` true and `jobsAllowedFor(<anyone else>)` false with `REASON_ACCOUNT_JOBS=owner`.

Never drive a real `account_cancel` or `account_bill_pay` on live without the owner: the first signs in
to his account and can end a subscription on his yes; the second charges his card on his approval.
The model-facing words: `ACCOUNT_JOB_TOOL_DEFS` in `src/accountjobtools.js`; the lines people are sent:
`notDoneLine`, `resultLine`, `mailLandedLine`, `mailNeverLine` in `src/accountjobs.js`.
