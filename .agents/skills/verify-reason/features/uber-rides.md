# Uber rides — sign in on your own phone, see the fare, say yes, ride

Somebody says "get me an Uber to the airport". If Uber is not connected, Reason texts a sign-in link;
they tap it on their own phone, approve at Uber (OAuth), and land on a small "you're connected" page.
Then Reason fetches options with an upfront fare, shows price and ETA, waits for a yes, and only then
requests the ride. It can check the ride, cancel it, and fetch the receipt.

Source: `src/uber.js` (`uberStatus`, `authorizeUrl`, `completeConnect`, `accessTokenFor`,
`api`, `quoteView`, `rideView`, `scopeRefusal`, `callbackPage`, `REDIRECT_PATH = /uber/callback`),
`src/tools.js` (`uber_link`, `uber_connect`, `uber_options`, `uber_request`, `uber_ride`,
`uber_cancel`, `uber_receipt`; the gate keys `uber:ride:<quote_id>` and `uber:cancel`),
`src/http.js` (`GET /uber/callback`, and the `uber` block in `/health`), `src/config.js`
(`UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`, `REASON_UBER_SANDBOX`, `UBER_API_BASE`), `src/db.js`
(`uber_rides`, `oauth_tokens`, `oauth_states`).
Find lines: `grep -n 'case "uber_' src/tools.js`.
Tests: `test/uber.test.js` (14 pass) against `test/fixture-uber.js`; the sign-in plumbing in
`test/signin.test.js` (21), `test/signin-window.test.js` (11), `test/signin-remote.test.js` (42).
Shipped in PR #9. (There is no `uber_status` tool: status is `uber.uberStatus()` and the `/health`
block; ride state is `uber_ride`.)

## Sub-features

- **Connect over OAuth on the user's phone.** `uber_link`/`uber_connect` mint a state row and an
  authorize URL; the callback exchanges the code. Two outcomes are distinguished in the log:
  `ride_access` (can_book) and `identity_only` (Uber granted sign-in but not ride scopes).
- **Scope refusal.** A tool whose scope was not granted answers with `scopeRefusal` that names what
  is missing, instead of a raw 403.
- **Options with upfront fare.** `uber_options` returns products and a `quote_id`.
- **Confirm gate.** `uber_request` requires a spent yes; it re-prices (the fare id is almost always
  expired) and shows a moved price again before booking. A quote from another conversation is refused.
- **Status, cancel, receipt.** `uber_ride`, `uber_cancel` (gated), `uber_receipt`.
- **Fails closed unconfigured.** No client id/secret: `uberStatus()` says so and every tool answers
  `not_configured`.

## How to get to it (user POV)

"Get me an Uber home", "how far is my driver", "cancel the Uber". First time: a link, a tap, Uber's
consent screen, a "connected" page, then back in the thread Reason shows the fare and asks.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/uber.test.js                 # 14/14, fixture Uber: real quotes, re-price, 409s
node --test test/signin*.test.js              # 21 + 11 + 42
```

Pinned by these: callback with bad/expired state, identity-only vs ride access, token refresh,
scope refusal, the gate, the quote ownership check.

**The cage** blanks the Uber credentials, so the surface answers `not_configured`. Prove it:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  console.log(JSON.stringify(await runTool("uber_options", {}, { conversationId: "dm:owner", messages: [] })).slice(0,300));
'
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$P/uber/callback?state=nope&code=x"   # not a 5xx
curl -s "http://127.0.0.1:$P/health" | grep -o '"uber":{[^}]*}'
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

**Live, read-only:** `bin/doctor.sh live`; `curl -s https://reason.tail3753c7.ts.net/health` and read
the `uber` block (configured / sandbox flags); journal
`journalctl -u reason --since '24 hours ago' | grep uber_callback`. **Never** call `uber_request`
live: it books a real car.

**End state that proves a connect:** `{uber_callback:"ride_access"}` in the journal and an
`oauth_tokens` row (provider `uber`) for the conversation. A ride: `uber_rides` row
`quoted` → `requested`, with `confirmations` + `action_ledger` rows behind it.

## Gotchas

- The redirect URI (`<public host>/uber/callback`) must be registered in the Uber developer
  dashboard, and `UBER_CLIENT_SECRET` must be present in Hetzner's `.env`. Missing either means the
  link opens and the callback fails; the tests cannot see that.
- `identity_only` is a success from Uber's side and a dead end for rides: check `can_book`.
- Browser sign-in (the old "log into Uber in Reason's browser" path) is dead from Hetzner; don't
  suggest it. See `signin*.js`.
- Sandbox (`REASON_UBER_SANDBOX=1`) uses `sandbox-api.uber.com`; never set it live without saying so.
- 908b38d's commit message mentions "2 pre-existing Uber/signin failures"; at the time of writing
  the files above are all green. If one is red, check `git status` before blaming Uber code.
