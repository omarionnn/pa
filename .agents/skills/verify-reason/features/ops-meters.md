# Plan meters on /ops: Cartesia calls, Plaid banks, Google Places (src/planmeter.js)

The owner opens `/ops` and sees, under Money, how much of each metered plan Reason has used. They get one
text as each meter crosses 50%, 80% and 100%. Shipped in #546 (Cartesia + Plaid, 2026-11-13), Google Places
in #577 (2026-11-14). Numbers only: no names, numbers or call content reach a reading.

Source: `src/planmeter.js` (`METERS`, `readAll`, `warnings`, `textFor`, `detailOf`, `warnedWords`),
`src/ops.js` (the `plan:<id>` rows, amber from 80%, `quiet`; `planmeter.warnings` runs after each 5-minute
pass with `sendNow`), `src/pages/ops.js` (`metersSection`, the bars), `src/config.js` (plan settings),
`src/calls/cartesia.js:986` (writes `calls.cartesia_seconds` / `cartesia_fell_back` when a call ends),
`src/googleplaces.js` (`TIERS`, `capOf`, `monthOf`: the Places caps and billing month).
Live state (2026-11-14 switches): no switch; owner-only by nature (only `/ops`). Cartesia and Plaid rows show
(keys set); the Places rows don't (no `REASON_GOOGLE_PLACES_KEY`).
Tests: `test/planmeter.test.js` (16), `test/places-google.test.js` (the Places meter).

## Sub-features

- **Cartesia calls (monthly).** Reason counts its own Cartesia call seconds this cycle (always shown, and
  always an estimate) against `REASON_CARTESIA_PLAN_USD` (default $5), `REASON_CARTESIA_RATE_USD_PER_MIN`
  (default $0.03) and `REASON_CARTESIA_CYCLE_DAY` (default the 30th; a short month uses its last day). The
  cycle is in UTC days. Shown only when `CARTESIA_API_KEY` and `REASON_CARTESIA_AGENT_ID` are set (both set
  on live). With an admin key (`CARTESIA_ADMIN_API_KEY`, or a `sk_car_admin_` key) it also reads Cartesia's
  own figure with `GET /usage/agents` at most every 15 minutes, never from a call. If that read fails,
  the last good figure stays, with its age. Live has no `CARTESIA_ADMIN_API_KEY` line, so Reason's count is
  what live shows unless the agent key is itself an admin key.
  Row: `54% of $5 · 90 of 167 min · 76 min left · cycle Oct 30–Nov 30 · at this pace runs out around the 28th · Reason's estimate`.
- **Plaid banks (standing).** Counts every bank ever connected across everyone (a disconnected one still
  counts, because Plaid's Trial never gives an Item back) against `REASON_PLAID_PLAN_ITEMS` (default 10;
  set on live). Shown only when Plaid is configured (`PLAID_CLIENT_ID` + a secret). Row:
  `5 of 10 bank connections · 50% · 5 left`.
- **Google Places (standing per month), only with a key.** Two rows, Pro and Enterprise searches, against
  Reason's own hard caps (`REASON_GOOGLE_PLACES_PRO_MAX` 4500, `REASON_GOOGLE_PLACES_ENT_MAX` 900 by default,
  inside Google's free 5,000 / 1,000, `src/googleplaces.js:49`). Texts at 80% and 100% only. The count resets on the 1st (Google's billing
  month, Pacific time). **Live has no `REASON_GOOGLE_PLACES_KEY`, so neither row shows there.**
- **The texts.** Each threshold texts once: per cycle for Cartesia, and on the way up for a standing
  count, re-armed when the count drops back below it. The mark goes in `ops_state` before the send, so a
  restart never repeats one. A jump straight past two thresholds texts only the higher one. Idempotency key
  `ops:plan_warn:<id>:…` (an operator notice). Wording, from the 2026-11-14 drive:
  - "Cartesia: 80% of this month's $5 call credit used (140 of 167 minutes). At this pace it runs out around the 18th. Calls fall back to the old voice when it does."
  - "Cartesia: 100% of this month's $5 call credit used (180 of 167 minutes). Calls are falling back to the old voice until the credits refresh. Credits refresh on the 30th."
  - "Plaid: 8 of 10 bank connections used (80%). New connections stop at 10 on the trial plan."
  - "Plaid: 10 of 10 bank connections used (100%). New connections stop here on the trial plan: 10 is the most it allows."
  The row adds "80% text sent Nov 21" once one has gone.

## How to get to it (user POV)

Open `heyreason.com/ops`, sign in, and look under Money for "Cartesia calls" and "Plaid banks" (plus the
two Google Places rows once a key is set). A row turns amber at 80%. The owner's phone gets the texts above (the operator's thread, keyed as an operator notice).

## Driving it with the harness

- Offline: `node --test test/planmeter.test.js test/places-google.test.js` (136/136 with the other ops files
  on 2026-11-14).
- In process, no network, nothing sent: a module on a throwaway `REASON_DB_PATH` with dummy
  `CARTESIA_API_KEY=cage-fake REASON_CARTESIA_AGENT_ID=cage-agent PLAID_CLIENT_ID=cage-fake PLAID_SECRET_SANDBOX=cage-fake`,
  no admin key and no Places key. Seed `calls` rows with `db.createCall` + `db.updateCall(c, id, { cartesia_seconds })`
  and `plaid_items` + `plaid_slots` rows, then call `planmeter.readAll({ fetchImpl: refuse })` and
  `planmeter.warnings({ readings, send: capture })`, and render `metersSection(readings)` from
  `src/pages/ops.js`. Seen 2026-11-14 (`7d5b5f54`): meters `cartesia,plaid` with no Places key; 50% →
  two texts, the same readings again → none, 80% → two, 100% → two, all keyed `ops:plan_warn:`; the panel
  carries no number; with a dummy Places key the meters are `cartesia,plaid,google-places-pro,google-places-enterprise`.
  (Drive script kept in that run's evidence folder.)
- Live, read-only: the `plan:cartesia` / `plan:plaid` rows in `/ops.json` after sign-in; on the live server
  (OVH, root@15.204.113.250) `sqlite3 -readonly /opt/reason/data/reason.db "SELECT k, v FROM ops_state WHERE k LIKE 'plan_warn:%'"`
  shows which texts have gone.

## Gotchas

- Never point a drive at the real Cartesia usage API. Leave the admin key unset (the page then shows
  Reason's count only) or pass a `fetchImpl` that refuses.
- The Cartesia count only sees calls that ran on Cartesia (`cartesia_seconds` set). GPT-Live calls,
  including free-tier callers who stay on GPT-Live (#575), don't count.
- The Plaid allowance is also the cap a new bank connection is checked against (`src/plaid.js`). Lowering
  `REASON_PLAID_PLAN_ITEMS` stops new connections, not just the meter.
