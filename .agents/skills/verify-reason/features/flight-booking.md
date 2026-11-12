# Flight booking — no booking route; the reusable parts are dark

**Reason does not book flights.** AgentCard's flight route (`flight_book`, the flight branches of
`purchase_confirm`, the sandbox fixtures, the smoke script) was removed 2026-11-11: the owner's
decision is that Crossmint is the only buy route. No Crossmint flight route exists yet — it has not
been proven with a real run (`docs/flight-booking.md` says what was read and the run that settles it).

What is left is what a route will reuse: the traveler tools, the booking states, the e-ticket check.
All of it is dark for every value of `REASON_FLIGHT_BOOKING`, because `bookingEnabled(c)`
(`src/flightbook.js`) needs the flag AND a route, and `bookingRoute()` is null. Tests stand a route
in with `flightbook._setRoute("test")`; nothing else may.

What to check, any flag value: `toolsFor(c)` has no `flight_book` and none of the four
`flight_traveler_*` tools; `flight_search`'s description says "SEARCH ONLY — Reason never books";
`flight_traveler_save` → `blocked: not_available`; `purchase` on an AgentCard flights catalog and
`purchase_confirm` on a flight row or flight cart → `blocked: flight_not_here`, nothing sent.
`node --test test/flight-booking.test.js test/ticket-check.test.js` pins all of it.

**Everything below this line was written for the AgentCard route and is history**, kept for the
traveler, state and e-ticket behaviour it still describes; anything about `flight_book`, a fresh
quote, AgentCard's cart or its approval link no longer exists.

Search is [flight-search.md](flight-search.md).

Source: `src/flightbook.js` (price view, finality, itinerary match, traveler fingerprint,
`BOOKING_STATES` / `bookingState`, `TICKETING_FIELDS`), `src/tools.js` (`flight_traveler_save`,
`flight_traveler_confirm`, `flight_travelers`, `flight_traveler_forget`, `flight_book`;
`flightConfirmRefusal` before the gate and in `purchase_confirm`; `flightPlacedAnswer`; the flight
branch of `purchase_track`; `purchase` refusing a flight cart), `src/db.js` (`flight_travelers`,
sealed; the flight columns on `agentcard_purchases`), `src/purchasesnote.js` (`flightStatusWords`),
`src/http.js` (order.* kept whole on a flight row; the flight wording of an expired approval).
The e-ticket check: `src/ticketcheck.js` (sweep `runtime.ticketChecks`, table `flight_ticket_watch`) — see
`docs/flight-booking.md` "The e-ticket check".
Tests: `test/flight-booking.test.js`, `test/ticket-check.test.js` (Gmail fixtures in
`test/fixtures/gmail-tickets/`, model reads recorded 2026-10-25). Fixtures: `test/fixtures/agentcard-flights/` — `0-…5-*.json`
RECORDED from the AgentCard sandbox on 2026-10-25, `constructed.js` built from them and labelled so.

## What the real AgentCard flight flow is (sandbox, 2026-10-25)

- Merchant slug `flights`, "Agentcard Flights", US/USD; capabilities `checkout, clear_cart,
  clear_unbooked_cart, cancel_order, vault_payment` — **no `track_order`**.
- Search → `needs_input` + catalog of `off_…` offers with `flight.legs` (origin, destination,
  wall-clock departureAt/arrivalAt, cabinClasses). No flight numbers.
- Pick → ONE cart line (the fare), `serviceFeesCents` = 2.5% of the fare with `merchantFeeLines:
  null`, no tax line, `approvedCeilingCents == totalCents`, **no `totalIsEstimate` key**.
  `next_action: guest_details`.
- Passenger → same cart, **same hash**. AgentCard saves the passenger on its side; a second run
  skipped `guest_details` entirely and reused it. Hence Reason always sends the confirmed travelers,
  and pins them in the confirm target.
- No fare rules anywhere. Confirm on sandbox → `declined` / `sandbox_mode` / `charge_status: none`.
- What a PLACED flight order carries (ticketing status, PNR, ticket numbers) has never been seen.
  `TICKETING_FIELDS` is empty, so nothing is ever read as a ticket and a placed order is always
  "ticketing not confirmed". The first live booking's order record is kept whole in
  `agentcard_purchases.order_raw_json` — read it, and only then add field names.

## How to get to it (user POV)

