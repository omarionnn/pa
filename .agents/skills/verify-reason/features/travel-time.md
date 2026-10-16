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
Tests: `test/saved-places.test.js` (12 pass), `test/notice.test.js` (37 pass, includes leave-by),
`test/notice-initiative.test.js`. `test/saved-places.test.js` was untracked in the working tree when
this was written; check `git status`. No test of `routing.js` against OSRM (network).
Shipped in `a3c7492`.

## Sub-features

- **Saved places.** Name key is case-insensitive, per conversation; saving the same name updates.
  Refuses empty names and invalid coordinates. Address is geocoded.
- **Mode-aware.** `drive` = live OSRM time each sweep (or stated override); `transit`, `walk`,
  `bike` = the person's stated `travel_minutes` (required for transit, their word is truth).
- **Commute sweep.** A place with `arrive_by` (+ `days`) yields a daily leave-by candidate, key
  `commute:<name>@<date>`.
- **Calendar leave-by.** Events with a `location` yield `leave:<account>:<event>@<date>`; moment is
  leave-by minus a buffer; past leave-by times are skipped.
- **Route description** is shown back in their own words.
- **Home is a saved place** (`getHome` reads `saved_places`, not the old columns).

## How to get to it (user POV)

"I live at 42 Broadway", "I work at 1 Wall St, in by 9, I take the 4 train, about 35 minutes".
Then nothing; the notice arrives on its own before a located event or on a commute morning.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/saved-places.test.js         # 12/12
node --test test/notice.test.js               # 37/37
```

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

`arrive_by` is minutes after midnight (540 = 9:00); `days` is a 7-char mask, Mon first
(`MTWTF..`). Confirm columns with `bin/peek.sh schema saved_places`.

**Live, read-only:** `ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db 'select conversation_id,name,mode,arrive_by from saved_places'"`
and `journalctl -u reason --since '24 hours ago' | grep calendar_leave_by`.
**End state that proves it:** a `calendar_leave_by` candidate in the sweep log and, if it was sent,
an `outbox` row in state `sent` with "leave by" in the body.

## Gotchas

- OSRM is a free public server: `drivingTime` has a 5s timeout and may fail; the notice must then
  fall back to the stated time or skip, never invent a number.
- Transit without `travel_minutes` is invalid; there is no live transit routing.
- Leave-by keys are per day; a second sweep the same day must not re-send (dedupe on `key`).
- Commute days follow the person's timezone (`REASON_TZ` / account tz), not the server's.
- The commit also fixed `listGuesses` using the wrong spread for query args; a regression there
  breaks the guesses/patterns surfaces, not travel.
