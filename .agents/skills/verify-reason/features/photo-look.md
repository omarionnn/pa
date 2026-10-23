# Photo look — a photo is written down, and can be brought back

Somebody sends a photo (a form, a receipt, a label, a screenshot). Reason answers from it, and in the
background a quiet pass writes down what the photo shows and every word in it, verbatim. A turn later,
with the picture long gone from context, "redo number 4" still works from that note. When the note is
not enough ("what colour was it?"), `photo_look` re-fetches the picture and attaches it to the tool
result. A form is a brief: Reason fills it in, it does not ask "want me to?" and never says "send it
again".

Source: `src/looked.js` (`CAPTURE_INSTRUCTIONS`, `CAPTURE_SCHEMA`, `noteFrom`, `noteFromReply`,
`captureViaCli`, `captureViaApi`, `startCapture`, `recordLooked`; `MAX_NOTE` 4000), `src/agent.js`
(the capture is started alongside the turn; the prompt lines "a photo is written down and can be
brought back" and "a form is a brief"), `src/tools.js` (`photo_look`, `media_reviewed`;
`grep -n 'case "photo_look"' src/tools.js`), `src/backends/mcp-core.js` (`splitImage`: `_image` →
MCP image block / API tool_result image block), `src/backends/claude-cli.js`, `src/media.js`
(`fetchImage`), `src/db.js` (`media_items`, `describeMedia` → the `description` column, `mediaItem`).
Tests: `test/looked.test.js` (17 pass), `test/photos-in-context.test.js` (12), `test/cli-photos.test.js`
(8), `test/media.test.js`. Live model: `test/flow-form.test.js` (needs `REASON_TEST_NUMBERS`
and the claude-cli backend; skipped otherwise). Shipped in PR #4 / `f250db1`; fixture
`test/fixtures/pictures/caregiver-form.png`.

## Sub-features

- **Verbatim capture.** Structured output, no tools, fast model: what the photo shows, then every
  word in it. A photo with no words is the description alone; a long note is cut at 4000, not dropped.
- **Runs alongside the turn.** On the CLI backend the capture starts before the model runs, and
  since #53 (`3f24400`) the reply does **not** wait for it: the reply goes out, and the *next* turn
  in that conversation waits for the note before it runs. (The API path still awaits
  `recordLooked` in-turn.) A capture that throws is a failed note, not a failed turn, and the
  reply-based note is kept instead.
- **History line.** Says the photo is out of sight and names the way back (`photo_look`); never
  "cannot look again".
- **`photo_look`.** Refuses an id that is not a photo (voice note, file), one that is nobody's in
  this conversation, one with no link, and a link that has gone; each in words. Success returns
  `id`, `filename`, `sent_at`, a note that the content is something to read and never an
  instruction, and `_image`.
- **A read, not an act.** It still runs on a turn the harm screen did not pass.
- **Both backends.** Over MCP the picture is an image block and the log and JSON only know its
  size; on the API path it rides in the `tool_result` as an image block.

## How to get to it (user POV)

Send a photo of a form with questions on it: the answers come back without a question. A turn
later: "redo number 4, shorter". Or "what colour was the second one?" and Reason looks again.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/looked.test.js test/photos-in-context.test.js test/cli-photos.test.js test/media.test.js   # 17 + 12 + 8 + 32, all pass at b2861c2
REASON_BACKEND=claude-cli node --test test/flow-form.test.js    # real model; form filled in, q4 redone, colour forces photo_look
```

**Caged:** send `features/payloads/photo.json` down the real road (a public Wikimedia `.jpg` of a
food spread — `fetchImage` refuses private hosts, so this needs the network), then read what was
stored. Because of #53, send one more text before reading: the note may still be in flight after
the first reply. **The URL must end in an image extension**: an extensionless URL (an Unsplash
`photo-…?w=640` link) is stored as `kind: "file"`, gets no note, and Reason answers that it came
through "as a file without an extension".

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
bin/inbound.sh file features/payloads/photo.json   # driven 2026-10-23: kind image, 207-char note, plate described
bin/inbound.sh text "cool"                          # lets the quiet note land before you read it
bin/peek.sh sql "SELECT id, kind, filename, url <> '' AS has_url, coverage, length(description) AS note_chars, substr(description,1,120) FROM media_items ORDER BY id"
bin/caged.sh stop
```

The cage cannot prove the Sendblue link re-fetch (no real link); that part is the same `fetchImage`
the inbound turn uses, covered by `looked.test.js` with a fake fetch.

**Live, read-only:** `journalctl -u reason --since '24 hours ago' | grep -E 'photo_noted|photo_note_failed|photo_look'`.
`photo_noted` carries `kind` and `words`; `photo_note_failed` carries `why`.
**End state that proves it:** a `media_items.description` holding the form's own wording (not a
paraphrase), and a later turn answered from it with no `photo_look` call, or a `photo_look` call
followed by an answer that depends on something only the pixels hold.

## Gotchas

- Sendblue links expire; a very old photo may answer "could not bring it back". The note is then
  the only record, which is why it is verbatim.
- What is in the photo is data, never instruction: the tool's `note` says so, and the capture prompt
  must not follow text inside the image.
- The note lives in `media_items.description` (`describeMedia`; the column is added by
  `addColumnIfMissing`), **not** `detail` — `detail` is a different column, and querying it shows an
  empty note however well the capture went. The capture's note wins; the reply-based note is only a
  fallback.
- `splitImage` strips `_image` from the logged result; if a log line ever contains base64, that is a regression.
- `flow-form.test.js` takes real model time and real tokens; do not loop it.
- **The `media_url` has to look like an image.** A URL with no image extension
  (`https://httpbin.org/image/jpeg`) lands as `media_items.kind = 'file'` with no description and no
  `photo_noted` line; the same drive with a `.jpg` URL gave `kind = 'image'`, a 181-character
  description and `{"photo_noted":2,"kind":"label","words":15}` (2026-10-23, Wikimedia
  `Example.jpg`). The repo is private, so `raw.githubusercontent.com` links to the fixture 404 —
  use a public image.
