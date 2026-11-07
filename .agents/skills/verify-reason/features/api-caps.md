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
- **Monthly cap** — `REASON_API_MONTHLY_CAP_USD` (default $10; live $150), every paid use but calls is
  stopped; calls' spend still counts toward it (it is the bill), for the
  calendar month (New York).
- **One text** — /ops rows `api_spend` and `api_call_cap` go amber (the monthly cap turns `api_spend`
  red, `bad`, with its own alert) with an `alert` in the owner's
  words ("API daily cap reached ($1.00), the pre-reply checks are on the subscription until
  midnight."), sent once through ops' sustained-alert path; `quietRecovery` makes the lift silent.
- `0` turns a cap off.

## How to get to it (user POV)

Nobody asks for it. The owner sees the /ops "API spend" row (`$X of $1.00 today · calls $Z of $2.00 ·
$Y of $10.00 this month`) and the "Phone calls on the API" row, and gets one text the day a cap hits.

## Driving it with the harness

- Offline: `node --import ./test/paid-key-guard.js --test test/api-hard-cap.test.js` — flip, midnight,
  month rollover, calls never stopped by any cap, exactly one text.
- Cage (2026-10-25): `bin/caged.sh start`; with `caged.sh env` exported (and `REASON_VERIFY_RUN`
  the same as the cage's), a node script calls `spend.recordApi` for `harm` $1.05 and `call` $2.10,
  `db.saveOpsCheck` both rows `warn` 10 min back, and inserts a `page_sessions` row
  (`conversation_id` = `config.ownerConversation`). `POST /ops.json` with `Cookie: reason_page=<token>`
  and `action=check` twice → `serve.log` shows ONE "Reason check — 2 things need you" text, then
  `texted:false`. (2026-10-27, via the since-removed `bin/call-turn.sh`) one call turn past both caps → `voice_turn_threw` with the SDK's
  "Could not resolve authentication method" (the key is blanked): the turn went to the API path, i.e.
  the call was not moved or stopped.

## Gotchas

- `caged.sh env` prints the DEFAULT run dir unless `REASON_VERIFY_RUN` is exported in the same
  shell — seeding then lands in another cage's database.
- Spend is an estimate off `config.apiPrices`; an unknown model costs $0 and never trips a cap.
- The API-backend reply path (`src/agent.js`) is not capped: there is nothing to fall back to and
  live runs on claude-cli. `looked.js captureViaApi` is the API backend's too.
