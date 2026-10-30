# Reason Web — the conversation (phase W2)

Signed in, `https://heyreason.com/web` is the person's ONE conversation with Reason (it replaced
W1's "You're in, <name>." landing): their lines and Reason's from the W0 per-message history
(`messages`), each labelled who · where · when (`You · iMessage · 6:42 PM`, `Reason · Web · …`),
newest at the bottom, older pages on scroll, a composer that posts into the SAME conversation through
the web channel, and live updates. **Behind `REASON_WEB`** like W1 (`on` on live since 2026-10-27
05:04 UTC: everyone with a Reason).

Source: `src/pages/webconvo.js` (the page, `/web/history`, `/web/send`, `/web/stream`, the copy, the
client script), `src/pages/websignin.js` (`webRequest` dispatches `history|stream|send`, signed in
only; `SECURITY_HEADERS` now has `connect-src 'self'`), `src/http.js` (`webRoute` regex + the stream
branch: `out.stream(res, req)`), `src/db.js` (`historyBus` `row` events from `writeMessage`,
`messagesBefore`, `markWebNoticeSeen` + `accounts.web_notice_seen_at`, `threads.web_hint_due`,
`takeWebHint`, `WEB_SWITCH_WINDOW_MS` = 12 h), `src/deliver.js` (`WEB_HINT`, decision 9),
`src/channels/web.js` (`typing()` emits a `typing` event). Plan: `docs/plans/reason-web-phase1.md`
§4.3–4.4, §6 W2, §10 "W2 as built".

## Sub-features

- **The look** (design handoff 2026-10-26; kit `src/pages/webkit.js`, screens in `webconvo.js`): no
  bubbles — your words serif italic right, Reason's Inter left, a typed label over each line
  (`YOU · WEB · 2:52 PM`, `REASON · IMESSAGE · …`, `YOU · VOICE · IMESSAGE · …`). Reason's lines are
  drawn SERVER-side from escaped text (`reasonBody`): paragraphs; consecutive `1.` / `-` / `•` lines
  → typed 01 02 03 in pen between dashed rules (a trailing `$540` gets its own column; an item keeps
  its own number so a reply split across texts still counts on); links to the pages/events hosts →
  paper cards (`linkCard`: domain, serif title, Open →; an event this conversation organises or
  attends with a date → the date-block card). Titles only from rows THIS conversation owns
  (`getPageIn`, organiser/attendee), else "A page Reason made" / "An event" / "An invite to Reason".
  Media already in history: photo = tilted frame (no image fetched), voice = Caveat transcript,
  file = typed slip; a media URL never leaves the server. `rowOut().html` carries the same markup to
  the script for live lines.
- **The screens**: `/web` = the arrival (B/B2: "What's good, <first>?", the composer, ALREADY IN HAND
  slips only from real open tasks + pending timers (`inHand`) else YOU COULD START WITH — three
  examples that fill the composer — then the unboxed "pick up from iMessage" block with the last
  two non-Web texts) unless they sent on Web in the last 30 min (`THREAD_RECENT_MS`; `/web?home` skips
  that rule — sign-in and the logo land there, #203/#206); `/web?thread` = the thread;
  `/web?tab=ongoing` = the phone's Ongoing tab (rows or "Nothing left to chase.");
  `/web/settings` = Settings ([web-settings.md](web-settings.md)); `/web/memory` = Memory ([web-memory.md](web-memory.md)); `/web/saved` = Saved ([web-saved.md](web-saved.md)). Desktop: SAVED / MEMORY /
  SETTINGS typed links, the Ongoing margin (empty state or IN HAND rows). Phone: ⋯ menu, Chat /
  Ongoing tab bar (hides while typing). A pending, unanswered confirmation (last 24 h) shows the
  approval card (no approve button; Caveat "just tell me in the chat when you want it.").
- **Ongoing tidy** (owner 2026-10-26, `test/web-ongoing2.test.js`): the margin and the phone's Ongoing
  tab show each group's top 3 (`OG_TOP`; IN HAND soonest `due` first; NEEDS YOU never cut) with a count
  on every heading, then a serif "See all N →" (`.og-more`) to `/web/ongoing/hand|back` (handoff v2;
  see features/web-ongoing.md "At volume"). The in-place fold (`.og-x`, `?all=1`) is gone. Desktop margin heading has "HIDE →": the panel slides away,
  the thread takes the width, and a thin vertical typed "ONGOING · N" at the right edge (`.og-back`, fixed, desktop only; handoff §3 sheet 3) brings it back; kept per device in
  localStorage `reason-web-og` (applied in HEAD_JS before paint). Phones keep the Chat/Ongoing tabs.
  The top bar (wordmark, MEMORY, SETTINGS) is `position:sticky`, dashed rule once scrolled
  (`.top.stuck`); "↑ SHOW EARLIER MESSAGES" stays at the top of the thread. Row titles = `label` on
  tasks/timers/series (src/itemtitle.js): the model's `title` (timer_set) / `short_title` (task_start),
  else ONE background summarise on the claude-cli subscription (`feature: "title"`; no API path —
  without `REASON_BACKEND=claude-cli` nothing is asked), never the person's name (`normTitle` drops
  it); a series' title goes onto each firing. Until a row has one: `cleanTitle` strips Reason's note
  prefixes. Old rows: `scripts/backfill-item-titles.js` (dry run by default, `--write`; copy first).
  Drive: render with the preview script and follow `.og-more`, click `.og-hide`, `.og-back`; scroll → `.stuck`.
