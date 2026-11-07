# The daily spending limit, per person (wt/spend-cap, 2026-10-31)

Owner's decision, 16:35 ET: every person has a daily shopping limit of **$100 by default**, and each
person can change their own. Before this the cap was one number for the whole install
(`REASON_MAX_SPEND_PER_DAY`, operator-only, $300 because live `.env` never set it).

- Code: `src/spendcap.js` (`daily_caps` one row per conversation; `cap_changes` the raise waiting for
  its yes; `capFor`, `view`, `requestChange`, `confirmChange`, `declineChange`, `overCapLine`,
  `approvalRow`). `src/trust.js checkSpendCap` / `spendToday` read `capFor`, so every path that asks the
  day's cap (Crossmint `payRow` on both the texted-yes and Face ID paths, AgentCard `purchase_confirm`,
  `browser_submit`) sees the person's number.
- The default: `REASON_MAX_SPEND_PER_DAY` (live `.env` line appended 2026-10-31: `=100`; code default
  stays 300 for a bare install). `0` = no cap at all.
- Monthly: the person's per-purchase / monthly numbers (`spend_caps`, `caps_set`) are asked only on the
  AgentCard path (`trust.checkCaps`); the Crossmint path everyone uses asks ONLY the daily cap. No
  monthly default was added — there is no monthly cap on that path to default.
- Rules, all pinned in `test/spend-cap-1031.test.js` (12; the texted yes read in code is pinned in
  `test/consent-in-code.test.js`, 11):
  - lowering, or any number at or under the default, applies at once (`applied: true`);
  - a raise above the default is a money control: with a passkey it is a Face ID link
    (`pay_approvals.kind = 'cap'`, the challenge bound to the change's id/owner/from/to; the page
    `/web/approve/<token>` shows "Raise your daily limit to $250?" and the tap applies it, one text
    says so); without one it is a plain yes — `spend_limit_confirm` in the chat, or the yes/keep pair on
    Settings — that runs out after `config.askTtlMoneyH` (24h) like every ask about money. With a passkey
    on file the code itself refuses a texted yes or the Settings button (`confirmChange` →
    `needs_face_id`) and hands back a fresh link; the prompt is not the only guard (review fix, 12th test).
    Since #349 the texted yes is read in code, never from the model's `answer`: their own typed message
    after the ask (`asked_after_msgs`), judged as a yes to that raise — none yet → `waiting_for_yes`,
    unclear → `not_a_yes`, a no declines the change (`src/shoptools.js` `spend_limit_confirm`);
  - the ceiling for self-set numbers is `SELF_MAX_CENTS` ($1,000 a day), the owner included; above it
    only the operator can go, by raising the default in `.env`. The refusal names the ceiling and never
    who could go higher or how;
  - a payment that does not fit: the person hears "Your daily limit is $100 and this would take you to
    $118. You can raise it in Settings → Shopping, or tell me a new limit." (`say`), once per payment
    on the Face ID path, as the model's line on the texted-yes path. Never an env var, never words to
    type. The approve page's `WHY.over_daily_cap` says the same;
  - `shop_status.spending`, `spend_today`, `caps_show.today` carry the real figures: spent today, the
    limit, what is left, who set it, the ceiling, any raise waiting.
  - **A payment with an unknown outcome counts (#357, security lead 5, 2026-11-07).** Once Crossmint's
    order intent exists, a checkout message that throws or answers non-2xx leaves the row `unknown`
    (the card may have reached the store), and `payRow`'s `unknown` now calls `countSpend(…, { unknown:
    true })`: the full amount goes on today's ledger as if it went through, the line ending
    "(OUTCOME UNKNOWN)" (`spendLineOf`), like AgentCard's `purchase_confirm` / `browser_submit` unknown
    lines. Fail closed: a second, different payment that would not fit is `over_daily_cap` and never
    reaches Crossmint. The run later succeeding does not count it twice. Before #357 an unknown
    Crossmint payment counted $0. At boot `backfillSpend` (`src/shopconnect.js`, from
    `resumeFollowing`) also counts `unknown` rows the ledger never had, once each (same `what`/`site`
    dedupe as paid rows; `spend_backfilled: n` in the log). The Face ID path (`payByPasskey`) now writes
    the same `trust.noteUnknownOutcome` record the texted-yes `shop_pay` writes. Pinned in
    `test/shop-unknown-spend.test.js` (4) and `test/passkey-pay.test.js` (the unknown-outcome test).
  - **…and stops counting once Crossmint confirms it never charged (security lead 5b, 2026-11-07).**
    `settleUnknownPayments` (`src/shopconnect.js`) reads each `unknown` row's order intent
    (`GET /api/unstable/order-intents/{id}`, client key + the person's JWT). Only `intentNeverCharged`
    releases it: same `orderIntentId`, `status` `cancelled` or `expired` (Crossmint's only non-active
    states; it has no "failed"/"declined" on an intent), and `amount.spent` and `amount.reserved` both
    plain decimals equal to 0 (every credential handed to the store draws on the intent, so 0 = the card
    never reached it, and a non-active intent can't hand it over later). Then, in one `db.atomically`:
    the row `unknown` → `failed` (compare-and-set, so once) and its "(OUTCOME UNKNOWN)" spend line is
    rewritten to 0 cents, `what` ending "(CROSSMINT CONFIRMED NOT CHARGED, not counted)" — the note
    stays in `spend_today.lines`; `spentToday`/`spentThisMonth`/ops count only `cents > 0` lines as
    commits. Log `unknown_payment_released`. Anything else — `active` (our intents run 15 min), any
    amount spent/reserved, a missing/odd field, another id, 404/500/timeout — leaves it counted. Asked
    when a Crossmint payment would be refused `over_daily_cap` (`capRefusal`, then the cap is re-read)
    and at boot after `backfillSpend`. The run's own `failed`/`cancelled` status is NOT a release (a run
    can fail after the card was used). Pinned in `test/shop-unknown-spend.test.js` (17).
- Tools (`src/shoptools.js`, shown where Shop Connect is): `spend_limit_set { daily, text }` and
  `spend_limit_confirm { change_id, answer }`. The spending playbook (`src/playbooks.js`) and the
  `spending_cap` capability line point at them.
- Settings → Shopping (`src/pages/websettings.js capSection`): "Daily limit." with the number, the
  default and the ceiling named, one `$` field + SAVE (`do=cap`), TODAY spent · left. Raise above the
  default: passkey → 303 to `/web/approve/<token>`; else 303 to `?confirm=cap&i=<change>` which draws
  "Raise your daily limit to $250? From $100 a day." with **Yes, raise it →** (`do=cap-confirm`) and
  KEEP $100 (`do=cap-keep`). `done=` cap / cap-kept / cap-bad / cap-ceiling / cap-expired.
- Staging: `scripts/web-staging.mjs` rows settings-shopping, settings-shopping-cap-saved,
  settings-shopping-cap-confirm, settings-shopping-cap-ceiling, approve-cap. Shots in
  `~/Desktop/spend-cap-1031/`.

## Offline

```bash
cd ~/Desktop/pa && node --test test/spend-cap-1031.test.js test/shop-unknown-spend.test.js test/shopping-everyone-1031.test.js test/sites.test.js test/passkey-pay.test.js test/web-settings.test.js
```

## Caged, tool level (fake Crossmint, no network, no model)

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/su.db node .agents/skills/verify-reason/bin/spend-unknown-drive.mjs
```

