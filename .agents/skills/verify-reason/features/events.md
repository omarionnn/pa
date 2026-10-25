# Events — organize by text, guests join with a name and a password

An organizer texts their Reason that they want to throw something; Reason asks the setup questions
and makes the event. Guests join with the event's name and password — by text, by pasting the event
link into their Reason, or by opening the link and tapping Join — including people with no Reason
yet, for whom an event is their way in. **Behind `REASON_EVENTS`** (`off` | `owner` | `on`, read like
`REASON_FLIGHT_BOOKING`): off, nobody's model is told events exist; `owner`, only the owner may
CREATE one, but anybody may join any event (the owner's links must work for every guest); on,
anybody with a Reason creates.

Source: `src/events.js` (the only reader of the event tables: passwords, matching, the attempt
limit, every access rule, the guest/public/organizer views, deliveries), `src/db.js` (the `events`,
`event_attendees`, `event_messages`, `event_deliveries`, `event_join_attempts`, `event_claims`
tables, `accounts.joined_via_event`, `redeemEventClaim`), `src/privacy.js` (`SECRET_TOOLS`: a
password is sealed out of the decision log and the action ledger), `src/config.js` (`events`).
Tests: `test/events.test.js`.

## Sub-features

- **Passwords** — scrypt (`node:crypto`), `scrypt$N$r$p$salt$hash`, salted per event; compared
  case- and space-insensitively (it is read out loud and typed on a phone), checked with async
  `scrypt` so guesses never stall the event loop, refused unhashed past 200 characters. Never
  stored, logged, returned or shown; `event_join_attempts` records that a try happened, never what
  was tried. Typed into a conversation, it is scrubbed (`scrubPassword`, whole words) out of that
  conversation's last 12 history messages and its rows from the last 10 minutes in `event_log`,
  `inbound_messages.text`, `inbound_parts.text`, `pending_inbound.text` and finished (`sent`/`failed`)
  `outbox.body` — never a message still waiting to go — at once and again 45s and 5min later, after
  the turn has written its own rows (`scrubSoon`). **Not reached:** a memory fact the extractor wrote
  from the turn before the later pass, and the claude-cli backend's own session files.
- **Matching** — by name: `nameKey` (case, accents, spaces, punctuation ignored), exact first, then
  either name containing the other only when that finds exactly ONE event (so "party" cannot sweep
  a guess across every party); the password picks among same-named events, and the same password on
  two asks who is organizing. By name, no such event and a wrong password are one answer
  (`no_match`), so the name route does not tell anyone which events exist. By link: `/e/<16-char random id>`; the link names the
  event and never stands in for the password.
- **Attempt limit** — per actor (`conv:<id>` for text, `ip:<addr>` for the page): 3 free wrong
  tries, then a 30s wait doubling per wrong try (cap 1h), and 20 wrong per 24h. A right password
  during a wait still waits. A wrong mark is written BEFORE the async check and taken back if it
  was right, so a burst sent at once is limited as if one by one. Plus a ceiling per event across
  everybody: past 60 wrong in an hour, anybody who has already got one wrong that hour is refused
  until it rolls on, while a first try is still checked (rows under actor `event:<id>`, which is
  also what the status page counts as that event's failed joins).
- **Isolation** — `managed(c, id)` is the one door to managing (null for somebody else's event and
  for a made-up id alike); `visible`/`viewFor` give the organizer view, a guest view, or nothing.
  `guestView` carries only released details; `publicView` is name + description + status + link.
  Phone numbers are in no view.
- **Capacity / state** — the capacity check and the insert are one transaction; paused and
  cancelled events take nobody; a removed guest cannot rejoin, one who left can (fresh token).
- **Web claims** — what the page collected plus an 8-char code (the invites alphabet,
  `db.newClaimCode`); `redeemEventClaim` spends it in one transaction with the account (if new:
  `joined_via_event`, no `invited_by`, nobody's invite allowance touched, and an allowance row of
  0 — an event account has no invites to hand on, or a party password would bypass the invite gate)
  and the attendee row; a claim made before a password rotation is dead.
- **Deliveries** — one `event_deliveries` row per message per guest carrying the outbox key
  (`event:<msg>:<conv>:<attempt>`); whether it reached them is read off the outbox rows for that
  key (`sent` / `sending` / `failed`), never assumed; a delivery stuck `pending` with no outbox row
  for 5 minutes (a crash mid-send) reads `failed`. A retry moves only a delivery whose outbox rows
  say failed, by compare-and-set, so it can never be a second copy; a message that broke partway
  resends only its failed parts, and not at all while any part is still unsettled (`unknown`); and it goes only to somebody still on the event (a removed guest
  only ever gets the line saying so; after a cancellation only the cancellation retries). The same
  words of the same kind to the same event within 10 minutes reuse the first message.

## How to get to it (user POV)

Not reachable by text or page in this slice (data model + access only); see the later sections as
they land.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/events.test.js       # passwords, matching, limits, capacity, isolation, claims, deliveries
```

Cage: `bin/caged.sh start`, then `bin/peek.sh sql "SELECT name FROM sqlite_master WHERE name LIKE 'event%'"`
shows the six tables made on start (`CREATE TABLE IF NOT EXISTS`, no data rewritten).

## Gotchas

- Events are the first rows shared across conversations: never read an event table from anywhere
  but `src/events.js`, and never add a path that returns an event without going through
  `managed`/`visible`.
- A password typed into a tool input is in that conversation's own history (the person typed it
  there); it is sealed out of the decision log and the action ledger by `SECRET_TOOLS`. Add any new
  tool that takes a password to that set.
