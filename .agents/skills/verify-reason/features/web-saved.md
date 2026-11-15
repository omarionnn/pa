# Reason Web — Saved (`/web/saved`)

Signed in, `https://heyreason.com/web/saved` is everything Reason made for the person, kept, with
nothing to manage: the third phone tab (Chat · Ongoing · Saved) and the desktop's SAVED top link.
Design: v2 handoff (2026-10-26) §4 "Saved", reference `sheet-saved-*` (S-A list, S-B empty) and
`desk-saved-*`.

Source: `src/saved.js` (the index, `saved_marks`, search, pin/remove/restore, `messageFor`),
`src/pages/websaved.js` (page, opened item, framed page, POST routes), `src/pages/websignin.js`
(dispatch, signed in only), `src/http.js` (route), `src/pages/webconvo.js` (`tabBar` with Saved,
SAVED in the top bar, `?thread&at=<id>` opens the thread at one message), `src/db.js`
(`calls.label`, `setItemLabel("call")`), `src/itemtitle.js` (a call's title, claude-cli only).

## Sub-features

- **The index (read, never copied).** `pages` of the conversation (meta `PAGE`, `· YOU PICKED X` from
  `page_choices`); `calls` with `is_owner = 0`, state completed/voicemail and a summary (`CALL · m:ss ·
  day`, BOOKED when `outcome_kind = confirmed`; title = `calls.label`, else the goal cleaned, and one
  title queued); `agentcard_purchases` placed / partially_placed (PAID) / cancelled (CANCELED, muted) —
  a cart or a passkey pause is not a receipt; `events` they organised (`EVENT · SHARED WITH N` joined
  guests); their `event_albums` (`ALBUM · N PHOTOS`). Owner calls to Reason are conversations, not
  things made: left out.
- **Groups.** Pinned first (phone: the paper card with the date block; desktop: serif rows). Then THIS
  WEEK (last 7 days, weekday on the right), EARLIER IN <this month>, IN <month> (year when not this
  one). Folded on ALL with no search: THIS WEEK 5, every older heading 1, then "+ N more" (desktop
  "+ N earlier in October"), `?all=1` opens them.
- **Kinds + find.** ALL · PAGES · CALLS · RECEIPTS · EVENTS (events + albums); the current word
  underlined with its count. FIND SOMETHING is a GET form; every word must appear in the title, the
  meta line or what the thing says (page blocks, call goal/summary, merchant, event).
- **Opened item** (`/web/saved/<kind>/<id>`; desktop opens the pinned/newest by itself, hidden on a
  phone): typed `KIND · MADE <day> <time>`, PIN/UNPIN (aria-pressed), OPEN THE PAGE ↗ (page:
  files. link; event: events. link; album: manage link; none for call/receipt), FIND IT IN THE CHAT →
  only when a history message carries it (page id / event id in the text; call/receipt: Reason's first
  line within 30 min of it ending). A page is the real page (`renderPage`, printing mode) in a
  same-origin iframe at `/web/saved/page/<id>/frame` (CSP frame-ancestors 'self', XFO SAMEORIGIN);
  the list page's CSP adds `frame-src 'self'`. Calls/receipts/events/albums draw their row's facts.
- **Marks.** `saved_marks(conversation_id, kind, item_id, pinned_at, removed_at)`. Remove hides it
  from Saved only (and unpins); `?removed=<key>` shows the Caveat line + PUT IT BACK (restore). POSTs:
  `sameOrigin` + session csrf; keys looked up in the session's conversation (another's → 404).

## Drive

```bash
node --test test/web-saved.test.js                       # 14 pinned
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/saved.db node bin/web-saved-drive.mjs   # 21 steps over real HTTP, all ok
```

## End state that proves it

Live, from the live server (OVH, root@15.204.113.250): a temporary owner `page_sessions` row; `https://heyreason.com/web/saved` shows the
owner's real pages/events with the right counts; one item pinned and unpinned through the form posts
(the `saved_marks` row deleted after, so nothing of the owner's changes); the session row deleted.
