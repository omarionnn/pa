# Food ordering (REASON_FOOD, 2026-11-10)

Owner spec (~/Desktop/reason-food-1110/spec.txt): craving → food at the door in the fewest texts, never
money without a yes on the exact total. Flag `REASON_FOOD` = off | owner | on (default off; `owner` =
the operator's thread only, never a phone call's prompt). **Live: `REASON_FOOD=on`** (everyone).

Source: `src/food.js` (all of it). Hooks: `src/shopconnect.js` (`sayPayment` → card picture + one line,
`foodFor`, `holdMsFor` 15 min, placed text, `ended` on a failed end, `moveOn` never moves a food order,
`relinkRun` on renew / sign-in retry / corrected address, `payTarget` carries `food#<id> r<rev>`,
DoorDash / Uber Eats / Grubhub in STORES as sign-in required), `src/shoptools.js` (`food_order_id` on
store_checkout, `hold_lapsed` refusal in shop_pay), `src/tapbacks.js` (`messageHandle`: only a message
of theirs in this conversation), `src/choicecards.js` (`queueCards`, `photoForOption`), `src/agent.js`
(`foodRules`), `src/serve.js` (attach: say, picture, wake, channels).
Already there before it and reused: Crossmint checkout job, confirm gate, Face ID, spend cap, choice
sets, inbound 👍 = yes (threading), shipping record.
Tests: `test/food-order.test.js` (19 offline 2026-11-14; at launch 16, 10 source mutations, every money one caught),
`test/food-direct.test.js` (direct ordering), `test/food-past-orders.test.js`, `test/food-receipts-real.test.js`,
`test/food-receipts-square.test.js` (receipts). All green 2026-11-14 (g2 pass, batch of 182 with plaid/account jobs).
`test/flow-food.test.js` needs a model.

## What it does
- `food_order start` → ⏳ on their request message. Status after: ❓ at the ask / a failure, ✅ placed,
  ❌ second failure or the model's call, 👍 cancelled. Any single emoji goes through Sendblue's
  send-reaction; pre-iOS-18 phones show "Reacted ⏳ to …".
- `food_order cart` records the cart (items + modifiers + prices, fees, tip, total, ETA, address,
  closing time) and runs the allergy/diet check (haiku side call, facts + food notes; failure = a
  "couldn't double-check" flag). Refused while the card is out (`card_out`): a change is a new checkout.
- At Crossmint's payment request: one JPEG card (restaurant, items, fees, tip, Crossmint's total, ETA,
  address, brand + last 4) then "Heads up: … $31.42 to your Visa 4821, here by 8:15. Place it?"
  (+ Face ID link where required). A different total from the cart's is said before the question.
- 15-minute hold: shop_pay refuses after it; the sweep (60 s) declines the payment and texts once.
  Closing warning once 15 min ahead. Placed: "Placed: R, items. $X charged, here by 8:15. Going to Home (…)."
  No order number. 15 min after the latest ETA the model is woken once to look (silent if delivered).
- `history`, `note`, `options` (≤3 dishes, ONE numbered picture, only tool-returned photos, never
  files.heyreason.com).
- **Direct first** (2026-11-10): the restaurant's own ordering (Toast, Square Online, ChowNow, Olo, Clover,
  BentoBox, Owner.com, own site; `DIRECT_HOSTS` / `orderingRoute` in `src/food.js`) before an app. An app cart
  is refused until the model looked for a direct link (`place` / `why_direct`); their own choice of the app is
  respected; the first direct order's ask says once why it's cheaper (`whyDirectLine`); Caviar/Slice are apps.
- **Past orders from their receipts** (`past_orders`, #517/#524): "what did I last order", "get that again",
  "sign into my DoorDash and check" → `pastOrders` searches their connected mail a year back
  (`RECEIPT_DAYS` 365, `receiptQuery`: confirmation/receipt subjects from the apps' and ordering hosts' own
  addresses, never the bare word "order"); a receipt is an order only by its sender ADDRESS and subject (codes,
  ads, rides, ratings, cancellations are not); restaurant, dishes and total read from the receipt
  (`readReceiptText`: the order's total, never the subtotal, a fee or a card number); what it lacks is said,
  nothing guessed; the receipt text is marked as someone else's words and a total in mail is never a price;
  newest first, one row per order; nothing found → says what was searched, never asks for a screenshot.
- **Square counts only when it's food** (#537, `foodReceipt`): Square takes any shop's payments, so its
  receipt is a food order only with a food/drink line, a restaurant's kind of name (never "…Barbershop"), or a
  place already in their food history.
- **An app's wall answers with the working route** (#517, `wallInstead` in `src/socialsignin.js:388`): a
  delivery app that walls Reason's browser gets "I can still order for you, from the restaurant's own site or
  through my checkout, and I can read what you ordered before from your receipts." and the model is told not
  to stop at the block or ask for a screenshot.

## Driving it (no model)
`money-probe.mjs` (2026-11-14, in process, throwaway DB, `REASON_FOOD=on`, every fetch throws): Square café
yes / barber no / known place yes; the receipt total `$29.41` over subtotal, fee and a card number; the
receipt query's subjects and a year back; the DoorDash wall line; `pastOrders` with an empty mailbox →
`count: 0` with what was `searched`. A whole order needs Crossmint and a model turn: offline only.

## Can't
DoorDash / Uber Eats answer Reason's browser and plain fetches with 403 (re-checked 11-10): menus, store
hours and driver tracking are not readable here; only Crossmint's checkout agent reaches them. No "driver
5 min away" text (no tracking source). Pays with the card saved for Reason (Crossmint), not a card saved
on the platform. All-in comparison across platforms needs a checkout run to the payment step on each;
the rules leave it to the model and it is unproven.
