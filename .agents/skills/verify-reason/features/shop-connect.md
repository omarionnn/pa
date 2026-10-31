# Shop Connect (src/shopconnect.js, src/shoptools.js, src/pages/webconnect.js) — REASON_SHOP_CONNECT off | owner | on

**Live: `on` for everyone since 2026-10-31 (owner's go at 15:59 ET)**, with `REASON_CHOICE_CARDS=on` and
`REASON_PASSKEY_PAY=on` beside it — appended to live `.env` (a later line wins under `--env-file`; the
`=owner` lines above them are history). Where Connect is on it is the ONLY way to buy, so every account
is off AgentCard's `purchase`/`vault_enroll`/`flight_book` (src/shoptools.js AGENTCARD_BUY_TOOLS); the
AgentCard rows and code stay, dormant. See "Everyone" below for what was checked and added before the flip.

Crossmint agent checkouts: `store_checkout` starts one (guest first; Target/Walmart or `sign_in:true` →
the person's own Crossmint browser profile + ONE texted link to sign in), the run pauses at payment,
Reason texts Crossmint's own amount, and `shop_pay` pays only on a yes to that exact ask.

## Offline
- `node --test test/shopconnect.test.js` — flag, link token hashed + 30-min TTL, protected answers must be
  exactly `{protectedInputId}`, only field KEYS logged, payment row kept as given, pay target pinned to the row.

## Drive (cage, recipe 2 + GET)
`REASON_SHOP_CONNECT=owner REASON_WEB=on CROSSMINT_JWT_KEY_FILE=<pem> CROSSMINT_JWT_KID=<kid> bin/caged.sh start`
(no Crossmint server key in the cage: nothing may reach Crossmint). Then:
- `shopToolVisible("shop_pay", owner)` true, for any other conversation false.
- `cardLink(owner)` → `GET /web/connect/<token>` 200, boot carries `apiKey`/`jwt`, CSP frames only Crossmint;
  a link minted for a non-owner conversation → the "expired" screen; a made-up token → "expired".
- `GET /web/connect/jwks.json` → one RS256 key with the configured kid, no private parts (`d`,`p`,`q`).

## Live (muted; owner only until 2026-10-31)
The real proof is heyreason.com: open a fresh `cardLink(owner)` in headless Chromium and see Crossmint's
iframes (`frame-src` www.crossmint.com) where the card fields are — never a plain `<input>` for a card
number or a store password. Never submit anything: Omari adds his own card.

## Server env
`CROSSMINT_SERVER_KEY`, `CROSSMINT_CLIENT_KEY` (prod, from ~/.openclaw/secrets/crossmint-prod.env),
`CROSSMINT_JWT_KEY_FILE` (/etc/reason/crossmint-jwt.pem, reason:reason 600), `CROSSMINT_JWT_KID`, flag.
The JWKS Crossmint trusts (issuer https://heyreason.com) must hold that kid.

## Any store (2026-10-30)
Key = the store's site (`storeKey`: amazon.com → amazon, shop.costco.com → costco, argos.co.uk → argos);
`STORES` are hints (name, site, `signIn: "required"`). Unknown store → guest; a guest run that ends
`merchant.no_safe_path` at a sign-in wall marks `shop_sites.sign_in = required` and restarts the same
checkout signed in, once (`shop_run_asks.retried`). The pages never show a store logo, icon or colour
(owner 10-30): the store is named in text. `ensureIcon` (https only, no private hosts, ≤200KB) is still
in src/shopconnect.js but no page calls it any more. Offline: section 6 of test/shopconnect.test.js. Real-network spot check
(Amazon, Sephora, Costco, Trader Joe's, Etsy) all returned an icon in ≤1.4s.

## Paper redesign (2026-10-30, card and store sign-in handoff)
Every screen is drawn with src/pages/paperkit.js (frame, underlined field, sealed slot, note, text
actions, lifted paper + stamp, step checklist, six-cell code input). States by `linkView`:
signin (+ `again` → "Target signed me out" first, when a connected store's checkout is asked to sign in
again) · code · **wrongcode** (a code asked again after a code was answered) · retry · checking ·
connected · failed · expired. No-account and, for the card, saving/error are steps on the same page
(`#step-<name>` opens one). Settings → Shopping: stores with SIGN OUT; the card with LAST USED (latest
`shop_payments` row with status `paid`, theirs only, `shop.lastPaid`), Replace card →, Forget it →
`?confirm=card` (the confirm, inside the section). Copy never names Crossmint (pages, Settings, the
texted link), never shows an email, never offers guest checkout.
- Offline: section 7 of test/shopconnect.test.js (incl. a hostile store field key never leaving its attribute).
- The card form stays on screen while Crossmint saves (a bank check inside its iframe stays reachable); the saving step shows only once it says saved.
- Look: `node scripts/connect-staging.mjs` → dist/connect-staging (screens.json maps each to its
  handoff screen); `--deploy` → https://connect--reason-web-staging.netlify.app (alias, never prod).

## Crossmint only (2026-10-30, owner: "we are moving off AgentCard")
Where `connectAllowedFor` is true, Crossmint is the ONLY way to buy. `AGENTCARD_BUY_TOOLS` (src/shoptools.js:
vault_enroll, purchase, purchase_confirm, purchase_track, purchases_recent, flight_book + the four
flight_traveler_* tools) are hidden by `toolsFor` and refused in `runTool` (`blocked: not_available`, points
at store_checkout). `shop_card` is the card tool ("add a card", "what card do I have"): the saved card,
and a 30-minute `/web/connect/<token>` link only when asked or when none is saved. `crossmintWords` rewords
offer_check, shop_handoff, deal_watch_set and the shopping playbook (on both toolsFor and mcpToolsFor), the
`buy_things` capability names store_checkout, and the purchases note calls old AgentCard rows "the old
checkout", never to be confirmed or tracked again. Everybody else: tools and descriptions byte-identical.
- Offline: `node --test test/crossmint-only-buys.test.js` (7).
- Drive (cage, claude-cli, one turn, owner, card seeded in `shop_cards`, no Crossmint server key): "order me
  the CeraVe foaming cleanser 16 oz from walmart" → web_search, offer_check, **store_checkout** (fails on
  "CROSSMINT_SERVER_KEY is not set", as the cage intends), shop_handoff. No AgentCard tool in any turn.
- Live: `toolsFor("dm:owner")` on the server (as reason, `--env-file=.env`): store_checkout + shop_card true,
  purchase/purchase_confirm/vault_enroll/flight_book false.
- Retiring an AgentCard row (no AgentCard void API): `db.markAgentcardPurchase(buyConv, { status: "declined",
  declineCode: "retired_moved_to_crossmint" })`; an `approved` webhook then does nothing (it acts only on
  awaiting_approval) and purchase_confirm is refused for the owner anyway. Row 8 (CeraVe, $17.79) done 10-30.

## Never a dead page (2026-10-31, owner: Walmart sign-in sat still ~100 s after Sign in)
What happened live (shop_links 255636d8, run ce771938, UTC): password answered 18:05:40; the process was
restarted by a deploy 18:06:37–18:06:55; Walmart's code question reached the page 18:07:23; a second
code 18:08:24; connected, stage `paid` 18:11:22. The page only redrew on a state change, so ~100 s of
nothing. Now every wait is a `live()` block (src/pages/paperkit.js): a sweeping pen line, a status line
by elapsed seconds (`checkingLines`: sent → checking 8 s → still checking 30 s → longer than usual 75 s →
still here, will text 180 s), a clock; `prefers-reduced-motion` drops the sweep and keeps the words.
`shop_links.answered_at` is the record's clock: `linkView` → `{state:"checking", waited, stage}`, the
page boots with `waited`, `GET …/state` returns `{state, waited, stage}` and the page resyncs on each
poll; `pfWake` polls at once on visibilitychange/pageshow/focus/online (Safari backgrounding). The run
ending while the link still says open (`TERMINAL` status) reads as `failed` with `failReason` (timeout /
lost / stopped) → "That sign-in didn't go through. Nothing was charged." + next step; an old or
made-up link → 410 "This link has expired. Ask me for a new one." The sign-in and card forms show a
"Sending to …, sealed." line while the tap is in flight; the card's saving step and the Face ID
approve page's paying step (`payingLines`, src/pages/webapprove.js) carry the same block.
- Offline: `node --test test/signin-progress.test.js` (9).
- Drive (cage, muted, no Crossmint key, real Chromium): `bin/shop-connect-live-drive.mjs` under
  `caged.sh env` — 18 checks: boot/`/state` waited, the words at 95 s, clock ticks, sweep moves, pageshow
  polls at once, a new question and the run dying each redraw the open page, 410s. Shots in
  `~/Desktop/signin-progress-1031/` (cage-checking-95s, cage-code, cage-failed).
- Look: `node scripts/connect-staging.mjs --deploy` → walmart-checking-{0,12,45,100,200}, walmart-failed-{timeout,stopped,lost}.

## Everyone (wt/shopping-everyone, 2026-10-31)
What was checked and added before `REASON_SHOP_CONNECT`, `REASON_CHOICE_CARDS` and `REASON_PASSKEY_PAY`
went from `owner` to `on` on live. Pinned in `test/shopping-everyone-1031.test.js` (7; three of them
fail on afc6ce8: the two cap tests and the pin test).
- **The daily cap is asked before a Crossmint payment, for everyone.** `payRow` (both the texted-yes
  path `payApproved` and the Face ID path `payByPasskey`) runs `trust.checkSpendCap` on the row's exact
  amount before claiming the row: over it → `{ error: "over_daily_cap", cap, spent_today, left, say }`,
  the row stays `asked`, nothing reaches Crossmint, and the journal gets `shop_pay_over_cap`. Until then
  only AgentCard's `purchase_confirm` and `browser_submit` asked it; a Crossmint payment was only counted
  afterwards (`countSpend`, #304). The cap is the install's `REASON_MAX_SPEND_PER_DAY` (whole dollars per
  person per day, default 300; NOT set in live `.env`, so $300 — **since wt/spend-cap later that day: `=100` on
  live, and each person's own number overrides it; see [spend-cap.md](spend-cap.md)**). The person's own caps (`caps_set`:
  per-purchase, monthly) are not asked here: every Crossmint payment is a yes to that exact amount, which
  is what those two let through anyway. On the Face ID path the cap is asked BEFORE the assertion is
  verified (verifying marks the link used), so the link stays open and the page never ends on "Already
  approved"; the page reads "This is past the day's spending limit here. Nothing was charged. Tomorrow,
  ask me to start the order again." (the Crossmint request itself runs out in ~30 min, so tomorrow is a
  new order, not this link), the person is texted one line with the figures once per payment, and the
  log gets `pay_failed over_daily_cap`. An amount that does not read as money is `bad_amount`, never $0.
- **The store-icon fetch connects to the addresses it checked** (`pinnedGet`: `node:https` with the
  checked list as its `lookup`, `_pinnedLookup`), so a name that answers a public address to the check
  and a private one to the connect (DNS rebinding) cannot reach the private one. Every redirect hop is
  resolved, checked and pinned on its own; a test's fake fetch sees `init.addresses` per request.
  A store named by a bare IP is never fetched at all (`hostOf` wants a lettered TLD).
- **A page JWT alone cannot start a payment through Reason.** Read-only probe on live (GETs with a
  throwaway `sub`, 2026-10-31 20:04Z): client key + JWT reads that user's own `payment-methods` and
  `order-intents` (200, empty); without the JWT the client key is refused (403); the client key has NO
  `agent-checkouts.*` scope, so it cannot read, run or answer a checkout — only the server key does that,
  and the `orderIntentId` is useless without a checkout to submit it to. The client key DOES carry
  `order-intents.create` / `order-intents.credentials` (Crossmint's design: order intents are the user's
  own), so a 30-minute JWT lifted off the person's own connect page could create an order intent on
  THEIR OWN saved card and ask for a credential — which needs the card network's own verification on
  their device (Visa/Mastercard rail) or the encrypted-card production add-on (unknown whether this
  project has it; a direct request without it fails `ADDON_REQUIRED`). The JWT's `sub` is the
  conversation's Crossmint user, signed server-side, so nobody can mint one for someone else's card.
  Not a blocker; noted.
- **Cooling-off is the same for everyone**: `passkey.register` — first passkey usable at once, any later
  one after `COOL_MS` (24h), no owner branch. Pinned for a non-owner.
- **Live state at the flip**: `agentcard_users` 3 rows (owner + two others, one with a visa linked
  2026-10-17); `agentcard_purchases` 4 open rows, all the owner's and stale (shopping / cart_shown /
  awaiting_approval, 10-24..10-30) — nothing cancelled, nothing texted. `shop_cards` 1 (owner).
