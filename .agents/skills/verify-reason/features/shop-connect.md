# Shop Connect (src/shopconnect.js, src/shoptools.js, src/pages/webconnect.js) — REASON_SHOP_CONNECT off | owner | on

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

## Live (owner only, muted)
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
