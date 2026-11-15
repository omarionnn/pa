# Paid-API hard caps

The owner tops up Reason's API key only on the promise it cannot be drained (2026-10-25: $10 went
overnight). `src/spend.js` `capReached` reads `model_usage` on every ask, so each cap lifts by itself
at New York midnight / on the 1st with nothing to reset.

## Sub-features

- **Daily cap** — `REASON_API_DAILY_CAP_USD` (default $1), every paid feature except calls. Reached:
  `apiOut(feature)` is true and `callApi` throws before any request. Since #227 (2026-10-27) no
  text-side feature calls the API at all (harm screen, one-thought sorter, said check, extraction,
  profile, judge, watch are CLI-only), so on the live claude-cli install this cap has nothing left
  to stop; it still governs the API backend (`REASON_BACKEND=api`), which live does not run. The
  alert text below still says "the pre-reply checks are on the subscription", which is now always true.
- **Call cap — a heads-up only** (owner, 2026-10-25) — `REASON_API_CALL_DAILY_CAP_USD` (default $2;
  live $6), features `call` and `call_harm` (`CALL_FEATURES`). Calls never count toward the daily cap
  and are NEVER stopped, moved or degraded by any cap: `apiSkipWhy` returns null for a call feature
  (only the out-of-credit pause applies) and `callBackendName()` in `src/calls/voice.js` ignores spend.
  Past it, the `api_call_cap` row goes amber and the owner gets one text; that is all.
