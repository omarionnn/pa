# The hosted browser (DoorDash) — `REASON_REMOTE_BROWSER`

For the people the switch covers, a job on a listed site (default: doordash.com only) runs in a plain
Browserbase session reached over CDP instead of this machine's Chrome. Everything above the browser is
the same code: the job, the browser tools, the private-network guard, the origin pin, the never-list,
the commit gate and spend confirmation, the refusal memory.

**Switch:** `REASON_REMOTE_BROWSER` = off | owner | on (default off). `REASON_REMOTE_BROWSER_SITES`.
Key: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` (env only).

Source: `src/remotebrowser.js` (switch, list, `sessionRequest` pinned body, API client, Contexts,
consent, metering, budget, failure words, `challengeOn` / `stopIfChallenged`), `src/browser.js`
(`launchProfile({ site })`, `pageFor(c, { url })`, `hostedErrand`), `src/tools.js`
(`hosted_browser_ok`, `hostedNoLink`, challenge stops in `browser_open/read/click/type/submit`, the
runner's `RemoteBrowserError` answer, deletes in `account_revoke` / `saved_login_forget`),
`src/signinemail.js` + `src/signin-remote.js` (emailed-code sign-in opens hosted for a tagged entry;
the phone link never does), `src/filler.js` (saved login: hosted refusal keys, no second go),
`src/refusing.js` / `src/sitefindings.js` (`browser: "remote"` keys), `src/data.js` (tables, delete).
Tests: `test/remote-browser.test.js` (fake Browserbase on loopback + local Chromium over CDP).

## What to check

- Off (or a person it does not cover): tool list, capabilities and SYSTEM hash the same as main; no
  request to Browserbase from any path.
- First use: one consent sentence, nothing opened; `hosted_browser_ok` only on their own words, own turn.
- A job: the session request equals `sessionRequest(...)`; the Context is made once and reused; every
  session is released (`REQUEST_RELEASE`) on close, error, cap and challenge; `remoteSessionsOpen()` 0.
- A challenge / block page: stop at once, mark `doordash.com~hosted`, one plain line, no click, no retry.
- Failures (key missing/invalid, unreachable, out of minutes, start timeout, busy): plain words, a
  digest line, no local fallback.
- Forget / revoke / data delete: `DELETE /v1/contexts/{id}` at Browserbase.
- Live: ONE smoke only, on the owner's say-so (costs browser minutes); never type a real login.

## DoorDash orders on it (`src/doordash.js`, `REASON_DOORDASH_PAY` = handoff | site_card)

- Tools (covered people with food on only): `doordash_order` start / address / checkout / status; `doordash_place` (site_card only).
- Steps: the playbook in `src/playbooks.js` ("doordash"). Code reads the checkout: breakdown, total, ETA, every item, the address, the tip.
- handoff: never pressed (doordash_place refuses; browser_submit, browser_click on Place order and Enter on the checkout refuse on hosted DoorDash).
- site_card: confirm gate pinned to `doordash order #id rN: $total from X to address`; the checkout is loaded fresh and re-read before the press; a moved total is a new ask; caps and the daily cap apply; CVV/3-D Secure after the press stops it.
- Stops: unavailable (asked), alcohol / ID, verify identity or phone, account or payment problem, card re-verification, challenge.
- Tests: `node --test test/doordash-order.test.js test/remote-browser-filler.test.js` (fixture DoorDash on loopback, fake Browserbase, local Chromium over CDP).
