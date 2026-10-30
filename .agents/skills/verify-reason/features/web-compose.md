# Reason Web — the composer's inputs and the message types that aren't words

HANDOFF §3 (Composer, Voice mode, Voice note, Photo you sent, File slip) and references
`composer-*` (01 at rest · 02 with files · 03 dictating · 04 dropping), `listening-*` (board D),
`sheet-messages-*` 4B, `sheet-states-*` 5A/5B, `sheet-global-*` 9C/9E. Behind `REASON_WEB` like the
rest of Web (`on` on live since 2026-10-27, see web-conversation.md).

Source: `src/webuploads.js` (keeping a file: bytes decide the kind — photo the model reads or HEIC,
PDF, doc, or a mic recording; caps 20 MB each (`LIMITS`), a photo over 7 MB fitted (v2, below); `data/web-uploads/<id>.{ext,json}`, 30 days; the
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

## v2 (2026-10-27, wt/v2-compose): sheet-uploads 3A–3E, sheet-voice 4A–4E, L9
- `+` opens a bottom sheet (desk: a card above the line): Photo or video (`image/*,video/*`) · Take a
  photo (`capture=environment`) · A file or PDF (PDF, .docx, .txt/.md/.csv) · NEVER MIND. Escape,
  NEVER MIND and a tap outside close it; focus goes in and comes back to `+`.
- Slips: `READY`, or faded (0.55) `UPLOADING…`; never a bar. A failed one stays, with the Caveat
  button "the <name> didn’t upload. tap to try again." (it re-uploads) and `PHOTOS, PDFS, DOCS · UP TO
  20 MB EACH` (`webuploads.LIMITS_LINE`, built from the same numbers the server holds). Send leaves
  failed files out.
- Server limits = the typed line: photos, PDFs, docs (Word .docx or plain text, `src/docread.js`) up to
  20 MB each. A photo over 7 MB is fitted on the way in (`src/webshrink.js`: ffmpeg on Linux, sips on
  macOS; HEIC via heif-convert first). Video is refused (415) — see SCOPE-v2 Q-v2 on video.
- A doc's text reaches the model like a PDF's (`docsFor` in claude-cli.js and agent.js).
- 3D: the sent file slip is a link, `TAP TO OPEN`. "on it." says what Reason is doing from the turn's
  own record: `src/doing.js` opened by `Runtime` around `runTurn` from the turn's attachments ("reading
  the lease…", "looking at the photo…"), closed when the turn ends; `/web/history` returns `doing`, the
  stream sends `event: doing`.
- 3E: dragging in covers the page (inset 12px), "let go. i’ll read it.", ON DESKTOP, DROP ANYWHERE.
- Voice: hold = Listening (4A); a pause → 4B PAUSED, `SENDING IN 3… 2… 1…` with dots, KEEP TALKING
  (resumes the same recording) / Edit it first / Send now →. Edit → 4C: the words in the (now
  auto-growing textarea) box under `FROM YOUR VOICE · EDIT ANYTHING`, the recording uploaded and sent
  with the edited words (4D `YOU · VOICE · WEB`, Caveat, ▶ + length). No browser words (Firefox): the
  paused recording is uploaded with `X-Reason-Hear: 1` and heard on the server (L9 "writing it down…"
  meanwhile); the send reuses that upload and never listens twice. L9 also shows while the browser
  finishes its last words after Send it →.
- 4E: getUserMedia refused (NotAllowedError) or speech refused with no server listening → "I can’t
  hear you yet." in place of the thread, Try again → (asks again), "or just type it."; focusing the
  box takes it away.
- Verify: `node --test test/web-compose.test.js test/web-uploads-voice.test.js test/web-compose-browser.test.js`.
  Previews: /tmp-free script in the builder's report; PNGs in ~/Desktop/reason-web-design-previews/v2/.
- Live: temporary owner session on Hetzner → POST a throwaway .docx + an 8 MB photo to
  https://heyreason.com/web/upload (doc kind, photo fitted ≤ 7 MB, .jpg), send with words that ask for
  nothing, poll `/web/history` for `doing` ("reading the …") and the reply on `channel=web`, check no
  outbox row to sendblue, then delete the proof rows, uploads and the session.