"find me a flight to boston on the 12th" → options with a Google Flights link → "book the 8am one"
→ traveler details → read-back → "yes" → itemized price → "yes book it" → approval link → passkey.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/flight-booking.test.js test/ticket-check.test.js   # 36 + 17 offline (1 skipped: the live reader) at f3669e8; 35 + 17 when merged with #115/#116; 36 + 17 (1 skipped) on 2026-11-07
REASON_TICKET_EVAL=1 REASON_BACKEND=claude-cli ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-name-pattern=live test/ticket-check.test.js  # the real reader, 3 emails, on the subscription (~42 s through the lane; passed 2026-10-25)
REASON_FLIGHT_SMOKE=1 AGENTCARD_SMOKE_USER_ID=usr_… node scripts/flight-booking-smoke.mjs .env
```

The smoke script is the ONE live check: by hand, after an install or upgrade, never scheduled. It
reads only the `AGENTCARD_SANDBOX_*` credentials, refuses unless the token says `sandbox: true`, and
ends at the sandbox decline. The sandbox user id is the `user_id` in `/opt/reason-sandbox`'s
`agentcard_users` (`dm:sandbox`).

On the cage every AgentCard credential is blank and the flag is off: `flight_book` answers
`not_available` (flag off) or `not_configured`. That is the cage holding. Driven 2026-10-25:
`flight_book {search_id, option, traveler_ids}` and `flight_travelers` → `blocked: not_available`
with "hand over the Google Flights link"; `checkTickets()` → all zeros, no tell. (A call missing
`traveler_ids` fails schema validation before the flag check — that is not the flag leaking.)
`toolsFor("dm:owner")` → 254 tools, none of `FLIGHT_BOOKING_TOOLS`, and `flight_search` still says
"SEARCH ONLY". Driven the same again at the merge with #115/#116 (254, `not_available` twice,
`checkTickets` all zeros, `ANTHROPIC_API_KEY` blank in the drive process since `caged.sh env` blanks it).
Tool counts drift as tools are added — compare the booking-tool count (0 or 5), not the total: on
2026-10-30 (feat/first-chat-onboarding) off → 255 owner / 249 other, `1` → 260 / 254, `owner` →
260 / 249. Again 2026-11-07 (rel/verify-maint, `REASON_SHOP_CONNECT` unset): off → 255 owner, 0
booking tools, `not_available` twice, `checkTickets` all zeros; `owner` → 260 with 5, other 0,
`flight_traveler_save` → `confirmed:false` + `read_back`, the other conversation's save →
`not_available`. In a worktree with no `.env`, `flight_traveler_save` throws "REASON_TOKEN_KEY is not
set": export a throwaway `REASON_TOKEN_KEY=$(openssl rand -hex 32)` for the drive process.

**The flag on, in one drive process on the cage only** (never in `/opt/reason/.env`):
`REASON_FLIGHT_BOOKING=1 node --env-file-if-exists=.env -e '…'` with `caged.sh env` exported. The
cage server itself stays off; only that one node process sees the flag. `toolsFor` → 259 with all
five booking tools; `flight_traveler_save {given_name, family_name, born_on:"YYYY-MM-DD", gender:"m"|"f",
email, phone}` → `confirmed:false` and a `read_back`; `flight_travelers` lists it for `dm:owner` and
returns `[]` for any other conversation; `bin/peek.sh sql "select * from flight_travelers"` shows
`details` as `enc:v1:…` with no name, birth date, email or phone in the clear; `flight_book` on a
search that doesn't exist → "There is no option 1 in flight search 1". Driven so 2026-10-25 at the
#111 merge with #112, and every value above again on 2026-10-27 at `00f3300`. (The field is `born_on`, not `date_of_birth`, and gender is lower-case.)

**Owner-only, one drive process per value** (`caged.sh env` exported, `REASON_FLIGHT_BOOKING=<v> node
--env-file-if-exists=.env drive.mjs`). Driven 2026-10-25 for the `owner` value: `owner` → `dm:owner`
259 tools with all 5 booking tools and "Two ways to finish"; any other conversation 248 with 0 and
"SEARCH ONLY"; `flight_traveler_save` as the owner → `ok`, `confirmed:false`, a `read_back`; as anyone
else `flight_traveler_save` and `flight_book` → `blocked: not_available`. `1` → both have 5. Empty →
neither has any. `checkTickets()` all zeros each time. Pinned in `test/flight-booking.test.js`
("REASON_FLIGHT_BOOKING=owner …") and `test/ticket-check.test.js` (only the owner's order is watched).

## Gotchas

- An approval page, a charge, `order_placed` and a confirmation code are each NOT a ticket. Only
  `bookingState(...).state === "issued"` (ticket numbers from AgentCard's known fields, or an
  e-ticket email for one of the order's passengers on its route and day) may be called booked. A PNR
  alone never is. An e-ticket email counts only once AgentCard has PLACED the order: while it is
  `payment_approved`, a matching ticket may be one they bought themselves off the Google Flights
  link, so that Gmail id is set aside for good (`flight_ticket_watch.not_ours`) and the watch goes on
  (`ticket_before_placed` in the log); only an e-ticket email read after the order was placed counts.
- The "check with the airline" text names the ORDER's carrier, never the carrier field an email
  gave (that is kept as a field only): no email text ever reaches their phone.
- Before `flight_book` sends passengers to AgentCard it writes their fingerprint to
  `ops_state` `flight:passengers_sent:<conversation>`; a cart priced for other passengers is then
  `travelers_superseded` even if that later `flight_book` failed and left no row. A per-person
  delete removes the key.
- An "issued" text that fails to send is retried every 5 minutes under the same key
  (`dueTicketWatches` includes `issued` with no `told_at`); an owed "check with the airline" is
  dropped once the order is cancelled, declined or expired.
- The e-ticket email is read on the subscription when the backend is `claude-cli` (live): through the
  background lane (`ticket:<n>` in `background.status().waiting`), `api: false`, feature
  `ticket_check` in `model_usage`, and `runtime.ticketChecks` runs the pass off the sweep's path
  (`{ started: true }`) so a reminder never waits behind it. Only the API backend reads it on Haiku.
- The e-ticket check never runs on the cage in a useful way: it needs a flight order (flag on) and a
  connected Gmail. Prove it offline; the live read of the fixtures is the gated eval above.
- Passenger details appear as `[sealed]` in `action_ledger`, the `--log` decision log and an export —
  that is `privacy.sealTravelers` working, not lost data; `flight_travelers` holds them, sealed.
- An expired or declined flight cart is `expired`/`declined` and is never confirmed again; a newer
  quote for different passengers refuses the older cart (`travelers_superseded`).
- `flight_book` refuses on any turn that is not the person's own (`offers.turnState(c).kind`): a
  watch or a suggestion never books.
- The first live booking is the owner's decision (spec Step 6g), once, with one cheap fare. It spends
  real money and, on AgentCard's free plan, may use up the account's only live order.
