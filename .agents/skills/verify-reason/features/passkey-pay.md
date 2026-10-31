# Purchase approval by passkey (Face ID)

Branch wt/passkey-approve, PR #285 (2026-10-31). Once someone has set up a passkey, a texted yes stops paying for Crossmint purchases. Reason texts a link instead, and only a user-verified passkey assertion pays, for that payment's exact amount and store, once, within 5 minutes. Self-hosted with `@simplewebauthn/server`.

- Flag: `REASON_PASSKEY_PAY` = off (default) / `owner` / on. It only works where `REASON_SHOP_CONNECT` is also on. Origin and RP ID come from `REASON_PASSKEY_ORIGIN`, else `REASON_SITE_URL`, else `https://heyreason.com`.
- Code: `src/passkey.js` (passkeys, approval links, the challenge bound to the payment row, the log), `src/pages/webapprove.js` (pages + routes), `src/shopconnect.js` (`approvalUrl`, `approvalView`, `payByPasskey`, `declineByLink`; `payApproved` refuses with `approve_with_passkey`), `src/shoptools.js` (`shop_pay` hands out the link), and the routes in `src/http.js`.
- Routes: `GET /web/connect/passkey` (signed-in setup page, options drawn in), `POST /web/connect/passkey/verify`, `GET /web/approve/{token}` (amount, store, item, Approve with Face ID, Decline), `POST /web/approve/{token}/verify|decline`.
- Tests: `test/passkey-pay.test.js` (a software authenticator and a fake Crossmint).

## Drive (muted: no texts, no model, no Crossmint, nothing leaves the process)

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/pk.db node --no-warnings .agents/skills/verify-reason/bin/passkey-drive.mjs [--shots=DIR] [--headed]
```

The drive runs the real `src/http.js` on loopback, opened in Chromium as `http://localhost:<port>` (RP ID `localhost`). The passkey is a CDP virtual authenticator (ctap2, internal, UV on), and it is used through the page's own buttons. Crossmint is answered by `shop._setFetch` and texts go to an array. Any other fetch throws. The last line reads `all ok`, or the drive exits 1.

| Step | Proves |
|---|---|
| (a) | Setup options say `userVerification: "required"` and `rp.id` is the origin's host |
| (b) | A real `navigator.credentials.create` through **Set up Face ID** is verified and saved, and the owner is texted |
| (h) | With a passkey saved, `shop_pay` with a granted yes returns the link and does not pay, `payApproved` returns `approve_with_passkey`, and no order intent is made |
| (c) | The approve page shows $12.49 at Best Buy and lists only the owner's credential. **Approve with Face ID** makes one order intent for exactly 12.49 USD, the row is paid and the owner is texted. Replaying the same assertion gets 400 `link_used`, and the page then says Already approved |
| (j) | **The payment does not start** (live 2026-10-31 at CVS, PR #288): Face ID passes, Crossmint refuses the order intent. The page shows "Face ID worked. The payment didn't start. Nothing was charged." with **Try again**; the row stays asked, `pay_approval_log` has `pay_failed order_intent_failed 400 <code>` then `link_reopened`; `shop_status` names the still-open link and makes no new one. Try again reloads under a fresh challenge (the first assertion replayed → `not_verified`); the next tap pays: one more order intent, row paid, run stage `paid`, "Paid $26.65" texted; then the link is used up |
| (d) | **Decline** tells Crossmint to decline. The row is declined and nothing is charged |
| (e) | 5 minutes on (in-process clock): verify gets `link_expired`, the page says "run out", GET returns 410 and nothing is paid |
| (f) | The row's amount changes after the link is made: `details_changed`, nothing paid |
| (i) | Virtual authenticator `isUserVerified: false`: the browser refuses (UV required). A UV-less assertion posted straight to the route gets 400. Nothing is paid |
| (g) | A made-up approve token gets 404 with no options on GET, verify and decline. Signed out, setup GET and POST should get 404 with no options. With the real link, anyone can view the page (it is a bearer link), but a credential that isn't the owner's gets `unknown_passkey`. With the flag off, approve gets 404. For a non-owner, or with the flag off, setup gets 404 or the Connect page for an unknown link (no options) |
| log | `pay_approval_log` has paid, declined and rejected entries, and no card detail |

A link is marked `used` the moment the assertion verifies, before the order intent. If the payment fails to start (no order intent: `order_intent_failed`, `no_card`, …) `passkey.reopenApproval` sets it back to `open` under a NEW nonce/challenge, so the same URL works for another tap and the first assertion is dead; the five-minute deadline does not move. Once the card may have reached the store (`unknown_outcome`) the link stays used — never paid twice. `shop_status` (`approvalHint`) hands the model a fresh `approve_url` only when no open link exists for an asked payment whose Crossmint window is still open; an open link is named with its minutes left; a passed window says to start again. Accepted origins: the site and its `www.` form (`passkey.ORIGINS()`); the RP ID is the apex host. The expired-checkout texts (`endText`, `stageLine`) name what the store wanted from the form's fields — "your shipping address and phone number" — via `askedFor(run)`, never the store's prompt.

Notes: the approve page is a bearer link by design, not signed-in only: it opens on a phone that may not be signed in to Web, and paying still needs the owner's passkey. Signed out, a non-owner, or the flag off, `/web/connect/passkey` is a plain 404 (http.js keeps it out of the Connect store-link route).

## Live check (after the flag flip, read-only, never create a payment)

- Signed in as the owner (headless with the `reason_page` cookie): `https://heyreason.com/web/connect/passkey` returns 200, and the `var B=` boot holds options with `rp.id` = `heyreason.com` and `authenticatorSelection.userVerification` = `required`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/connect/passkey`: signed out gives 404, with no `var B=`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/approve/$(printf 'x%.0s' {1..32})` gives 404 with no options. A real approve page (`rpId` heyreason.com) only exists for a real pending payment. Check it on one Omari starts, never by making one.
- As a non-owner, or with the flag off: no setup options on either route.
