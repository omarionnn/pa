# Reason Web: notes as tags, files as chips

Shipped #267 (2026-10-30). Stored message text and the model's turn text are unchanged; only the page draws them.

- `src/pages/webnotes.js`: `readLine` splits a stored line into what they typed + pipeline notes (`[they shared their location: …]`, inline reply, contact card, voice, file, burst, effect). `notesHtml` draws tags: SHARED LOCATION · <how long> + short address (`shortPlace`), IN REPLY TO “…”, contact name. Used by webconvo `lineInner`, webhistory `searchMessages`, daily `pickupFor`.
- `src/sentfiles.js` `sentFile(conversationId, rowId)`: history row (assistant, same conversation, not deleted) → its outbox row (same conversation) → `media.file`, realpath strictly inside documentRoot / imagenOutputDir / imageTmpRoot / shotRoot, regular file. Anything else: null → 404.
- `src/webmedia.js` `/web/media/m/<row>/<i>`: signed-in only (signed out = same 404), nosniff, sandbox CSP except PDF, Content-Disposition inline only for pdf, png/jpeg/gif/webp/heic, audio, video, text/plain; filename ASCII-sanitised + RFC 5987 `filename*`.
- Voice notes and call recordings: now an audio chip that plays, see [web-audio.md](web-audio.md).

Drive: `bin/web-notes-drive.mjs` (see SKILL.md feature map). Live proof: owner's location row → tag; row 811 docx → 200 docx for him, 404 signed out.
