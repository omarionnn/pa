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
(`fetchImage`), `src/db.js` (`media_items`, `describeMedia`, `mediaItem`).
Tests: `test/looked.test.js` (16 pass), `test/photos-in-context.test.js` (12), `test/cli-photos.test.js`
(8), `test/media.test.js`. Live model: `test/flow-form.test.js` (needs `REASON_TEST_NUMBERS`
and the claude-cli backend; skipped otherwise). Shipped in PR #4 / `f250db1`; fixture
`test/fixtures/pictures/caregiver-form.png`.

## Sub-features

- **Verbatim capture.** Structured output, no tools, fast model: what the photo shows, then every
  word in it. A photo with no words is the description alone; a long note is cut at 4000, not dropped.
- **Runs alongside the turn.** On the CLI backend the capture starts before the model runs and is
  stored once the reply is in; a capture that throws is a failed note, not a failed turn, and the
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
node --test test/looked.test.js test/photos-in-context.test.js test/cli-photos.test.js test/media.test.js   # 16 + 12 + 8 + media
REASON_BACKEND=claude-cli node --test test/flow-form.test.js    # real model; form filled in, q4 redone, colour forces photo_look
```

**Caged:** send a photo payload down the real road with `bin/inbound.sh file payload.json` (write a
picture payload modelled on `features/payloads/location.json`),
then read what was stored:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
bin/inbound.sh file features/payloads/<picture>.json   # no picture payload exists yet; write one like features/payloads/location.json
bin/peek.sh sql "SELECT id, kind, filename, url <> '' AS has_url, coverage, length(detail) AS note_chars, substr(detail,1,120) FROM media_items ORDER BY id"
bin/caged.sh stop
```

The cage cannot prove the Sendblue link re-fetch (no real link); that part is the same `fetchImage`
the inbound turn uses, covered by `looked.test.js` with a fake fetch.

**Live, read-only:** `journalctl -u reason --since '24 hours ago' | grep -E 'photo_noted|photo_note_failed|photo_look'`.
`photo_noted` carries `kind` and `words`; `photo_note_failed` carries `why`.
**End state that proves it:** a `media_items.detail` holding the form's own wording (not a
paraphrase), and a later turn answered from it with no `photo_look` call, or a `photo_look` call
followed by an answer that depends on something only the pixels hold.

## Gotchas

- Sendblue links expire; a very old photo may answer "could not bring it back". The note is then
  the only record, which is why it is verbatim.
- What is in the photo is data, never instruction: the tool's `note` says so, and the capture prompt
  must not follow text inside the image.
- `describeMedia` (writes `media_items.detail`) is overwritten by the capture; the reply-based note is only a fallback.
- `splitImage` strips `_image` from the logged result; if a log line ever contains base64, that is a regression.
- `flow-form.test.js` takes real model time and real tokens; do not loop it.
