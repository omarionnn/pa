# Account jobs — cancel a subscription, pay a bill, inside their own account; owner only on live

"Cancel my X subscription" and "pay this bill" finished by Reason itself, through Crossmint's Agent
Checkouts in the person's own browser profile. Design, Crossmint's documented limits and the sign-in
order: `docs/account-jobs.md`.

**Live: `REASON_ACCOUNT_JOBS=owner`** (off | owner | on; code default off). On for a person only with the
switch AND the shopping path on for them (`CROSSMINT_SERVER_KEY` + `REASON_SHOP_CONNECT`):
`accountjobs.jobsAllowedFor(c)` (`src/accountjobs.js:59`). Never on a call, switch on or off:
`NEVER_BY_VOICE` (`src/tools.js:10109`: account_cancel, account_cancel_confirm, account_bill_pay,
account_signin, account_job_answer, browser_proof) → `blocked: "never_by_voice"`, "Not done: this is never
done on a call. Say in one line that you'll do it by text right after the call…".

## Sub-features (user POV)
- **Cancel** (`account_cancel` → `account_cancel_confirm`): the run's cap is `0.000001` (Crossmint refuses 0),
  so the cancel can never pay; a payment question on a cancel run is declined with no payment row. The yes
  is pinned to job, plan, site, run and question.
- **Pay a bill** (`account_bill_pay`): through the pay path with the daily cap and Face ID.
- **Where to go** (`src/accountplace.js`, #554): found from their own mail (a manage link, a biller, the
  account) or one short question; a manage link goes first.
- **Done rules** (`OUTCOME_TABLE` / `VERDICTS`, `src/accountjobs.js:151`; one done/not-done table everywhere):
  `done` = the page showed the new state AND the merchant's own confirming mail arrived; `done_result_only`
  = the page showed it, no mail connected; **`already_done` = "Done, already so"**: the page already showed
  it cancelled / paid, nothing changed or paid, quoted with the page's own line (`alreadyLine`: "Done: Premium
  at Streamco was already set to end on Dec 3, so I didn't change anything; you keep access until then.
  Streamco's page says: "…"."); `waiting_mail` = "page says cancelled, no mail yet" is **not confirmed**, mail
  checked every 10 min for a day, and a day with no mail closes as "page said so, no email came"
  (`mailNeverLine`). The run reports through fixed result lines (`RESULT: CANCELLED NOW` / `ALREADY CANCELLED`
  / `NOT FOUND` / `PAID` / `ALREADY PAID`).
- **Sign-in routes**: saved profile, emailed code read from mail, texted code asked once, the protected
  page texted once; the merchant's block codes.
- **Proof pictures** (`browser_proof`, `src/proofshot.js`, #554): one masked, cropped, sealed picture of the
  page Reason finished on, only where it lets them CHECK something (`PICTURE_FOR`: a cancellation notice, a
  paid/receipt confirmation, a changed plan, a confirmation number, a site error; `pictureForJob`); cropped to
  the proving block clear of payment/invoice/address/email rows, else no picture. Never a sign-in page, a
  page with a secret box (shown or not), a full card or bank number, or a crop naming someone else they have
  on record (`refusedLine`: "I didn't take a picture: the page shows a full card or bank number."). One per
  result (5 min); exported and deleted with their data; pruned with the content retention window. The
  switch is `proofAllowedFor` (`src/tools.js:10104`): the tool is LISTED for every model, and refused in
  `runTool` for anyone the switch does not reach (`blocked: "not_enabled"`, `text_only: true`).

## Driving it with the harness
- Offline: `node --test test/account-jobs.test.js test/proofshot.test.js` (green 2026-11-14 in the g2 pass; 76/76 on `18b47891`, 2026-11-18).
  What they pin: tools shown only with the switch; the cap and task; the pinned yes; each sign-in route;
  "page says cancelled, no mail yet" is NOT done; already-so endings; the bill with the daily cap; every
  not-done line; the crop rules, refusals, export/delete/retention, never by voice, the switch.
- In process, no network (2026-11-14, `REASON_ACCOUNT_JOBS=owner`, throwaway DB, every fetch throws;
  `money-probe.mjs` in the evidence): owner sees all 6 job tools, another account 0; another account's
  `browser_proof` → `not_enabled`; every voice-barred job tool and `browser_proof` on a call → `never_by_voice`; `CANCEL_CAP`,
  the cancel task's already-cancelled branch, the `already_done` verdict and line, `pictureForJob`, the card
  number / sign-in page / other-person refusals — 12/12. Again 2026-11-18 on `18b47891` (`caged.sh env`, fake
  Crossmint keys, every fetch throwing): the owner's 6 job tools (`account_cancel`, `account_cancel_confirm`,
  `account_bill_pay`, `account_job_answer`, `account_job_status`, `account_job_stop`), another account 0;
  `browser_proof` listed for both, `not_enabled` for the other; all 6 `NEVER_BY_VOICE` names refused on a call.
- Live, without side effects: on the live server (OVH, root@15.204.113.250) import
  `/opt/reason/src/accountjobs.js` with `REASON_DB_PATH` on a temp file and `fetch` stubbed; print the create
  body for a cancel (cap, `browser.profileId`, task); `jobsAllowedFor(<owner>)` true, anyone else false.

## Gotchas
- Never drive a real `account_cancel` or `account_bill_pay` on live without the owner: the first signs in
  to their account and can end a subscription on a yes; the second charges the card on approval.
- The model-facing words: `ACCOUNT_JOB_TOOL_DEFS` in `src/accountjobtools.js`; the lines people are sent:
  `notDoneLine`, `alreadyLine`, `resultLine`, `mailLandedLine`, `mailNeverLine` in `src/accountjobs.js`.
- `browser_proof` being listed for everyone is not a leak: its `runTool` case refuses first. Check
  `proofAllowedFor`, not `toolsFor`, when proving the switch.
