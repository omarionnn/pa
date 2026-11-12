# Uber rides — a link with the trip filled in; they tap Request themselves

Somebody says "get me an Uber to the airport". Since #73–#80 (2026-10-23) a ride is **`uber_link`**:
one link to Uber's web booking page, `https://m.uber.com/go/looking?pickup=<JSON>&drop[0]=<JSON>`
(`src/sites.js:407`), which opens in their browser with both ends filled in. Nothing is requested or
charged until they tap Request. No Uber connection is needed, and `uber_connect` is **refused** for a
ride (`blocked: "not_for_rides"`, `grep -n 'not_for_rides' src/tools.js`) unless they asked to connect their Uber
account itself. The OAuth path (`uber_connect` → `uber_options` → `uber_request`) still exists for
that case: upfront fare, a yes, then a booked car, plus status, cancel and receipt.

Source: `src/sites.js` (the link builder), `src/ridelinks.js` (`withCoords`, and the outbox rebuild
that logs `ride_link_rebuilt`), `src/rides.js` (the NYC boxes and the verified car services),
`src/uber.js` (`uberStatus`, `authorizeUrl`, `completeConnect`, `accessTokenFor`,
`api`, `quoteView`, `rideView`, `scopeRefusal`, `callbackPage`, `REDIRECT_PATH = /uber/callback`),
`src/tools.js` (`uber_link`, `uber_connect`, `uber_options`, `uber_request`, `uber_ride`,
`uber_cancel`, `uber_receipt`; the gate key `uber:ride:<quote_id>`),
`src/http.js` (`GET /uber/callback`, and the `uber` block in `/health`), `src/config.js`
(`UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`, `REASON_UBER_SANDBOX`, `UBER_API_BASE`), `src/db.js`
(`uber_rides`, `oauth_tokens`, `oauth_states`).
Find lines: `grep -n 'case "uber_' src/tools.js`.
Tests: the link in `test/sites.test.js` (46 in the file; the Uber link from ~line 425, "the uber deep link"), `test/rides.test.js`
(5: the NYC geofence and the two verified numbers), `test/ridelinks.test.js` (5: coordinates, the
outbox rebuild, and a log with no link text), `test/uber.test.js` (17) against `test/fixture-uber.js`; the sign-in plumbing in
`test/signin.test.js` (29 on 2026-11-07), `test/signin-window.test.js` (11), `test/signin-remote.test.js` (50; the link itself: [signin-link.md](signin-link.md)).
`test/flow-resend-link.test.js` (#79, needs a model) pins that a link they tap to act on is sent
again, never pointed at. (There is no `uber_status` tool: status is `uber.uberStatus()` and the
`/health` block; ride state is `uber_ride`.)

## Sub-features

- **The ride link.** `uber_link` builds the URL and remembers it (`db.rememberSeenUrls`); it mints
  no state row. Its note says to tell them, in one short line, that it opens in the browser (the
  Uber app ignores pre-filled trips) and the first time they may need to sign in there.
- **The pickup comes from what Reason already knows (#74),** in this order: where they said they are
  in the chat; then `get_location` (a live share, a recent pin, or a saved place — Reason says which
  it used); only then does it ask, with the Share My Location card.
- **Coordinates on both ends (#76).** `withCoords` fills them in: a saved place's own pin first,
  else the address geocoded (network).
- **NYC car service (#73/#75).** A pickup inside the five-borough boxes adds
  `also_offer.car_services` (Dial 7, Carmel). Reason only calls one (`call_place`) on their yes.
- **Every ride link is rebuilt on the way out (#80).** `src/outbox.js` hands any m.uber.com link to
  `src/ridelinks.js`, which rebuilds it with today's builder, so a link copied from earlier in the
  thread never goes out stale. The `ride_link_rebuilt` log line carries lengths and flags only
  (`from_len`, `to_len`, `had_coords`, `had_client_id`) and `ride_link_rebuild_failed` only the
  error's name/code: no link text, address or coordinates reach the journal (until 2026-10-31 it
  logged the link's first 60 characters). Pinned by `test/ridelinks.test.js` ("a rebuild logs
  lengths and flags only"); driven 2026-10-31 in-process under `caged.sh env` through the real
  `Router` + `FakeChannel` with a captured log: rebuilt to `/go/looking`, one
  `ride_link_rebuilt` line, no `uber.com`/address/lat-lng in any logged value (the old code leaked
  `uber.com…`).
- **Connect over OAuth on the user's phone — only when they ask for it.** `uber_connect` mints a
  state row and an authorize URL; the callback exchanges the code. Two outcomes are distinguished in
  the log: `ride_access` (can_book) and `identity_only` (Uber granted sign-in but not ride scopes).
- **Scope refusal.** A tool whose scope was not granted answers with `scopeRefusal` that names what
  is missing, instead of a raw 403.
- **Options with upfront fare.** `uber_options` returns products and a `quote_id`.
- **Confirm gate.** `uber_request` requires a spent yes; it re-prices (the fare id is almost always
  expired) and shows a moved price again before booking. A quote from another conversation is refused,
  and the gate never describes it: its `use_target` reads `unknown uber quote <id>` (no product,
  pickup, destination or fare), because that refusal goes back to the caller before the handler's
  ownership check runs (audit lead 21, `confirmTargetFor` in `src/tools.js`). Quote ids are
  `q_<randomUUID>` (were `q_<Date.now()>_<product prefix>`, guessable), and `recordUberQuote` never
  updates a row owned by another conversation (`WHERE uber_rides.conversation_id = excluded.conversation_id`).
- **Status, cancel, receipt.** `uber_ride`, `uber_cancel`, `uber_receipt`. `uber_cancel` is
  **ledgered, not gated** — it stops a ride rather than spending money (the comment above the ledger list near the top of `src/tools.js`, and its
  schema says so); the fee is said before cancelling.
- **Fails closed unconfigured.** No client id/secret: `uberStatus()` reports `connected: false` with
  `missing: ["UBER_CLIENT_ID", …]`, and every tool answers `notConnected()` —
  `status: "not_connected"`, the same `missing` list, `use_instead: "uber_link"`. (There is no
  `not_configured` status.) Configured but no token row for the thread: also `not_connected`.

- **Uber's row on the status page (`/ops`, `provider:uber`).** Judged from the ledger of Reason's own
  calls to auth.uber.com / api.uber.com; there is no key probe. The connect check
  (`uber.connectReady`) reads Uber's 302 itself, and that redirect counts as a call that worked:
  until 2026-11-12 it was written down as a failure and the row sat amber ("last call failed: HTTP
  302") from 2026-11-10 with nothing wrong. A row already stored that way reads green. A 401/403
  from Uber is still red. Pinned by `test/ops-redirect-not-failure.test.js` (3). The row says
  nothing about Limited vs Full Access: that only shows when somebody connects (`uber_callback`:
  `ride_access` or `identity_only` in the log).

## How to get to it (user POV)

"Get me an Uber home": one link back, with the pickup and the destination already in it; they tap
it, check the trip on Uber's page, tap Request. In NYC Reason also offers to call a car service.
"Connect my Uber" (asked for in so many words) is the only way into the OAuth flow: a link, a tap,
Uber's consent screen, a "connected" page, then fares in the thread.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/sites.test.js test/rides.test.js test/ridelinks.test.js test/uber.test.js   # 69 at 226ff17; 46 + 5 + 5 + 17 = 73 after lead 21
node --test test/signin*.test.js              # 29 + 11 + 44, plus signin-progress (10), which the glob also takes
```

Driven 2026-11-07 (rel/verify-maint, cage :8832, `caged.sh env`): `uber_link` → `/go/looking` url,
`has_pickup`/`has_coordinates` true; `uber_connect` → `not_for_rides`; `uber_options` → `not_connected`
with both `missing`; `/uber/callback?state=nope` → 400; `/health` `uber` block `app_configured:false`.

**The link, on the cage, in-process** (`caged.sh env` exported; pass coordinates so nothing is
geocoded over the network):

```js
await runTool("uber_link", { pickup_latitude: 40.7484, pickup_longitude: -73.9857,
  latitude: 40.6413, longitude: -73.7781, address: "JFK Airport" }, ctx)
// → url "https://m.uber.com/go/looking?pickup=…&drop%5B0%5D=…", has_pickup + has_coordinates true,
//   also_offer.car_services (Dial 7, …) because the pickup is in Manhattan
await runTool("uber_connect", {}, ctx)   // → ok:false, blocked:"not_for_rides"
```

Driven 2026-10-23 at `226ff17`: both answers exactly as above; again 2026-10-27 at `00f3300` (plus the
`not_connected` drive below; the callback answered 400).

Pinned by these: callback with bad/expired state, identity-only vs ride access, token refresh,
scope refusal, the gate, the quote ownership check.

**The cage** blanks `UBER_CLIENT_ID` and `UBER_CLIENT_SECRET`, so the surface answers
`not_connected` with `missing: ["UBER_CLIENT_ID","UBER_CLIENT_SECRET"]`. Prove it:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  console.log(JSON.stringify(await runTool("uber_options", {}, { conversationId: "dm:owner", messages: [] })).slice(0,300));
'
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$P/uber/callback?state=nope&code=x"   # not a 5xx
curl -s "http://127.0.0.1:$P/health" | grep -o '"uber":{[^}]*}'   # app_configured:false, missing, redirect_uri, sandbox
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

**Live, read-only:** `bin/doctor.sh live`; `curl -s https://reason.tail3753c7.ts.net/health` and read
the `uber` block (`app_configured`, `missing`, `redirect_uri`, `sandbox`); journal
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
- The link was tapped on a real iPhone on 2026-10-23 (`docs/unverified.md`, "The Uber ride link —
  verified on a phone"). Still unproven: an iPhone not signed in to Uber, and Android. The Uber
  *app* ignores pre-filled trips, which is why the link is the web page (#78).
- Sandbox (`REASON_UBER_SANDBOX=1`) uses `sandbox-api.uber.com`; never set it live without saying so.
- 908b38d's commit message mentions "2 pre-existing Uber/signin failures"; at the time of writing
  the files above are all green. If one is red, check `git status` before blaming Uber code.
