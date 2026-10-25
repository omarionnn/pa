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
  case- and space-insensitively (it is read out loud and typed on a phone). Never stored, logged,
  returned or shown; `event_join_attempts` records that a try happened, never what was tried.
- **Matching** — by name: `nameKey` (case, accents, spaces, punctuation ignored), exact first, then
  either name containing the other; the password picks among same-named events, and the same
  password on two asks who is organizing. By link: `/e/<16-char random id>`; the link names the
  event and never stands in for the password.
- **Attempt limit** — per actor (`conv:<id>` for text, `ip:<addr>` for the page): 3 free wrong
  tries, then a 30s wait doubling per wrong try (cap 1h), and 20 wrong per 24h. A right password
  during a wait still waits.
- **Isolation** — `managed(c, id)` is the one door to managing (null for somebody else's event and
  for a made-up id alike); `visible`/`viewFor` give the organizer view, a guest view, or nothing.
  `guestView` carries only released details; `publicView` is name + description + status + link.
  Phone numbers are in no view.
- **Capacity / state** — the capacity check and the insert are one transaction; paused and
  cancelled events take nobody; a removed guest cannot rejoin, one who left can (fresh token).
- **Web claims** — what the page collected plus an 8-char code (the invites alphabet,
  `db.newClaimCode`); `redeemEventClaim` spends it in one transaction with the account (if new:
  `joined_via_event`, no `invited_by`, nobody's invite allowance touched) and the attendee row; a
  claim made before a password rotation is dead.
- **Deliveries** — one `event_deliveries` row per message per guest carrying the outbox key
  (`event:<msg>:<conv>:<attempt>`); whether it reached them is read off the outbox rows for that
  key (`sent` / `sending` / `failed`), never assumed. A retry moves only a delivery whose outbox
  rows say failed, by compare-and-set, so it can never be a second copy.

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
