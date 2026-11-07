# Shopping — verified offers, the figures check, the handoff, and price watches

Somebody asks what a thing costs, whether it is a good deal, to buy it, or to tell them if it gets
cheaper. Every price Reason says comes from a page or an AgentCard result that code read this turn,
never from what the model remembers about a shop. When Reason can't buy something, it hands over one
link and an honest list of what was and was not checked. When they ask it to watch a price, a drop is
said only after a fresh read of that page.

Buying itself (the vault, `purchase`, `purchase_confirm`, webhooks, the purchase record) is
[agentcard.md](agentcard.md). This file is everything around it. Shipped in #87 (offers, reply
check, offers → carts), #88 (handoff, the `message_send` figures check, the sandbox loop offline)
and #90 (price watches), all 2026-10-23.

Source: `src/offers.js` (reading an offer off a page, `guardReply`, `matchCartToOffer`, the
per-turn state `beginTurn`/`turnState`), `src/handoff.js`, `src/deals.js` (price-watch evidence,
notice kinds `deal_drop` / `deal_watch_stopped`), `src/runtime.js` (`checkWatches` → `deals.checkPrice`),
`src/notice.js` (the drop goes through the notice gate), `src/db.js` (`offers` table,
`watches` rows with `kind = 'price'`), `src/tools.js` (`offer_check`, `shop_handoff`,
`deal_watch_set`; `guardReply` on every `message_send`). The turn's reply is checked in
`src/agent.js` (`guardReply(conversationId, reply)`).
Tests: `test/shopping-offers.test.js` (26), `test/shopping-loop.test.js` (2),
`test/deal-watch.test.js` (10), `test/shopping-sandbox-fixes.test.js` (5) — 43/43 at `587f67a`;
the figures gate since #335: `test/unverified-1105.test.js` (33 incl. subtests) — 26 + all pass at
`36db733`. No-model drive of the gate on the reply and on `message_send`:
`bin/recall-figures-drive.mjs` (steps "unchecked price …" to "message_send …", see
[recall.md](recall.md) for the command).

## Sub-features

- **A verified offer.** `offer_check` reads ONE product page (by url, or `from_browser`) and code
  writes an `offers` row from the page's own schema.org markup: product, price, stock, seller,
  shipping cost/time, return terms, url, `fetched_at`. A field the page did not carry is
  `"unverified"` and listed in `unverified`, never filled in. Sources: `page`,
  `agentcard_catalog`, `agentcard_cart`.
- **Offers → carts.** `purchase` with an `offer_id` checks the AgentCard cart against that exact
  product (`matchCartToOffer`); a cart for something else is a mismatch, not a purchase.
