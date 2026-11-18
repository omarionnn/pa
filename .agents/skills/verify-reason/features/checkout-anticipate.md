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
  ZIP is not trusted — a street with no ZIP, misheard in a voice note, was seen on live), the account's name and
  number, the default connected Gmail (or the only one). What they type into a form (`shop_answer`) is learned
  and never overwritten by a gathered value.
- **the instruction** — `startCheckout` writes the record's address into `what` where it says to ship
  ("…shipped to the address on file. Ship to <first last>, <street>, Apt 1, <city>, <ST> <zip>."), so the
  form often never comes. Never on a pickup food order (`noAddress`, `src/shopconnect.js:719`): a site
  that switches it to delivery cannot quietly ship it to them; on a pickup run a form's address fields are
  never filled from the record either (`PICKUP_NEVER`): a required one is asked of them (`test/food-fixes-1117.test.js`).
- **a plain form the record covers** → answered by code in `step()` (no model turn), one text:
  `Shipping to <street> Apt 1, <city>, the usual. Say if that's wrong.` ("as you gave it to me before" the
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
- **somebody else's address** — an instruction that ships to another ZIP ("shipped to my mom <name>, 12
  Other St, Newark, NJ 07102") is left exactly as written, its form is answered with THAT address (the buyer's
  phone and email stay theirs), and the line says "as you asked"; the record is not changed by it. The same
  ZIP is the person's own address as the record now has it (a corrected street number). Names are read only
  after "to"/"for" (through "my mom") or as a lone opening word; the ZIP must sit right behind place words.
- **after the review (2026-10-31)** — a correction that changes nothing on the record (`nothing_changed`)
  restarts nothing; a correction after the payment ask declines that ask and restarts; a record answer the
  store refused (`refused:<request>` on `told`) is not merged in again, and the wake carries only the HTTP
  status, never the store's message; a superseded run never retries signed in; `matchOption` takes one
  word-start hit or nothing; only the person's own facts (self subjects + the account's name) seed the record.
- **free words to the form's exact option (#498, 2026-11-12)** — `shapeAnswers` (`src/shopconnect.js`): a
  choice answered in words becomes the option's VALUE: first `shipping.matchOption`, then `looseOption` (the
  same amount of money — "$2 tip" / "2 dollars" → the `$2.00` option, never a `%` one — else every word given,
  minus filler like "it/my/at/tip", is in the label: "leave at door" → "Leave it at my door"). A tie or no hit
  is not sent: `shop_answer` returns `no_matching_option` with `options` and a `say` listing them, nothing is
  posted, the run stays `needs_input` (Chipotle 11-10 had a store refuse the raw words). Pinned in
  `test/shop-form-options.test.js`; driven in process 2026-11-14 (`money-probe.mjs`): "leave at door" /
  "$2 tip" → `option-2` / `tip-2`; "put it in the mailbox" left as given.
- **the words** — `offers.guardReply` drops "Here's the page if you'd rather just buy it yourself" and the
  bare link under it while a run of theirs is open or just ran (rule `self_buy_hedge`); `checkoutNote` says a
  started checkout is Reason's to finish and names the card on file ("Mastercard ••••<last4> … never ask whether
  they have a card").

## Offline
- `node --test test/checkout-anticipate.test.js` (12 pass 2026-11-07; the three "review:" tests are the
  gift address, a contact's "ship to" fact / nothing-changed correction, and ordinary "here's the link"
  sentences not read as a hedge): the live 12:15 Ulta form (keys `address1`, `state`
  choice, `email` required, `phone` optional) with the record → posted by code, `state: "option-33"`, one
  line, no wake; a size form still wakes the model; email unknown → wake names only `email`, clock-time
  deadline, `shop_answer {email}` merges 7 keys from the record, record learns, next form whole; "NY" shaped,
  400 `detail`; correction → new run with the corrected street number, old run's payment declined silently; hedge +
  link dropped only with a run; card on file in the note; parser cases (the Walmart instruction, the typed
  "<last>, <street>, <city> <zip> apt1", "apartment one", no-ZIP refused) and gather() from rows.
- 2026-11-18 on `18b47891`: green in the 84/84 checkout batch (see [checkout-job.md](checkout-job.md)).
- `test/checkout-job.test.js` wording pin updated (clock time, not "expires in"); both fixtures clear
  `shop_shipping`.

## Live (read-only, on the live server: OVH, root@15.204.113.250)
`sqlite3 -readonly /opt/reason/data/reason.db "SELECT conversation_id, length(address1)>0, length(email)>0, used, source FROM shop_shipping"`
— counts and flags only, never the values. A covered form shows in the journal as `{"shop_auto_answered":…}`-less:
look for the one `Shipping to …` outbound and no `[checkout]` cli turn for that request.
