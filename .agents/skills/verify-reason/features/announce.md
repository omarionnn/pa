# Owner announcements — one text to everybody active, sent later, by the owner only

A CLI the owner runs on the Hetzner box to tell active people about something new. No tool, page or
text reaches it. Dry run by default: it prints the recipient count, the counts left out by reason,
and the bubbles, never a number or a name, and writes nothing. The one announcement shipped is
`events-1025` (two bubbles: the Events pitch, then `reason.omarinyarko.com/updates`). It must
never be sent without the owner's explicit go.

Source: `scripts/announce.js` (`ANNOUNCEMENTS`, `audience`, `sendAll`, `renderDryRun`,
`parseArgs`, `theirSettings`/`inTheirNight`), reusing `src/outbox.js` `attempt` and
`src/db.js` `enqueueOutbound` (the outbox's unique `idem_key` is the ledger:
`announce:<id>:<digits>#1` / `#2`, the number alone across channels). Tests: `test/announce.test.js` (12/12).

## Sub-features

- **Audience:** an account on `sendblue`/`linq` with an inbound in the last 30 days.
- **Opted-out left out** (any conversation for the number opts the whole number out; blocks match by digits): `accounts.state` not `active`, `paused_at` set, `notice_mode` `off` or a
  snooze running, a `blocked_numbers` row, or an outbox `OPTED_OUT` failure with no inbound since.
- **One number, one recipient** (digits only), across conversations and channels.
- **Never twice:** any outbox row for that number and announcement, in any state (a permanent
  failure too), counts as already-sent. A retryable failure stays `queued` and the live service's
  outbox sweep finishes it (that retry has no quiet-hours check — rare, since backoff is short); a rerun of the script does not.
- **Quiet hours:** the same rule as unprompted texts (their zone, their window, 22:00–08:00
  default), read without `settingsFor` because that inserts a `notice_sweeps` row. Nobody in their
  night gets a row, so a later run picks them up. Rechecked right before each send.
- **Paced:** `--gap-seconds` (default 5, minimum 1). Rows carry `to_owner = 1` and `told_at`
  pre-stamped, so a failure is never read back to them as "a message of mine didn't go".
- **Send needs both** `--send` and `--confirm=<id>`; either alone is a refusal (exit 2) or a dry run.

## How to get to it (user POV)

Owner only, on the server:

```bash
ssh root@91.98.19.150 'cd /opt/reason && sudo -u reason node --env-file=.env scripts/announce.js'          # dry run
# real send, ONLY on the owner's go:
# ssh root@91.98.19.150 'cd /opt/reason && sudo -u reason node --env-file=.env scripts/announce.js --send --confirm=events-1025'
```

Options: `--id=<announcement>`, `--skip-owner`, `--gap-seconds=N`.

## Driving it with the harness

Offline: `node --test test/announce.test.js`.

Cage (2026-10-25): the caged env, a seeded throwaway database, and `bin/fake-sendblue.mjs` for the
send. Start the fake as its own long-running background command (a fake started with `&` inside a
one-shot command dies with it and every send reads `fetch failed`), and give the fake env
`SENDBLUE_WEBHOOK_SECRET` too — without it the adapter reads not-connected and both bubbles fail.

```bash
cd <worktree> && REASON_VERIFY_RUN=/tmp/rv-x .agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /' > /tmp/rv-env.sh
. /tmp/rv-env.sh   # then seed accounts + inbound_messages with 202-555-01xx numbers via src/db.js
node scripts/announce.js                                  # dry run
node .agents/skills/verify-reason/bin/fake-sendblue.mjs 8797 /tmp/cap.jsonl ok   # separate, background
export SENDBLUE_API_KEY_ID=cage-fake SENDBLUE_API_SECRET_KEY=cage-fake SENDBLUE_FROM_NUMBER=+12025550101 \
  SENDBLUE_WEBHOOK_SECRET=cage-fake SENDBLUE_API_BASE=http://127.0.0.1:8797
node scripts/announce.js --send --confirm=events-1025 --gap-seconds=3
```

End state seen: seeded 1d, 3d, 40d, mode-off and Tokyo-at-night people → dry run `recipients: 2`,
`opted-out 1, quiet-hours 1`; the send put four `POST /api/send-message` on the fake, bubble 1 then
the link per person, 3 s apart; a rerun sent nothing and the dry run then read `already-sent 2`.

Live: the dry run only, read-only. Check it wrote nothing: the script prints a `warning: this
process changed N rows` line on stderr if anything did.

## Gotchas

- `settingsFor` (src/notice.js) is not read-only — it creates a `notice_sweeps` row. The script
  reimplements its zone/window/mode precedence; `test/announce.test.js` pins the parity.
- A fresh process's first import of `src/db.js` after new accounts appear can run per-row
  migrations (seen on a cage DB: 5 rows). That is schema upkeep, the same a restart does, and the
  warning line names it; the dry run's own queries write nothing (pinned in the test).
- `sqlite3 -readonly` on a WAL database with no `-shm` file fails "unable to open database file".
- **Live's `accounts` table has no `state` column** (2026-10-25: `pragma table_info(accounts)`; the
  `CREATE TABLE IF NOT EXISTS` gained it after live's table existed and no migration adds it). The
  first live dry run therefore read every person as opted-out (`recipients: 0, opted-out 8`); the
  script now reads a missing column as active. Prove live-shaped behaviour on a `.backup` copy of
  the live db in a `sudo -u reason mktemp -d` dir with `REASON_DB_PATH` pointed at it, then delete it.
