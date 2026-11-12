# Flight booking

**Reason does not book flights today.** Search is real ([flight-search.md](flight-search.md)) and ends
at the Google Flights link, where the person picks the flight and pays the airline or agent
themselves. There is no booking route.

- **AgentCard's flight route was removed on 2026-11-11.** The owner's decision: Reason does not use
  AgentCard, and Crossmint is the only buy route. Gone: the `flight_book` tool, the AgentCard search →
  pick → passenger → cart conversation behind it, the flight branches of `purchase_confirm`, the
  recorded sandbox fixtures and the smoke script. It had never placed a live order.
- **No Crossmint flight route is built**, because it has not been proven with a real run (below).
  Nothing here is built on a guess.

## The switch

`REASON_FLIGHT_BOOKING` (off | owner | on, default off) is still read, and on its own it now shows
nothing: `bookingEnabled` (`src/flightbook.js`) needs the flag **and** a booking route, and
`bookingRoute()` is null. So for every value of the flag: no traveler tool is shown to any model or
runs (`blocked: not_available`), a flight search says "SEARCH ONLY", and the e-ticket check reads no
mail. A route that is built and proven names itself in `src/flightbook.js`, and the flag then means
what it always did — `owner` is the owner's own conversation only, `1/true/on/yes` is everyone.

Two refusals keep a flight from being bought through AgentCard while its general shopping code is
still in the tree: `purchase` refuses a cart or catalog from AgentCard's `flights` merchant, and
`purchase_confirm` refuses any flight row or flight cart before the gate, so nothing is sent and no
yes is ever collected for one (`blocked: flight_not_here`).

## Can Crossmint book a flight? Read, not proven

Read on 2026-11-11 from docs.crossmint.com (`llms.txt`, `llms-full.txt`, and the Agent Checkouts
pages: overview, how it works, quickstart, configure, answer questions, pay, statuses, test, check a
price, common questions).

| Question | What the docs say |
|---|---|
| Which Crossmint product does Reason's shopping use? | **Agent Checkouts** (`/api/unstable/agent-checkouts`, production keys only), with Agent Cards order intents for the payment (`src/shopconnect.js`). |
| Is there a flights product? | **No.** The whole documentation has no page and no sentence about flights, airlines, passengers or travel. The older "Worldstore" flights flow (production flights on approval from Crossmint's team) is not in the docs any more. |
| Could Agent Checkouts do it anyway? | On paper, yes: it "works on any merchant website where a person can buy online", with no merchant list and nothing to enable. It takes a start URL (a product, search or home page) and a task in words, asks form questions when the site needs something, and stops at a payment request for approval. An airline or travel site is such a website. Nothing in the docs says one has been tried. |
| Passenger details | Asked as form questions (`awaiting_input`), each with an expiry; a buyer profile carries only name, contact and shipping address, so date of birth and gender as on the ID would be asked for or sent in the task. |
| The price | **One number.** The payment request carries `amount` (`exact`, or `maximum` when the site showed no final total — then it is the cap, not a price). No fare, tax or fee lines; any breakdown is the checkout agent's prose. |
| A confirmed order | `result.purchase.kind`: `receipt_captured` with `receipt.total` and, "when available", `receipt.merchantOrderId`; or `confirmed_without_receipt` with nothing. **No ticket numbers and no per-passenger fields.** The airline's own email is the only place a ticket number would appear, which is what the e-ticket check below reads. |
| Ways it stops | `merchant.access_blocked`, `merchant.human_verification_required` (a CAPTCHA it cannot do), `merchant.no_safe_path`, `policy.max_cost_exceeded`, `input_expired`. Airlines defend their booking pages hard; these are the likely ones. |
| Testing without buying | Documented: run to the payment step, read the amount, **do not answer the payment request**, cancel (`POST …/{runId}/cancel`). Or set `maxCost` below the price. Each started checkout counts against the 1,000 free a month. |

**The real run was not made.** It needs Reason's production Crossmint server key
(`CROSSMINT_SERVER_KEY`). It is not in any env file on the build machine (the repo's local `.env` has
no Crossmint keys), and the live server, which has it, was off limits while another deploy was running. No Crossmint
Console change is needed for it: the key's existing `agent-checkouts.*` scopes are the ones a price
check uses, and a server key cannot create an order intent, so it cannot pay even by mistake.

### The run that settles it

One checkout, as a Crossmint user with no saved card and no browser profile, so no payment can
follow:

1. Start URL an airline's own site (or a search page for it); task: one adult, one way, a named
   domestic route and date a few weeks out, the cheapest main-cabin fare, no extras, **go to the
   payment page and stop, do not pay**; `maxCost` a little above the fare.
2. Answer the passenger questions with clearly fake, valid-format details.
3. At the payment request, record it and cancel. Never answer it.

What to write down: every question asked and its fields, whether `amount.kind` is `exact`, how long it
took, and which blocked code ended it if one did. What a confirmed order carries can only be seen on
a real booking; until one is seen, "booked" comes from the e-ticket email and nothing else.

### If it passes: the shape of a Crossmint route

Built on the shopping path, not beside it: `startCheckout` → `step` (questions) → `recordPayment` →
the confirm gate (`shop_pay`) → the per-person daily cap → the passkey approval → the order intent
(`src/shopconnect.js`, `src/passkey.js`, `src/spendcap.js`). What a flight adds is already here:
confirmed travelers and the fingerprint that pins the yes to who flies, the booking states, and the
e-ticket check. Rules it must keep: an `amount.kind` of `maximum` is never asked for approval as a
price; `succeeded` with a merchant order id is "ordered, ticket not confirmed", never "booked";
"booked" only when a ticket number for every passenger has been seen.

## What is kept for a route to reuse

Nothing below talks to a provider or spends money.

- **Travelers** (`flight_traveler_save`, `flight_traveler_confirm`, `flight_travelers`,
  `flight_traveler_forget`; table `flight_travelers`). Legal name as on the ID, date of birth, gender
  as on the ID, contact email and phone; kept unconfirmed until the person says the read-back is right
  in their own words on a later message; a correction makes them unconfirmed again; a confirmation
  covers one hour. Sealed at rest and sealed out of the action ledger, the decision log and the data
  export (`privacy.sealTravelers`); never visible from another person's conversation.
  `travelerFingerprint` goes in the confirm target, so a yes for one set of travelers cannot be spent
  on another.
- **The states**, kept apart in the record and in the words: `quoted` → `approval_pending` →
  `payment_approved` → `ticketing_pending` → `issued`, plus `reserved`, `declined`, `expired`,
  `outcome_unknown` and `cancelled` (`bookingState`). Only `issued` — ticket numbers — is "booked". A
  charge, an order placed and a confirmation code are each said as what they are, with "check with the
  airline". `TICKETING_FIELDS` is empty on purpose: no provider's order record is read as a ticket
  until a real placed order has shown which fields carry one.
- **The approval window and the quote's age** (`approvalExpired`, `quoteFresh`,
  `REASON_FLIGHT_QUOTE_MAX_AGE_MS`): an expired approval or a stale price is a fresh quote and a new
  yes, never a retry.
