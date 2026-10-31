# Checkout anticipates the form (src/shipping.js, src/shopconnect.js step/answerRun, src/offers.js) — rides on REASON_SHOP_CONNECT

Why (2026-10-31, 12:16 ET): the Ulta guest checkout for the owner's CeraVe reached the shipping form and
Reason texted "Ulta's checkout is at shipping and needs your address. Send me your last name, street address,
city and zip (apt # too if you have one) in the next 10 min, or it times out." His address was already in the
Walmart run's instruction (`shop_run_asks.what`), in his facts and in his account. He typed it; the model sent
"NY" into Ulta's `state` dropdown (61 options, values `option-N`, labels `NY - New York`); Crossmint refused
twice (400, body never read); Reason offered him the store's page to buy it himself. Owner's rule: if Reason
already knows it, it at most asks to confirm.

What code does now:
- **the record** — `shop_shipping`, one row per person: first/last name, street, apt, city, state, zip, phone,
  email. `shipping.profileFor(c)` reads it and, while it is short, gathers from: earlier checkout instructions
  (`shop_run_asks.what`, newest first), facts about shipping/delivery (never "lives at"; an address without a
  ZIP is not trusted — "3247 Brauna Avenue" is a voice-note mishearing on live), the account's name and
  number, the default connected Gmail (or the only one). What they type into a form (`shop_answer`) is learned
  and never overwritten by a gathered value.
- **the instruction** — `startCheckout` writes the record's address into `what` where it says to ship
  ("…shipped to the address on file. Ship to Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469."), so the
  form often never comes.
- **a plain form the record covers** → answered by code in `step()` (no model turn), one text:
  `Shipping to 3247 Bruner Ave Apt 1, Bronx, the usual. Say if that's wrong.` ("as you gave it to me before" the
  first time). A choice field gets the option's VALUE (`shipping.matchOption`: by value, label, state code or
  name; placeholders never). `told` carries `auto:<request>`.
- **a form it covers in part** → the model is woken once naming what is filled and the ONLY keys still needed,
  with the deadline as a clock time in their zone ("Ulta holds the cart until 12:25 PM; … never as a countdown
  or 'or it times out'"). `shop_answer` with only those keys merges the rest from the record; `stageLine` /
  `checkoutNote` say "still needed from them: Email (the rest is on record)".
- **shop_answer** shapes choices ("NY" → `option-33`), returns Crossmint's 400 message as `detail`, learns
  the typed values; a correction after an auto-answer (`auto:<request>` on `told`, stage in_progress, unpaid)
  fixes the record, marks the run `superseded` (its payment request is declined without a word, its end is not
  texted) and starts the same checkout again with the corrected instruction.
- **the words** — `offers.guardReply` drops "Here's the page if you'd rather just buy it yourself" and the
  bare link under it while a run of theirs is open or just ran (rule `self_buy_hedge`); `checkoutNote` says a
  started checkout is Reason's to finish and names the card on file ("Mastercard ••••1929 … never ask whether
  they have a card").

## Offline
- `node --test test/checkout-anticipate.test.js` (9): the live 12:15 Ulta form (keys `address1`, `state`
  choice, `email` required, `phone` optional) with the record → posted by code, `state: "option-33"`, one
  line, no wake; a size form still wakes the model; email unknown → wake names only `email`, clock-time
  deadline, `shop_answer {email}` merges 7 keys from the record, record learns, next form whole; "NY" shaped,
  400 `detail`; correction → new run with `3249 Bruner Ave`, old run's payment declined silently; hedge +
  link dropped only with a run; card on file in the note; parser cases (the Walmart instruction, the typed
  "Nyarko, 3247 Bruner Ave, Bronx 10469 apt1", "apartment one", no-ZIP refused) and gather() from rows.
- `test/checkout-job.test.js` wording pin updated (clock time, not "expires in"); both fixtures clear
  `shop_shipping`.

## Live (read-only)
`sqlite3 -readonly /opt/reason/data/reason.db "SELECT conversation_id, length(address1)>0, length(email)>0, used, source FROM shop_shipping"`
— counts and flags only, never the values. A covered form shows in the journal as `{"shop_auto_answered":…}`-less:
look for the one `Shipping to …` outbound and no `[checkout]` cli turn for that request.
