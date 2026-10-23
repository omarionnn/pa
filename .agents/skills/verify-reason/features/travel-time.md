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
Tests: **no offline test covers leave-by or the commute today.** `test/saved-places.test.js` (12,
the `savePlace`/`getPlace`/`placesWithCommute` helpers) is NOT on main: it lives only in `b0adcea` on
`origin/wt/local-rescue`. `test/notice.test.js` (37) and `test/notice-initiative.test.js` (39) pass
but contain nothing on `calendar_leave_by`, `commute:` or `set_place`. No test of `routing.js`
against OSRM (network).
Shipped in `a3c7492`.

## Sub-features

- **Saved places.** Name key is case-insensitive, per conversation; saving the same name updates.
  Refuses empty names and invalid coordinates. Address is geocoded.
- **Mode-aware.** A stated `travel_minutes` wins for every mode (their word is truth). With none:
  `drive` = live OSRM time each sweep; `transit` = skipped; `walk`/`bike` fall through to OSRM
  **driving** time, labelled as walk/bike (a known approximation; see `resolveTravelMin` in
  `notice.js`).
- **Commute sweep.** A place with `arrive_by` (+ `days`) yields a daily leave-by candidate, key
  `commute:<name_key>@<date>`.
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
node --test test/notice.test.js               # 37/37 — the notice sweep, NOT leave-by
# test/saved-places.test.js (12) only once wt/local-rescue (b0adcea) is merged
```

Because nothing offline covers leave-by, the caged drive below is the proof of the save path, and a
leave-by candidate has to be read off `notice_seen` (see Live).

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

**Live, read-only:** `ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db 'select conversation_id,name,mode,arrive_by from saved_places'"`.
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
- **A commute leave-by needs the person's Google connected, though it reads nothing from Google.**
  `gather` in `src/notice.js` returns at the token check (`google.allAccessTokens`) before the
  travel-time block whenever no Google account is connected — only flights were moved above that
  check. So on the cage, and for any tester without Google, a saved commute never produces a
  candidate: `db.placesWithCommute` returns the place and `notice_seen` stays empty. Driven
  2026-10-23 at `b2861c2` (home + transit `work` arriving in 2h, `MTWTFSS`; one sweep; no row).
  That is a product gap, recorded for the owner — not drift. On the cage this is
  verified-unreachable: the prerequisite is a Google token row for the conversation.
