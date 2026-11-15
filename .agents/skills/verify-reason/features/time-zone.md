# Per-person time zone — guessed, asked once, kept (`REASON_TZ_ASK`)

Before 2026-10-30 every reminder, calendar write, scheduled call and the `[stamp]` the model reads ran
on the install's zone (`REASON_TZ`, Eastern) for everybody; only the notice sweep had a per-person
zone (`accounts.notice_tz`, from the waking-hours question, else the calendar's). Now, with
`REASON_TZ_ASK=on`, the first clock-time action a person asks for while their zone is unconfirmed is
HELD: the tool returns `status: "confirm_time_zone"` with a best guess and its reason, the model asks
once in its own words, and the `time_zone` tool saves the answer and runs the held call(s) with the
wall clock they said re-read in that zone. Off, behaviour is exactly the old one (`zonescope.current()`
returns "" and the calendar override is skipped).

- Guess order (`zone.guessZone`): confirmed > Reason Web browser zone (`X-Reason-Tz` on the
  `/web/signal` poll → `accounts.web_tz`) > last shared location (`get_location` → tz-lookup →
  `accounts.place_tz`) > connected calendar (`notice_sweeps.time_zone`) > phone prefix
  (`src/phone-zones.txt`, libphonenumber's map, offline) > `config.installTz`.
- Held tools (`CLOCK_TOOLS`, `src/zone.js:210`; the gate is `zone.gate`, `src/zone.js:225`):
  `timer_set` with a `fire_at` unless `relative: true` — a series (`repeat`) is held too
  (`src/zone.js:211`) — `commitment_set`, `calendar_create/change`, `apple_calendar_create/change`
  (only when a start/end is given), `event_create` without `timezone`.
  Only on the person's own turns (`ctx.kind === "user"`); timers firing and Reason's own check-ins
  never ask. Up to 5 held per person, 2 h window (`PENDING_TTL_MS`).
- Confirmed zone = `accounts.notice_tz` (+ `tz_confirmed_at`). The operator is confirmed on the
  install's zone at boot (`preconfirmOperator`) and on the fly in the gate.
- Their clock everywhere: `config.tz` is a getter over `src/zonescope.js` (AsyncLocalStorage). Scopes:
  every runtime turn (`Runtime.runTurn`, API and CLI), every `tools.runTool` call (the CLI's MCP calls
  are their own HTTP requests), every HTTP request once a page-session cookie names the person
  (`db.pageSessionOwner/Peek` → `zonescope.enter`). Stamps carry the zone's short name only when it is
  not the install's. Caps/spend/subscription day keys read `config.installTz` explicitly.
- Travel: `get_location` coordinates on another clock than the confirmed zone → `time_zone_check` on
  the result, once per zone (`accounts.tz_travel_asked`); nothing changes unless they say yes.
- **The callee's clock for calls (#505, #507; every account, no switch).** A call Reason places to
  somebody else is held 9pm–8am on THEIR clock (`zone.calleeZone`, used by `call_place` →
  `withinCallingHours` in `src/calls/brief.js`): a place a lookup returned is timed by where it is
  (`notePlace`, kept in the `place_zones` table so a restart does not forget), else the number's area
  code (both clocks when it spans two), else the account holder's guessed zone, the server's only when
  nothing is known. A call to their own phone is not timed this way. Tests:
  `test/call-callee-hours.test.js` (7).

Source: `src/zone.js`, `src/zonescope.js`, `src/config.js` (`installTz`, `tz` getter, `tzAsk`,
`stamp`), `src/tools.js` (gate in `runToolOnTheirClock`, `time_zone`, `timer_set.relative`, calendar
zone order, `get_location` hook), `src/db.js` (`zoneRow`, `setZoneFields`), `src/runtime.js`,
`src/agent.js`, `src/backends/claude-cli.js` (`kind` into the MCP tool ctx), `src/http.js`,
`src/pages/webnotify.js`, `src/background.js` (lane runs outside any person's scope), `src/serve.js`.
Tests: `test/time-zone.test.js` (26).

## Drive (no model, in process, under `caged.sh env` with `REASON_TZ_ASK=on`)

On throwaway accounts (`+13125550123`, `+14155550123`): `runTool("timer_set", { fire_at:
"2026-11-15T18:00:00", note }, { conversationId, kind: "user", messages })` → `ok:false,
status:"confirm_time_zone"`, guess `America/Chicago` "their number is a 312 area code", no timer row;
`runTool("time_zone", { zone: "America/Chicago", their_words: "yes" }, …)` → `held_actions:
["timer_set"]`, timer `2026-11-16T00:00:00Z` (6 PM CST); the 415 person's `relative: true` timer → set
at once, no question; `zone.notePlace({ phone, latitude: 34.05, longitude: -118.24 })`, then
`zone.forgetPlaceZonesInMemory()` (a restart) → `calleeZone(phone)` still `{zone:
"America/Los_Angeles", source: "place"}`. Driven 2026-11-14 at `7d5b5f54`, all as stated. The model's
own wording of the question needs the subscription drive below.

## Drive (cage, subscription — a handful of turns)

`REASON_VERIFY_RUN=/tmp/reason-verify-tz REASON_VERIFY_PORT=8797 REASON_VERIFY_BACKEND=claude-cli
REASON_TEST_NUMBERS=+12025551234,+13125550123,+14155550123 REASON_TZ_ASK=on bin/caged.sh start`, then
`bin/inbound.sh file` payloads from the 312 / 415 numbers. 2026-10-30, wt/user-timezone:
1. 312: "remind me sunday at 6pm to take the trash out" → "quick check: you're on central time,
   right? I'm going off your 312 number." `serve.log` has `confirm_time_zone`; no timer row.
2. "yes" → `time_zone` then the held `timer_set`; reply "sunday at 6pm central"; timer
   `2026-11-02T00:00:00Z` = Sun Nov 1 6:00 PM **CST** (the day US clocks go back); tool result
   `fires_at` "… 6:00 PM CST" (the CLI path is on their clock).
3. 415: "remind me in 10 minutes to check the oven" → `timer_set` with `relative: true`, set at
   once, no question.
