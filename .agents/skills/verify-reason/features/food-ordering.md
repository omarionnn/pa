# Food ordering (REASON_FOOD, 2026-11-10)

Owner spec (~/Desktop/reason-food-1110/spec.txt): craving → food at the door in the fewest texts, never
money without a yes on the exact total. Flag `REASON_FOOD` = off | owner | on (default off; `owner` =
the operator's thread only, never a phone call's prompt).

Source: `src/food.js` (all of it). Hooks: `src/shopconnect.js` (`sayPayment` → card picture + one line,
`foodFor`, `holdMsFor` 15 min, placed text, `ended` on a failed end, `moveOn` never moves a food order,
`relinkRun` on renew / sign-in retry / corrected address, `payTarget` carries `food#<id> r<rev>`,
DoorDash / Uber Eats / Grubhub in STORES as sign-in required), `src/shoptools.js` (`food_order_id` on
store_checkout, `hold_lapsed` refusal in shop_pay), `src/tapbacks.js` (`messageHandle`: only a message
of theirs in this conversation), `src/choicecards.js` (`queueCards`, `photoForOption`), `src/agent.js`
(`foodRules`), `src/serve.js` (attach: say, picture, wake, channels).
Already there before it and reused: Crossmint checkout job, confirm gate, Face ID, spend cap, choice
sets, inbound 👍 = yes (threading), shipping record.
Tests: `test/food-order.test.js` (16, offline; 10 source mutations, every money one caught).

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

## Can't
DoorDash / Uber Eats answer Reason's browser and plain fetches with 403 (re-checked 11-10): menus, store
hours and driver tracking are not readable here; only Crossmint's checkout agent reaches them. No "driver
5 min away" text (no tracking source). Pays with the card saved for Reason (Crossmint), not a card saved
on the platform. All-in comparison across platforms needs a checkout run to the payment step on each;
the rules leave it to the model and it is unproven.
