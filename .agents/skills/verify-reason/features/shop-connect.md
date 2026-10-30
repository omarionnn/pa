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
