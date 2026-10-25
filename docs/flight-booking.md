# Flight booking through AgentCard

Booking is the second half of the flight feature: search is Fli ([flight-search.md](flight-search.md)),
and a flight the person picks and asks Reason to book goes through AgentCard's hosted purchase API —
the same `POST /buy` loop, cart hash, `purchase_confirm`, confirm gate, caps and passkey approval
as every other purchase. There is no second payment path.

**Dark by default.** `REASON_FLIGHT_BOOKING` is off on live. Off: no booking tool is shown to any
model or runs, `purchase_confirm` refuses a flight row, `purchase` refuses a flight cart, and a search
offers the Google Flights link alone. The first live booking is the owner's decision (below).

## The path chosen

Reason's own AgentCard client (`src/agentcard.js`) is extended, not replaced. The official Node
Commerce SDK (`@agent-cards/commerce-sdk` 0.13.0, read 2026-10-24) wraps the same `/buy` endpoint;
adopting it would replace the audited shopping path (the cart-hash gate, the reconcile reads, the
webhook dedupe) for no capability Reason lacks, so it was read for field names and not installed.
The SDK's `BuyCart`, `BuyTurn`, `BuyFlightItinerary` and `BuyNextAction` types are where every new
field name came from, and each one was then seen on a real sandbox answer.

## What AgentCard's flight flow really does (sandbox, 2026-10-25)

Recorded in `test/fixtures/agentcard-flights/`.