- **The figures check on everything Reason sends — no "(unverified)" tag, ever (PR #335, 11-05/11-07).**
  `guardReply` (`src/offers.js:606`) never writes a hedge into the text. A money figure (`$`/`£`/`€`,
  `USD`, "95 dollars/bucks", `REPLY_MONEY` `:451`) is known when a tool read it this turn, when it is
  **theirs** (their message, minus the line code puts over an inline reply — a quote of Reason's own
  words is not theirs, `QUOTED_LINE` `:456`; what they sent: a photo note only when the photo read wrote it (`media_items.description_from = 'photo'`, never Reason's fallback reply) and transcripts, `db.theirOwnWords` (`src/db.js:11071`); this turn's photo words ride on the turn (`offers.notePhotos`/`photoWords`), so the rewrite and `message_send` read them too;
  their thread history), when Reason remembers it about them (older than 14 days → "as of <date>",
  `STALE_MEMORY_MS` `:539`), or when it is arithmetic on known figures (sums, ×/÷ 2–10, a percent
  of theirs — "18% tip on $84 is $15.12"). A bare number of theirs counts only when they used it as
  money (`MONEY_BEFORE`/`MONEY_AFTER`, `NOT_MONEY_UNIT` `:491-494`, a money word within `NEAR_WORDS` (4) words of it, never after a label like zip/room/flight — `NOT_MONEY_LABEL`; "I'm 30, 2 kids" and "my zip is 10001, rent's high" back nothing; "ran a 5k" is no $5,000). Their purchase record backs its own amounts but is never a base for sums (`records`).
  Anything else is `dollar_unsourced`: the turn's reply goes back to the model **once**
  (`recompose`, taken by `Runtime._turn` via `takeRecompose`, `src/runtime.js:583`) to check it or
  leave it out; on the rewrite (`beginTurn(..., { carry: true })`) a price still unchecked is
  **dropped** sentence by sentence — the sentence holding that whole figure (`dollar_dropped`), and a reply left empty becomes `PRICE_LEFT_OUT`
  "I couldn't confirm the price, so I've left it out rather than guess. Want me to look it up?"
  (`:590`). Coupons/deals the same (`discount_unsourced` → `discount_dropped`; a concrete code/
  amount must match a source; BOGO/free shipping/"$N off" are deals). "best"/"cheapest" needs two
  priced offers (or a flight search's fares). A purchase ask must carry AgentCard's total. The
  history read happens only when the reply has a figure or a deal. `message_send`
  (`src/tools.js:10763`): an unchecked price or deal is refused **every** try
  (`blocked: "unchecked_figures"`, `offers.sendBack` `:776`, "never a bracketed tag like
  "(unverified)""), to their own person too; other fixes are sent back once. `offer_check`'s note
  says a field the page lacks is "doesn't say" in plain words, never a tag (`src/tools.js:13728`).
- **The handoff.** `shop_handoff` (and every failed purchase) gives one link with plain words for
  what it opens, what was verified (field, value, where, when), what was not, one next step, and
  `cart_transferred: false` always. A Shopify cart permalink only when the page pins one variant;
  otherwise the product page. Amazon gets `/dp/{ASIN}`, never an add-to-cart link.
- **Price watches.** `deal_watch_set` only on a turn THEY started, with `said` copied from their
  message this turn; only a `page` offer with a machine-read price; one watch per product
  (`already_watching`); at most `REASON_DEAL_WATCH_MAX_ACTIVE` (10); every 12h by default, never
  under 6h. The sweep re-reads the page; a drop below the previous VERIFIED price (same currency)
  becomes a `deal_drop` candidate in the notice gate (quiet hours, budget, snooze all apply). A shop
  that blocks the read stops the watch and says so (`deal_watch_stopped`). A watch never buys,
  carts or pre-approves anything.

## How to get to it (user POV)

"how much is this <link>", "is that a good price", "just send me the link, I'll buy it",
"watch this and tell me if it drops", "tell me if it goes under $80".

## Driving it with the harness

Offline first — the whole loop, against the fake AgentCard and fake shops:

```bash
cd ~/Desktop/pa
node --test test/shopping-offers.test.js test/shopping-loop.test.js test/deal-watch.test.js \
  test/shopping-sandbox-fixes.test.js      # 43/43 at 587f67a
```

On the cage, in-process (Drive 2). `offer_check` really fetches the shop page (a public GET, no
account); `deal_watch_set` needs the turn opened first, or it refuses whatever `ctx` says:

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const offers = await import("./src/offers.js");
  const ctx = (t) => ({ conversationId: "dm:owner", messages: [{ role: "user", content: "[Sat, Oct 24, 2026, 11:58 AM] Omari: " + t }] });
  const o = await runTool("offer_check", { url: "https://www.allbirds.com/products/mens-tree-runners" }, ctx("how much is this"));
  const id = o.offer.offer_id;                                   // note: o.offer.offer_id, not o.offer_id
  console.log(JSON.stringify(await runTool("shop_handoff", { offer_id: id, why: "buying is not set up here" }, ctx("just send me the link"))));
  offers.beginTurn("dm:owner", "yeah watch it for me", "user");  // what the runtime does at the top of a turn
  console.log(JSON.stringify(await runTool("deal_watch_set", { offer_id: id, said: "yeah watch it for me" }, ctx("yeah watch it for me"))));
'
.agents/skills/verify-reason/bin/peek.sh sql "SELECT id, kind, url, every_ms, checks FROM watches"
```

**End state (driven 2026-10-24 on the cage).** `offer_check` → `ok`, `source: "page"`,
`price: "$100.00"`, `stock: "in stock"`, seller/shipping/returns `unverified`, `read_via: "fetch"`.
`shop_handoff` → `link.kind: "product_page"`, two verified fields with source and `read_at`, four
unverified, one `next_step`, `cart_transferred: false`. `deal_watch_set`: a turn whose text lacks
`said` → refused; an `event` turn → "only starts on a turn they started"; a `user` turn with the
words → `watch.id`, `every_hours: 12`, a `watches` row with `kind='price'`, `every_ms=43200000` and an
`action_ledger` row `deal_watch_set` / `watch:1` (columns `action`, `target`); the same call again →
`already_watching`. Re-driven exactly so 2026-10-27 at `00f3300`. `shop_handoff`'s fields are under
`.handoff` (`link`, `verified`, `unverified`, `next_step`, `cart_transferred`).

**Live, read-only.** `SELECT source, count(*) FROM offers GROUP BY source` and
`SELECT count(*) FROM watches WHERE kind='price'` over ssh (2026-10-24: 8 `agentcard_catalog`,
3 `agentcard_cart`, 0 price watches). `reply_guard` lines in `journalctl -u reason` show the
figures check firing (3 `dollar_unsourced` on 2026-10-24: 03:55Z `$13.62`/`$5` — an earlier search
price and a computed difference, correctly flagged — and 12:53Z/12:54Z `$16.76`, the total on the
owner's own Walmart rows, wrongly flagged; fixed in the PR after #98).

## Gotchas

- **`deal_watch_set` reads the turn, not `ctx.messages`.** Without `offers.beginTurn(c, text, "user")`
  a direct drive always answers "'said' has to be their own words from this message". That is the
  harness, not the product.
- **`offer_check` hits the real shop.** Pick a stable public product page; a shop's bot check is a
  `blocked` answer, not a regression. Never point it at a page behind a sign-in.
- **The figures check sees this turn's sources plus the person's own purchase record.** Tool output
  this turn (`purchases_recent`, `purchase_track` included), the purchases block when it rides, and
  every amount on their own `agentcard_purchases` rows (row amount, cart items, fee lines, total —
  `purchasesnote.purchaseRecordSource`, passed as `extraSources` by both backends and
  `message_send`). Anything else Reason knows from its database — an old offer row, a remembered
  price — is still not a source. A direct `guardReply` drive must pass the record itself.
- **No AgentCard on the install is not "nothing to say".** `purchase_track` answers from the local
  row (`read_from: "local_record"`, `live_check: "not_configured"`); only with no row is it
  `not_configured`. A `not_configured` AgentCard call writes no ledger row, so it never switches
  the purchases block on.
- **A model that already obeys the rule never trips the gate.** Real claude-cli turn on the cage,
  2026-11-07 at `8113bcf` ("roughly how much is a 60 min massage there? just ballpark from memory"):
  `web_search` → `not_connected`, the reply said it had no price and offered to call — no figure, no
  "(unverified)", no `reply_guard` line. The gate's own paths (recompose, drop, `message_send`
  refusal) are proved by the no-model drive and `test/unverified-1105.test.js`, not by a live turn.
- **The handoff never moves a cart.** If a reply says "it's in your cart" after a handoff, that is
  the model, and `cart_transferred: false` is the proof it is wrong.
