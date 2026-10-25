# Flight booking — through AgentCard, behind the owner's approval, never "booked" without a ticket

Somebody picks a flight from a flight search and asks Reason to book it. Reason re-checks the fare
through Fli, reads the travelers back and gets a "those are right", builds the booking with
AgentCard, shows the cart's own numbers (and names what the cart does not itemize), asks for a yes
pinned to that exact cart and those exact travelers, sends AgentCard's approval link on its own, and
afterwards says exactly which state the booking is in. **It is DARK**: `REASON_FLIGHT_BOOKING` is off
on live, and off means no booking tool is shown or runs and a search offers the Google Flights link
alone.

Search is the Fli feature (src/flightsearch.js, src/fli.js). Payment is the AgentCard purchase path
([agentcard.md](agentcard.md)) — `purchase_confirm`, the confirm gate, the caps, the passkey pause —
with no parallel payment path.

Source: `src/flightbook.js` (price view, finality, itinerary match, traveler fingerprint,
`BOOKING_STATES` / `bookingState`, `TICKETING_FIELDS`), `src/tools.js` (`flight_traveler_save`,
`flight_traveler_confirm`, `flight_travelers`, `flight_traveler_forget`, `flight_book`;
`flightConfirmRefusal` before the gate and in `purchase_confirm`; `flightPlacedAnswer`; the flight
branch of `purchase_track`; `purchase` refusing a flight cart), `src/db.js` (`flight_travelers`,
sealed; the flight columns on `agentcard_purchases`), `src/purchasesnote.js` (`flightStatusWords`),
`src/http.js` (order.* kept whole on a flight row; the flight wording of an expired approval).
Tests: `test/flight-booking.test.js`. Fixtures: `test/fixtures/agentcard-flights/` — `0-…5-*.json`
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
node --test test/flight-booking.test.js          # all of it offline, recorded fixtures
REASON_FLIGHT_SMOKE=1 AGENTCARD_SMOKE_USER_ID=usr_… node scripts/flight-booking-smoke.mjs .env
```

The smoke script is the ONE live check: by hand, after an install or upgrade, never scheduled. It
reads only the `AGENTCARD_SANDBOX_*` credentials, refuses unless the token says `sandbox: true`, and
ends at the sandbox decline. The sandbox user id is the `user_id` in `/opt/reason-sandbox`'s
`agentcard_users` (`dm:sandbox`).

On the cage every AgentCard credential is blank and the flag is off: `flight_book` answers
`not_available` (flag off) or `not_configured`. That is the cage holding.

## Gotchas

- An approval page, a charge, `order_placed` and a confirmation code are each NOT a ticket. Only
  `bookingState(...).state === "issued"` (a ticketed status AND ticket numbers, from known fields)
  may be called booked.
- `flight_book` refuses on any turn that is not the person's own (`offers.turnState(c).kind`): a
  watch or a suggestion never books.
- The first live booking is the owner's decision (spec Step 6g), once, with one cheap fare. It spends
  real money and, on AgentCard's free plan, may use up the account's only live order.
