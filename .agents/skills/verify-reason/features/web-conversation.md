# Reason Web — the conversation (phase W2)

Signed in, `https://heyreason.com/web` is the person's ONE conversation with Reason (it replaced
W1's "You're in, <name>." landing): their lines and Reason's from the W0 per-message history
(`messages`), each labelled who · where · when (`You · iMessage · 6:42 PM`, `Reason · Web · …`),
newest at the bottom, older pages on scroll, a composer that posts into the SAME conversation through
the web channel, and live updates. **Behind `REASON_WEB`** like W1 (`owner` on live: only the owner).
Not deployed with this PR; the owner approves the look first.

Source: `src/pages/webconvo.js` (the page, `/web/history`, `/web/send`, `/web/stream`, the copy, the
client script), `src/pages/websignin.js` (`webRequest` dispatches `history|stream|send`, signed in
only; `SECURITY_HEADERS` now has `connect-src 'self'`), `src/http.js` (`webRoute` regex + the stream
branch: `out.stream(res, req)`), `src/db.js` (`historyBus` `row` events from `writeMessage`,
`messagesBefore`, `markWebNoticeSeen` + `accounts.web_notice_seen_at`, `threads.web_hint_due`,
`takeWebHint`, `WEB_SWITCH_WINDOW_MS` = 12 h), `src/deliver.js` (`WEB_HINT`, decision 9),
`src/channels/web.js` (`typing()` emits a `typing` event). Plan: `docs/plans/reason-web-phase1.md`
§4.3–4.4, §6 W2, §10 "W2 as built".

## Sub-features

- **The page** (`conversationPage` → `renderConversation`): newest `PAGE` = 40 lines server-drawn
  (escaped, links only for http(s), `white-space: pre-wrap`), day separators (Today / Yesterday /
  Mon, Oct 24), a hand-lettered "Continued on Web" / "Continued in iMessage" divider where the
  person's place changes, "Show earlier messages" (button + IntersectionObserver) or, at the very
  start, "Your conversation before <day> stays in your texts." (no backfill). Source label:
  `web` → Web, `console` → Console, else SMS when the thread's `service` is SMS, otherwise iMessage.
- **The boundary note, once** — on the first signed-in visit `markWebNoticeSeen` flips
  `accounts.web_notice_seen_at` and the page carries the §9 wording + the supporting line in a dashed
  card with "Got it". Never again, in any browser of that person.
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
  Fallback: the script polls `/web/history?after=<last>` every 4 s while a reply is awaited or the
  stream is down, and on tab focus.
- **History API** (`GET /web/history?before=<id>` → `{messages, more, start}`; `?after=<id>` → new
  rows): the session's conversation only; an id from another conversation finds nothing.
- **Decision 9** — a TEXT inbound whose thread `last_channel` was `web` within 12 h sets
  `threads.web_hint_due`; the next text to them (`deliver`, not web/console, `toOwner`, not a
  `pcode:`/`esign:`/`wsign:` key, `webAllowedFor`) takes it atomically and ends with
  `\n\nOur full conversation, the Web part included, is on Reason Web.` Once per switch.

## Proving it

```bash
cd ~/Desktop/pa
node --test test/web-convo.test.js   # 14: isolation (page/history/stream), forged ids, Web-only reply, same id = one turn (2 tabs), tab close, boundary once, decision 9 (x2), refusals, rate limit, safe rendering, stream (resume/typing/sign-out), paging, the page's form
node --test test/web-w0.test.js test/web-signin.test.js test/domains.test.js   # W0/W1 still hold (W0's two text→web→text expectations now carry WEB_HINT)
# over REAL HTTP on loopback, cage env, throwaway DB, real Router/Runtime/outbox/WebChannel + FakeChannel, scripted model:
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-convo-drive.mjs   # 16 steps
node .agents/skills/verify-reason/bin/web-convo-preview.mjs [outDir] [prefix]   # <prefix>mobile.png (390) + desktop.png (1280), fictional lines, real CSP + fonts + script
```

## Gotchas

- **The CSP needed `connect-src 'self'`.** Without it `default-src 'none'` blocks EventSource and
  fetch; the preview script prints any CSP violation, which is how it was found.
- **Netlify and SSE: unproven live.** The site's `/web/*` is a signed proxy rewrite. If Netlify
  buffers or cuts a streaming response, the stream degrades to the 20 s cycle and the 4 s poll while a
  reply is awaited carries the answer. Prove on deploy with a real browser through heyreason.com.
- **The page's CSS contains `.c-list`**: split bodies on `<ol class="c-list"`, not on the class name.
- **The router's contact-card offer** still texts the phone the first time an account without
  `contact_card_sent_at` sends anything, Web included (W0 behaviour; every live account has the card).
  Tests set it so the phone stays quiet.
- **Typing is per address**, not per conversation: twin accounts on one number (decision 4) share it.
- Deferred to W3+: the Ongoing panel (`.c-app` is a one-column grid ready for a second), notification
  preferences, browsers list + per-row revoke, token hashing/rotation, a CSP nonce instead of
  `'unsafe-inline'`, attachments from Web (the composer is text only).
