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
- Rules, all pinned in `test/spend-cap-1031.test.js` (11):
  - lowering, or any number at or under the default, applies at once (`applied: true`);
  - a raise above the default is a money control: with a passkey it is a Face ID link
    (`pay_approvals.kind = 'cap'`, the challenge bound to the change's id/owner/from/to; the page
    `/web/approve/<token>` shows "Raise your daily limit to $250?" and the tap applies it, one text
    says so); without one it is a plain yes — `spend_limit_confirm` in the chat, or the yes/keep pair on
    Settings — that runs out after `config.askTtlMoneyH` (24h) like every ask about money;
  - the ceiling for self-set numbers is `SELF_MAX_CENTS` ($1,000 a day), the owner included; above it
    only the operator can go, by raising the default in `.env`. The refusal names the ceiling and never
    who could go higher or how;
  - a payment that does not fit: the person hears "Your daily limit is $100 and this would take you to
    $118. You can raise it in Settings → Shopping, or tell me a new limit." (`say`), once per payment
    on the Face ID path, as the model's line on the texted-yes path. Never an env var, never words to
    type. The approve page's `WHY.over_daily_cap` says the same;
  - `shop_status.spending`, `spend_today`, `caps_show.today` carry the real figures: spent today, the
    limit, what is left, who set it, the ceiling, any raise waiting.
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
cd ~/Desktop/pa && node --test test/spend-cap-1031.test.js test/shopping-everyone-1031.test.js test/sites.test.js test/passkey-pay.test.js test/web-settings.test.js
```

## Live (muted; read-only)

- `.env` has `REASON_MAX_SPEND_PER_DAY=100` as a later line (a later line wins under `--env-file`).
- `sqlite3 -readonly /opt/reason/data/reason.db "SELECT name FROM pragma_table_info('pay_approvals')"`
  lists `kind`; `daily_caps` and `cap_changes` exist (`.tables`).
- As reason with `--env-file=.env`: `(await import("./src/spendcap.js")).capFor("dm:owner")` →
  `{ cents: 10000, own: false, … }` until somebody sets their own.

## Unproven

A real person raising the limit by Face ID on a phone (the software authenticator and the passkey
drive's shape cover the route). Nobody but the owner has a passkey on live.
