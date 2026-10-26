# Event albums — one private photo album per event

Guests text Reason photos naming the event ("for Game Night"); the organizer ends the event and
releases the album; the guests the organizer checked in open it, save photos or the whole album, and
it closes a fixed time after release. **Behind `REASON_EVENT_ALBUMS`** (`off` | `owner` | `on`, on
top of `REASON_EVENTS`; `owner` = only the owner's events have albums). Read it read-only with
`ssh root@91.98.19.150 "grep -E '^REASON_EVENT_ALBUMS=' /opt/reason/.env"` — **`REASON_EVENT_ALBUMS=1` on live
since 2026-10-26 08:08 UTC** (#163 merged as `5dabcf9`, deployed, flag appended as the last line of `.env`).

Source: `src/albums.js` (the only reader of the album tables: the switch, the ONE retention setting
`RETENTION` ← `config.albumRetentionDays` ← `REASON_ALBUM_RETENTION_DAYS`, default 3; `viewFor`, the
one place that decides what a person may see; contribute / remove / pin / check-in / release /
sweep; the ZIP), `src/albumtools.js` (`album_add`, `album_remove`, `album_info`, `album_manage`),
`src/pages/album.js` (`/e/<id>/album`, `/e/<id>/album/manage`, `/album/photo/<n>`,
`/album/download`, handed off from `src/pages/event.js` after the same session + role read),
`src/db.js` ("the event photo album": `event_albums`, `event_photos`, `event_checkins`,
`album_consents`). Files: `data/event-albums/<event public_id>/<random>.<ext>`. Sweep:
`Runtime.eventAlbums` → `albums.sweep`, every pass. The events feature is untouched: no event
table gained a column, no event tool or prompt line mentions albums (pinned).

## What proves it

- **A batch for a named event lands in that album, as "Shared by <display name>"** — never a number.
  First time ever for a person, `album_add` returns `needs_answer` with the note (shared with
  checked-in attendees after release; save or screenshot; kept N days after release, then deleted);
  the yes has to arrive in a LATER inbound (`db.lastInboundAt > asked_at`). Then photos go straight
  in. Same bytes from the same person = `duplicates`, not a second photo; a non-photo, a missing
  link, a wrong format or over 7 MB = `failed` with why, never counted as added. Takes JPEG, PNG,
  GIF, WebP; HEIC converted first (`fetchImage`).
- **An unnamed batch with two events it could be for asks** (`which_event`, nothing stored) —
  `events.whichEvent`, the same read every event tool makes.
- **Before release a guest sees only their own photos**; the organizer's page shows everything with
  pin / remove and the check-in list. Contributor removes own, organizer any; the file is unlinked
  before the row goes.
- **Release = the organizer's tap** (page button "End event and release album", or
  `album_manage release`). Sets `released_at` + `expires_at = released_at + RETENTION`. Exactly one
  text per checked-in guest (`event_messages` kind `album`, `event_deliveries` one per guest — the
  outbox key is the ledger), words first ending on a colon, the guest's own link last on its own
  line. A second release, a later upload: nothing sent. A guest checked in AFTER release gets the
  one message then (same message row → never twice). The scheduled start/end time releases nothing.
- **A link grants nothing.** Unknown browser → the gate, which only offers to text a code to the
  link's OWNER (organizer link → organizer; guest link → that guest). Recognized browser with no
  role on the event → 404, byte-identical to a made-up link. A joined guest the organizer never
  checked in, on the organizer's forwarded link → their own role: their own photos, no controls.
  Photo bytes and the ZIP obey the same `viewFor`.
- **The exact expiry is on the album and in the announcement.** Past it, `sweep` deletes every file
  and the event's directory, drops the rows, sets `closed_at`; the page says it closed and when;
  `album_add` answers `closed`. A never-released album: no timer, nothing deleted, `albums.waiting()`
  lists it (open decision for the owner).

## Driving it

```bash
cd ~/Desktop/pa
node --test test/event-album.test.js                # 14 pinned tests, everything above (5 for the nudges + check-in by name)
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_EVENT_ALBUMS=on REASON_DB_PATH=$(mktemp -d)/albums.db node .agents/skills/verify-reason/bin/album-drive.mjs
node .agents/skills/verify-reason/bin/album-preview.mjs ~/Desktop   # three PNGs: attendee page, organizer page, sample chat (note · release · the nudge + "let everyone in")
```

Over HTTP on the cage: start it as `REASON_EVENTS=on REASON_EVENT_ALBUMS=on bin/caged.sh start`,
make an event + a page session in its database under `caged.sh env` (see `album-drive.mjs` for the
calls), then `curl -si http://127.0.0.1:8796/e/<id>/album/manage` → the gate (200, "Text me a
code"), with `-H 'Cookie: reason_page=<token>'` for the organizer → 200 with `Check-in list`, and a
stranger's token → 404. Driven 2026-10-26 at the PR's head (see Baseline).

- **The organizer is nudged to check people in, never bypassed** (owner, 2026-10-26). `albums.release`
  returns `joined` / `checked_in` and, when not everyone who joined is in, `nudge` (`checkinNudge`):
  how many of the guests who joined are checked in, that only checked-in guests can see the album,
  and who should be let in — plain intent, no phrase to type. Through the tool the model relays it
  (the result's `note` says so); from the page button the organizer is TEXTED it once
  (`nudgeOrganizer` → `event_messages` kind `album_nudge`, one delivery, the words into their thread)
  and the page says "Nobody can see the album yet". A release to zero still releases. The sweep
  (`albums.sweep`, now also the nudge pass) texts the same nudge ONCE around the event's end —
  `END_NUDGE.afterStartMs` (4 h) past `starts_at`, events having no end time — only for an unreleased
  album with photos and nobody checked in; `event_albums.nudged_at` is set compare-and-set first, so
  never twice; somebody checked in, event not active, or more than `staleAfterStartMs` (24 h) past
  the start → marked and dropped unsent. Kind `album_end_nudge`.
- **The organizer checks people in by name** (`album_manage`): `check_in` / `undo_check_in` with
  `guest_names` (or `guest_id` / `guest_ids`), `check_in_all` with optional `except`. `albums.guestsNamed`
  matches against THIS event's joined guests (membership display name, else account name): a name
  said whole, or every word said beginning a word of theirs ("Dan" → Daniel). Two guests answering
  to a name → `which_guest` with the choices, nothing checked in on a guess (and "everyone except
  <ambiguous>" does nothing at all); a name nobody has → `unknown_guest` with the list. The page
  keeps a **Check everyone in** button (`action=checkin_all`). Every bulk check-in after release
  texts each NEWLY checked-in guest the announcement once — the same per-guest message row as a
  single check-in, so repeating "everyone" sends nothing.

## Decided (owner, 2026-10-26)

- Photo order: upload time. `albums.PHOTO_ORDER = "upload time"`, read by `db.photosOf`; the one setting.
- Confirmed as built: a guest checked in after release is sent the one announcement at check-in;
  "End event" touches the album only (the event row stays `active`); no 24h reminder.
- Organizer never uses the check-in list: no bypass, no auto check-in — the nudges above are all
  that happens; only the organizer's words or taps check anybody in.

## Open decisions (owner's; built so the answer drops in)

- Never-released albums: kept, no timer, `albums.waiting()` lists them; nothing surfaces them to the
  owner yet (the ops page is a one-line add).
- "Around the end" with no end time on events: 4 h after the start (`END_NUDGE`), sent at that moment
  whatever the hour (the organizer is at their own event); change the constant if the owner wants
  the morning after instead.

## Not reached

- A real model turn naming the photos for an event (flow test); the owner's own phone opening the
  pages. Nothing here can text a real person: every send goes through the fake runtime or the cage.