$100 cap → a $90 payment whose checkout message answers 500 → `unknown_outcome`, $90 counted, line
"Best Buy: USB-C cable ($90.00) (OUTCOME UNKNOWN)", `spend_today` $90 spent / $10 left → a second $90
is `over_daily_cap` ("…would take you to $180…"), no second order intent, row stays `asked` → an old
uncounted `unknown` row counted once by `backfillSpend`, a second run adds 0. 10 steps, all ok on
7e38e15 (2026-11-07, cage on port 8839 doctor-clean first). Lead 5b adds: order intent `active` →
still counted, a third $90 refused; `expired` with $0 spent → the unknown $90 released (row `failed`,
$0 note line), the next $90 paid, spent stays $90; a second `settleUnknownPayments` releases 0. 14 steps, all ok (cage port 8882 doctor-clean first, 2026-11-07).

## Live (muted; read-only)

- `.env` has `REASON_MAX_SPEND_PER_DAY=100` as a later line (a later line wins under `--env-file`).
- `sqlite3 -readonly /opt/reason/data/reason.db "SELECT name FROM pragma_table_info('pay_approvals')"`
  lists `kind`; `daily_caps` and `cap_changes` exist (`.tables`).
- As reason with `--env-file=.env`: `(await import("./src/spendcap.js")).capFor("dm:owner")` →
  `{ cents: 10000, own: false, … }` until somebody sets their own.

## Unproven

A real person raising the limit by Face ID on a phone (the software authenticator and the passkey
drive's shape cover the route). Nobody but the owner has a passkey on live.
