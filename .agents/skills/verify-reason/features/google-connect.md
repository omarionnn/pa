# Connecting Google: calendar, Drive files, and mail when a task needs it (google_connect)

Somebody asks about their calendar or mail, or asks to connect Google. Reason texts a link; they open it,
prove it is them (a texted six-digit code in a browser that is not signed in), and Google's own page shows
what is granted. Reason never takes a password. Several Google accounts can be connected; each is its own grant.

No switch: on for everybody wherever `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are set
(live: set, read 2026-11-18).

Source: `src/google.js` (the rules at the top: scopes, revoking one account, **the 100-user cap**, refresh
token limits; `authorizeUrl` at `:411`, `completeConnect` at `:612`, `accountsFor`, `disconnect`,
`accessTokenFor`), `src/tools.js` (`google_connect` at about `:6320`, its case at about `:17129`;
`google_accounts`, `google_disconnect`), the shared browser-bound start page `/connect/start` (#358, see
[security-boundaries.md](security-boundaries.md) and `bin/oauth-connect-drive.mjs`), route `/google/callback`
(`googleCallbackRequest` in `src/http.js`). Table `oauth_tokens` (provider `google`, one row per account).

## What a person sees

- **The link** is Reason's own `/connect/start?state=…` page, one use, 15 minutes. A browser that is not
  signed in gets the code gate first ("Text me the code"); then Google's consent screen.
- **The first screen** asks for the calendar (`calendar.events` + `calendar.calendars.readonly`), Drive
  only for files Reason makes (`drive.file`) and who they are; **Gmail only when a task needs it** (a link
  that names the missing scope). Another account added later gets the chooser and does not replace the first.
- **Google's warning:** the app is unverified, so Google may show "Google hasn't verified this app": they
  tap Advanced, then continue (the tool's `google_may_warn` tells the model to say so). If Google refuses
  them outright, the app is in Testing and their address is not on the test-user list.
- **The cap:** an unverified External app has a lifetime cap of 100 Google accounts (not people; one person
  with three accounts spends three). Only the Cloud console's "OAuth user cap" shows the real count.
- A made-up `state` or an `access_denied` callback → a 400 page, nothing connected.

## Drive

- Offline: `test/google.test.js`, `test/google-accounts.test.js`, `test/oauth-binding.test.js`,
  `test/oauth-token-seal.test.js`, `test/continue-with-google.test.js`, `test/calendar-conflict.test.js` →
  200/200 at 18b47891 (`test/fixture-google.js` stands in for Google's token endpoint).
- In process + the cage's HTTP, no real Google (2026-11-18, evidence `*-google-connect`, fake client id
  `GOOGLE_OAUTH_CLIENT_ID=cage-client…`): a brand-new non-owner's `google_connect` → `url` on `/connect/start`
  with `state`, `scopes` calendar.events + calendar.calendars.readonly + drive.file + identity, `google_may_warn`
  present, 15 min; GET of that page on the cage with no cookie → 401 with the code box (gate holds);
  `/google/callback` with a made-up state → 400, `access_denied` → 400, no `oauth_tokens` row.
  The code → Google hop is the same page `bin/oauth-connect-drive.mjs` walks for GitHub.
- Not provable here: Google's real consent screen, the unverified-app warning, the cap. Live read
  (2026-11-18, counts): 3 Google accounts connected, all on one conversation (the operator's); nobody else
  has connected Google on live yet.
