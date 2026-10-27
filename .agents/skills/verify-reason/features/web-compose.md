# Reason Web — the composer's inputs and the message types that aren't words

HANDOFF §3 (Composer, Voice mode, Voice note, Photo you sent, File slip) and references
`composer-*` (01 at rest · 02 with files · 03 dictating · 04 dropping), `listening-*` (board D),
`sheet-messages-*` 4B, `sheet-states-*` 5A/5B, `sheet-global-*` 9C/9E. Behind `REASON_WEB` like the
rest of Web (`owner` on live).

Source: `src/webuploads.js` (keeping a file: bytes decide the kind — photo the model reads or HEIC,
PDF, or a mic recording; caps 7 MB / 20 MB / 20 MB; `data/web-uploads/<id>.{ext,json}`, 30 days; the
upload link `https://<pages host>/web/media/u/<id>/<name>` and `localUpload(url)`, which src/media.js
`fetchImage`/`fetchPdf` and src/voice.js `hear` use to read it from disk), `src/webmedia.js`
(`POST /web/upload` same-origin + `X-Reason-Csrf`; `GET /web/media/u/<id>` and `/web/media/m/<row>/<n>`
to the owning session only, same 404 otherwise, Range for audio; `prepareSend` — a voice note's
words from the browser, else heard by `voice.hear` (Gemini), marked so `hearInto` never hears it
twice), `src/pages/webcompose.js` (composer markup, Listening overlay, 4B media markup, CSS, the
page script: +, drop anywhere, slips, image shrink over 7 MB, the mic — tap = dictate on the line,
hold = Listening; live words from the browser's SpeechRecognition, pausing sends, Space keeps it
open), hooks in `src/pages/webconvo.js` (`sendRequest` takes `files` + `voice`; `rowOut` → `mediaOut`;
`R.api` post/pendingLine/state), `src/http.js` (the `/web/upload|/web/media/` block before `webRoute`),
CSP `img-src … blob:; media-src 'self' blob:` (websignin.js), `src/backends/claude-cli.js` (now reads
PDFs, like the API path).

## How a person reaches it
Signed in at heyreason.com/web: `+` ("Add a photo or file") or drag anything onto the page; the mic
("Speak instead") appears only where the browser records AND (has speech recognition OR the server
can listen — `window.REASON_WEB.hear`). Firefox on live: no live words, recording heard on the server.

## Verify
- `node --test test/web-compose.test.js` (unit + real HTTP through src/http.js) and
  `node --test test/web-compose-browser.test.js` (Chromium, fake mic, stand-in SpeechRecognition:
  02, 04, errors, 03, D incl. pause-sends and NEVER MIND, 5A SENT · time / didn't go once, 9C, mic hidden, 320px).
- Live (Hetzner, temporary owner session): POST a tiny PNG to `https://heyreason.com/web/upload`
  with the cookie + csrf, POST `/web/send` with `files=<id>`, then `/web/history?after=<n>` shows the
  line with `<img src="/web/media/u/…">`, the image GETs 200 with the cookie and 404 without, and
  Reason's reply row is `channel=web` with no outbox row to sendblue.
