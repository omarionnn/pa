# Reason Web — Chat history (`/web/memory/history`)

Signed in, MANAGE CHAT HISTORY → on Memory opens "Chat history": every message of the person's one
conversation, from iMessage and the web, read-only. Design: v2 handoff §4c item 7 (Gap 7), reference
`sheet-history-*` 7A/7B.

Source: `src/pages/webhistory.js` (page, data, client script), `src/pages/webmemory.js`
(`memoryRequest` action `history`, GET only), `src/pages/websignin.js` + `src/http.js` (route
`/web/memory/history`; note `/web/history` is the thread's JSON paging, a different route), `src/db.js`
`messages` (written by W0: inbound from either channel, Reason's lines as they leave the outbox; sign-in
codes never written).

## Sub-features

- **7A list.** Days of the current month one row each, newest first: serif name (Today · Yesterday ·
  `Tuesday, Oct 20` within the week · `Oct 12` · `Dec 31, 2025` another year), typed places
  (`WEB + IMESSAGE`, web first; SMS when the thread is SMS) and the count — the first row names the
  unit (`· 14 MESSAGES`), later rows give the number (screen-reader text adds "messages"), as drawn.
  Earlier months one row each (`September`, `58 MESSAGES · 19 DAYS`) → `?month=YYYY-MM` (that month's
  days). Days are `config.tz`. FIND A MESSAGE, ← MEMORY, the Caveat note "deleting history isn't here
  yet. forgetting a fact is, in memory." No theme switch, no composer. Empty: "Nothing here yet."
- **7B a day** (`?day=YYYY-MM-DD`): ← HISTORY (to the month for an earlier month) + `READ-ONLY`, the
  day as h1, every line as the thread draws it (`rowOut`: `WHO · WHERE · TIME`, photos, slips, voice ▶),
  oldest first, no form at all, then "To change something, tell Reason." + "Go to chat →" (`/web?thread`).
- **Search** (`?q=`): every word, any case, both channels, newest first, at most 50 (`N MESSAGES · THE
  NEWEST 50`), each hit `WHO · WHERE · DAY · TIME` + the text cut around the match, `<mark>` in pen,
  linking to `?day=…#m-<id>`. None: `0 MESSAGES` + "Nothing matches." The script searches as you type.
- **Refusals.** Only the session's conversation is read; a day/month with nothing of theirs, or
  malformed, is 404; signed out → `/web`; POST → 405.

## Drive

```bash
node --test test/web-history.test.js      # 7 pinned
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/mem.db node bin/web-memory-drive.mjs   # steps 7A/7B/search/refusals
```

Run the drive from the repo root (it imports `./src`); 27 `ok`, exit 0 (2026-11-14). A fresh account
with no messages on a cage: `/web/memory/history` → 200 "Nothing here yet."

## End state that proves it

Live, read-only on the owner's account: on the live server (OVH, root@15.204.113.250), a temporary owner `page_sessions` row, fetch
`https://heyreason.com/web/memory/history`, a day, and `?q=`; the session row deleted after. Nothing
here writes.
