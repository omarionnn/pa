# Paid-API hard caps

The owner tops up Reason's API key only on the promise it cannot be drained (2026-10-25: $10 went
overnight). `src/spend.js` `capReached` reads `model_usage` on every ask, so each cap lifts by itself
at New York midnight / on the 1st with nothing to reset.

## Sub-features

- **Daily cap** — `REASON_API_DAILY_CAP_USD` (default $1), every paid feature except calls. Reached:
  `apiOut(feature)` is true and `callApi` throws before any request, so the harm screen,
  purchase-topic, the one-thought sorter and the said-ledger's pre-send check take the CLI fallback
  a dry key takes (claude-cli backend). Judge, watch, extraction and profile are already on the CLI.
- **Call cap** — `REASON_API_CALL_DAILY_CAP_USD` (default $2), features `call` and `call_harm` only
  (`CALL_FEATURES`). Calls never count toward the daily cap. Reached: `callBackendName()` in
  `src/calls/voice.js` answers `claude-cli` on a subscription install (the `cliGenerator`, slower,
  tools as `TOOL` lines) and `capped` otherwise — the call says `CAPPED_LINE` ("Sorry, I can't take
  calls right now. Please text me instead.") and `end_call`s. No warm-up, no paid screen.
- **Monthly cap** — `REASON_API_MONTHLY_CAP_USD` (default $10), all paid use, calls included, for the
  calendar month (New York).
- **One text** — /ops rows `api_spend` and `api_call_cap` go amber with an `alert` in the owner's
  words ("API daily cap reached ($1.00), the pre-reply checks are on the subscription until
  midnight."), sent once through ops' sustained-alert path; `quietRecovery` makes the lift silent.
- `0` turns a cap off.

## How to get to it (user POV)

Nobody asks for it. The owner sees the /ops "API spend" row (`$X of $1.00 today · calls $Z of $2.00 ·
$Y of $10.00 this month`) and the "Phone calls on the API" row, and gets one text the day a cap hits.

## Driving it with the harness

- Offline: `node --import ./test/paid-key-guard.js --test test/api-hard-cap.test.js` — flip, midnight,
  month rollover, calls exempt but capped, exactly one text.
- Cage (2026-10-25): `bin/caged.sh start`; with `caged.sh env` exported (and `REASON_VERIFY_RUN`
  the same as the cage's), a node script calls `spend.recordApi` for `harm` $1.05 and `call` $2.10,
  `db.saveOpsCheck` both rows `warn` 10 min back, and inserts a `page_sessions` row
  (`conversation_id` = `config.ownerConversation`). `POST /ops.json` with `Cookie: reason_page=<token>`
  and `action=check` twice → `serve.log` shows ONE "Reason check — 2 things need you" text, then
  `texted:false`. `bin/call-turn.sh new` + one turn → `{"voice_backend":"capped"}` and the
  `CAPPED_LINE` with `end_call`. Delete the seeded rows and the next turn goes back to the API path.

## Gotchas

- `caged.sh env` prints the DEFAULT run dir unless `REASON_VERIFY_RUN` is exported in the same
  shell — seeding then lands in another cage's database.
- Spend is an estimate off `config.apiPrices`; an unknown model costs $0 and never trips a cap.
- The API-backend reply path (`src/agent.js`) is not capped: there is nothing to fall back to and
  live runs on claude-cli. `looked.js captureViaApi` is the API backend's too.
