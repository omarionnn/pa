# Call completeness — a call and a text are one memory, and a call leaks nothing

What is said on a phone call (Reason's own voice, ElevenLabs) is written into the same thread and the
same facts as a text. A fact from a call is recallable by text, and a text correction supersedes it.
Filler on a call ("yeah", "(inaudible)") does not cost an extraction. The texted yes that guards a
sensitive thing asked on a call no longer repeats the detail on a phone screen. Every voice turn logs
how long the first word took. What Reason looked up on a call stays known for the rest of the call
and in the texts after it, and the call model starts talking without a thinking pass first.

Source: `src/calls/postcall.js` (`writeCallIntoThread`, `worthExtracting`, `FILLER`,
`MIN_EXTRACT_CHARS` 12, `turnsFromTranscriptString`; the `postCallRequest` once-only guard),
`src/calls/verify.js` (the `verify_caller` tool definition and the texted-yes check,
`verify_sent_at`; the text is "confirm what was just asked", no action detail), `src/calls/voice.js`
(`voiceTurn`; `timing()` → `first_word_ms` and `turn_ms` on each `voice_turn` log line;
`case "verify_caller"` in `runCallTool`; `lookupEntry`, `withCallRecord`; `apiRequestFor`, which
builds both the ring-time cache warm-up and every turn), `src/calls/voice-prompt.js`
(`ownerCallFrame`), `src/calls/provider.js`, `src/config.js` (`callThinking`), `src/db.js`
(`event_log` with `channel = 'call'`, `extraction_queue`, `calls.lookups`, `addCallLookup`,
`callLookups`).
Tests: `test/call-cross-channel.test.js` (10 pass), `test/call-verify-text.test.js` (7),
`test/call-voice.test.js` (52; includes the latency fields, the thinking setting, the lookups
record, and the #65/#68 rules below), `test/call-postcall.test.js` (22), `test/call-addendum.test.js` (50),
`test/call-readback.test.js` (13), `test/elevenlabs.test.js` (19) — counts at `226ff17`.
Shipped in PR #13 / `908b38d` ("Part 4"); PR #59 (`4e9f09f`) and PR #60 (`b2861c2`), 2026-10-23.
Other call behaviour (opening line, voicemail) is covered by the sibling `call-*.test.js`
files but not mapped here.

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
  `turn_ms` (total); `first_word_ms` is `null` when no content was streamed. `http.js` also logs
  `call_llm_first_content_ms` per request.
- **No thinking pass before the first word (PR #59).** `claude-sonnet-5-5` thinks before every reply
  by default — ~3.5s of silence on the line (call 38: 4–6s per turn). `apiRequestFor` sends
  `thinking: { type: config.callThinking }`, default `between_tools` (`REASON_CALL_THINKING`; empty
  sends no field). `{type: "disabled"}` is a 400 on this model.
- **Lookups remembered across turns (PR #60).** ElevenLabs sends each turn back as spoken words
  only, so a search and its result were gone by the next turn — on call 41 Reason read out a real
  Kitco gold price and one turn later said it had never looked. Every Reason tool run on a call is
  recorded in `calls.lookups` (newest 20: time, name, input head, result head), and
  `withCallRecord` puts that record in front of the newest thing they said on every later turn,
  marked as code's record and "not something to mention". `writeCallIntoThread` adds one line
  listing the lookups after the transcript, so the texts after the call see them too. The call
  prompt says live facts (prices, news, weather, scores) are always looked up before they are said.
- **`NO_REPLY` is never spoken (#68).** The text path's silence marker is dropped from speech
  (`withoutSilenceMarker` in `src/calls/voice.js`, logged `voice_no_reply_dropped`), and the call
  prompt (`src/calls/voice-prompt.js`) says `skip_turn` instead.
- **Another language on the owner's own call is a mishearing (#65),** not a switch
  (`ownerLanguageRule`). Both pinned in `test/call-voice.test.js`.
- **Once-only post-call write.** A second `writeCallIntoThread` for the same call would double the
  rows; the guard is in `postCallRequest`, not in the function.

## How to get to it (user POV)

Ring Reason or ask it to ring somebody. Say a fact on the call ("my landlord is Mr. Osei"); later by
text ask "who's my landlord?". Ask for something sensitive on a call and get a text asking only for a
yes. Ask "what's the price of gold?", then "no, it's okay" — Reason searches once, answers, and never
takes the answer back.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/call-cross-channel.test.js test/call-verify-text.test.js \
  test/call-voice.test.js test/call-postcall.test.js     # 10 + 7 + 52 + 22 = 91 at 226ff17
node --test test/call-addendum.test.js test/call-readback.test.js test/elevenlabs.test.js   # 50 + 13 + 19
```

The tests drive the real post-call path with a faked transcript and a scripted extractor, so the
queue behaviour is proven without a phone.

**A real call turn on the cage — `bin/call-turn.sh` (SKILL.md, Drive 5).** The cage cannot place or
receive a phone call (no ElevenLabs key, no number), but it can answer the custom-LLM endpoint
ElevenLabs uses, with the cage's own bearer. That runs the real call model, harm screen and tools — when the cage has a key. Since #115 it
has none: a turn answers "Sorry — something broke on my end. Say that again?" (`voice_turn_threw`
"Could not resolve authentication method") and `show` reads `lookups: []`; that still proves the
endpoint, the bearer and the call row (2026-10-25). The recipe below is the 2026-10-23 drive.
Driven 2026-10-23 at `b2861c2`:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
dir=$(bin/evidence.sh new call-turn-lookups)
bin/evidence.sh run "$dir" 01-new  -- bin/call-turn.sh new
bin/evidence.sh run "$dir" 02-gold -- bin/call-turn.sh "can you check what the price of gold is today?"
bin/evidence.sh run "$dir" 03-ok   -- bin/call-turn.sh "no, it's okay."
bin/evidence.sh run "$dir" 04-again -- bin/call-turn.sh "what was that number again?"
bin/evidence.sh run "$dir" 05-show -- bin/call-turn.sh show
grep -E 'voice_turn"|call_tool"|call_llm_first' "${TMPDIR:-/tmp}/reason-verify/serve.log"
bin/caged.sh stop
```

**End state that proves it:** turn 2 runs `web_search` (`call_tool` in the log) and says a number;
`show` lists that search in `lookups` with the result head; turn 3 does NOT say it never looked
anything up (it was "No problem, skipping the text. Anything else you need?"); turn 4 repeats the
same number without a second search. The cage's `first_content_ms` (2.5–6.6s on 2026-10-23) is
this Mac to Anthropic with a cold cache — not a latency proof.

**Live, read-only** (Hetzner is the live path; ElevenLabs' post-call webhook goes there):

```bash
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since '24 hours ago' \
  | grep -E 'voice_turn|call_written_into_thread|call_verify_text|call_llm_first_content_ms' | cut -c1-220 | tail -20"
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select count(*), sum(length(content)<12) from event_log where channel='call'\""
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select id, state, length(lookups) from calls order by id desc limit 3\""
```

**End state that proves it:** after a real call, a `call_written_into_thread` log line, `event_log`
rows with `channel='call'`, fewer `extraction_queue` rows than call turns (filler skipped), and
`voice_turn` lines with numeric `first_word_ms`. For the texted yes: an `outbox` row whose body
contains no dollar amount or action text. For a call where Reason searched: `lookups` longer than
`[]` on that call's row. `call_llm_first_content_ms` on Hetzner was 2.1–2.9s on call 41, the first
call after PR #59 (3.5–6.3s on call 38 before it).

## Gotchas

- `first_word_ms` is measured to first CONTENT, not first byte; the role-only first chunk of an
  OpenAI-style stream does not count.
- When timing the model directly, time the first `text` or `tool_use` block, not the first
  `content_block_start` — a `thinking` block starts ~1.4s in and looks like a fast first token.
- The filler regex is anchored: "yeah I think so" is substantive and is queued.
- A replayed transcript has no tool results in it. A model that "confesses" it never looked
  something up during a replay is the PR #60 bug, not a replay artifact — check `withCallRecord`
  is in the path before dismissing it.
- `bin/call-turn.sh` turns run Reason's real tools: `web_search` hits the network and costs a
  search. `message_send` fails at the cage's closed channel, as every send does there.
- `doctor.sh live` does not checksum `src/calls/*`; compare `voice.js` by hand (SKILL.md, Launch C).
- Never place a live call to prove this. Never forward `voicemail_detection` (see the voicemail work).
- Hetzner timestamps are UTC; compare with ET carefully when matching a call to its rows.
- Never read call transcripts out of the live database into a report.