- **States** (page script): SENDING… at 60%, SENT that fades, WAITING TO SEND offline + the Caveat
  line "you're offline. i'll send it when you're back.", "lost the line for a sec. nothing's lost."
  after two missed polls, "didn't go. tap to try again." (a button, same id), "on it." (role=status)
  instead of dots, 9D "Still working on it. Sign back in to see." on a 401 mid-task, 9B error page
  when a Web request throws (src/http.js), the reas◯n+ing loader once per tab (never under reduced
  motion).
- **The greeting** (owner copy 2026-10-26): serif italic h1 "What's good, <first name>?" (first word
  of `accounts.name`), "What's good?" with no name — `greeting()` in `websignin.js`.
- **The page** (`conversationPage` → `renderConversation({ deferred: true })`; since v2 the page opens with L1 and the script fetches the newest page from `/web/history` as drawn HTML — see [web-thread.md](web-thread.md); no-script gets it in `<noscript>`): newest `PAGE` = 40 lines server-drawn
  (escaped, links only for http(s), `white-space: pre-wrap`), day separators (Today / Yesterday /
  Mon, Oct 24), a hand-lettered "Continued on Web" / "Continued in iMessage" divider where the
  person's place changes, "Show earlier messages" (a button; L2 while it loads) or, at the very
  start, "Your conversation before <day> stays in your texts." (no backfill). Source label:
  `web` → Web, `console` → Console, else SMS when the thread's `service` is SMS, otherwise iMessage.
- **The first-visit note, once (5C)** — on the first signed-in GET `markWebNoticeSeen` flips
  `accounts.web_notice_seen_at` and the whole page is "One Reason. Pick up anywhere." + "This is the
  same Reason you text. What you send here stays here; it won't show up in your iMessage thread." +
  Caveat + "Got it →" (/web). Never again, in any browser of that person; a HEAD never spends it.
- **Send** (`POST /web/send`, form `id`, `text`, `c`; header `X-Reason-Csrf`): `sameOrigin` + the
  session's `page_sessions.csrf`; id `/^[A-Za-z0-9-]{8,64}$/`; 1..4000 chars; 20 per minute per
  conversation (429). Calls `router.deliver({ channel: "web", externalId: id, conversationId: <the
  session's>, text })` and answers once it resolves or after `ACK_WAIT_MS` = 1.5 s, whichever is first
  (refused → 403 with the reason; duplicate → `{ ok, duplicate: true }`). The turn is never tied to
  the request. JSON for the script; a plain form post (no script) is a 303 back to `/web`, with a
  server-minted id in the form so a resubmit is still one turn.
- **One message, one turn** — the router claims `<conversation>:<id>`; the page's script keeps unsent
  messages in `sessionStorage` and, after a reload, re-posts them under the SAME id; retries (network
  error, 5xx) reuse the id. A second tab sends its own ids and sees the first tab's lines via the stream.
- **Live** (`GET /web/stream`, `text/event-stream`): `retry: 1500`, then `id:`/`event: message` per new
  history row of THIS conversation (from `historyBus`), `event: typing` `{on, until}` for this
  person's address only (`WebChannel.typing`, called by the router's "…" bubble for a Web turn),
  `event: signedout` when the session ends (checked every 10 s and before every push). Resumes after
  `Last-Event-ID` / `?after=`. Each response ends after `STREAM_MS` = 20 s (browser reconnects).
  Stream-first (owner 10-26: replies feel instant): the server sends a named `event: ping` every
  15 s; the script polls `/web/history?after=<last>` every 4 s only while the stream is not open or
  has been silent > 40 s (a dead stream with no error), never alongside a live one, and on tab focus.
- **Instant replies** (`GET /web/live`): the same stream, opened by the page on the PAGES host
  (`webStreamOrigin()`: the pages origin when it is https and under the website's domain; config
  `REASON_WEB_STREAM` = off | an https origin; default on). `/web/live` is the one /web path the pages
  host does not 301 to the website. Origin must be exactly `REASON_SITE_URL`'s (→ CORS with
  credentials for that origin, `Vary: Origin`) or absent (same host); anything else 403. Cycles every
  5 min. CSP `connect-src` names that one origin. The shared `Domain=heyreason.com` cookie rides along.
- **History API** (`GET /web/history?before=<id>` → `{messages, more, start}`; `?after=<id>` → new
  rows): the session's conversation only; an id from another conversation finds nothing.
