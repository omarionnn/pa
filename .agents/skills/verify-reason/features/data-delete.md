# Deleting a person's data

Somebody asks for everything Reason holds about them to go. The operator runs
`npm run data:delete -- <conversation>` (or the admin path that calls `deleteData`), and nothing of
theirs is left in any table, on disk under `data/`, or in a browser profile.

## Sub-features

- **Every table keyed by their conversation.** `TABLES` in `src/data.js` (and `CHILD_SCOPE` for
  tables reached through a parent row: `shop_run_asks` via `shop_runs`, `ride_matches` via either
  side's offer, `event_claims` by `used_by`). Until #353 (2026-11-07) ~60 tables were missing —
  messages, the memory graph, shop/pay rows, stamps, calls, event rows — and re-admitting the same
  number (`dm:<channel>:<addr>` is deterministic) handed them back.
- **No table can be forgotten again.** `COVERAGE` lists every table as `deleted`, `global`,
  `kept` (`KEPT_ON_DELETE`, each with its reason: billing/trial `plan`, `harm_events`, shared
  `events`/`event_albums`/`event_messages`, `event_join_attempts`, `ride_blocks`) or `installWide`
  (`INSTALL_WIDE`). `test/data-coverage.test.js` fails when a table is in none.
- **Files too.** Event album photos they added are unlinked under `data/event-albums/<event>/`
  (`event_photos` in the result), alongside recordings, documents, profiles and build dirs.
- **Export seals what opens something.** `SECRET_COLUMNS` (checkout links, Face ID approvals, a
  guest's directory key, join codes, stamp share ids, AgentCard session handles) and
  `pay_passkey_regs` dropped.
- **A whole-install delete** (no conversation) also takes `KEPT_ON_DELETE` and `GLOBAL_TABLES`.

## How to get to it (user POV)

They text "delete everything you have on me"; the operator runs the delete. There is no self-serve
button.

## Driving it with the harness

```bash
# from the repo root
node --test test/data-coverage.test.js          # 5 tests
V=.agents/skills/verify-reason/bin
export REASON_VERIFY_RUN=/tmp/rv-<name> REASON_VERIFY_PORT=<port>
$V/caged.sh start && $V/doctor.sh caged
eval "$($V/caged.sh env | sed 's/^/export /')"
node $V/delete-coverage-drive.mjs               # exit 0 = pass
$V/caged.sh stop
```

The drive seeds one row into every table of the cage database for a test person and a control
person, runs the real `deleteData({ conversation })` with network refused, and scans every column
of every table for the person's number. End state: `unexplained: []` and `control_rows_lost: []`.
2026-11-07 at `8a1fe18`: 160 tables, all 160 seeded, 134 rows deleted, left only in `kept` (7),
`global` (3) and `install_wide` (16, synthetic: the seed writes the id into every column).
2026-11-07 on the release branch (`8113bcf`, cage started first): 161 tables — the new
`recall_forgotten` (forget's out-of-recall marks) is in `TABLES` (`src/data.js:212`)
— all seeded, 135 rows deleted, same `kept`/`global`/`install_wide`, `unexplained: []`. At the release head `36db733` `recall_reindex` (forget's re-index queue, `src/db.js:10579`) joins it in `TABLES` (`src/data.js:215`), so expect 162. Run it with
the cage **started**: under `caged.sh env` alone only the tables of the modules the drive imports
exist (137 that way), which reads like lost coverage and is not.

Never run it against live: it writes to the database it is pointed at, and it refuses unless
`REASON_DB_PATH` looks like a cage.

## Gotchas

- A scoped delete keeps the number in `GLOBAL_TABLES` (`access_requests`, `blocked_numbers`,
  `turned_away`) and in `incidents.last_addr`. That is by design in `src/data.js`, not a miss —
  but it is still their number on disk; say so if someone asks "is everything gone".
- A table made by a module `npm run data:*` does not load is skipped when absent (`present()`), so
  run the drive on a cage the server started: that is the database with every table in it.
- `sqlite3` from the shell may be refused on cage paths by the OpenClaw state guard; write with
  `node:sqlite` instead.