| Cited in the spec or the docs | Seen |
|---|---|
| Flights are a bookable merchant kind with an itinerary and a "book" action | Held. Direct merchant `flights`, "Agentcard Flights", US/USD. Capabilities `checkout, clear_cart, clear_unbooked_cart, cancel_order, vault_payment` — **no `track_order`** (classes, hotels and reservations have it). Catalog items carry `flight.legs` (origin, destination, wall-clock `departureAt`/`arrivalAt`, `cabinClasses`); no flight numbers; ids look like Duffel offer ids (`off_…`). |
| What a flight cart itemizes | One cart line, the fare, as one number. `serviceFeesCents` — 2.5% of the fare both times ($4.33 on $173.14; $3.97 on $158.69) — with `merchantFeeLines: null`, so the fee has no label. AgentCard's own reply calls it "the service fee for booking through here", not refunded on cancellation. **No tax line**; asked, AgentCard said the listing does not say whether the fare includes taxes. |
| Whether the total can be final | `approvedCeilingCents == totalCents` (the card is held for exactly the total, as the SDK docs say for flights), and **no `totalIsEstimate` key at all**. Reason calls a total final only when the estimate flag is not set AND the ceiling equals the total. |
| Fare rules | **None** in the cart; AgentCard said it has none for the fare. Reason says "not verified" every time. |
| Traveler details | `next_action: guest_details` after the pick. Giving the passenger **does not change the cart hash**. AgentCard **saves the passenger on its side** — a second run skipped `guest_details` and went straight to `confirm` with the saved one. So Reason always sends the travelers the person just confirmed and pins them in the confirm target (`travelerFingerprint`). |
| The approval page with a device passkey; 15-minute expiry | **Not seen**: sandbox stops before payment. `approval_expires_at` is read off each paused confirm (field from the SDK's `BuyTurn`) and stored; an expired approval is refused before the gate and sent back for a fresh quote. |
| What a confirmed flight order carries (ticketing status, PNR, e-ticket numbers) | **Not seen, and not documented.** The `flights` merchant has no `track_order`. `TICKETING_FIELDS` in `src/flightbook.js` is empty, so a placed flight order is always "ticketing not confirmed" — never "booked". The first live order's record and every order.* body are kept whole in `agentcard_purchases.order_raw_json`; field names are added only from that. |
| Sandbox stops before payment | Held: `declined`, `decline_code: sandbox_mode`, `charge_status: none`; the conversation read says `last_checkout.status: "denied"` with `total_cents` 17314 (the fare without the fee). |

## The states, kept apart

`quoted` → `approval_pending` → `payment_approved` → `ticketing_pending` → `issued`, plus `reserved`,
`declined`, `expired` (the approval ran out), `outcome_unknown` and `cancelled` (`src/flightbook.js`
`bookingState`). Only `issued` — ticket numbers, from AgentCard's known fields or from the e-ticket
email below — is "booked". A charge, `order_placed`, and a confirmation code (`retailer_order_id`) are
each said as what they are, with "check with the airline". An expired or declined cart, like an
unknown outcome, is never confirmed again; only a fresh `flight_book` and a new yes can.

AgentCard keeps one set of passenger details per person on its side, and every `flight_book` sends
the confirmed travelers explicitly. So an older cart is refused (`travelers_superseded`) once a newer
one was priced for different passengers. Passenger details are sealed at rest (`flight_travelers`)
and sealed out of the action ledger, the decision log and the data export (`privacy.sealTravelers`).

## The e-ticket check (Gmail)

`src/ticketcheck.js`, in the sweep (`runtime.ticketChecks`). Inert while `REASON_FLIGHT_BOOKING` is off.

- **When.** A flight order in `payment_approved`, `ticketing_pending` or `reserved`, for a person with
  Gmail connected. Not connected: the watch closes as `no_gmail`, nothing is read, and they hear the
  booking state's own words.
- **The window.** Checks at 10, 25 and 45 min, then 1h15, 2h, 3h, 4h30 and 6h from the watch's start:
  eight narrow searches. E-tickets normally land minutes after ticketing; the backoff still covers a
  slow ticketing queue without reading a mailbox every sweep, and six hours leaves time to sort it
  out with the airline before most trips.
- **The search.** `after:<order created> "<family name>" <FROM> <TO> {"<carrier>" agentcard} -in:sent
  -in:drafts`, at most 5 messages, read with `messages.get`. Nothing is sent, replied to or labelled.
- **The read.** The small model (`REASON_TICKET_READ_MODEL`, Haiku; CLI fallback) gets one email,
  fenced and marked untrusted, and answers a schema: tickets with the passenger each is for, the
  printed passengers, locator, carrier, airports, date. Code then keeps a ticket only if it's 13
  digits, for one of the order's passengers (family name, plus the given name when one is printed),
  on the order's route and day. A locator counts only when one of their passengers is on the email.
- **Evidence.** A ticket number is a ticket: the watch is `issued` and `bookingState` says booked.
  A locator alone is kept, and the watch goes on.
- **Kept.** `flight_ticket_watch`: ticket numbers, PNR, carrier, Gmail message id, per
  conversation_id. Never a body, subject or sender. In the export and the delete.
- **Said once.** Issued: "your ticket's issued: e-ticket …, confirmation …", straight away. It answers
  something they did, so it skips the notice budget. Nothing by the end: one "no e-ticket email has
  come in … check with <carrier> directly" line. That one spends the notice budget as urgent (it can
  go past the one a day, never past the hard cap) and waits out their quiet hours.
- **Stops** on issued, at the end of the window, or when the order leaves those states.

Pinned in `test/ticket-check.test.js`: issued, PNR only, no email, another passenger's e-ticket
(with an instruction planted in it), Gmail not connected, per-conversation scope, flag off. The
fixtures are Gmail message resources built to the documented shape. Each one's `read` was recorded
through the real reader, and `REASON_TICKET_EVAL=1` re-checks it live.

## The first live booking — the owner's decision

Not done. It needs: `REASON_FLIGHT_BOOKING=1` on live (owner-only use first), a real card in the
owner's vault, and one cheap real fare. It spends real money, the 2.5% booking fee is not refunded,
AgentCard charges Reason's org its 1% commerce fee from the prefunded Balance, and on AgentCard's free
plan it may use up the account's only live order (support has not said whether that is lifetime or
one at a time). Afterwards: read `order_raw_json` and the order.* bodies, fill `TICKETING_FIELDS`
from what is really there, and pin it with a recorded fixture.

## Smoke test

By hand, after an install or upgrade; never scheduled. Sandbox credentials only:
`REASON_FLIGHT_SMOKE=1 AGENTCARD_SMOKE_USER_ID=usr_… node scripts/flight-booking-smoke.mjs .env`
