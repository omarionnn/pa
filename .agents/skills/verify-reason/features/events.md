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
Pages: `src/pages/event.js` (`eventPageRequest`: the join page, the claim/finish step, the
who's-going page), routed in `src/http.js` (`/e/<id>`, `/e/<id>/join`, `/e/<id>/who`, and the same
under `/p/` for the files domain — Caddy rewrites everything there under `/p`). The text that
finishes a web join: `src/channels/router.js` `#claimEvent`.
Tools: `src/eventtools.js` (definitions, schemas, visibility, and one handler per tool, wired
into `src/tools.js` as one switch arm and `...EVENT_TOOL_DEFS`). Tests: `test/events.test.js`,
`test/event-tools.test.js`.

## Sub-features

- **Passwords** — scrypt (`node:crypto`), `scrypt$N$r$p$salt$hash`, salted per event; compared
  case- and space-insensitively (it is read out loud and typed on a phone), checked with async
  `scrypt` so guesses never stall the event loop, refused unhashed past 200 characters. Never
  stored, logged, returned or shown; `event_join_attempts` records that a try happened, never what
  was tried. Typed into a conversation, it is scrubbed (`scrubPassword`, whole words) out of that
  conversation's last 24 history messages and its rows from the scrub window (10 minutes; 2 hours for a setup) in `event_log`,
  `inbound_messages.text`, `inbound_parts.text` and sent `outbox.body` — never a message still
  waiting to go or to be retried, never a text not yet read — at once and again 45s and 5min later, after
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
  everybody: past 60 wrong in an hour, every browser (`ip:` actor — its address can be forged on
  the Tailscale funnel path) waits until the hour rolls on, and a phone (`conv:` actor) that has
  already got one wrong does too, while a phone's first try is still checked (guests held at the
  page can text Reason the name and password) (rows under actor `event:<id>`, which is
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

- **Creating** (`event_create`) — shown only where `canCreate(c)`. The model asks the setup
  questions conversationally (name, description, date/time in their zone, location, optional
  welcome, password, and separately: time shown on join? location shown on join? guest list
  visible? optional cap); the tool refuses with `missing: [...]` until every answer is in, so an
  abandoned setup leaves no row. The result hands back `share: {name, password, link}`. Somebody
  other than the owner creating one → the owner gets ONE `runtime.say` line (who, name, the
  event's public page — never the organizer's key, never the password), under its own outbox key
  `event-created:<id>`, and `owner_told_at` is set only when it went. `event_list` and
  `event_guests` are in `SAFE_WHILE_SCREENED`; every other event tool is held by a non-clear screen.
- **Organizer actions** — `event_guests` (names + directory choices + Instagram, no phone),
  `event_update` (guests told about a change only to what they can see; a change to a still-hidden
  time/location is saved quietly; a zone on its own keeps the wall-clock time), `event_release` (one detail per call, every guest texted it),
  `event_blast` (unmuted guests; refused while paused; while paused, an update's or removal's
  messages are HELD — `deliveryState` `held` — and `releaseHeld` sends them on resume to whoever is
  still owed them; a cancellation always goes out, as the bare fact on a paused event), `event_password_rotate` (joined stay, old
  password and half-finished web claims die), `event_guest_remove` (told, directory token dead,
  cannot rejoin, account untouched), `event_cancel` (everyone told, muted too). Shown to whoever may
  create or already organizes one; every one goes through `managed()` and answers a guest, a
  stranger and a made-up id with the same words.
- **Listing** — `event_list`, shown to everybody while events are on: the organizer view of their
  own, the guest view of joined ones.
- **Joining by text / pasted link (existing users)** — `event_lookup` reads a pasted `/e/<id>` link
  and returns `publicView` only, then the model asks for the password; `event_join` takes a name
  or that link plus the password (`ambiguous` → asks who is organizing; `needs_display_name` →
  asks). On success Reason sends the welcome (`sendWelcome`: organizer's message, released details,
  the who's-going link if the list is visible, hidden details said to come later) as its own
  tracked text; `already` sends nothing. The password typed is scrubbed from that conversation.
  Their account is untouched: no onboarding, no name change. After `ambiguous`/`needs_display_name`
  the right password is held in memory for 10 minutes (the ids it opened, never the password), so
  the follow-up needs no password and the scrubbed placeholder is never sent as one
  (`events.joinVerified`). A Reason event link given to `web_lookup` is routed to `event_lookup`
  (`isOwnEventLink`: our pages/public host + `/e/<id>`). Everything an organizer wrote reaches a
  guest's model through `fromOutside` (src/outside.js): marked as somebody else's words and scanned
  for injection shapes — `event_lookup`, `event_join`, guest `event_info`, `event_list.going_to`.
- **After joining** — `event_info` (guest view only; `where_hidden`/`when_hidden`), `event_leave`
  (token dead, account kept), `event_mute` (blasts/updates stop, cancellation still arrives),
  `event_directory` (opt in/out, display name, Instagram as a handle or removed).

- **The join page (web route)** — before the password: name, description, a Join form and the
  plain line that joining also signs them up for Reason (og tags: name + description only; a
  cancelled event shows only its name and that it is off, with no preview tags). After the
  password, two people:
  - **Already on Reason with a page session** (`reason_page` cookie, path `/p/`, from any page of
    theirs on the files domain): told "you're signed in to Reason as X — no signup", tap Join, in on
    the spot (`via: web`), welcome to their Reason thread, no card, no question, no new account.
  - **Anybody else**: display name, optional Instagram, directory opt-in, all on the page, then the
    LAST step is one "Text Reason to finish" `sms:` button prefilled with
    `Hi Reason, I'm joining <name> with code ABCD-EFGH`. Their text proves the phone (inbound-only
    line: Reason cannot text first) and `#claimEvent` → `db.redeemEventClaim` joins them: a new number
    gets an account through the event (0 invites, `joined_via_event`), then welcome → contact card
    (`EVENT_CARD_LINE`) → one question (`EVENT_QUESTION`), no model turn on the code; a number that
    already has an account is just joined (welcome only — the existing-user web route without a
    session). Claims live 24h, die on a password rotation, are single-use; a retried webhook is a no-op.
  - Wrong passwords count per browser (`ip:<addr>`) and per event. The address is Caddy's
    `X-Forwarded-For` only when the request is from loopback AND carries `X-Files-Domain: true` (Caddy
    2.6 replaces a browser's own XFF); never `X-NF-Client-Connection-IP` (nothing strips it on that
    path); otherwise the socket address. Form actions and links are absolute (`/e/<id>/join`,
    `/e/<id>/who?t=`): the public link has no trailing slash, so a relative `join` would post to
    `/e/join` and 404 — pinned by a test that resolves them against the real link.
  - A page session only joins an account `accounts.admit` still allows (not paused/removed/blocked).
- **Who's going** (`/e/<id>/who?t=<token>`) — a joined guest's own token (dead when they leave or are
  removed, and on a cancelled event) or the organizer's token. Opted-in guests only (the organizer
  sees everyone, unlisted marked), Instagram as `https://www.instagram.com/<handle>/` with
  `rel="noopener noreferrer"`, released details only, never a phone number. Guests edit their own
  entry (name, Instagram, listed) on the page. Guest list off → "kept private".

- **The status page** (`/ops`, signed-in owner only; src/pages/ops.js `eventsSection`, data from
  `events.opsSummary`) — made this week, joins this week, wrong passwords today; per event: organizer,
  state, going/cap, joins and wrong passwords (today, ever), and per message (welcome, blast, update,
  release, cancellation, removal) how many reached their guest / sending / held / failed, read off the
  outbox. Buttons (`POST /ops action=event_pause|event_resume|event_retry event_id=N`, 303 back):
  pause (joining + blasts stop, pages say paused, updates/removals held), resume (`releaseHeld`: each
  held message once, to whoever is still owed it), retry (failed deliveries only, never a second
  copy; offered only when a retry could still send something — owed to a current guest, event not
  paused). The buttons are `form.act-ev` plain posts (the page script only hijacks `form.act`).
  Events beyond the 20 newest still show when paused or holding a retryable failure. `/ops.json`
  carries `events` only once events exist or are on (its keys are pinned) and never while a check
  pass is running (the page polls it every half second then). Delivery lookups use an idem_key
  range the outbox's unique index serves. Fields
  are picked one by one: no password, hash or phone number. The owner's creation text links
  `opsUrl("events")`.

## How to get to it (user POV)

- Open the link the organizer shared → enter the password → (already on Reason, same phone's
  browser) tap Join; (anybody else) name + choices → "Text Reason to finish" → press send.

- Organizer texts "i want to throw a halloween party and have people join through you" → Reason
  asks the setup questions → name, password and link come back.
- Guest texts "can you get me into omari's halloween party" → asked for the password → in, and the
  welcome arrives as its own text. Or pastes the link → Reason names the event and asks for the
  password.
- "where is it?" → the released details or "the organizer hasn't shared that yet"; "who's going?" →
  the who's-going link. "mute it" / "i'm out" / "put me on the list with my insta @x".
- "move it to 10:30", "share the address now", "tell everyone to bring snacks", "change the
  password", "kick Yaw", "cancel the party" → the matching organizer tool.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/events.test.js       # passwords, matching, limits, capacity, isolation, claims, deliveries
node --test test/event-tools.test.js  # every tool through runTool: creation, owner text, visibility per flag, organizer actions, isolation
node --test test/event-join.test.js   # text + pasted-link joins, same-name events, welcome tracked once, info/leave/mute/directory
# the real Runtime + Router + outbox + FakeChannel, in process, cage env, throwaway DB (no model):
node --test test/event-ops.test.js    # the status page section, pause/resume/retry, owner-only
node --test test/event-web.test.js    # the pages, the finishing text, existing users by session and by text, who's going
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/events.db node .agents/skills/verify-reason/bin/events-drive.mjs
REASON_BACKEND=claude-cli node --test test/flow-events.test.js   # by meaning, real model on the subscription: setup questions, text join, pasted link, hidden address
```

Cage: `bin/caged.sh start`, then `bin/peek.sh sql "SELECT name FROM sqlite_master WHERE name LIKE 'event%'"`
shows the six tables made on start (`CREATE TABLE IF NOT EXISTS`, no data rewritten).

## Gotchas

- The cage (`bin/caged.sh start`) serves the pages at `http://127.0.0.1:<port>/e/<id>` once an event
  exists in its DB — `curl` them to see the HTML a stranger gets. Its texting channels are not
  connected, so the finish step there says the line isn't connected (no `sms:` button): that is
  correct, and the drive script covers the button with a FakeChannel instead.
- The `sms:` body is HTML-escaped in the page (`I&#39;m`); unescape before decoding.

- Events are the first rows shared across conversations: never read an event table from anywhere
  but `src/events.js`, and never add a path that returns an event without going through
  `managed`/`visible`.
- A password typed into a tool input is in that conversation's own history (the person typed it
  there); it is sealed out of the decision log and the action ledger by `SECRET_TOOLS`. Add any new
  tool that takes a password to that set.
