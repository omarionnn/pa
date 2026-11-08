# Purchase approval by passkey (Face ID)

Branch wt/passkey-approve, PR #285 (2026-10-31). Once someone has set up a passkey, a texted yes stops paying for Crossmint purchases. Reason texts a link instead, and only a user-verified passkey assertion pays, for that payment's exact amount and store, once, within 30 minutes (5 until #376, 2026-11-07). Self-hosted with `@simplewebauthn/server`.

- Flag: `REASON_PASSKEY_PAY` = off (default) / `owner` / on — **`on` for everyone on live since 2026-10-31** (owner-only that morning; see shop-connect.md "Everyone"). It only works where `REASON_SHOP_CONNECT` is also on. Origin and RP ID come from `REASON_PASSKEY_ORIGIN`, else `REASON_SITE_URL`, else `https://heyreason.com`.
- Code: `src/passkey.js` (passkeys, approval links, the challenge bound to the payment row, the log), `src/pages/webapprove.js` (pages + routes), `src/shopconnect.js` (`approvalUrl`, `approvalView`, `payByPasskey`, `declineByLink`; `payApproved` refuses with `approve_with_passkey`), `src/shoptools.js` (`shop_pay` hands out the link), and the routes in `src/http.js`.
- Routes: `GET /web/connect/passkey` (signed-in setup page, options drawn in), `POST /web/connect/passkey/verify`, `GET /web/approve/{token}` (amount, store, item, Approve with Face ID, Decline), `POST /web/approve/{token}/verify|decline`.
- Tests: `test/passkey-pay.test.js` (a software authenticator and a fake Crossmint).

## Drive (muted: no texts, no model, no Crossmint, nothing leaves the process)

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/pk.db node --no-warnings .agents/skills/verify-reason/bin/passkey-drive.mjs [--shots=DIR] [--headed] [--non-owner]
```

`--non-owner` (2026-10-31, shopping for everyone): the flags `on`, the person paying is Ama (an account
that is not the operator) and "the other person" is a third account, whose setup page is then its own
(200) rather than a 404. Both runs 23/23 ok on 2026-10-31 (wt/shopping-everyone), muted, and again on 2026-11-07
(rel/verify-maint, `caged.sh env`, throwaway DB; `test/passkey-pay.test.js` 15 pass).

The drive runs the real `src/http.js` on loopback, opened in Chromium as `http://localhost:<port>` (RP ID `localhost`). The passkey is a CDP virtual authenticator (ctap2, internal, UV on), and it is used through the page's own buttons. Crossmint is answered by `shop._setFetch` and texts go to an array. Any other fetch throws. The last line reads `all ok`, or the drive exits 1.

