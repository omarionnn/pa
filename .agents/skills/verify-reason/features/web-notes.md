# Reason Web: notes as tags, files as chips

Shipped #267 (2026-10-30). Stored message text and the model's turn text are unchanged; only the page draws them.

- `src/pages/webnotes.js`: `readLine` splits a stored line into what they typed + pipeline notes (`[they shared their location: …]`, inline reply, contact card, voice, file, burst, effect). `notesHtml` draws tags: SHARED LOCATION · <how long> + short address (`shortPlace`), IN REPLY TO “…”, contact name. `readLine`/`notesHtml` are used by webconvo `lineInner` (src/pages/webconvo.js:221-227) and webcompose `ownWords` (src/pages/webcompose.js:86); webhistory `searchMessages` and daily `pickupFor` read only `displayText` (src/pages/webhistory.js:23, src/daily.js:39).
- `src/sentfiles.js` `sentFile(conversationId, rowId)`: history row (assistant, same conversation, not deleted) → its outbox row (same conversation) → `media.file`, realpath strictly inside documentRoot / imagenOutputDir / imageTmpRoot / shotRoot (src/sentfiles.js:20), or, for an audio file only, recordingRoot / audioTmpRoot (:21, :56; a call recording also needs its `calls` row in this conversation with `recording_state = 'stored'`), regular file. Anything else: null → 404.
- `src/webmedia.js` `/web/media/m/<row>/<i>`: signed-in only (signed out = same 404), nosniff, sandbox CSP except PDF, Content-Disposition inline only for pdf, png/jpeg/gif/webp/heic, audio, video, text/plain; filename ASCII-sanitised + RFC 5987 `filename*`.
- Voice notes and call recordings: now an audio chip that plays, see [web-audio.md](web-audio.md).

Tests: `test/web-notes.test.js` (8). Drive (refuses without BOTH a temp `REASON_DATA_DIR` and a new `REASON_DB_PATH` inside it):
`eval "$(bin/caged.sh env | sed 's/^/export /')" && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/web.db node bin/web-notes-drive.mjs` → 12 `ok`, exit 0 (2026-11-07). Live proof: owner's location row → tag; row 811 docx → 200 docx for him, 404 signed out.
