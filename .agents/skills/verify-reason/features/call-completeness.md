# Call completeness — a call and a text are one memory, and a call leaks nothing

What is said on a phone call (Reason's own voice, ElevenLabs) is written into the same thread and the
same facts as a text. A fact from a call is recallable by text, and a text correction supersedes it.
Filler on a call ("yeah", "(inaudible)") does not cost an extraction. The texted yes that guards a
sensitive thing asked on a call no longer repeats the detail on a phone screen. Every voice turn logs
how long the first word took.

Source: `src/calls/postcall.js` (`writeCallIntoThread`, `worthExtracting`, `FILLER`,
`MIN_EXTRACT_CHARS` 12, `turnsFromTranscriptString`; the `postCallRequest` once-only guard),
`src/calls/verify.js` (the texted-yes check, `verify_sent_at`; the text is
"confirm what was just asked", no action detail), `src/calls/voice.js` (`timing()` →
`first_word_ms` and `turn_ms` on each `voice_turn` log line), `src/calls/provider.js`, `src/tools.js`
(`verify_caller` and the call tools; `grep -n 'case "verify_caller"\|case "call' src/tools.js`),
`src/db.js` (`event_log` with `channel = 'call'`, `extraction_queue`).
Tests: `test/call-cross-channel.test.js` (10 pass), `test/call-verify-text.test.js` (7),
`test/call-voice.test.js` (40; includes the latency fields), `test/call-postcall.test.js` (22),
`test/call-addendum.test.js` (49), `test/call-readback.test.js` (13), `test/elevenlabs.test.js` (18).
Shipped in PR #13 / `908b38d` ("Part 4"). Other call behaviour (opening line, voicemail, language)
is covered by the sibling `call-*.test.js` files but not mapped here.

## Sub-features

- **Cross-channel proof.** Call turns go to `event_log` with `channel = 'call'` and are enqueued
  for extraction; a call fact appears in `remembered()`; `correctFact` supersedes a call-originated
  fact; one user's call fact is invisible to another; facts under 0.5 confidence are skipped.
- **Extraction guard.** `worthExtracting` is false for under 12 characters or filler. Those turns
  still reach `event_log` (the thread record) and are NOT enqueued.
- **Detail-hiding texted-yes.** The text reads `On the phone with you now — reply "yes" to confirm
  what was just asked. Anything else and I won't do it.` It never carries "transfer $500" or any
  action detail; the person on the call already knows. Only a yes arriving after the text counts.
- **Latency logging.** `voice_turn` log lines carry `first_word_ms` (speech to first content) and
  `turn_ms` (total); `first_word_ms` is `null` when no content was streamed.
- **Once-only post-call write.** A second `writeCallIntoThread` for the same call would double the
  rows; the guard is in `postCallRequest`, not in the function.

## How to get to it (user POV)

Ring Reason or ask it to ring somebody. Say a fact on the call ("my landlord is Mr. Osei"); later by
text ask "who's my landlord?". Ask for something sensitive on a call and get a text asking only for a yes.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/call-cross-channel.test.js test/call-verify-text.test.js \
  test/call-voice.test.js test/call-postcall.test.js     # 10 + 7 + 40 + 22
node --test test/call-addendum.test.js test/call-readback.test.js test/elevenlabs.test.js
```

The tests drive the real post-call path with a faked transcript and a scripted extractor, so the
queue behaviour is proven without a phone.

**The cage cannot place or receive a call** (no ElevenLabs key, no number). What it can prove is the
post-call webhook shape and the rows it writes: post a signed-less payload to the caged instance
and expect a refusal, then read nothing written.

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
bin/peek.sh sql "SELECT channel, count(*) FROM event_log GROUP BY channel"      # no 'call' rows yet
bin/peek.sh sql "SELECT state, count(*) FROM extraction_queue GROUP BY state"
bin/caged.sh stop
```

**Live, read-only** (Hetzner is the live path; ElevenLabs' post-call webhook goes there):

```bash
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since '24 hours ago' \
  | grep -E 'voice_turn|call_written_into_thread|call_verify_text' | cut -c1-220 | tail -20"
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select count(*), sum(length(content)<12) from event_log where channel='call'\""
```

**End state that proves it:** after a real call, a `call_written_into_thread` log line, `event_log`
rows with `channel='call'`, fewer `extraction_queue` rows than call turns (filler skipped), and
`voice_turn` lines with numeric `first_word_ms`. For the texted yes: an `outbox` row whose body
contains no dollar amount or action text.

## Gotchas

- `first_word_ms` is measured to first CONTENT, not first byte; the role-only first chunk of an
  OpenAI-style stream does not count.
- The filler regex is anchored: "yeah I think so" is substantive and is queued.
- Never place a live call to prove this. Never forward `voicemail_detection` (see the voicemail work).
- Hetzner timestamps are UTC; compare with ET carefully when matching a call to its rows.
- Never read call transcripts out of the live database into a report.
