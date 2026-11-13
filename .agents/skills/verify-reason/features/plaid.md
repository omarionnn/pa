# Their bank, read-only, through Plaid (plaid-readonly, 2026-11-12)

- Code: `src/plaid.js` (switch `REASON_PLAID=off|owner|on`, `PLAID_ENV`; tables `plaid_items`,
  `plaid_accounts`, `plaid_transactions`, `plaid_links`, `plaid_reads`, `plaid_pay_checks`; the `bank`
  tool; `verifyWebhook`, `handleWebhook`, `finishLink`, `sync`, `balances`, `balanceCheck`, `disconnect`).
  Routes in `src/http.js`: `POST /plaid/webhook` (`plaidWebhookRequest`), `GET /bank/done` (`bankDonePage`).
  The pay-step check is in `src/shoptools.js` (`shop_pay`). Memory exclusion: `src/runtime.js`
  (`financeReply`), `src/dream.js` (`withoutFinanceReplies`). Delete/export: `src/data.js`.
- Offline proof: `node --test test/plaid.test.js` (36), against `test/fixture-plaid.js` through the
  real `plaid` SDK. The fixture answers the way the real Sandbox did (`SHAPES_FROM`), first sync
  empty included, and one test holds it to the recordings in `test/fixtures/plaid/`.
- Live proof, Sandbox only (needs `PLAID_CLIENT_ID` / `PLAID_SECRET_SANDBOX` in an env file; run
  2026-11-13, 9 of 9, record in `docs/plaid-sandbox-proof-2026-11-13.json`):
  `REASON_PLAID_SANDBOX=1 node scripts/plaid-sandbox-proof.mjs --env-file <file>`. It drives
  `src/plaid.js` itself against sandbox.plaid.com with a throwaway database: Hosted Link creation,
  `/sandbox/public_token/create` → the SESSION_FINISHED handler → exchange → sync (asked before
  anything has arrived: `still_loading`, no number) → balance → recurring; a second bank with a card
  and loans; real transfers and a card payment put there with `/sandbox/transactions/create`; the
  60-day rule with the clock moved; `/sandbox/item/reset_login` → `ITEM_LOGIN_REQUIRED` → an
  update-mode link; `/sandbox/item/fire_webhook`; `/item/remove` and `ITEM_NOT_FOUND` after.
  It prints one line per step and no identifier; every Item is removed at exit.
- Not provable from a laptop: a real webhook delivery and its signature (Plaid needs a public
  address; a 401 or 404 is never retried, so check the first real one in the service log:
  `plaid_webhook` vs `plaid_webhook_rejected`), and Hosted Link in a browser. For the second:
  `node scripts/plaid-sandbox-link.mjs --serve --env-file <file>` prints the link and its expiry;
  open it, pick First Platypus Bank, `user_good` / `pass_good`; the last page is Reason's own
  `/bank/done` served on 127.0.0.1; then `--check` (what came in) and `--disconnect`.
- What to check on a person's screen: the heads-up line and the link on its own line; `/bank/done`
  shows no bank, balance or number; the confirmation text; "how much did i spend this week" leads
  with a number; "disconnect my bank" answers and `plaid_*` rows for them are gone.
