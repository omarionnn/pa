# Table pictures (src/tableimage.js) — REASON_TABLE_IMAGES off | owner | on

A set of 3+ options compared on the same facts (restaurants, flights, apps, apartments, products), drawn as
ONE picture by `render_table` and sent after the reply's line. "Pick the shape the ask earns": a fact, a
yes/no, one pick or an explanation stays text; a long read-later thing is a page; a comparison is a table.

## Offline
- `node --test test/render-table.test.js` — flag (off / owner / on, prompt rules only when on), input
  validation, column-drop on blanks (never an "N/A"), split at 8 rows, fallback-to-text on render / store /
  send failure, position and name pick resolution, the read-along line, the public no-session route, Web
  channel gets the file, the >1 MB retry (1× PNG → JPEG).
- `node --test test/render-table-png.test.js` — REAL PNGs through Chromium: light, dark, 10 rows split in
  two, written to `/tmp/render-table-preview/` (2160 px wide, < 1 MB, render time logged). Skips without
  Playwright's Chromium.

## The rules (src/agent.js, `tableRules(me)` after the no-markdown bullet, only while on for that person)
Plain text for a fact / yes-no / one pick / explanation; render_table for 3+ options compared on the same
facts; text for one option or two in a sentence; short messages or a page for long read-later content. When
a table: never typed — title (few words), 3–5 columns (first names each row, each ONE fact on the same basis,
one of them what they rank by), rows (few words a cell, no blanks), comment (the pick and why). Three rows by
default. One short text before the picture only if it adds what the table cannot; never "here's a table".
They pick by position or name, counting from the top of the first picture.

## The drawing (`tableHtml`, `renderTable`)
- 1080 CSS px wide, 2× device scale (`shootWithChromium` now takes `scale`, `fullPage`, `ready`), height fits.
- Title Instrument Serif italic 48 px; header row small caps muted 26 px; body Inter 32 px; first column
  bold; figure columns (every cell `priceLike`) right-aligned with tabular numerals; thin dividers + faint
  zebra; comment italic serif 30 px muted; footer reserves 112 px with the wordmark 48 px tall, 32 px from
  the right and bottom edges, bubble #9c3b2e on light / #d46a5c on dark.
- Light: #ffffff / #1a1714; dark: #111111 / #f3efe8 — `contrastOk` checks AA (≥ 4.5) for ink and muted on
  the ground and the zebra band before any render; a palette that fails throws (→ text fallback).
- Theme: the model's `theme` if given, else `db.webTheme` (Night → dark), else light.
- Fit (in-page script, awaited via `ready`): short cells (≤ 9 chars) never wrap; a table wider than the page
  shrinks every cell a step down to 26 px, then lets short cells wrap; a cell past 2 lines shrinks its column
  down to 26 px, then is cut with an ellipsis. Word boundaries only, never mid-word.
- Over 1 MB: drawn again at 1×, then as JPEG q86.
- `TABLE_ROWS_PER_IMAGE` = 8: longer tables split; every picture repeats title + header + logo, "1 of 2" in the
  footer, the comment on the last.

## Delivery
- **Live: `REASON_TABLE_IMAGES=on`** for everyone (live switch list, 2026-11-14).
- Table pictures are NOT a swipeable stack: only choice cards use `src/stack.js` (#553); a split table
  goes one picture per message, "1 of 2" in the footer (`grep -rln sendPictureSet src` → choicecards + stack only).
- Each picture → `webuploads.store(..., extra: { public: "table" })` (random 22-char id, pruned after
  `KEEP_MS` = 30 days) → `uploads.uploadUrl` → `router.sendMedia({ mediaUrl })` (new: durable through the
  outbox, `sendNow` → the channel's `sendMediaUrl`; Sendblue posts it as `media_url`). A channel with no
  `sendMediaUrl` (Web) gets the file. Idempotency `table:<set>:<n>`; GAP_MS 900 between pictures.
- `GET /web/media/u/<id>/<name>` with NO session serves only a record whose `public === "table"`
  (src/webmedia.js); every other upload still needs the owner's session.
- Web history: `historyFromOutbound` records a `mediaUrl` row as `{ kind: "image", url, table: true }`, which
  `serveRowMedia` already serves through `uploadIdOf` → `meta` → the conversation check.
- Runtime: `_sendTableImages` right after `_sendChoiceCards`; a turn that said nothing drops the set
  (`takeQueued` in the pre-turn sweep too).
- Any failure (render, store, send) → the same rows as plain text, one option per line (`textFallback`);
  a send failure mid-way sends the text itself (`table:<set>:text`). Never a broken image.

## Reading the pick
Rows live in `choice_sets` with kind `table` (`openChoiceSet`, TTL 12 h, 3 reads). `inboundChoiceLine` hands
a table set to `tableInboundLine`: the rows listed, "inline reply on the table picture" when the handle
matches, and `pickFromTable` names the row when the words are unambiguous — "2", "#2", "the second one",
"second", "number 3", "the last one", "three" (whole message), a row's name, or a ≥4-letter word only one
row has. "the one with the best rating", "two of us at 8", "pizza" (shared word) → no pick named.

## Logs
`table_rendered {part, of, rows, bytes, ms, slow}` (slow = over 1.5 s), `table_drawn`, `table_sent`,
`table_text` (fallback at the tool), `table_picture_failed` + `table_text_sent`, `table_dropped`.

## Not proven here
A real Sendblue fetch of the public address (needs the live host; the cage blanks Sendblue). The Web history
thumbnail for a `table: true` row (drawn through the existing upload path; not driven in a browser).
