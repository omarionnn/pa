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
