# Travel time — saved places, leave-by notices, the commute

Somebody tells Reason where home, work and the gym are, and how they get there ("I take the 2 train,
45 minutes"). From then on Reason texts "leave by 8:15 for your 9am at Main St" before calendar
events with a location, and "leave by 8:10 to get to work by 9" on commute days.

Source: `src/tools.js` (`set_place` schema near `name: "set_place"`, handler `case "set_place"`),
`src/db.js` (`saved_places` table, `savePlace`, `getPlace`, `listPlaces`, `deletePlace`,
`placesWithCommute`, `getHome`), `src/routing.js` (`drivingTime` via keyless OSRM,
`travelTimeTo`), `src/notice.js` (section "travel time: leave-by for events AND daily commutes",
kind `calendar_leave_by`), `src/runtime.js` (the notice sweep that calls it). There is no tool
named `travel_time`; the pieces above are the feature.
Tests: `test/commute.test.js` (3: no Google, wall-clock time on UTC, skips) covers the commute; nothing covers calendar-event leave-by. `test/saved-places.test.js` (12,
the `savePlace`/`getPlace`/`placesWithCommute` helpers) is on main since `833aed6` (#66).
`test/notice.test.js` (37) and `test/notice-initiative.test.js` (39) pass
but contain nothing on `calendar_leave_by`, `commute:` or `set_place`. No test of `routing.js`
against OSRM (network).
Shipped in `a3c7492`.

## Sub-features

- **Saved places.** Name key is case-insensitive, per conversation; saving the same name updates.
  Refuses empty names and invalid coordinates. Address is geocoded.
- **Mode-aware.** A stated `travel_minutes` wins for every mode (their word is truth). With none:
  `drive` = live OSRM time each sweep; `transit` = skipped; `walk`/`bike` fall through to OSRM
  **driving** time, labelled as walk/bike (a known approximation; see `travelFrom(...).minutesTo`
  in `notice.js`).
- **Commute sweep.** A place with `arrive_by` (+ `days`) yields a daily leave-by candidate, key
  `commute:<name_key>@<date>` — only when a home is known (a saved `home` place, or
  `REASON_NOTICE_HOME_LAT`/`LNG`), the arrival is within 6 hours, and the leave-by is still ahead.
- **Calendar leave-by.** Events with a `location` starting within 6 hours yield
  `leave:<account>:<event>@<date>`; leave-by = start − (travel minutes from `resolveTravelMin` +
  `noticeTravelBufferMin`) (`src/notice.js`, "Calendar events with a location"); cancelled events,
  an unresolvable trip and past leave-by times are skipped.
- **Route description** is shown back in their own words.
- **Home is a saved place** (`getHome` reads `saved_places`, not the old columns).
- **A saved place is said as an assumption (#581).** When weather, `nearby_places` or `directions` work
  from a saved place with no fresh position (no live share, no pin in the last 24 h), the answer says which
  place it assumed and sends the Share My Location card, or asks first when what they told Reason about their
  hours says they are not there (a saved fact like "works 7am to 3pm": off shift → not at work, on shift → not
  at home) — `src/whereabouts.js` `whereNote`/`shiftOf`, only when the ask depends on where they are now;
  pinned in `test/location-assumed.test.js`. Leave-by notices are unchanged.

## How to get to it (user POV)

"I live at 42 Broadway", "I work at 1 Wall St, in by 9, I take the 4 train, about 35 minutes".
Then nothing; the notice arrives on its own before a located event or on a commute morning.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/commute.test.js               # 3/3 — commute leave-by, no Google, wall-clock time
TZ=UTC node --test test/commute.test.js        # the same on a UTC machine, like the live one
node --test test/notice.test.js               # 37/37 — the notice sweep
node --test test/saved-places.test.js         # 12/12 (3 + 12 + 37 = 52 pass at 226ff17)
```

Calendar-event leave-by still has no offline test; commutes do (`test/commute.test.js`).

**Caged drive of the save path** (`set_place` geocodes over the network, so drive `db.savePlace` with explicit coordinates):

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const db = await import("./src/db.js");
  console.log(JSON.stringify(db.savePlace("dm:owner", { name:"work", address:"1 Wall St", lat:40.7074, lng:-74.0113, mode:"transit", travelMinutes:35, arriveBy:540, days:"MTWTF.." })));
  console.log(JSON.stringify(db.placesWithCommute("dm:owner")));
'
.agents/skills/verify-reason/bin/peek.sh sql "SELECT name, mode, travel_minutes, arrive_by, days FROM saved_places"
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

`arrive_by` is minutes after midnight (540 = 9:00); `days` is a 7-char mask, Mon first.
`set_place` writes `MTWTF..` (weekdays), `MTWTFSS` (every day, and the default when `arrive_by` is
set), `.....SS` (weekends), or a per-letter mask. Confirm columns with `bin/peek.sh schema saved_places`.

**Live, read-only** (the live server, OVH, root@15.204.113.250; check the DB path under `/opt/reason` first): `ssh root@15.204.113.250 "sqlite3 /opt/reason/data/reason.db 'select conversation_id,name,mode,arrive_by from saved_places'"`.
Candidates are not logged as `calendar_leave_by`; the sweep writes them to `notice_seen`
(`db.recordNotice`; UNIQUE on conversation, kind, key), so read
`sqlite3 … "select key,moment_at,said_at from notice_seen where kind='calendar_leave_by'"`. The only
journal line is when one is told: `journalctl -u reason --since '24 hours ago' | grep -E 'notice_told.*(leave:|commute:)'`.
**End state that proves it:** a `notice_seen` row of kind `calendar_leave_by` and, if it was sent,
`said_at` set plus an `outbox` row in state `sent` with "leave by" in the body.

## Gotchas

- OSRM is a free public server: `drivingTime` has a 5s timeout and may fail; the notice must then
  fall back to the stated time or skip, never invent a number.
- Transit without `travel_minutes` is accepted by `set_place` and then silently skipped by the sweep;
  there is no live transit routing. Check the row has `travel_minutes` before expecting a notice.
- Leave-by keys are per day; a second sweep the same day must not re-send (dedupe on `key` in
  `notice_seen`).
- Commute days follow the person's timezone (`REASON_TZ` / account tz), not the server's — but the
  `@<date>` in the commute key is the UTC date (`toISOString`), so near midnight UTC it can differ
  from their local day.
- The commit also fixed `listGuesses` using the wrong spread for query args; a regression there
  breaks the guesses/patterns surfaces, not travel.
- **A commute leave-by does not need Google.** `commuteCandidates` in `src/notice.js` runs above
  the Google token check in `gather`, beside flights. Until 2026-10-23 it ran below it, so anyone
  without Google never got one. The arrive-by is their wall clock wherever the process runs; on the
  UTC server a 9:00 AM New York arrival used to be computed as 9:00 UTC. Both are pinned in
  `test/commute.test.js` (run it with `TZ=UTC` too).
