# Their bank, read-only, through Plaid (plaid-readonly, 2026-11-12; on for everyone #568, 2026-11-13)

**Live: `REASON_PLAID=on`** — every active account (`src/accounts.js` admit) plus the owner's own thread;
not a paused account, not a group, not a stranger, never on a call (`plaidOn` / `plaidOnFor`, `src/plaid.js:69-86`).

## Sub-features (user POV)
- **Connect by text.** "connect my bank" → a Hosted Link, alone on the last line, good for 30 min. The
  **first** link a person is ever sent comes after fixed consent words (`CONSENT_WORDS`, `src/plaid.js:295`,
  tool field `tell_first`): "before you tap: this connects your bank through Plaid, read-only. i can see your
  balances, transactions and account names (last 4 digits only), and i can't move money. i keep the last 60
  days of transactions. you can tell me to disconnect your bank anytime, and i remove it at Plaid and delete
  what i had." Later links get a one-line heads-up in Reason's own voice. A bank that needs signing in again
  gets an update-mode link (no new Item, never counted).
- **The plan cap** (`connectRoom`, `src/plaid.js:259-276`), checked BEFORE a link is made: banks ever
  connected (`plaid_slots`, one-way: a disconnect or a delete gives none back, as Plaid's Trial counts every
  Item ever) + other people's open new-bank links + 1 must fit `REASON_PLAID_PLAN_ITEMS` (code default **10**,
  Plaid's Trial, `src/config.js:698`; live sets it — the owner was told **20**; the switch value is masked,
  so read the /ops Plaid meter for the live number). Full → `say_exactly` "bank connections are full right
  now; I'll let you know when there's room" (`FULL_WORDS`), no link, Plaid not asked.
- **No per-person bank limit** (owner, 2026-11-15; `REASON_PLAID_PER_PERSON` is gone): anybody connects as many
  banks as the plan's total has room for. Full → the owner gets one line in the daily digest (`FULL_OWNER_LINE`).
- **Open links, not banks:** at most `OPEN_LINKS_PER_PERSON` (2) new-bank links open (unfinished, unexpired) per
  person, and every open link, their own too, counts toward the total. A third ask, or an ask at the last place
  with one of theirs open → `link_open`, `say_exactly` `LINK_OPEN_WORDS` (their earlier link still works), no link,
  Plaid not asked, not waitlisted.
- **The waitlist.** Either refusal puts them in `plaid_waits`; the hourly sweep (`src/serve.js:156`,
  `tellWaiting`) texts "there's room now to connect your bank. want me to send the link?" once, longest
  waiting first, as many as fit. Room appears only when the cap is raised (slots never free up).
- **Only on their own turn.** `case "bank"` in `src/tools.js` (grep `their bank, read-only`): any turn whose
  `ctx.kind` is not `user` (an email, a timer, the nightly review, an event) → `not_asked`, nothing read,
  no link sent.
- **Reads**: `spending` (leads with the total), `transactions`, `subscriptions` (Plaid's recurring list),
  `balance`, `status`, `disconnect`; only the last 60 days are kept (`beyond_60_days` for older); a bank
  that needs a new sign-in is named with a reconnect offer. The pay-step balance check is `shop_pay`.
- **Ops meter**: `/ops` "Plaid banks" (`src/planmeter.js:172`) counts slots against the cap and texts the
  owner at 50/80/100%.

## Source and proof
- Code: `src/plaid.js` (switch `REASON_PLAID=off|owner|on`, `PLAID_ENV`; tables `plaid_items`,
  `plaid_accounts`, `plaid_transactions`, `plaid_links`, `plaid_reads`, `plaid_pay_checks`; the `bank`
  tool; `verifyWebhook`, `handleWebhook`, `finishLink`, `sync`, `balances`, `balanceCheck`, `disconnect`).
  Routes in `src/http.js`: `POST /plaid/webhook` (`plaidWebhookRequest`), `GET /bank/done` (`bankDonePage`).
  The pay-step check is in `src/shoptools.js` (`shop_pay`). Memory exclusion: `src/runtime.js`
  (`financeReply`), `src/dream.js` (`withoutFinanceReplies`). Delete/export: `src/data.js`.
- Offline proof: `node --test test/plaid.test.js test/planmeter.test.js` (43 + 16; the cap,
  per-person, own-turn and forget-me-keeps-the-count tests start at `test/plaid.test.js:1040`), against `test/fixture-plaid.js` through the
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
- **No-network drive (2026-11-14, `REASON_PLAID=on`, cap 20 as on live):** the real `src/plaid.js`, `runTool("bank")`
  and the `/plaid/webhook` handler, with `test/fixture-plaid.js`'s fetch handed to the SDK (`plaid._setFetch`),
  on a throwaway DB under `caged.sh env`. 16/16: cap 20 / per-person 2 read; on for active, off for paused and
  groups; an event turn → `not_asked`; first link carries `tell_first` = the consent words, the second not; a
  third bank → `per_person_limit` (removed 2026-11-15: no per-person limit now); the owner connects three; slots filled to 20 → `connections_full`, Plaid
  not asked, waitlisted; sweep tells nobody until the cap rises, then once; a disconnect frees no slot; no
  token or secret in anything returned or logged. Script kept with the evidence (`plaid-drive.mjs`).
- On the cage itself the switch is off (route `POST /plaid/webhook` → 404) and no Plaid key is set:
  `caged.sh` does not blank `PLAID_*`, so a checkout with a `.env` holding them would reach real Plaid.
- What to check on a person's screen: the heads-up line and the link on its own line; `/bank/done`
  shows no bank, balance or number; the confirmation text; "how much did i spend this week" leads
  with a number; "disconnect my bank" answers and `plaid_*` rows for them are gone.