- **The e-ticket check**, next.

## The e-ticket check (Gmail)

`src/ticketcheck.js`, in the sweep (`runtime.ticketChecks`). Inert today: it runs only when booking is
enabled, which needs a booking route as well as `REASON_FLIGHT_BOOKING`. It is written against the
flight rows AgentCard's route kept (`agentcard_purchases`, `kind = flight`); a Crossmint route feeds it
its own orders.

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
- **Evidence.** A ticket number is a ticket once AgentCard has placed the order: the watch is
  `issued` and `bookingState` says booked. While the order is only `payment_approved`, a matching
  e-ticket may be one they bought themselves on Google Flights (Reason hands them that link too), so
  it proves nothing yet; the watch goes on and the same email counts once the order is placed. A
  locator alone is kept, and the watch goes on.
- **Kept.** `flight_ticket_watch`: ticket numbers, PNR, carrier, Gmail message id, per
  conversation_id. Never a body, subject or sender. In the export and the delete.
- **Said once.** Issued: "your ticket's issued: e-ticket …, confirmation …", straight away; a send
  that fails is retried every 5 minutes under the same idempotency key. It answers
  something they did, so it skips the notice budget. Nothing by the end: one "no e-ticket email has
  come in … check with <carrier> directly" line. That one spends the notice budget as urgent (it can
  go past the one a day, never past the hard cap) and waits out their quiet hours.
- **Stops** on issued, at the end of the window, or when the order leaves those states — including a
  "check with the airline" still owed for an order since cancelled, declined or expired.

Pinned in `test/ticket-check.test.js`: issued, issued-before-placed held, a failed issued text
retried, an owed line dropped on cancel, PNR only, no email, another passenger's e-ticket
(with an instruction planted in it), Gmail not connected, per-conversation scope, flag off, no route. The
fixtures are Gmail message resources built to the documented shape. Each one's `read` was recorded
through the real reader, and `REASON_TICKET_EVAL=1` re-checks it live.

## Left in the tree, on purpose

- AgentCard's general (non-flight) code: `src/agentcard.js`, the `purchase` / `purchase_confirm` /
  `purchase_track` / `vault_enroll` tools, its webhooks and tests. Dormant on live, where Crossmint is
  on for everyone, and not part of this removal. `src/agentcard.js` still parses a `flight` itinerary
  on catalog items and keeps a flight order's raw record; both are unreachable now.
- The flight columns on `agentcard_purchases` and the flight branch of `purchase_track`, so a flight
  row from an older install is still read out honestly, in booking states.
- `bookingState`'s words name AgentCard, because the only rows it can read are AgentCard's.
- PR #417 (a Duffel booking route) is separate and untouched.
