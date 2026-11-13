# Flight booking through Crossmint

Search is [flight-search.md](flight-search.md). A flight the person picks and asks
Reason to book is a **Crossmint Agent Checkout on the airline's own website** — the shopping path
whole (`src/shopconnect.js`): Crossmint's exact total, the confirm gate (`shop_pay`), the per-person
daily cap, the Face ID approval, the order intent. There is no second payment path.
`src/flightcheckout.js` is what a flight adds to it.

AgentCard's flight route was removed on 2026-11-11 (the owner's decision: Reason does not use
AgentCard; Crossmint is the only buy route).

**Dark by default.** `REASON_FLIGHT_BOOKING` (off | owner | on) is off on live. Booking is on for a
person only with the flag **and** the shopping path on for them (`REASON_SHOP_CONNECT`, Crossmint
keys in place): `bookingEnabled` in `src/flightbook.js`. Off: no booking or traveler tool is shown or
runs, a search says "SEARCH ONLY" and hands over the Google Flights link, no flight payment goes out,
and the e-ticket check reads no mail. `owner` is the owner's own conversation only.

## What a real run showed (2026-11-11, no purchase)

One checkout, production Crossmint, run from the live host with the key live already uses, as a
throwaway Crossmint user with no saved card and no browser profile. Stopped at the payment request,
which was **never answered**, and cancelled. Recorded in
`test/fixtures/crossmint-flights/jetblue-pricecheck.json`.

- **Asked for:** jetblue.com, one adult, one way New York → Boston on Wed 2 Dec 2026, cheapest
  nonstop, lowest standard fare, no extras, guest, pay by card.
- **93 s — a question:** which of three $119 nonstop departures (a choice field). The route names
  the exact flight number and time in the instruction, so this is not normally asked.
- **135 s — one passenger form:** title, first name and last name as on the ID, email, gender as on
  the ID, date of birth (MM/DD/YYYY), street, city, state, ZIP, phone. All standard fields; nothing
  protected, no sign-in, no CAPTCHA.
- **226 s — the payment request:** card, **exact 118.40 USD**, merchant "JetBlue". One number: no
  fare, tax or fee lines (the agent's prose mentioned a $119 fare and a declined +$35 upsell).
- **Not seen:** what a placed order returns. Crossmint documents `receipt.total` and, "when
  available", `receipt.merchantOrderId` — never a ticket number. The test of a placed order in
  `test/flight-crossmint.test.js` is built to that documented shape and labelled CONSTRUCTED.
- **Not tried:** any other airline, a travel site, a round trip, two passengers. A second checkout,
  started first, was abandoned at its first question by a bug in the test script; it had no card and
  expired on its own.

## How a booking runs

1. **`flight_book`** (`src/tools.js`) — only on the person's own message, for one option of their own
   search, with travelers they confirmed in the last hour, adults only, one traveler per seat. The
   option must be on one airline Reason books with (`AIRLINES` in `src/flightcheckout.js`: only
   JetBlue has been run; the others are the same kind of site and may answer with a block). It
   re-runs the search: unchecked, gone or moved prices stop here. One flight checkout at a time.
   Then `startCheckout` on the airline's site with an instruction naming exactly those flights by
   number and time, and a cost ceiling above the searched price. **No passenger detail is in the
   instruction** or kept with the run.
2. **The passenger form** is answered by code from the sealed traveler record (`fill`), with the
   contact address from their shipping record; for one traveler, and only when every required field
   has an answer. Otherwise the model is woken and answers with `shop_answer`.
3. **The payment request** is the shopping path's: one exact total, texted for approval. A "maximum"
   is a ceiling, declined, never asked as a price. The yes is pinned to the travelers too
   (`payTarget` ends `travelers [fingerprint]`), and `payRefusal` stops the payment — before the cap,
   the order intent or anything else — if a traveler changed since, or booking was switched off.
4. **After the airline takes the order** it is kept as a flight order (`agentcard_purchases`,
   `kind = flight`, key `crossmint:<runId>`), in state `ticketing_pending`, and the person is told
   "took the order … that is not a ticket yet". The e-ticket check below watches their mail.
   **"Booked" only when a ticket number has been seen for every passenger.**

## Not done, and the owner's decision

- **The first real booking.** `REASON_FLIGHT_BOOKING=owner` on live, the owner's own card, one cheap
  fare. It spends real money; refunds are the airline's rules, which were not read. Afterwards: record
  the `succeeded` result as a fixture and replace the CONSTRUCTED test.
- Travel sites (Expedia and the like), round trips and multi-passenger forms are unproven.
- A flight's status after the order is said by the e-ticket check's own texts; `shop_status` shows
  the checkout's stage, not the booking state.

## The parts that do not depend on the route

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

`src/ticketcheck.js`, in the sweep (`runtime.ticketChecks`). Inert while booking is off. It reads the
flight order record (`agentcard_purchases`, `kind = flight` — the table AgentCard's route left, which
the Crossmint route writes its placed orders to).

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
- **Every passenger.** The order is `issued` only when tickets have been seen for every passenger on
  it, in one email or several; a ticket for some of them is kept in hand and the watch goes on.
- **Evidence.** A ticket number is a ticket once the order is placed: the watch is
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
  on for everyone. `purchase` and `purchase_confirm` refuse any AgentCard flight cart or flight row
  (`flight_not_here`).
- The flight order record is still the table named `agentcard_purchases`; renaming it is a migration
  of its own.
- PR #417 (a Duffel booking route) is separate and untouched.