- **Monthly cap** — `REASON_API_MONTHLY_CAP_USD` (default $10; live $1,200 per #374's read of live `.env`, 2026-11-07), every paid use but calls is
  stopped; calls' spend still counts toward it (it is the bill), for the
  calendar month (New York).
- **One text** — /ops rows `api_spend` and `api_call_cap` go amber (the monthly cap turns `api_spend`
  red, `bad`, with its own alert) with an `alert` in the owner's
  words ("API daily cap reached ($1.00), the pre-reply checks are on the subscription until
  midnight."), sent once through ops' sustained-alert path; `quietRecovery` makes the lift silent.
- `0` turns a cap off.
- **80% heads-up, once per day / per month** (#374, 2026-11-07) — `capWarnings` (src/spend.js:393),
  run after every ops pass (`startOps`, src/ops.js:949-950). At `WARN_AT` of a cap (src/spend.js:280,
  `REASON_API_WARN_AT`, a share strictly between 0 and 1, else 0.8) the owner gets one live text:
  "Reason heads-up: API spend is at 81% of the daily cap, $49.00 of $60.00 today (phone calls not
  counted)." / "… 80% of the monthly cap, $969.00 of $1200.00 this month." Keyed `api_warn:daily:<day>`
  / `api_warn:monthly:<YYYY-MM>` in `ops_state`, marked before the send (`capWarningsDue`,
  src/spend.js:376); idem key `ops:<key>`. Daily counts `todayOther` (calls excluded). At or past a
  cap there is no 80% line (the cap's own alert speaks); a cap of 0 is off. The `api_spend` row then
  adds "daily 80% warning sent 2026-11-07 15:00 UTC" (`warnedWords`, src/spend.js:405) and stays green.
- **Provider usage-limit alert, once per episode** (#374) — `recordApi` (src/spend.js:59), which every
  paid lane goes through, calls `noteLimitError` / `clearLimitHit` (src/spend.js:332, :347).
  `isUsageLimit` (src/spend.js:299) matches the 11-05 wording ("reached your specified workspace API
  usage limits … regain access on …") or a 429 naming a usage limit; a per-minute 429
  `rate_limit_error` and the credit refusal (`isLowCredit`, own path) are not. First refusal → one text
  at once: "Reason alert: the Anthropic API workspace usage limit is reached, so every paid API call is
  being refused until 2026-12-01 at 00:00 UTC (the API's words). Raise the limit in the Anthropic
  Console, or move replies to the subscription." (`limitText`, src/spend.js:319; idem
  `ops:api-limit:<at>`). Episode in `ops_state` `api_limit:hit` (count, regain, told). A paid call that
  goes through ends it (`api_limit:last`) — but only 60 s or more after the last refusal
  (`LIFT_MARGIN_MS`: a success sooner is a call begun before the limit). A refusal seen at boot before
  the wiring is told by `startAlerts` (src/spend.js:286), once. No cheaper-model fallback: the limit is
  on the key. Both texts go `runtime.say(owner, digest.scrub(text), { toMaster })` — live, never the digest.
- **/ops "API usage limit (provider)"** (`api_limit`, money group, src/ops.js:619-622, `limitCheck`
  src/spend.js:359) — `quiet: true`, so the pass never texts it. Red while refused: "the provider is
  refusing paid calls: workspace usage limit reached since … UTC · 5 refused · access back 2026-12-01
  at 00:00 UTC per the API · owner texted … UTC"; clear: "never hit" or "not hit now · last hit …,
  over … (N refused)".

## How to get to it (user POV)

Nobody asks for it. The owner sees the /ops "API spend today / 7d by feature" row (`api_spend`, src/ops.js:611) (`$X of $1.00 today · calls $Z of $2.00 ·
$Y of $10.00 this month`) and the "Phone calls on the API" row, and gets one text the day a cap hits.

## Driving it with the harness

- Offline: `node --import ./test/paid-key-guard.js --test test/api-hard-cap.test.js` — flip, midnight,
  month rollover, calls never stopped by any cap, exactly one text. `test/spend-alert.test.js` (12 at
  rel-1107) — the 80% lines, the usage-limit episode, the quiet row, startOps wiring, the digest hour.
- **No-model drive of the warnings** (2026-11-07, rel-1107 `8bbcb96`): from the repo root,
  `D=$(mktemp -d /tmp/sa.XXXX); env -i PATH=$PATH HOME=$HOME REASON_DB_PATH=$D/x.db REASON_DATA_DIR=$D
  REASON_TZ=America/New_York REASON_CALL_PROVIDER=fake node .agents/skills/verify-reason/bin/spend-alert-drive.mjs`
  — real `spend.js` + `ops.runChecks` + `startOps` with a fake `runtime.say`: 78% nothing / 81% one
  daily line / monthly once / past cap none / 429 not a limit / first refusal texted, four more silent /
  `api_limit` row bad+quiet / success at +30 s keeps the episode, at +70 s ends it / row "not hit now ·
  last hit …" / next refusal texts again / `api_spend` "daily 80% warning sent" / startOps sends to
  `dm:owner` with `ops:api_warn:daily:<day>`. 16 steps, "all ok", rc 0. Nothing leaves the process.
- Cage (2026-10-25): `bin/caged.sh start`; with `caged.sh env` exported (and `REASON_VERIFY_RUN`
  the same as the cage's), a node script calls `spend.recordApi` for `harm` $1.05 and `call` $2.10,
  `db.saveOpsCheck` both rows `warn` 10 min back, and makes an ops session with `db.startPageSession("ops", token, { conversationId: config.ownerConversation })`
  (since 11-08 rows are hashed and /ops opens only on `page_id 'ops'`). `POST /ops.json` with `Cookie: reason_ops=<token>` and an `Origin` of the cage's own address
  and `action=check` twice → `serve.log` shows ONE "Reason check — 2 things need you" text, then
  `texted:false`. (2026-10-27, via the since-removed `bin/call-turn.sh`) one call turn past both caps → `voice_turn_threw` with the SDK's
  "Could not resolve authentication method" (the key is blanked): the turn went to the API path, i.e.
  the call was not moved or stopped.

- 2026-11-14 (`7d5b5f54`, evidence `*-g4-api-caps`): `spend-alert-drive.mjs` all ok again (same recipe); the
  api-caps suites 49/49 (no paid call constructed on any backend).

## Gotchas

- `caged.sh env` prints the DEFAULT run dir unless `REASON_VERIFY_RUN` is exported in the same
  shell — seeding then lands in another cage's database.
- Spend is an estimate off `config.apiPrices`; an unknown model costs $0 and never trips a cap.
- The 80% monthly line only helps if `REASON_API_MONTHLY_CAP_USD` is at or below the Anthropic
  Console's workspace limit: on 11-05 the workspace refused at about $70 of spend with Reason's cap at
  $1,200 (#374 body). An owner `.env` change, not code.
- `LIFT_MARGIN_MS` (60 s): a drive that records a success right after a refusal sees the episode stay
  open. That is the rule, not a bug.
- The API-backend reply path (`src/agent.js`) is not capped: there is nothing to fall back to and
  live runs on claude-cli. `looked.js captureViaApi` is the API backend's too.
