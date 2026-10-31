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
| (d) | **Decline** tells Crossmint to decline. The row is declined and nothing is charged |
| (e) | 5 minutes on (in-process clock): verify gets `link_expired`, the page says "run out", GET returns 410 and nothing is paid |
| (f) | The row's amount changes after the link is made: `details_changed`, nothing paid |
| (i) | Virtual authenticator `isUserVerified: false`: the browser refuses (UV required). A UV-less assertion posted straight to the route gets 400. Nothing is paid |
| (g) | A made-up approve token gets 404 with no options on GET, verify and decline. Signed out, setup GET and POST should get 404 with no options. With the real link, anyone can view the page (it is a bearer link), but a credential that isn't the owner's gets `unknown_passkey`. With the flag off, approve gets 404. For a non-owner, or with the flag off, setup gets 404 or the Connect page for an unknown link (no options) |
| log | `pay_approval_log` has paid, declined and rejected entries, and no card detail |

Notes: the approve page is a bearer link by design, not signed-in only: it opens on a phone that may not be signed in to Web, and paying still needs the owner's passkey. Signed out, a non-owner, or the flag off, `/web/connect/passkey` is a plain 404 (http.js keeps it out of the Connect store-link route).

## Live check (after the flag flip, read-only, never create a payment)

- Signed in as the owner (headless with the `reason_page` cookie): `https://heyreason.com/web/connect/passkey` returns 200, and the `var B=` boot holds options with `rp.id` = `heyreason.com` and `authenticatorSelection.userVerification` = `required`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/connect/passkey`: signed out gives 404, with no `var B=`.
- `curl -s -o /dev/null -w '%{http_code}' https://heyreason.com/web/approve/$(printf 'x%.0s' {1..32})` gives 404 with no options. A real approve page (`rpId` heyreason.com) only exists for a real pending payment. Check it on one Omari starts, never by making one.
- As a non-owner, or with the flag off: no setup options on either route.
