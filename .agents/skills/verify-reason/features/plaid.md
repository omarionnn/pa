# Their bank, read-only, through Plaid (plaid-readonly, 2026-11-12)

- Code: `src/plaid.js` (switch `REASON_PLAID=off|owner|on`, `PLAID_ENV`; tables `plaid_items`,
  `plaid_accounts`, `plaid_transactions`, `plaid_links`, `plaid_reads`, `plaid_pay_checks`; the `bank`
  tool; `verifyWebhook`, `handleWebhook`, `finishLink`, `sync`, `balances`, `balanceCheck`, `disconnect`).
  Routes in `src/http.js`: `POST /plaid/webhook` (`plaidWebhookRequest`), `GET /bank/done` (`bankDonePage`).
  The pay-step check is in `src/shoptools.js` (`shop_pay`). Memory exclusion: `src/runtime.js`
  (`financeReply`), `src/dream.js` (`withoutFinanceReplies`). Delete/export: `src/data.js`.
- Offline proof: `node --test test/plaid.test.js` (27), against `test/fixture-plaid.js` through the
  real `plaid` SDK. `SHAPES_FROM` in the fixture says whether its shapes are from the docs or a real
  Sandbox run.
- Live proof (needs `PLAID_CLIENT_ID` / `PLAID_SECRET` for Sandbox in `.env`): not yet run. The
  Sandbox flow to drive: `/sandbox/public_token/create` (ins_109508, transactions) → exchange →
  `/transactions/sync` → `/accounts/balance/get` → `/transactions/recurring/get` →
  `/sandbox/item/fire_webhook` (SYNC_UPDATES_AVAILABLE, needs a public webhook URL) →
  `/sandbox/item/reset_login` then a sync (expect ITEM_LOGIN_REQUIRED and an update-mode link) →
  `/item/remove`. Hosted Link itself has to be opened by a person (user_good / pass_good).
- What to check on a person's screen: the heads-up line and the link on its own line; `/bank/done`
  shows no bank, balance or number; the confirmation text; "how much did i spend this week" leads
  with a number; "disconnect my bank" answers and `plaid_*` rows for them are gone.
