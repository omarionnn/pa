# Checkout job (src/shopconnect.js "following a checkout: the job", src/shoptools.js, src/offers.js checkoutClaims) — rides on REASON_SHOP_CONNECT

A Crossmint checkout is a persistent job, not a turn. Row `shop_runs` carries `stage`
(started → in_progress → needs_input → needs_approval → approved → paid → placed, or failed / cancelled),
`revision` + `progress_at` (Crossmint's revision moving is progress), `told` (which texts went, once each),
`question` + `request_json` (the open request, keys only), `paid_at`, `order_ref`, `mail_until`.

Why (2026-10-31): at 10:58 ET `store_checkout` started a real Ulta run (bfbab17b…); at 11:00 Crossmint
asked a plain form (shipping and contact details); the follower handled only payment and protected
forms, so nobody answered; 11:10 `input_expired`, run failed, nothing texted. Asked "Updates?" at 11:17
the model, with no record to read, said the checkout "never actually started" (false), started another
(3e6845d9…), same death, same silence.

What code does now, with no model in front of it:
- **plain question** → `wake` (an event turn, key `shop:<run>:<request>`, once): `[checkout] Ulta's
  checkout for … (run …) is waiting on an answer. Ulta asks: "…". Fields (key: label): … Ulta holds
  the cart until <clock time>; say that as the time, never as a countdown …` (`inputEvent`,
  `src/shopconnect.js:1382-1396`; the "It expires in N minutes" wording went with checkout-anticipate) — the model answers with `shop_answer` (values sealed out of the log by src/privacy.js) or
  asks the person for exactly what is missing;
- **protected form** → the sign-in link, as before; **payment** → the ask, itemized when Crossmint
  itemizes (`item $18.99, shipping $6.95, tax $2.30; $28.24 all in.` above `OK to pay …`), Face ID link
  where they have a passkey;
- **the store's hold runs out while they still have time to approve** (#376) → `renewHold` asks the same checkout again (≤ `RENEW_MAX` 2), one "let go of the cart … asking again" text, no end text for the old run (its `result` reads `renewed: store hold ran out; asked again as <run>`); see [passkey-pay.md](passkey-pay.md);
- **the end** → one text saying what happened: expired input (what was asked), blocked (summary),
  cancelled, placed (order ref if Crossmint gives one), ended after a payment (outcome unknown; since #357 that amount already counts against the day's cap).
  Since #412 the after-payment end looks in their Gmail itself (`paidEndText` → `checkMail(..., {ending:true})`)
  and says what is there: new mail from the store (model woken to read it), mail the watch already read
  ("has already written since the payment"), nothing yet (watching), or couldn't look; it promises more
  watching only while the watch runs, an unknown-outcome payment starts the watch here, and it never says
  "check your email" (`test/no-check-your-email.test.js` guards src/);
- **a stall** (`STALL_MS` 12 min without the revision moving; never while `needs_approval` since #376 — the one approval reminder covers that, see [passkey-pay.md](passkey-pay.md) "Thirty minutes"; past Crossmint's 10-min input expiry so an
  expiring request reads as expired) → one text; Crossmint saying it does not know the run (a 404)
  for `LOST_MS` (60 s since #337) → failed ("lost"), cancelled at Crossmint, said once; Crossmint down
  or refusing (5xx, 429, no answer) for `OUTAGE_MS` (36 min) → given up but never cancelled; a follow
  loop that throws on Reason's own bug only logs `checkout_follow_broken` (`src/shopconnect.js`
  `LOST_MS` / `OUTAGE_MS`);
- **a payment Reason can't approve** (not a card, no readable amount) → said once, never the model's;
  `shop_answer` refuses anything but a plain form (`not_a_form`, `needs_signin_link`);
- **a wake that failed** (the runtime threw) is raised again on the next look (`told` carries `woke:<request>`);
- **after a payment** → the person's Gmail is watched (`MAIL_EVERY_MS`, up to `MAIL_WATCH_MS` 24h) for
  mail from the store's domain since `paid_at`; a hit wakes the model (key `shop:<run>:mail`) to read it
  with `gmail_read` and text the order number and delivery estimate, or say NO_REPLY; each NEW message
  id wakes once (`mail_seen`, at most `MAIL_WAKES_MAX` 5), so a "rate your visit" does not end the watch;
  no mail connected → watch over quietly; 24h with nothing → one text unless the order is `placed`;
- **restart** → `resumeFollowing()` follows every `status = 'running'` row and every open mail watch.

The record in front of the model: `checkoutNote` on their turns (every run of the last 24h, one line
each, "overrides anything the chat says"); `shop_status` on demand. The reply guard: a "started the
checkout" line with no run of theirs (started ≤15 min ago or still open) is dropped with its promises
and replaced by `I haven't actually started a checkout: nothing is running and nothing has been charged.
Want me to start it now?`; a "never actually started" line with a run of the last 30 min on record gets
`Actually, checking my record: the <store> checkout for <item> did start N min ago; now: <stageLine>.`
in front (`src/offers.js:95`), and only on a turn where they asked about the checkout (`aboutCheckout`).

**Status from the record (#501, 2026-11-12).** `shop_status` and every reply about a checkout agree with the
newest run of the last two hours (`againstRecord` in `src/offers.js`; `chargedOf` / `stoppedByReason` in
`src/shopconnect.js`): a reply saying "nothing's charged" after a payment went out (paid, being paid, or
outcome unknown) is caught; "started / running" about a run that ended failed or cancelled (with nothing else
running) is caught; "declined" about a payment Reason called off itself (a run switch, a ceiling, a corrected
address: `shop_payments.stopped_by = 'reason'`) is caught. The contradicting sentences go and one line from the
record goes first: `Actually, checking my record: the <store> checkout for <item>: <stageLine>.` A run Reason
called off reads "cancelled …: I called it off myself, the store and the card had no part in it; nothing
charged", never "declined". Their own no is `stopped_by = 'them'`. Pinned in `test/shop-status-truth.test.js`
(the 10-31 14:10, 10-31 10:58 and 10-30 20:00 lines).

## Offline
- `node --test test/checkout-job.test.js test/checkout-mail-read.test.js` (19 + 2 pass 2026-11-08 at #412; earlier: 16 pass 2026-11-07; the four "review" ones cover non-card payment, expired
  approval wording + wake retry, lost run + a pre-change row with stage '', and "review 11-06" Crossmint
  503 for minutes is not a lost run): the exact 10:58 line refused without a run and untouched
  with one; the 11:17 line corrected; the shipping form → wake → `shop_answer` → in_progress, sealed;
  sign-in form never through `shop_answer`; expiry/blocked/cancelled/after-payment texts, once; stall once
  at 10 min; `shop_status` + note from the row; itemized ask; placed + mail watch + 24h bound; resume.
- `node --test test/shopconnect.test.js test/passkey-pay.test.js test/crossmint-only-buys.test.js` still green.
- 2026-11-14 (g2 pass): `checkout-job` + `shop-status-truth` + `shop-form-options` + `checkout-anticipate` +
  `shopconnect` + `passkey-pay` in one 122/122 batch; `checkout-mail-read`, `crossmint-only-buys`,
  `no-check-your-email` in the 601-pass batch. In process: `chargedOf` of a run with no payment → `no`.
  A live stall/wake needs a real Crossmint run: offline only.

## Live (read-only, on the live server: OVH, root@15.204.113.250)
`sqlite3 -readonly /opt/reason/data/reason.db "SELECT run_id, store, stage, told, substr(question,1,60) FROM shop_runs ORDER BY created_at DESC LIMIT 5"`;
the journal shows `{"checkouts_resumed":…}` on boot when a run was open, and the `[checkout]` event
turns as ordinary `{"cli":…}` lines. Crossmint's own view of a run: `GET /api/unstable/agent-checkouts/<run>`
with `X-API-KEY` AND `x-crossmint-user-id: reason-<sha256("crossmint:"+conversation)[:24]>` — without the
user header every run is "not found".
