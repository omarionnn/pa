# Events — organize by text, guests join with a name and a password

An organizer texts their Reason that they want to throw something; Reason asks the setup questions
and makes the event. Guests join with the event's name and password — by text, by pasting the event
link into their Reason, or by opening the link and tapping Join — including people with no Reason
yet, for whom an event is their way in. **Behind `REASON_EVENTS`** (`off` | `owner` | `on`, read like
`REASON_FLIGHT_BOOKING`): off, nobody's model is told events exist; `owner`, only the owner may
CREATE one, but anybody may join any event (the owner's links must work for every guest); on,
anybody with a Reason creates. **Live since 2026-10-25 16:38: `REASON_EVENTS=on`,
`REASON_EVENT_RIDES=on`** (owner: "on for everyone"); read them read-only with
`ssh root@91.98.19.150 "grep -E '^REASON_EVENT(S|_RIDES)=' /opt/reason/.env"`.

Source: `src/events.js` (the only reader of the event tables: passwords, matching, the attempt
limit, every access rule, the guest/public/organizer views, deliveries), `src/db.js` (the `events`,
`event_attendees`, `event_messages`, `event_deliveries`, `event_join_attempts`, `event_claims`
tables, `accounts.joined_via_event`, `redeemEventClaim`), `src/privacy.js` (`SECRET_TOOLS`: a
password is sealed out of the decision log and the action ledger), `src/config.js` (`events`).
Pages: `src/pages/event.js` (`eventPageRequest`: the join page, the claim/finish step, the
who's-going page), routed in `src/http.js` (`/e/<id>`, `/e/<id>/join`, `/e/<id>/who`, and the same
under `/p/` for old files-domain requests). **Event links live on `https://events.heyreason.com`**
(owner's domain rule, 2026-10-26): `REASON_EVENTS_URL` (unset → `REASON_PAGES_URL`) is the one base
for every event address (`events.eventUrl` → directory, organizer page, album, manage, cover,
cover preview, code `@host` binding). Caddy's `events.heyreason.com` block passes `/e/*` (and the
icons) to the app unchanged; `files.heyreason.com/e/*` (and `files.reason.omarinyarko.com/e/*` via
files.) answer 301 to events. + same path and query. `isOwnEventLink` still accepts old files. links. The text that
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
- **Roles per event (spec v3 §11)** — `event_attendees.role` is `organizer` | `guest`, per
  membership. The organizer's own row is written when the event is made (`db.insertEvent`) and
  backfilled once on start for older events; every guest read (`attendeesOf`, `joinedCount`,
  `joinsSince`, `eventsAttendedBy`, `attendeeById`, `attendeeByToken`, `leaveAttendee`) is
  `role = 'guest'`, so the organizer is never counted, listed, texted or given a guest page.
  `roleIn(c, id)` is the one place a role is read: their own membership row of THAT event (an
  organizer row counts only when `events.organizer_conversation_id` agrees). The same account
  organizes A and is a plain guest at B; organizer tools on B answer `guest_there` ("they're a guest
  at B") — a stranger still gets exactly the made-up-id answer.
- **Which event (spec v3 §11)** — every per-event tool takes `event_named` (their words: a name or the
  link). `whichEvent` runs when they hold more than one live membership the tool could be about
  (organizer tools: events they organize; leave/mute/directory: events they're a guest at;
  `event_info`: all): unless `event_named` picks out exactly the `event_id` given (link → public id;
  name → `nameKey` exact, then containment, then the organizer's name said alongside), the answer is
  `which_event` with `choices` (guest-visible fields only) and NOTHING is done. One event they could
  mean → no question. Every message to guests carries the event's name.
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
  `event_blast` (unmuted guests; needs the organizer's yes to the exact words, pinned by hash —
  see [confirm-gate.md](confirm-gate.md), audit lead 28; refused while paused; while paused, an update's or removal's
  messages are HELD — `deliveryState` `held` — and `releaseHeld` sends them on resume to whoever is
  still owed them; a cancellation always goes out, as the bare fact on a paused event), `event_password_rotate` (joined stay, old
  password and half-finished web claims die), `event_guest_remove` (told, directory token dead,
  cannot rejoin, account untouched), `event_cancel` (everyone told, muted too). Shown to whoever may
  create or already organizes one; every one goes through `managed()` and answers a stranger and
  a made-up id with the same words (a guest of that event is told they're a guest there).
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
  plain, visible notice that joining gives them access to Reason and starts a Reason text
  conversation (never "signs you up") (og tags: name + description only; a
  cancelled event shows only its name and that it is off, with no preview tags). After the
  password, two people:
  - **Already on Reason with a page session** (`reason_page` cookie, path `/p/`, from any page of
    theirs on the files domain): told "you're signed in to Reason as X — this just adds you to the event", tap Join, in on
    the spot (`via: web`), welcome to their Reason thread, no card, no question, no new account.
  - **Anybody else**: display name, optional Instagram, directory opt-in, all on the page, then the
    LAST step is one "Text Reason to finish" `sms:` button prefilled with
    `Hi Reason, I'm joining <name> with code ABCD-EFGH`. Their text proves the phone (inbound-only
    line: Reason cannot text first) and `#claimEvent` → `db.redeemEventClaim` joins them: a new number
    gets an account through the event (0 invites, `joined_via_event`), then welcome → the first-chat
    onboarding (features/onboarding.md; switch off: contact card `EVENT_CARD_LINE` → `TRY_LINE`, never a
    question about what they do), no model turn on the code; a number that
    already has an account is just joined (welcome only — the existing-user web route without a
    session). Claims live 24h, die on a password rotation, are single-use; a retried webhook is a no-op.
  - Wrong passwords count per browser (`ip:<addr>`) and per event. The address is Netlify's
    `X-NF-Client-Connection-IP` ONLY alongside a valid website signature (`x-nf-sign`,
    src/pages/siteproxy.js — event pages are not proxied by the website today, so in practice never);
    else Caddy's `X-Forwarded-For` only when the request is from loopback AND carries `X-Files-Domain:
    true` AND Caddy's secret `X-Reason-Caddy` = `REASON_CADDY_SECRET` (`caddyClientIp`; the Funnel
    shares Caddy's port and passes browser headers through, so the marker alone is forgeable);
    otherwise the socket address — one `ip:127.0.0.1` count for every unvouched browser, and for
    every Caddy visitor while the secret is unset. Pinned: `test/caddy-marker.test.js`. Form actions and links are absolute (`/e/<id>/join`,
    `/e/<id>/who?t=`): the public link has no trailing slash, so a relative `join` would post to
    `/e/join` and 404 — pinned by a test that resolves them against the real link.
  - A page session only joins an account `accounts.admit` still allows (not paused/removed/blocked).
- **Who's going** (`/e/<id>/who?t=<token>`) — opens only on a browser recognized as somebody on
  THIS event (see below): a guest sees their own guest view, the organizer the organizer view,
  whatever token the link carries. Opted-in guests only (the organizer sees everyone, unlisted
  marked), Instagram as `https://www.instagram.com/<handle>/` with `rel="noopener noreferrer"`,
  released details only, never a phone number. Guests edit their own entry (name, Instagram,
  listed) on the page — the edit is by session, never by the token in the form. Guest list off →
  "kept private".
- **Recognized browsers (spec v3 §12, §14)** — every private event page (who's going, a joined
  guest's details on `/e/<id>`, the organizer's own page) is decided on the server per request:
  `sessionAccount` (the `reason_page` cookie → `page_sessions.conversation_id`, an account
  `accounts.admit` still allows) → `events.roleIn` for THIS event. A browser that isn't recognized
  gets a gate showing the event's name only:
  - **From a guest's or the organizer's link** — "Text me a code" texts the person the token belongs
    to (a forwarded link texts its owner, never the holder). Code typed → session → their page.
  - **Sign in by number** (`/e/<id>/signin`, linked from the join form) — only a number whose live
    account is ON this event is texted a code (it has texted the line before, so the inbound-only
    line can reach it); no account, or an account not on this event, gets the identical page and
    no text, then "Join as a new guest" — so a typed number can only buzz a member of an event whose
    link the typer holds, and the page never says which numbers use Reason. The send is not awaited
    (no timing difference). 10 sign-in requests per browser per hour (`event_join_attempts` route
    `signin`, never counted as a join or a wrong password).
  - Codes are the page code gate's (`src/pages/access.js` `requestCode`, key `esign:<conversation>`; the text's outbox key is `esign:<conversation>:<code row id>`, so two taps in one ms both text — #147):
    six digits (`randomInt`, leading zeros kept — since 2026-10-25; the text is "Your Reason code is
    NNNNNN, to …" then a blank line and Apple's domain-bound `@<pages host> #NNNNNN`, the host taken
    from `eventUrl`; the box is `codeInputAttrs` in `src/pages/render.js` — one-time-code, numeric,
    maxlength 6, a pasted whole text is cut to its code, and `typedCode` reads it the same way on
    the server), stored as `sha256:` in `page_codes` (every page code now — `db.pageCodeHash`/
    `pageCodeIs`; older bare rows still compare), 15 minutes, once, a new one kills the old, 3 sent
    per 15 minutes per person. Wrong tries (`events.trySigninCode`): 5 per 15 minutes per BROWSER
    (`esignb:<ip>` — the only limit ever said, so the answer never depends on the number and a
    stranger cannot lock the real person out) plus a silent 20 per person across browsers (and 40 per person per day, since six digits).
    The ceiling bounds guessing, not the person (lead 25): each code is bound to the asking browser
    (`page_codes.bound` = `events.signinBinding(<ip actor>)`; a new request kills only that browser's
    old code); past the ceiling a code opens only on its own browser and gets one try. Never in
    a log line (`event_signin_*` log only ok/why). The code text itself sits in that one outbox row,
    like every sent message. A person's export/delete (`src/data.js`) reaches `esign:` rows and every
    `page_sessions` row of theirs.
  - A session lasts 90 days (`SESSION_TTL_MS`), cookie `Path=/`, HttpOnly, SameSite=Lax, Secure on
    https. "Sign out of this browser" (`POST /e/<id>/signout`, only with the cookie presented — a
    cross-site post clears nothing) on every private page;
    `browsers_sign_out` (tool, by text) ends every browser of theirs.
  - The code proves who; the role is still checked: a verified non-member gets the join form
    (password still needed) and nothing private; a removed or departed guest's browser loses the
    pages at once.

- **Rides between guests (spec v3 §13)** — `src/eventrides.js` (not `src/rides.js`, which is
  Uber/Lyft), tables `ride_offers`, `ride_matches`, `ride_asks`, `ride_blocks`, `events.rides_enabled`.
  **Behind `REASON_EVENT_RIDES`** (`off` | `owner` | `on`): owner = only events the owner organizes
  may turn it on. Off per event until the organizer turns it on (`event_rides_setting`, which also
  returns counts only — matched / still looking, also in `organizerView.rides` while the flag is on).
  A guest's one tool is `event_ride` (offer | need | cancel | answer | coordinate | message | neither
  | report), shown only to a guest of an event with rides on. Intake is only a neighborhood (a place
  that geocodes to a street address — Nominatim `house_number` — is refused), a rough leave time,
  seats, one way or round trip.
  - **Matching by code**: same general area = within 6 km between where the two areas geocode
    (neither placed → the same words), leave times within 45 min, enough seats left (checked again at
    the moment both say yes), a round-trip rider only with a round-trip driver; never two PEOPLE who
    were already suggested and it came to nothing (a no, a lapse — `db.ridePeopleSpent`) or who were
    reported (`ride_blocks`). One suggestion per person at a time, closest area then closest time;
    each side sees the other's first name + area (+ Instagram only if shown on this event's
    directory). Nothing is set until both say yes; then pickup around the rider's area ±15 min, both
    told, and asked how to coordinate — `reason` (messages passed along) or `intro` (numbers swapped
    only once BOTH chose intro). Offer status is recomputed after every change (`settle`).
  - **Changes**: an edit that still fits keeps the pairing (the other side is told the new plan);
    one that doesn't ends it. A cancel, an unfitting edit, leaving or removal (`leftEvent`, called
    from `event_leave` / `event_guest_remove` at once, and by the sweep for anything missed) tells the
    other side right away and puts them back in line. A report names ONE person (`about`, asked when
    ambiguous), ends only the pairing with them, blocks the two for good, tells the other only that
    the ride is off, and the organizer only if asked.
  - **Never gives away what's hidden**: no ask while the time is hidden ("tomorrow" = the date); no
    suggestion while the time or place is (interest is held).
  - **Sweep** (`Runtime.eventRides`, each event in its own try; an event whose organizer is
    stopped — `events.organizerStopped` — is skipped whole until they are let go): released offers of people gone;
    outside the night (21:00–09:00 in the event's zone — no new suggestion, lapse, ask or reminder
    goes then; a late offer is told "the morning"), suggestions lapse after 12h (both told), the
    day-before ask once per unmuted guest (from 11:00 local the day before, not within 2h of the
    start; a guest who joins on the day is asked on the next pass), suggestions, the day-of reminder
    once per agreed pair from 3h before.
  - **Delivery**: every ride text is an event message (`kind` `ride`, `ride_report` to the organizer)
    with a tracked delivery, never to a muted guest except the direct answer to their own action.
    Once sent it is also written into the RECEIVER's thread as the last thing Reason said (so "yes
    pair us" answers the match) — queued behind any running turn of theirs (`Runtime.enqueue`),
    never for the person whose own turn sent it (the CLI path records that off the outbox), never
    twice. `ridesNote` rides on every turn they start (src/agent.js).
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
- **The link's card (spec §14, `src/eventcover.js`)** — the join page's served HTML carries
  og:title = the event name, og:description = `INVITE_LINE` ("You're invited. Join with the event
  password."), og:image = `/e/<id>/cover.jpg?v=<u{version}|g{name hash}>` (absolute, 1200×630 JPEG,
  public) — never the description, time, place, a guest's name or the password. No uploaded cover →
  Reason draws one (`generatedHtml`: the name large, the small wordmark, `src/pages/wordmark.js`; the kicker in the dark brand red). An uploaded one goes
  through `event_cover` (organizer only): `use_photo {photo_id}` draws the exact card into
  `cover_pending` (file `p-…` under `data/event-covers`), reads the picture with the model on the
  subscription (`readFlyerViaCli`, CLI `--json-schema`), checks the password against the hash, and
  sends the organizer the card by its private `/e/<id>/cover-preview.jpg?k=` address. `approve`
  needs a later inbound text (`db.lastInboundAt` > the offer) and no conflicts; a picture that
  could not be read is a conflict. A hidden (not `*_public`) time/place, a guest's name or the
  password in it BLOCKS; only a new picture or `event_detail_public` (ask → a LATER yes; public
  also releases to guests) clears time/place. `discard` keeps the live cover; `remove` goes back to
  the drawn one. Columns: `cover_file`, `cover_version`, `cover_approved_at/_by`, `cover_media_id`,
  `cover_findings`, `cover_pending`, `time_public`, `location_public`, `public_ask`. `event_create`
  returns `share.share_text` (name + password, never the link; sealed in logs) and says to send the
  link as its own message so Messages draws the card.

- **Guest-list note + Instagram (owner decision 2026-10-25, `src/events.js` "the guest-list note")**
  — somebody already on Reason who joins (text, link, page, or the page's claim text) is on the
  who's-going list by default (`in_directory` 1; the page's "show me" box starts ticked) under the
  name Reason knows. `afterJoin` keeps a handle they typed on `accounts.instagram`, else carries the
  kept one onto the row, and owes ONE note (`event_attendees.list_note` ask|carried|shown →
  sent|dropped, `list_note_at` = due then settled; compare-and-set, never twice per membership).
  `scheduleListNote` sends it through `Runtime.enqueue`, so it lands AFTER Reason's reply; the
  sweep (`runtime.eventListNotes`) is the backstop after 10 min and the morning send: nothing
  21:00–09:00 in the event's zone, nothing while paused or while the organizer is stopped (held, goes once let go), dropped if the list is private, they are
  off it, the ask is moot, or 12h past the start. Guest list off → never owed, never mentioned. The
  organizer gets the same note on `event_create` and is listed first (`db.organizerListing`,
  "(organizing)" on the page) — never counted (`going` stays guest-only). The answer is the model's:
  `event_directory` (handle → also saved to the profile; off the list or Instagram off one
  list; organizers allowed on their own row) and `event_instagram` (remove / change everywhere).
  Pinned: `test/event-list-note.test.js`; drive: the `note:` steps in `bin/events-drive.mjs`.
  New users from a claim get their typed handle kept but no note (their welcome flow is its own).
- **Scheduled messages + automatic reminders (`src/eventschedule.js`, table `event_scheduled`)** —
  `event_schedule` (behind the confirm gate like `event_blast`; target pins event + time + words
  hash, `scheduleRefusal` refuses a past time / paused / cancelled BEFORE a yes is asked) sets or
  changes one message to every guest at a wall-clock time in the event's zone; `event_scheduled`
  lists, cancels (no yes) and switches reminders. The manage page's `03 · LATER` section does the
  same through `runEventTool` with its own preview → confirm. Sending is only the runtime sweep
  (`Runtime.eventScheduled`): claim pending → sending + its `event_messages` row in one
  transaction; a row left `sending` by a dead process is finished on the next pass (deliveries
  dedupe per guest). Recipients = joined, unmuted guests at send time. Paused → waits; >2 h late →
  `missed` (shown on the page); the organizer's NUMBER paused or removed by the master
  (`events.organizerStopped` → `db.stoppedStateOf`, any line; never the master's own) → the same
  hold: a pending row stays pending, a `sending` row is not finished, no reminder is claimed; let go
  in time it goes, past its window it is `missed` ("it was on hold when it was due"); event cancelled → pending rows cancelled. Reminders: day before at
  18:00 local (may go until 21:00) and start − 2 h (skipped if 22:00–08:00); only while the time is
  shared; location only if shared; once per (event, kind, starts_at); not if the event was made
  after the reminder time. `events.remind_day_before/remind_soon`: 0 for events made before this
  shipped, 1 for new ones. History kinds `scheduled` / `reminder`. Pinned:
  `test/event-scheduled.test.js`; drive: the `sched:` steps.
- **Message only some guests (2026-11-08, `src/events.js` `pickAudience` / `recipients(ev, kind, audience)`)** —
  `event_blast` and `event_schedule` take `only_guest_ids` (guest_id from `event_guests`) or
  `only_joined_after` (wall-clock, event zone); neither = everyone. The model reads who they meant
  against the guest list; code checks ids are joined guests of THIS event (`not_guests` refused before
  any yes, `audienceRefusal`). Floor unchanged: joined, unmuted only (cancel still everyone). The
  confirm target adds ` to <label> — N get it: names {hash(pick + reached ids)}`, so a different pick,
  or someone muting / leaving / joining between ask and send, needs a new yes; everyone's target is
  byte-for-byte the old one. The gate refusal carries `reaches` (count, names, skipped_muted).
  Stored as canonical JSON in `event_messages.audience` / `event_scheduled.audience` (NULL =
  everyone; an unreadable key reaches nobody). Dedupe (`recentEventMessage`) matches audience too.
  Page: "WHO GETS IT" radio (everyone / only guests I pick / joined since) on both the 02 MESSAGE
  GUESTS and 03 LATER forms; preview lists count + every name; send step re-checks a `pin` of the
  reached ids and re-shows the preview if it moved. Owner decisions 2026-11-08: "joined since" compares
  `event_attendees.first_joined_at` (set on first join, kept on a rejoin; old rows backfilled from
  `joined_at`, which still moves on a rejoin), so a guest who left and came back is not new — the
  pick list's JOINED line and `event_guests.joined` show the same first join; muted guests are in
  the pick list with NO muted label (they still get nothing; the confirm step says "N guest(s) you
  picked muted the event"); the page section is "Message guests" (was "Message everyone"). Pinned:
  `test/event-some-guests.test.js`; drive: the `some:` steps (incl. the left-and-came-back one).
- **Guest-list privacy and the cap after creation (2026-11-08, `src/events.js` `setListVisible` / `setCapacity`, tool `event_settings`)** —
  `event_settings` takes `guest_list_visible`, `capacity` (1–100000) or `no_cap`. Hiding the list is quiet: no
  text, no yes, every guest's `in_directory` kept. Showing it never lists anybody who didn't choose it: new
  column `event_attendees.list_chosen` (1 = joined with the box ticked while the list was shown, or turned it
  on themselves; a page save that leaves a private event's default tick is not a choice; backfilled once when
  the column is added: in_directory AND the event's list shown). On show, every joined guest with
  in_directory=1 and list_chosen=0 is set off the list (`db.openListFor`) and owed list note kind `opened`
  ("<organizer> turned on a who's-going list for <event>… you're not on it — if you'd like to be, just let me
  know (you'd show as <name>)."), sent by the list-note sweep: never 21:00–09:00, never to a muted guest,
  never twice, dropped if the list is private again first. The organizer goes on their own list as at
  creation. Guests who chose it before reappear without a text. By text, showing a private list with anybody
  to ask is CONDITIONALLY_GATED (`settingsNeedYes`); target `show the who's-going list of <event> (event #id)
  and ask N guests who joined while it was private: names {hash(ids)}`; the refusal carries `asks` (count,
  names, muted_not_asked, text_they_get); refusals (`settingsRefusal`) come first. Cap: nobody is ever
  taken off; at/under the number in, joins refuse `full` on every route (text, page, claim) until the count
  drops below the cap; guests never told. Full copy: text "full right now… same password works… no
  waitlist", page "This event is full right now. If a spot opens up, the same link and password will
  work.", claim line "that event is full — it filled up before your join went through…". Page: 05 GUESTS has WHO SEES
  THE GUEST LIST (tag PRIVATE / SHOWN TO GUESTS; show = confirm step with who gets asked, the exact text and a
  `pin` re-checked on send; hide = confirm, quiet) and HOW MANY CAN JOIN (tag `N OF CAP` / `FULL · N OF CAP`;
  empty = no cap; confirm step only when the new cap is at or under the number in). Guest rows on a private
  list read "joined while the list was private". Waitlist out of scope. Owner decisions 2026-11-08 (#401, yes
  to all three): guests who joined while it was private are asked once, behind the yes; the organizer goes on
  their own list when they show it (`hostWouldList`; the text reply's `you_listed_as`, the page's "You go on it
  too, as …"); the full-event wording stays as written. Pinned: `test/event-edit-limits.test.js`; drive: the
  `limits:` steps (one per decision: asked once, organizer listed, full wording).

- **Guest questions (2026-11-08, `src/eventquestions.js`, tools `event_questions` / `event_answer`, tables `event_questions` / `event_answers`, `event_claims.answers`)** —
  the organizer asks up to 3 short questions guests answer on joining: `text` (answer ≤200 chars) or `choice` (one of 2–6
  choices, each ≤40). Every one optional: the join page shows them under the name ("THE HOST ASKS · ALL OPTIONAL", nothing
  `required`), a blank is a skip, joining never waits; an unreadable answer (a choice that isn't one) is sent back with the
  form kept. Page claim: answers ride on `event_claims.answers` and are filed by `db.fileClaimAnswers` inside
  `redeemEventClaim` only when the question's `version` is still what the guest read (a reword drops that answer). Signed-in
  page join files them at once. Text join: `event_join` returns `questions` (choices numbered) and `say` tells the model to
  ask only the first, optional, then the next after each `event_answer` (`choice` 1-based, `text`, `clear`; shown only to a
  guest of an event that asks something). By text, `event_questions` add/change is CONDITIONALLY_GATED: target
  `add a question for guests of <event> (event #id): "<words>" (pick one: a / b) {hash}`, refusal carries `asks`
  (`guests_see`, `guests_already_in`); `questionsRefusal` refuses a 4th, empty, bad choices, a repeat, or a reword of an
  answered one BEFORE any yes. list/remove ask nothing; remove with answers refuses `has_answers` + count until
  `delete_answers` (answers deleted with it). Adding texts nobody; guests already in answer on their own page. Reword only
  while 0 answers (`version` +1). Guest's own page (`/e/<id>`, joined) has "YOUR ANSWERS FOR THE HOST" → `POST
  /e/<id>/answers` (guest session + `ownOrigin`, blank clears). Privacy: answers only on the organizer's manage page
  (`06 · GUEST QUESTIONS`: ANSWERED · N OF M, count bar + names per choice, each text answer by name, "Not answered yet"),
  in `event_guests` (per guest `answers`) and `event_questions` list (wrapped `fromOutside`); never on who's-going, the
  public join page, another guest's page or `event_info`; joined guests only. `event_answers` keyed by the guest's
  `conversation_id` (their delete takes them); `event_questions` KEPT_ON_DELETE. Call gate: `event_answer` and non-list
  `event_questions` are consequential on a caller-ID-only call. Pinned: `test/event-guest-questions.test.js`; drive: the
  `ask:` steps.
  **Owner decisions 2026-11-11 (same PR):** (1) **Required** — `event_questions.required`; `required: true` on add/change
  (target line ends `, required)` and the hash covers it; `asks.required`). Join page: "THE HOST ASKS" with REQUIRED /
  OPTIONAL tags, `required` on the inputs, and `readForm().missing` refuses a blank server-side ("the host asks everyone
  this one before they're in"). Text join: `events.joinExisting`/`joinVerified` return `needs_answers` + `questions`
  before admitting (no welcome, no row); the model asks gently one at a time and calls `event_join` again with `answers`
  `[{question_id, choice|text}]` and no password (the `verified` hold covers it, like needs_display_name); the answers
  are filed as `via text`. Made required only while 0 answers (`answered_required` refused before the gate; CAS in
  `db.setEventQuestionRequired`), optional again any time with answers standing (`version` untouched, not a reword); a
  change with the words left out keeps them. Guests already in are never held to it (own-page save with it blank goes;
  a required answer can be changed, never cleared: `event_answer clear` → `required`, no "No answer" pick). Manage page:
  checkbox "Everyone has to answer this one to join", confirm "GUESTS SEE · REQUIRED", "Make it optional" on an answered
  required one (`done=question_required|question_optional`). (2) **Ask the guests already in** — `event_questions action
  ask_guests` (CONDITIONALLY_GATED; `questionsRefusal` → `nobody_to_ask` before any yes): target `ask N guests already in
  <event> (event #id) to answer "<words>" (…): names {hash of question_id+version+ids}`, `asks` = guests/names/
  muted_not_asked/`text_they_get` (`events.questionAskText`: "<organizer> added a question for everyone going to
  <event>: "…" — a, b. totally optional — …" / required: "they're asking everyone…"). The yes owes one
  `event_question_asks` row per guest (UNIQUE question+attendee, never twice; `oweQuestionAsks`), due after
  `LIST_NOTE.backstopMs`; `sweepQuestionAsks` (run from `Runtime.eventListNotes` next to the list notes, result key
  `asks`) sends by the list-note rules — not 21:00–09:00 in the event's zone, never muted/left, dropped when moot
  (answered since, question reworded = version changed, removed, event cancelled/stale, guest left: `dropAnswersOf`
  drops owed asks). `event_messages.kind = question_ask`, into the thread as Reason's own words. Adding by text: the
  note says `can_ask_guests` N and tells the model to offer it in one line. Manage page: adding to an event with guests
  lands on "Ask the N guests already in?" (names, exact text, `pin` = version + ids re-checked on send; "Don't ask" →
  `done=question_not_asked`, nothing owed); each question with guests left to ask has "Ask the N guests already in →".
  (3) **Creation mention** — `event_create.say` adds one plain line (ask people a few short questions when they join, up
  to 3) and the tool description tells the model to offer it when the event is RSVP-shaped. Per-event SQL on
  `event_answers`/`event_question_asks` is on `test/fixtures/unscoped-sql-baseline.json` (scoped by event_id; the
  organizer is checked in `events.managed` first).
- **Paid events (2026-11-11, `src/eventpay.js`, tools `event_price` / `event_payouts` / `event_refund`, tables `event_payments` /
  `event_payout_accounts`, `events.price_cents` + `currency`, flag `REASON_PAID_EVENTS` off|owner|on, off on live)** —
  Stripe Connect Express + destination charges; Reason never holds funds. Per ticket at price P: the guest pays P plus
  Stripe's processing (2.9% + 30¢ of the total, one "Processing" line on the hosted Checkout, Apple Pay included); the
  organizer gets P less Reason's 2.5% of P; `application_fee_amount` = total − organizer's share (`quote()`:
  $25 → $26.06 total, $1.06 processing, organizer $24.37, fee $1.69). Price $5–$500, `event_price` (price_dollars or
  free:true; a price change is for new joins, nobody already in is charged or refunded). **Payouts first:** a price
  needs the organizer's Express account with `charges_enabled` (`ensureAccount` → one `account_links` onboarding link,
  texted on its own; return/refresh `/e/<id>/payouts` on the events domain, which re-reads the account and lands on
  `#money`); `account.updated` readies it and texts the organizer once. **Nobody is in until the webhook:** on a priced
  event the right password (text `event_join`, page join, page→claim text) answers with the Checkout link and a 15-minute
  hold (`event_payments` status open; `openHolds` counts against the cap; one open link per person per event, asked twice
  = the same page); `checkout.session.completed` → `settlePaid` (one transaction: row paid + `addAttendeeTx` under the
  cap; welcome + a `receipt` message; a late payment with no spot left is refunded in full and said); the sweep
  (`runtime.eventPayments`) expires holds past 15 min and `/expire`s the Stripe session (Stripe's own expires_at is 31
  min, its minimum). `checkout.session.expired` / `async_payment_failed` mark the row. **Refunds:** `event_refund` by
  text is in `ALWAYS_NEEDS_CONFIRMATION` + `GATED_ACTIONS` + `NEVER_STANDING`, target `refund $X to <name> for <event>
  (event #id) [pay N]`, refusals (`refundRefusal`: not theirs, no such guest, never paid) before any yes; the page's
  Tickets section refunds behind a review → confirm step; `refund()` posts `reverse_transfer` + `refund_application_fee`
  so the guest sees one full refund (Reason eats Stripe's processing on a refund); the guest leaves (`leaveAttendee`,
  rides told) and gets a `refund` message; `charge.refunded` from Stripe's dashboard does the same; `event_cancel` →
  `refundAll` (everyone paid, fee included) and expires open Checkouts. **Manage page 07 · Tickets** (only where
  `paidEventsOn() && (canPrice(c) || priced(ev))`): payouts setup / finish button (303 to Stripe), price with a live
  quote (`price_in` → `price_quote`) behind a review step, PAID · GROSS · YOU GET, WHO PAID with Refund / Retry refund,
  Open your Stripe dashboard (`login_links`, one-time). Organizer view carries `tickets` (paid, gross, you_get,
  refunded, spots_held_for_payment, per_person) and `payouts_ready`; public/guest views carry `price_per_person`,
  `price`, `paid_event`; the guest's `you.paid`. Webhooks share `/stripe/webhook` with the subscription:
  `eventpay.isOurs(event)` routes tickets/accounts, `plan.js` the rest; a second signature try with
  `STRIPE_CONNECT_WEBHOOK_SECRET` for a Connect endpoint. `event_payments` / `event_payout_accounts` are KEPT_ON_DELETE;
  their id/session/intent-keyed SQL (webhook lookups) is on the unscoped-SQL baseline. **Not provable offline:** Connect
  itself — on 2026-11-11 the Stripe account (test mode) answered `You can only create new accounts if you've signed up
  for Connect`; the test-mode endpoint lacks `account.updated`, `checkout.session.expired`, `charge.refunded`. Pinned:
  `test/event-paid.test.js` (18); drive: the `pay:` steps (17 of the 21).
- **Refund policy + sales summary (2026-11-11, PR event-refund-sales, same flag `REASON_PAID_EVENTS`, tool
  `event_ticket_refund`, columns `events.refund_policy` + `refund_hours`, `event_payments.refund_policy` + `refund_hours`)** —
  **Policy** per priced event: `none` | `until` N hours before the start (default; null = until 48 h) | `anytime` until it
  starts; picked with the price (`event_price` refund_policy / refund_hours / refund_days, or alone; the manage page's
  REFUNDS radios + N hours|days inside the price form, behind the same review step; a policy-only change titles it
  "Change the refund policy?"). Each ticket snapshots the policy at Checkout; `ticketPolicy` = the looser of then/now
  (loosening reaches tickets sold, tightening only new sales — said in the tool note and the review). Shown: join page
  "Refunds:" row next to Price (v1) / "Refunds" fact (v2) + the paid-join note; Stripe Checkout `custom_text.submit`
  + the ticket line's `product_data.description`; the pay-link text; the paid-join receipt (`receiptBody`: `paid $X for
  <name> — you're in. refunds until … — just text me "refund my ticket"…`); guest view `you.your_refund_policy` +
  `can_ask_for_refund_now`. **Guest's own refund:** `event_ticket_refund` (visible only while `holdsTicket`: a paid row
  on a non-cancelled event) is in `ALWAYS_NEEDS_CONFIRMATION` + `GATED_ACTIONS` + `NEVER_STANDING`, target `cancel my ticket
  for <event> (event #id): $25.00 back [pay N]`; `ticketRefundRefusal` (no ticket; `refundWindow` says no_refunds / closed /
  started) answers BEFORE any yes, saying the organizer can still choose to refund. Allowed → `guestRefund` → `refund()`
  with why=guest. **Who asked decides what comes back (owner decision 2026-11-11, `refundSplit`):** a guest's own cancel
  (why guest/buyer) refunds `amount` = the price with `reverse_transfer` and `refund_application_fee=false` (the transfer
  of a destination charge is the whole charge, so the proportional reversal is exactly the price), then `feeBack` posts
  `/v1/application_fees/<fee>/refunds` amount = Reason's 2.5% (fee id from GET `/v1/payment_intents/<pi>?expand[]=latest_charge`);
  Stripe keeps its processing; the organizer ends with $0 for the ticket. Owed fee-backs sit on
  `event_payments.fee_back_owed_cents` (key `evfeeback:<id>:<fee_back_seq>`) and the sweep retries. Organizer refunds,
  cancels, no-room and dashboard refunds stay whole (processing included). Every guest-facing line says it:
  `policyWithMoney` "Refunds until 48 hours before it starts. If you cancel: $25.00 back; the $1.06 processing fee isn't
  refundable." (join page, Stripe description + submit text, pay-link text), receipt "(… isn't refundable)", ticket
  block "Plans changed? Cancel and you get …", confirm step "You paid $26.06. Cancel and you get …" + button "Cancel and
  get $25.00 back", done page, text "done — your ticket for X is cancelled …: $25.00 back; the $1.06 processing fee isn't
  refundable"; organizer hears "<name> cancelled their ticket to <event> under your refund policy and got the $25.00
  ticket price back". `event_payments.refunded_cents` = what went to the card; `summary().returned_cents` sums it.
  Guest page: YOUR TICKET block (paid, policy, closing time only when the event's time is out to them) with "Refund my
  ticket" → POST `/e/<id>/refund` step=review (confirm page) → step=do (Refunded page); outside the window no button, "The
  organizer can still choose to refund you"; a stranger's POST 404, cross-origin 403. Organizer `event_refund` ignores
  the policy. **Sales:** `summary()` sold (paid + refunded) · gross (price × sold) · refunded · Reason's 2.5% (standing
  tickets only) · coming to you; gross − refunded − fee = coming. 07 Tickets shows SOLD · GROSS · REFUNDED · REASON'S
  2.5% · COMING TO YOU · NEXT PAYOUT; `event_payouts status` returns `tickets` + `next_payout` + a plain `say`. Next
  payout = `payoutInfo` (GET `/v1/balance` + `/v1/payouts?limit=10` with `Stripe-Account: <acct>`, 4 s timeout, cached
  60 s; the organizer's GET of their page asks first): a pending/in-transit payout's amount + arrival date, else "None
  scheduled yet — $X still clearing" / "… ready", else "Not available yet"; Stripe down → "Not available right now".
  Account-wide (all their events). Pinned: `test/event-refund-sales.test.js` (10); drive: 4 more `pay:` steps (policy on
  Stripe + receipt; sales by text with the payout asked on the connected account; tightening spares Yaw's ticket; no
  ticket → no guest refund). **Not provable offline:** a real Stripe custom_text render, real balance/payouts on a live
  connected account, a real refund.
- **Buy for friends (2026-11-11, PR event-buy-friends, same flag `REASON_PAID_EVENTS` / early access `paidEvents`, tool
  `event_seats`, table `event_seats` (KEPT_ON_DELETE, `claim_token` a secret column), columns `events.ticket_max`,
  `event_payments.quantity` + `refunded_cents`, `event_claims.tickets` + `seat_id` + `seat_version`)** — a buyer gets up to
  `ticketMax(ev)` tickets (default 4, organizer 1–10; 1 = off; `event_price max_tickets`, the manage page's TICKETS PER
  PERSON select) in ONE Checkout: quantity N on both lines, `application_fee_amount` N × one ticket's; every amount column
  on `event_payments` stays PER TICKET (Stripe's amount_total ÷ N at settle). Join page "HOW MANY TICKETS?" select (v1 + v2,
  only priced + max > 1, options "N — me + K friends ($total)"); text `event_join tickets`; the page claim carries
  `tickets` to the finishing text. Hold = N places (`openHolds` sums quantity); asked again for another N the old page is
  expired. **Seats:** `settlePaid` checks joined + unclaimed + N ≤ cap (else the whole charge back, "didn't have room for
  all your tickets"), then seat 0 claimed by the buyer + seats 1..N-1 open with `claim_token` (24 random bytes,
  base64url, 32 chars); receipt "paid $X for N tickets … the other K are for your friends (links next)", then one line +
  each link as its own message (`sendSeatLinks`). Older payments are backfilled as seat 0. `paidRow(ev, c)` = the seat
  that person holds (theirs or a friend's), per-ticket amounts, `seat_id`, `buyer_conversation_id`. **Capacity:**
  `db.setReservedPlaces` → unclaimed seats count in every `addAttendeeTx` (free joins too) and `spotsLeft`; a claim
  (`onSeat`) skips the cap (its place was already counted). **Claim:** `/e/<id>/seat/<token>` (http.js route; token
  hidden in error logs) — no password, "<buyer> got you a ticket — it's already paid for", public details without the
  price, name/Instagram/who's-going + the organizer's questions (required enforced); preview card line "You've got a
  ticket. Tap to claim it." (never a name). Signed in → `claimSeat` now (BEGIN IMMEDIATE: seat open at the same
  token/version, event active, not organizer / already in / removed) → welcome + list note + buyer "X claimed the ticket
  you got them". Not signed in → claim with `seat_id` + `seat_version` → finishStep "Text Reason to claim it" →
  `redeemEventClaim` spends the claim (password version not checked for seats; already-in/removed refused first) →
  router `claimSeat`; a changed/used/refunded seat → SEAT_CLAIM_LINES. Buyer / organizer / already-in opening a link: a
  message, never spent. **Buyer:** page TICKETS FOR FRIENDS (each link, "Text it to a friend →" sms: link, NEW LINK,
  REFUND THIS TICKET while the policy allows) → POST `/e/<id>/seats` (same-origin); text `event_seats`
  list | new_link | refund | send — refund and send in CONDITIONALLY_GATED + GATED_ACTIONS + NEVER_STANDING, refusals
  before any yes (`seatsRefusal`), targets pinned `[seat N vV]`. new_link = new token + version+1 (old link 404, a claim
  begun on it fails "changed"). **send:** only to a number with an account Reason can reach (`accountForNumber`),
  not the buyer/organizer/already in, once per friend per event; owed → `sweep` (runtime passed) sends the line + link
  as its own message, never at night (`listNoteQuiet`), dropped once moot; the buyer always gets the same words.
  **Refunds per seat:** `refund({ seat })` = a partial refund (`amount` = one ticket's total, or on a guest's own
  cancel — a friend's give-back, the buyer's unclaimed seat, the buyer's own — its price, `refundSplit`; omitted only for
  the whole charge), reverse_transfer + refund_application_fee (proportional = exactly one ticket's share; false on a guest
  cancel, whose 2.5% goes back by `feeBack`); key `evrefund:<pay>:s<seat>:<attempts>` (+`p` on a price-only refund) on multi-ticket payments (one-ticket payments keep `evrefund:<pay>:<attempts>`);
  `refunding_at` marks it so a racing full `charge.refunded` is left to us; `refunded_cents` grows; the payment goes
  `refunded` only when no seat stands. Buyer gives back an unclaimed seat (`seatRefund`, policy of their payment); a
  friend's `event_ticket_refund` / page "Give back my ticket" → money to the buyer's card (friend, buyer and organizer
  each told); organizer `event_refund` guest_id (any holder) or seat_id (unclaimed), page WHO HAS A TICKET per seat
  ("Not claimed yet · bought by X for a friend", "ticket from X"); cancel → `refundAll` refunds what stands on each
  payment (one Stripe refund each; friends told it went to the buyer's card). **Summary counts tickets** (seats):
  sold / standing / refunded / unclaimed; FOR FRIENDS row; `event_guests` `ticket_bought_by` + `unclaimed_tickets`.
  Pinned: `test/event-buy-friends.test.js` (11); drive: 7 more `pay:` steps (quantity Checkout; seats + links; a friend
  claims, a second seat for someone in is refused; an unclaimed seat holds its place; buyer's partial seat refund; the
  friend gives back theirs to the buyer's card; cancel refunds the rest). **Not provable offline:** Stripe's real
  partial refund with reverse_transfer on a live connected account, Messages' rendering of the seat link card, a real
  friend text through Sendblue.

## How to get to it (user POV)

- Open the link the organizer shared → enter the password → (already on Reason, same phone's
  browser) tap Join; (anybody else) name + choices → "Text Reason to finish" → press send.
- Already on Reason, new browser → "Already use Reason? Sign in with your number" → code from your
  texts → your own view of the event. The who's-going link from your welcome, opened somewhere new →
  "Text me a code" → in.

- Organizer texts "i want to throw a halloween party and have people join through you" → Reason
  asks the setup questions → name, password and link come back.
- Guest texts "can you get me into omari's halloween party" → asked for the password → in, and the
  welcome arrives as its own text. Or pastes the link → Reason names the event and asks for the
  password.
- "where is it?" → the released details or "the organizer hasn't shared that yet"; "who's going?" →
  the who's-going link. "mute it" / "i'm out" / "put me on the list with my insta @x".
- "move it to 10:30", "share the address now", "tell everyone to bring snacks", "change the
  password", "kick Yaw", "cancel the party" → the matching organizer tool.
- Rides (organizer: "let people carpool to it"): guest texts "i can drive 2 from fort greene around
  8:15" → saved; a match arrives as its own text; "yes pair us" → set once both say yes.
- In two events, "change the location" → "For your birthday dinner or the rooftop party?" and
  nothing changes until they answer; "cancel Ama's dinner" from a guest of it → "you're a guest there".

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/events.test.js       # passwords, matching, limits, capacity, isolation, claims, deliveries
node --test test/event-tools.test.js  # every tool through runTool: creation, owner text, visibility per flag, organizer actions, isolation
node --test test/event-roles.test.js  # v3 §15.11/12/14: organizer of A + guest of B, "which event?", same-name links, one organizer's two events
node --test test/event-verify.test.js # v3 §15.13: gate, code to the link's owner, expired/reused/wrong, send + attempt limits, non-member, removal, sign out
node --test test/event-rides.test.js  # v3 §15.15: off → nobody asked; day-before ask once; one match at a time; first name + area; both-yes; cancel; counts only; hidden details hold
node --test test/event-join.test.js   # text + pasted-link joins, same-name events, welcome tracked once, info/leave/mute/directory
node --test test/numeric-codes.test.js # #132: six digits, `@<host> #code` last line, one-time-code box, pasted text, past-40/day: own fresh code still opens, bound + one try
node --test test/code-guards.test.js   # #134: every code text ends `@<live host> #code`; every code box is one-time-code
# the real Runtime + Router + outbox + FakeChannel, in process, cage env, throwaway DB (no model):
node --test test/event-ops.test.js    # the status page section, pause/resume/retry, owner-only
node --test test/event-web.test.js    # the pages, the finishing text, existing users by session and by text, who's going
node --test test/event-manage.test.js test/event-scheduled.test.js test/event-some-guests.test.js test/event-edit-limits.test.js test/event-guest-questions.test.js test/event-paid.test.js  # /e/<id> manage page (#386), scheduled + reminders (#388), only some guests (#390), list privacy + cap after creation, guest questions, paid events (fake Stripe)
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/events.db node .agents/skills/verify-reason/bin/events-drive.mjs
REASON_BACKEND=claude-cli node --test test/flow-events.test.js   # by meaning, real model on the subscription: setup questions, text join, pasted link, hidden address
```

Cage: `bin/caged.sh start`, then `bin/peek.sh sql "SELECT name FROM sqlite_master WHERE name LIKE 'event%' OR name LIKE 'ride%'"`
shows the tables made on start (`CREATE TABLE IF NOT EXISTS`, no data rewritten): `events`,
`event_attendees`, `event_messages`, `event_deliveries`, `event_join_attempts`, `event_claims`, the
four `ride_*` tables — and `event_log`, which is the conversation log, not an events table.

Over HTTP on the cage (driven 2026-10-25 at `f3669e8`). The cage's own env does not set the flags,
so start it as `REASON_EVENTS=owner REASON_EVENT_RIDES=owner bin/caged.sh start`, then make an event
in its database in process (`runTool("event_create", {name, description, starts_at:
"2026-10-31T20:00", location, password, show_time_on_join: true, show_location_on_join: false,
guest_list_visible: true}, {conversationId: "dm:owner", messages: […]})` under `caged.sh env` with
the same two flags) and read `public_id` with `bin/peek.sh sql "SELECT public_id FROM events"`:

- `GET /e/<id>` and `/p/e/<id>` → 200, name + description + the "access to Reason" notice + "Sign
  in with your number"; a hidden location is not in the HTML. `/e/<id>/who?t=bogus` → 404.
- `POST /e/<id>/join` with a wrong `password` → "That password isn't right"; with the right one in
  other case and spacing plus `display_name` → the finish step says the texting line isn't
  connected (cage), no `event_claims` row spent.
- `POST /e/<id>/signin` with `number=` a member's number vs a stranger's → byte-identical pages
  except the echoed number; only the member gets a `page_codes` row (`page_id` `esign:<conv>`) and
  `{"event_signin_code_sent":1,"ok":false}` (not connected) in `serve.log`. Before #130 a US number
  typed as ten digits (`3475550000` for `+13475550000`) matched nobody — no code while the page said one was coming.
- The boxes' look: `node bin/event-inputs.mjs [--shot out.png]` renders the sign-in, code (sign-in
  and gate) and join pages in headless Chromium at 320/375/390/430/1280, dark and light, and fails
  any box whose edges aren't its button's, under 48px tall, under 16px text, or a page that scrolls
  sideways. The boxes share one `.ev-form` rule in `src/pages/event.js` (text, password, tel): full
  width, `--card` fill, `--edge` border, `--accent` focus ring, `--dim` placeholder; the shell's
  code-box look (spaced, uppercase, centred) is reset for every box but `name=code`. Before
  2026-10-25 the tel box had no rule — a ~150px, 21px-tall browser default.
- The card: `node bin/event-card.mjs [--shot out.jpg]` serves a throwaway event (time and place
  hidden, one guest) from the real `createServer`, opens the join page in Chromium with JavaScript
  OFF, and checks og:title/description/image, that no tag carries the password, guest, place, time
  or description, and that og:image is a 1200×630 JPEG under 1 MB. The flyer reader with the real
  model: `REASON_LIVE_FLYER=1 ANTHROPIC_API_KEY= node --test test/event-cover-live.test.js` (~15s).
- Roles, which-event and rides have no model-free HTTP surface; `bin/events-drive.mjs` drives them
  through the real Runtime (its `roles:`, `which event:` and rides lines).

## Gotchas

- **Two "Text me a code" sends in the same millisecond** used to lose the second text (keyed
  `esign:<conv>:<ms>`); fixed in #147 — `sendSigninCode` in `src/pages/event.js` now keys it
  `esign:<conv>:<code row id>`. `bin/events-drive.mjs` still waits for the new text itself.
- **Wrong passwords on the cage trip the attempt limit fast** (3 free per `ip:127.0.0.1`, then 30 s
  doubling): the right password then answers "Too many wrong tries…". Wait it out between probes.
- **Sign in by number needs a member's ACCOUNT.** The organizer `dm:owner` has no `accounts` row on a
  fresh cage, so `POST /e/<id>/signin` with the owner number sends nothing — same as a stranger.
  Use a joined guest (`bin/events-drive.mjs` does).

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
