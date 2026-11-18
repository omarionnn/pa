# Sites that refuse software-driven browsers (Netflix) — said up front

Some sites turn away any browser run by software, Reason's included, whatever the login (Netflix
answered every submit "Something went wrong. Please try again in a few minutes.", from the server and
from a home connection). Reason does not disguise its browser, so for such a site it says so before
any save link or Face ID ask, hands the person the site's own page for what they asked, and, when
their mail is connected, answers from the site's own emails.

**Switch:** none of its own; it lives inside the saved-login paths, so it reaches only people
`REASON_SAVED_LOGINS` reaches (**live: owner**; see [saved-logins.md](saved-logins.md)).

Source: `src/refusing.js` (seed list, `refusingSite`, `markRefusing` strikes, `reachedForm`,
`clearRefusal`, `DEEP_LINKS`, `refusalAnswer`), `src/filler.js` (asks before launching; marks a wall or
a twice-seen generic error; clears on any account-level answer), `src/loginintake.js`
(`savedLoginRoute` → `{ refusing }`, `saveOfferFor` skips them), `src/tools.js`
(`saved_login_offer`, `account_signin`, `signin_status` via `vaultSigninFor`; `mailFor`), tables
`site_refusals` / `site_wall_strikes` (per site, never per person; `src/data.js`).
Tests: `test/signin-refusing.test.js` (12), `test/save-google-login-1115.test.js` (the Google strike),
`test/remote-browser.test.js` (the hosted keys), plus refusing cases in `test/signin-ux.test.js`,
`test/vault-pin.test.js`, `test/filler.test.js`, `test/signin-route.test.js`.

## Sub-features

- **The up-front answer (#565).** `account_signin`, `saved_login_offer` and `signin_status` for a
  refusing site answer `result: "refuses_software"` with fixed words: "<Site> turns away browsers run
  by software, including mine, so I can't sign in there. It isn't about your login." + "Here's
  <Site>'s own page for that, to finish in the <Site> app or your own browser:" + the link. Nothing
  opened, no save link, no Face ID ask, the saved login left as it is, no "try anyway" offer.
- **The site's own page for the task.** `DEEP_LINKS` (Netflix only, checked by hand 2026-11-13):
  cancel → `/cancelplan`, sign out everywhere → `/manageaccountaccess`, billing → `/BillingActivity`,
  profiles → `/account/profiles`, plan → `/account/membership`; nothing matched → `/account`; a site
  with no map gets "You can do it in the <Site> app or your own browser."
- **Answered from their mail.** Gmail connected → one more line "I'm also checking your <Site> emails
  for what I can answer from them." and a note telling the model to `gmail_search` the site's mail now,
  without asking.
- **Strikes vs marks (#566).** Walls are often intermittent, so one wall or challenge is a STRIKE
  (`site_wall_strikes`), not a mark. A second one at least 10 min after the first (`STRIKE_GAP_MS`)
  with nothing reached in between marks the site for 7 days; reaching the form forgets a single wall.
  The generic error after a submit twice, and the seed (netflix.com, 2026-11-13), are believed 30 days.
  Any account-level answer (signed in, wrong password, a code asked) clears the site at once. A
  wall-marked site's words say what was seen: "<Site> has turned my browser away the last two times I
  tried, so I can't sign in there right now."
- **Google turning the browser away (#592).** Google's own "This browser or app may not be secure" /
  "Couldn't sign you in" in a Continue-with-Google job is a `browser_refused` strike against google.com, the
  same strike rule (two, 10+ min apart → marked 7 days; any account-level answer from Google clears it).
  `strikeOn(site)` reads a single strike still inside its 7 days; saving the Google login says a mark or a
  strike first, as a question ([saved-logins.md](saved-logins.md)); no site is said to refuse Reason without
  one of these records.
- **The hosted browser keeps its own memory (#596).** For a site the hosted browser carries
  ([hosted-browser.md](hosted-browser.md)), every call takes `{ browser: "remote" }` and its rows sit under
  `<site>~hosted` (`HOSTED_SUFFIX`): a wall Reason's own browser met says nothing about the hosted one, and
  back. The hosted browser tries once, so its first wall, challenge or generic refusal (`hosted_refused`)
  marks the site at once, believed 7 days; no seed applies there.

## How to get to it (user POV)

Owner only: "cancel my netflix" → the up-front lines + Netflix's cancel page (+ "checking your
Netflix emails" with Gmail connected). A site that walls Reason twice, 10+ min apart, gets the
"turned my browser away the last two times" lines for a week.

## Driving it with the harness

Offline (slot gate): `node --import ./test/paid-key-guard.js --test test/signin-refusing.test.js`.
In process under `caged.sh env` (no model, throwaway DB): `refusingSite("www.netflix.com")` → the
seed, gone after 30 days; `markRefusing(site, "wall", t)` → nothing at t and t+5 min, a mark at
t+11 min, gone after 7 days, cleared by `clearRefusal`; `refusalAnswer` for "cancel my netflix" →
`/cancelplan`, for a bill with mail → `/BillingActivity` + the mail line (2026-11-14 at 7d5b5f54).
On a cage without a key service the tools stop earlier ("Not available."), so the tool path is
proved only offline.

## Gotchas

- The seed lives in code (`SEEDS`), not a row: `_resetRefusals()` empties both tables and Netflix is
  still refusing. Clearing the seed writes a newer `cleared` row, which wins over it.
- The rows hold a domain, an evidence word and a time — no person, no page text. Keep it that way.
