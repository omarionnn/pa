# Shop Connect (src/shopconnect.js, src/shoptools.js, src/pages/webconnect.js) — REASON_SHOP_CONNECT off | owner | on

Crossmint agent checkouts: `store_checkout` starts one (guest first; a store known or learned to need an
account, or `sign_in:true` → the person's own Crossmint browser profile + ONE texted link to sign in),
the run pauses at payment, Reason texts Crossmint's own amount, and `shop_pay` pays only on a yes to that
exact ask.

**Any store (10-30).** A store's key is its site's name (`storeKey`: amazon.com → `amazon`; a bare
unknown name is keyed by the start URL). `STORES` is hints only (name, `signIn` required/guest, `drawn`
for the three drawn marks). Unknown stores go guest; a guest run that ends `blocked`/`failed` with
`merchant.no_safe_path` (and a why that's about an account, or no why) sets `shop_store_info.sign_in`
for that store and starts ONE signed-in retry, whose sign-in form texts the link. Names and icons live
in `shop_store_info`; icons come from `src/storeicons.js` (apple-touch-icon / favicon ≥32px, public https
only, every redirect hop DNS-checked), cached as a data: URI, retried after 7 days; none → the serif
monogram. The page waits at most 3 s for a first fetch.

## Offline
- `node --test test/shopconnect.test.js` — flag, link token hashed + 30-min TTL, protected answers must be
  exactly `{protectedInputId}`, only field KEYS logged, payment row kept as given, pay target pinned to the row.

## Drive (cage, recipe 2 + GET)
`REASON_SHOP_CONNECT=owner REASON_WEB=on CROSSMINT_JWT_KEY_FILE=<pem> CROSSMINT_JWT_KID=<kid> bin/caged.sh start`
(no Crossmint server key in the cage: nothing may reach Crossmint). Then:
- `shopToolVisible("shop_pay", owner)` true, for any other conversation false.
- `cardLink(owner)` → `GET /web/connect/<token>` 200, boot carries `apiKey`/`jwt`, CSP frames only Crossmint;
  a link minted for a non-owner conversation → the "expired" screen; a made-up token → "expired".
- Any store: `createLink` a sign-in for `storeKey("https://www.amazon.com/dp/…")` and for an unknown store
  (`rememberStore("bluebottlecoffee", { name: "Blue Bottle Coffee", host: "bluebottlecoffee.com" })`) →
  both 200, "Sign in to Amazon." with `cx-mark-i` + a `data:image/` icon (fetched live from amazon.com),
  "Sign in to Blue Bottle Coffee." with the `cx-mark-x` monogram and no `<img>`; `shop_store_info` has
  both rows with `icon_checked_at` set. `scripts/connect-staging.mjs` draws amazon-signin,
  amazon-connected, unknown-signin and Settings with three stores.
- `GET /web/connect/jwks.json` → one RS256 key with the configured kid, no private parts (`d`,`p`,`q`).

## Live (owner only, muted)
The real proof is heyreason.com: open a fresh `cardLink(owner)` in headless Chromium and see Crossmint's
iframes (`frame-src` www.crossmint.com) where the card fields are — never a plain `<input>` for a card
number or a store password. Never submit anything: Omari adds his own card.

## Server env
`CROSSMINT_SERVER_KEY`, `CROSSMINT_CLIENT_KEY` (prod, from ~/.openclaw/secrets/crossmint-prod.env),
`CROSSMINT_JWT_KEY_FILE` (/etc/reason/crossmint-jwt.pem, reason:reason 600), `CROSSMINT_JWT_KID`, flag.
The JWKS Crossmint trusts (issuer https://heyreason.com) must hold that kid.