| Step | Proves |
|---|---|
| (a) | Setup options say `userVerification: "required"` and `rp.id` is the origin's host |
| (b) | A real `navigator.credentials.create` through **Set up Face ID** is verified and saved, and the owner is texted |
| (h) | With a passkey saved, `shop_pay` with a granted yes returns the link and does not pay, `payApproved` returns `approve_with_passkey`, and no order intent is made |
| (c) | The approve page shows $12.49 at Best Buy and lists only the owner's credential. **Approve with Face ID** makes one order intent for exactly 12.49 USD, the row is paid and the owner is texted. Replaying the same assertion gets 400 `link_used`, and the page then says Already approved |
| (j) | **The payment does not start** (live 2026-10-31 at CVS, PR #288): Face ID passes, Crossmint refuses the order intent. The page shows "Face ID worked. The payment didn't start. Nothing was charged." with **Try again**; the row stays asked, `pay_approval_log` has `pay_failed order_intent_failed 400 <code>` then `link_reopened`; `shop_status` names the still-open link and makes no new one. Try again reloads under a fresh challenge (the first assertion replayed → `not_verified`); the next tap pays: one more order intent, row paid, run stage `paid`, "Paid $26.65" texted; then the link is used up |
| (d) | **Decline** tells Crossmint to decline. The row is declined and nothing is charged |
| (e) | `APPROVAL_TTL_MS` (30 min since #376, was 5) on, in-process clock: verify gets `link_expired`, the page says "run out", GET returns 410 and nothing is paid |
| (f) | The row's amount changes after the link is made: `details_changed`, nothing paid |
| (i) | Virtual authenticator `isUserVerified: false`: the browser refuses (UV required). A UV-less assertion posted straight to the route gets 400. Nothing is paid |
| (g) | A made-up approve token gets 404 with no options on GET, verify and decline. Signed out, setup GET and POST should get 404 with no options. With the real link, anyone can view the page (it is a bearer link), but a credential that isn't the owner's gets `unknown_passkey`. With the flag off, approve gets 404. For a non-owner, or with the flag off, setup gets 404 or the Connect page for an unknown link (no options) |
| log | `pay_approval_log` has paid, declined and rejected entries, and no card detail |

A link is marked `used` the moment the assertion verifies, before the order intent. If the payment fails to start (no order intent: `order_intent_failed`, `no_card`, …) `passkey.reopenApproval` sets it back to `open` under a NEW nonce/challenge, so the same URL works for another tap and the first assertion is dead; the five-minute deadline does not move. Once the card may have reached the store (`unknown_outcome`) the link stays used — never paid twice; since #357 the amount counts against the day's cap ("(OUTCOME UNKNOWN)" ledger line) and `payByPasskey` writes the same `trust.noteUnknownOutcome` record (`shop_pay`, the payment's target) as the texted-yes path. `shop_status` (`approvalHint`) hands the model a fresh `approve_url` only when no open link exists for an asked payment whose Crossmint window is still open; an open link is named with its minutes left; a passed window says to start again. Accepted origins: the site and its `www.` form (`passkey.ORIGINS()`); the RP ID is the apex host. The expired-checkout texts (`endText`, `stageLine`) name what the store wanted from the form's fields — "your shipping address and phone number" — via `askedFor(run)`, never the store's prompt.

Notes: the approve page is a bearer link by design, not signed-in only: it opens on a phone that may not be signed in to Web, and paying still needs the owner's passkey. Signed out, a non-owner, or the flag off, `/web/connect/passkey` is a plain 404 (http.js keeps it out of the Connect store-link route).

## Thirty minutes, one re-ask, one reminder, the breakdown (#376 shop-small, 2026-11-07)

Live 10-31 CVS: the ask went at 16:22:49, Crossmint's hold ran out at 16:32:47 (10.0 min) and the Face ID
link lasted 5 min, cut further to Crossmint's `expires_at`; the run ended "didn't get it in time".

- **The link lasts 30 min** (`APPROVAL_TTL_MS` `src/passkey.js:67`); `createApproval(row, { until })`
  (`:219`) ends it at the first ask's half hour when sooner, never at Crossmint's hold. A tap after the
  hold pays nothing (`payRow` refuses an expired row). Spend-limit (`kind: 'cap'`) links keep their own deadline.
- **The half hour runs from the first ask** across re-asks: `shop_runs.ask_since` (`src/shopconnect.js:258`,
  set at the first `needs_approval` `:1701`), `askDeadline` `:1116`.
- **The store let go → asked again** (`renewHold` `src/shopconnect.js:1837`): hold expired
  (`input_expired` / "expired while waiting") during `needs_approval`, before `ask_since + 30 min − 5 min`,
  nothing `declined` or `paying`, at most `RENEW_MAX` (2, `:1828`) times → the same checkout starts again,
  carrying `ask_since`, `renewals` and whether the reminder went; the old run's link closes `renewed` and its
  page reads "Stores hold a payment for ten minutes. I asked again for the same thing, and a fresh link comes…"
  (`src/pages/webapprove.js:199`); one text: "<Store> let go of the cart before you approved, so I'm asking
  again for <item>. Nothing was charged. A fresh link comes with the total."
- **One reminder** (`remindApproval` `:1863`, `REMIND_BEFORE_MS` 5 min `:1830`): "Still waiting on your
  approval: $26.65 at CVS for …, until 4:52 PM. The Face ID link I sent still works until then." — 5 min
  before the half hour ends, or before the last hold ends when no re-ask is left. `told` carries
  `reminded` across a re-ask, so never twice. The 12-min stall text no longer fires in `needs_approval`.
- **The page shows what the total is made of** (`breakdownRows` `src/pages/webapprove.js:60`): Item ·
  Shipping · Tax · Total from `shop_payments.breakdown` (new column, `src/shopconnect.js:259-260`; written
  from `itemizedParts` `:1326` — Crossmint's structured breakdown, or the question's words when the parts
  add up). A missing shipping/tax row reads "none listed"; one number → "Item, shipping and tax: all in the
  total" + "<Store> gave one number, with shipping and tax in it." The bound challenge is unchanged.
- Driven 2026-11-07 (rel-1107): `bin/passkey-drive.mjs` 23/23 ok rc 0 (step (e) now labelled thirty
  minutes); in-process probe: `APPROVAL_TTL_MS` 1800000, `RENEW_MAX` 2, `REMIND_BEFORE_MS` 300000,
  `itemizedParts` from words and from a structured breakdown both `item 15.97 / shipping 6.99 / tax 2.04`,
  `breakdownRows` → "Item $15.97 Shipping $6.99 Tax $2.04 Total $25.00" and the one-number note;
  `test/shop-small-1107.test.js` (re-ask, old-link page, no re-ask past the half hour or after a decline,
  one reminder) in a 70/70 run. Not proven live: a real re-ask after Crossmint's hold, the reminder on a phone.

## The card's order-intent registration (wt/card-registration, 2026-10-31)

Why the 16:23 UTC approval failed: Crossmint makes an order intent only for a card with an
**order-intent registration**, and the owner's card had none. `saveCard` had PUT
`/api/2026-09-16/payment-methods/{id}/order-intent-registration` as "best effort" with an empty
catch and a body without the email Crossmint requires, so it had been refused (400
`CONSUMER_EMAIL_REQUIRED`) and nobody knew. The owner's card was registered by hand that afternoon
(PUT with his email → 200, rails agentic-token + spt).

Now (`src/shopconnect.js`, `registerCard`/`sweepCards`; `shop_cards.registered` NULL/1/0 and
`reg_error`, the code only):

- `saveCard` registers with the email on their shipping record (`src/shipping.js` gathers it from
  facts, the account and the connected Gmail). Refused: the card row stays, `registered = 0` with the
  code, `card_registration` logged with status+code (never the email). When the email is what is
  missing they are texted once: "Card saved. One more thing before it can pay: which email should
  receipts go to?" The answer goes through `shop_card { receipt_email }`, which keeps it on the record
  and registers the card.
- `payRow`: a card not known registered is registered before the order intent; an intent refused with
  `ORDER_INTENT_REGISTRATION_NOT_FOUND` registers and retries the intent once; only then
  `order_intent_failed`, with `order_intent_failed` logged (status + code) and `needs_email` set when
  that is the cause. `shop_pay` tells the model to ask for the email; `payByPasskey` texts it (once),
  since no model turn runs there.
- Boot: `resumeFollowing` starts `sweepCards()` — every card with `registered IS NULL` is read back
  once (GET → 1, 404 → 0, unreachable stays NULL for next boot), `card_registrations_swept` logged.
- Crossmint's `Origin` is `JWT_ISS()` (`CROSSMINT_JWT_ISSUER`, default `https://heyreason.com`), never
  `REASON_PUBLIC_URL` (the tailscale URL).

Tests: `test/card-registration.test.js` (9: the PUT carries the email; no email → 0 + one text; 400
`CONSUMER_EMAIL_REQUIRED` → 0 + one text; another code → 0, no text; unknown card registered before
the intent; NOT_FOUND → register + retry once, twice → failure with the code logged; no email → payment
stays open, `shop_card receipt_email` registers and the same yes pays; boot sweep; no email in logs).
The passkey drive seeds its card `registered = 1`.

**The email rule (wt/card-email-rule, 2026-10-31, the owner's standing rule for any checkout
snag):** Reason says what is happening, what it can do and what it already has, and asks only for
the decision — never a bare question, never silence. `shipping.knownEmails` lists every email on
record (shipping record, connected Gmail accounts, own facts, earlier checkout instructions);
`receiptEmail` in `src/shopconnect.js` applies it: the record's email is used as is; exactly one
known anywhere is kept on the record and used, and the outcome line names it ("Card ••••1929 is set
up to pay. Receipts go to …"); none → "… is saved, but it can't pay until I have an email for its
receipts. Which one should I use?"; two or more → "… I need an email for its receipts, and I have A
and B on record. Which one?" (`emailAsk`; the Face ID wording adds "Tell me here, then tap the link
again"). Setup is complete at save time: "Card ••••1929 is set up to pay" is said only when the
registration succeeded; another refusal says it couldn't be set up just now and will be retried at
pay time. `shop_pay`/`shop_card` hand the model `emails` and the same instruction; a paid result
carries `receipts_email` when Reason picked it at pay time. Tests: `test/card-email-rule.test.js`
(9 as of 2026-11-07 — the two added: an email `gather()` took from Gmail is a guess, so a second one
on record still means asking; a contact's email in a fact or instruction is never a candidate. The first 7: one → announce and proceed; record email → no announcement; two → both named, ask which, the
answer registers; none → ask with why, once; Face ID wordings + pay-time pick; shop_pay with two;
save-time refusal text).

Live check after deploy: `journalctl -u reason` shows `card_registrations_swept` with
`registered: 1` for the owner's card (saved 2026-10-30, registered by hand 2026-10-31), and
`sqlite3 data/reason.db "SELECT last4, registered, reg_error FROM shop_cards"` reads `1929|1|`.

## The card's CVC after Face ID (wt/cvc-recollect, 2026-11-08)

Live 11-08: the owner's Amazon $14.83 (run 650f8c4c, payment row 3) was approved with Face ID; the
intent was made, handed to the checkout, the row marked paid and $14.83 counted, while Crossmint read
the intent's `encrypted-card` rail as `pending_cvc_recollection` (spent 0.00 / reserved 0.00). The
checkout couldn't fill the card and asked again; every new link hit the same wall.

- After making the intent, `payRow` reads it (`GET /api/unstable/order-intents/{id}`, asked twice).
  `cardRail`: **ready** (an active rail with `"card"` in its credentialFormats; agentic-token /
  encrypted-card by name when formats are missing) → handed over, paid, counted; **cvc** (encrypted
  card `pending_cvc_recollection`, nothing ready) → row back to `asked`, intent kept on the row, no
  spend line, `needs_cvc`; **blocked** (encrypted card in error) and **unreadable** → `order_intent_failed`
  (retryable, nothing reached the store); **unlisted** (no encrypted-card rail at all) → handed over,
  as Crossmint's docs say for a card with no network rail.
- Face ID path: `/verify` answers `needs_cvc` + `cvc {apiKey (client key), jwt (10 min), paymentMethodId}`
  — only after a verified assertion, never in the GET page, never logged. The link reopens (fresh
  nonce) and `shop_payments.cvc_until` = now + 10 min. The page shows "Face ID worked. Enter your card's
  3-digit code to finish." and mounts `ReasonCrossmint.cvcField` (island.jsx →
  `CrossmintCvcRecollection`, @crossmint/client-sdk-react-ui 4.13.4; the code goes to Crossmint's
  iframe only). On `complete` the page POSTs `/web/approve/{token}/cvc` → `payAfterCvc`: link open,
  row asked, inside `cvc_until`, row unchanged (bindingChallenge), link claimed once → `payRow` reuses
  the SAME intent (`intentReusable`: active, same card, same total, nothing drawn, ≥2 min left).
  Still pending → `needs_cvc` again (no new JWT). Page closed meanwhile → a new Face ID reuses the intent.
- Texted-yes path: `needs_cvc` with words (re-save the card in Settings → Shopping); never the card id.
- Network verification (agentic-token `pending_verification`, `OrderIntentVerification`) is not asked:
  Agent Checkouts falls back to the encrypted card, so the CVC alone unblocks.
- CSP of /web/approve now allows `script-src 'self'` (the island) and Crossmint for frame/connect.
- Ledger: `settleUnknownPayments` also releases **paid** rows whose run ended unplaced (status
  failed/cancelled/expired/blocked or stage failed/cancelled, no order_ref) when the intent drew nothing
  and is closed or past `expiresAt` (`intentLapsedUnused`; Crossmint can still read it `active`). Same
  `releasedLineOf` rewrite to $0, row → failed. Runs at boot and on an over-cap check. Live row 3
  releases at the first boot after deploy (log `paid_payment_released`).

Tests: `test/cvc-recollect-1108.test.js` (12; 8 source mutations all caught). Drive `bin/passkey-drive.mjs`
scenario (k): real Chromium, Face ID → CVC screen → island stand-in (network-routed, same URL so the CSP
decides) → Finish → paid with the same intent; shots `passkey-cvc.png`, `passkey-paid-after-cvc.png`.
Fakes in 10 suites + 2 drives answer the new intent read with a ready rail.
Unproven: Crossmint's real field on a phone; whether the production client key has the
`payment-methods.update` scope the docs ask for (a `refused`/`invalid-credentials` result would show it).

## Live check (after the flag flip, read-only, never create a payment)

- Signed in as the owner (headless with the `reason_page` cookie): `https://heyreason.com/web/connect/passkey` returns 200, and the `var B=` boot holds options with `rp.id` = `heyreason.com` and `authenticatorSelection.userVerification` = `required`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/connect/passkey`: signed out gives 404, with no `var B=`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/approve/$(printf 'x%.0s' {1..32})` gives 404 with no options. A real approve page (`rpId` heyreason.com) only exists for a real pending payment. Check it on one Omari starts, never by making one.
- As a non-owner, or with the flag off: no setup options on either route.
