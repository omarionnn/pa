# Reason Web — reply to one message (REASON_WEB_REPLY off | owner | on)

Hover a line on Web → a small `↩ REPLY` at the end of its label → the composer says `REPLYING TO
REASON|YOU` + the words (× or Esc cancels) → send. Reason reads it exactly as an iMessage inline reply.
Code: `src/pages/webreply.js` (lookup, quote, button, chip, CSS, page script), `src/dailyflag.js`
(`webReplyMode`, `webReplyAllowedFor`), `src/pages/webconvo.js` (`rowOut` → `m.quote` / `m.canReply`,
`lineInner`, `sendRequest` reads `re`, client `send`/submit/pendingLine hooks), `src/channels/router.js`
(`canPin` for Web), `src/pages/webcompose.js` (`composerHtml` `lead`). Shipped 2026-10-30 (wt/web-reply-to).

## Sub-features

- **Flag.** Live: `on` (everyone). `off`: no button, no chip, no CSS/JS, `re` on a send ignored, Web turns get no `answering`.
  `owner`: only the operator's conversation (`accounts.ownerOf(...).isOperator`). `on`: everyone.
- **Send.** The browser posts `re=<messages.id>` (digits only, else 400 `bad_reply`). The server
  resolves it in the SESSION's conversation (`handleOfRow`: theirs → `inbound_messages.external_id`,
  Reason's → `outbox.message_id`, shared thread only, sent only) and the thread root (`threadRootOf`:
  follows thread_root/reply_to/outbox.reply_to up, ≤6 hops, stops on a loop). Router.deliver gets
  `replyTo` + `threadRoot` → claimInbound keeps both → `replies.inboundReplyLine` puts
  `[they sent this as an inline reply in the thread under your|their message: "…"]` in the turn.
  Unknown / other person's row: the message still goes, ordinary; log `web_reply_unknown`.
- **Quote line.** Any history row whose message answers another draws `<a class="rq">` (who + ≤80 chars,
  muted, hairline rule; `/web?thread&at=<id>#m-<id>`; the script scrolls + `.lit` when the parent is on
  the page). Theirs from Web: `reply_to`. Theirs from iMessage: `thread_root` first (Sendblue's
  `reply_to` can name the newest message, 2026-10-06). Reason's: `outbox.reply_to` (answerTarget,
  latePin, reply_to tool). The stored `[they sent this as an inline reply…]` note is not drawn as words
  on a line that draws its quote. History's day view passes `reply: false` (no button, no quote).
- **Web pins too.** With the flag, a Web turn gets `answering`, so `replies.answerTarget` pins its answer
  under the Web message when the thread moved on (drawn as a quote on Web). The burst line and the
  reply_to tool stay iMessage-only (`inline`).
- **Touch.** `(hover:none)`: a tap on a line toggles `.rp-on` (REPLY shown, icon only); a long press
  (480 ms) replies at once; `-webkit-touch-callout:none` on lines there.
- **iMessage side.** Nothing new is texted. A Web reply and its answer live on Web only (as every Web
  message does); the turn text keeps the reply line, so a later text turn reads it in history. Phone
  thread replies and Reason's pinned texts show their quote on Web.

## How to get to it (user POV)

Signed in (owner while `owner`), `/web?thread`: hover any line → REPLY → type → Enter. Phone: tap a
line → ↩, or press and hold. Tap a quote line to jump to the message it answers.

## Driving it with the harness

```bash
ANTHROPIC_API_KEY= node --test test/web-reply.test.js          # 10 rules, offline
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/reply.db node .agents/skills/verify-reason/bin/web-reply-drive.mjs /tmp/shots
```

The drive: real HTTP (send with `re`, turn text, inbound row, quote, iMessage parent, forged row,
bad `re`), then Chromium light + dark (hover opacity 0 → 1, chip + focus, Esc, Enter sends, quote on
the sent line, quote click scrolls + `.lit`) and a 390px touch context (tap reveals, REPLY opens,
long press replies). End state: 27 `ok`, exit 0. Staging: `conversation-replies`,
`conversation-reply-shown`, `conversation-replying` (`scripts/web-staging.mjs`, `REASON_WEB_REPLY=on`).

## Gotchas

- `.rp` sits inside `.lbl` absolutely positioned with no left/top (its static position = right after
  the time), so the label's `overflow:hidden` does not clip it and it takes no space; `.you .rp` uses
  `right:100%` (left of the line).
- Opacity has a .15 s transition: a check right after a tap reads mid-fade; wait ~300 ms.
- Merging with PR #267 (webnotes tags for `[they sent this as an inline reply…]`): both touch
  `lineInner`; a line with a quote must not ALSO draw #267's "IN REPLY TO" tag.
- Sendblue may drop a pin (`reply_dropped`) and the outbox still holds `reply_to`; Web then shows a
  quote the phone did not pin.