- **Decision 9** — a TEXT inbound whose thread `last_channel` was `web` within 12 h sets
  `threads.web_hint_due`; the next text to them (`deliver`, not web/console, `toOwner`, not a
  `pcode:`/`esign:`/`wsign:` key, `webAllowedFor`) takes it atomically and ends with
  `\n\nOur full conversation, the Web part included, is on Reason Web.` Once per PERSON, ever
  (owner 10-27): taking it sets `threads.web_hint_told_at`, and a told thread is never made due again.
  The column's migration marks anyone whose outbox already carries the line as told. Pinned by
  test/web-hint-once.test.js; the drive's step 7 checks a second switch stays silent.

### One shared thread (owner 10-27 07:08; Web-only chats from #209 retired)

- **Nothing starts a Web-only chat.** No NEW WEB CHAT →, no menu "New Web chat"; `/web?newchat` → 303
  `/web?thread`. Home's composer (old Home, `renderHome`) and every other composer carry no `chat`
  field; `POST /web/send` ignores a stale `chat` and the message lands in the shared thread
  (`chat_id` NULL), claiming no chat. `GET /web/chats/recent` is removed.
- **Earlier chats stay, read-only.** `web_chats` + `messages.chat_id` are kept. `/web?chat=<id>` (own,
  existing chat only; `chatFrom` → 404 for another account's, an unknown or a malformed id) draws all
  its lines server-side with `CLOSED_CHAT` in the composer's place ("Continue the thread →").
  `/web/history` and `/web/live` with `?chat=` still read only that chat (cross-account → 404).
  Chat history lists each as `WEB CHAT · <DAY> · N MESSAGES` with its title (`src/webchats.js`).
- **Approvals asked in an old chat** (`confirmations.thread_key` = `<conv>#web:<id>`) move to the shared
  thread the first time the shared thread looks (`db.adoptWebChatAsks` via `trust.adoptWebChatAsks` in the
  claude-cli context build, `confirm_pending`, `recordConfirmation`): thread_key NULL, count reset, so
  only a reply after that grants it. Ongoing/daily links go to `/web?thread&about=approval:<id>`.
  A turn still keyed to a Web chat keeps the old scoping (never answers an access or call check).
- **Speak-first** (#211/#213) always speaks in the shared thread; `/web/about` ignores `chat`.
- Tests: `node --test test/web-chats.test.js` (+ titles). Preview: `bin/web-chats-preview.mjs`
  (Home, the thread, an earlier chat read-only, Chat history).

## Proving it

```bash
cd ~/Desktop/pa
node --test test/web-design.test.js  # 34: the design states, cards/lists/media, /web/live CORS over real HTTP
node --test test/web-convo.test.js   # 19: isolation (page/history/stream), forged ids, Web-only reply, same id = one turn (2 tabs), tab close, boundary once, decision 9 (x2), refusals, rate limit, safe rendering, stream (resume/typing/sign-out), paging, the page's form
node --test test/web-w0.test.js test/web-signin.test.js test/domains.test.js   # W0/W1 still hold (W0's two text→web→text expectations now carry WEB_HINT)
# over REAL HTTP on loopback, cage env, throwaway DB, real Router/Runtime/outbox/WebChannel + FakeChannel, scripted model:
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-convo-drive.mjs   # 18 steps
node .agents/skills/verify-reason/bin/web-preview.mjs   # every screen, 390/1280 × Paper/Night, + compare-*.png vs the handoff (see web-signin.md)
```

## Gotchas

- **The CSP needed `connect-src 'self'`.** Without it `default-src 'none'` blocks EventSource and
  fetch; the preview script prints any CSP violation, which is how it was found.
- **Netlify buffers SSE (proven 10-26):** through heyreason.com/web/stream the first byte arrived
  after ~16 s, all at once. Hence `/web/live` on files.heyreason.com. Caddy 2.6.2 with the live
  files. `@web` block flushes each event as written (probed on Hetzner 10-26 with a throwaway Caddy +
  SSE emitter on loopback ports, same binary, identical block: events 1 s apart arrived 1 s apart, CORS
  headers intact). After deploy, prove end to end in a real browser on heyreason.com/web: DevTools
  shows the EventSource to files.heyreason.com/web/live open, and a reply lands without the 4 s poll.
  If it ever misbehaves: `REASON_WEB_STREAM=off` → back to /web/stream + poll, no code change.
- **The page CSS contains `.thread`**: split bodies on `<ol class="thread"`, not on the class name.
- **Reason's replies arrive as several lines** (deliver.js splits a reply into texts), so a list
  may span lines; each item keeps its own number.
- **The router's contact-card offer** still texts the phone the first time an account without
  `contact_card_sent_at` sends anything, Web included (W0 behaviour; every live account has the card).
  Tests set it so the phone stays quiet.
- **Typing is per address**, not per conversation: twin accounts on one number (decision 4) share it.
- Deferred to W3+ at W2 (since shipped: Ongoing details — web-ongoing.md, attachments + mic — web-compose.md,
  the nudge, notification preferences — web-notify.md): Ongoing detail views (2A–2E), attachments + dictation (owner 10-26: no
  + and no mic until they work; the input runs edge to edge), the "needs a yes →" nudge, notification
  preferences, browsers list + per-row revoke, token hashing/rotation, a CSP nonce instead of
  `'unsafe-inline'`, attachments from Web (the composer is text only).
