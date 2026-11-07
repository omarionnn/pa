# Call completeness — a call and a text are one memory, and a call leaks nothing

What is said on a phone call (Reason's own brain, GPT-Live's voice over Twilio) is written into the same thread and the
same facts as a text. A fact from a call is recallable by text, and a text correction supersedes it.
Filler on a call ("yeah", "(inaudible)") does not cost an extraction. A consequential thing asked on
an unverified call waits for the call to end and is picked up by text (nothing is texted mid-call
since 7a1476d, 2026-11-06). Every voice turn logs
how long the first word took. What Reason looked up on a call stays known for the rest of the call
and in the texts after it, and the call model starts talking without a thinking pass first.

Source: `src/calls/postcall.js` (`writeCallIntoThread`, `worthExtracting`, `FILLER`,
`MIN_EXTRACT_CHARS` 12, `turnsFromTranscriptString`; the once-only guard is `settleGptLive` in `src/calls/gptlive.js`),
`src/calls/verify.js` (`VERIFY_TOOL` `verify_caller`, src/calls/verify.js:98; `verify()` writes
`calls.verify_deferred` and logs `call_verify_deferred`, :187-198; `src/calls/postcall.js`
picks it up after the call with `onlyAnExplicitYes`), `src/calls/voice.js`
(`voiceTurn`; `timing()` → `first_word_ms` and `turn_ms` on each `voice_turn` log line;
`case "verify_caller"` in `runCallTool`; `lookupEntry`, `withCallRecord`; `apiRequestFor`, which
builds both the ring-time cache warm-up and every turn), `src/calls/voice-prompt.js`
(`ownerCallFrame`), `src/calls/provider.js`, `src/config.js` (`callThinking`), `src/db.js`
(`event_log` with `channel = 'call'`, `extraction_queue`, `calls.lookups`, `addCallLookup`,
`callLookups`).
Tests: `test/call-cross-channel.test.js` (10 pass), `test/call-voice.test.js` (73; includes the
latency fields, the thinking setting, the lookups record, the #269 holding line, and the #65/#68
rules below), `test/call-postcall.test.js` (24), `test/call-addendum.test.js` (52; the after-the-call
check, line 193), `test/call-readback.test.js` (13), `test/no-elevenlabs.test.js` (4, 2026-11-07: the old custom-LLM / post-call / inbound routes 404, GPT-Live is its own provider) — counts at
`8113bcf` (2026-11-07). `test/call-verify-text.test.js` was deleted in 7a1476d with the mid-call text.
Shipped in PR #13 / `908b38d` ("Part 4"); PR #59 (`4e9f09f`) and PR #60 (`b2861c2`), 2026-10-23.
Other call behaviour (opening line, voicemail) is covered by the sibling `call-*.test.js`
files but not mapped here.

## Sub-features

- **Cross-channel proof.** Call turns go to `event_log` with `channel = 'call'` and are enqueued
  for extraction; a call fact appears in `remembered()`; `correctFact` supersedes a call-originated
  fact; one user's call fact is invisible to another; facts under 0.5 confidence are skipped.
- **Silent line + our own summary (2026-10-27).** A `completed` call whose transcript has Reason
  lines and no "Them:" line with a letter or digit (`theySpoke` in `src/calls/outcome.js`) settles as
  `outcome_kind = line_silent`, outcome "the line was silent — nobody spoke" (not "they answered"),
  redial `retry`. A third-party call's summary is `callSummary`: "Reason called <number> on <owner>'s
  behalf (<owner> was not on the call), to: <goal>." then the provider's text as "The call service's
  notes: …", or a silence line when nobody spoke. Owner calls keep the provider summary. Applied in
  `settleCall` and `fillLateDetails` (`src/tools.js`). Tests: `test/call-postcall.test.js` (silent
  line; spoken third-party framing), `test/call-handling.test.js` (`theySpoke`/`outcomeFor`).
  Proof: `/tmp/silent-verify/replay.mjs` replays live calls row 44 (the Strand) through `settleCall`
  in a temp DB → `line_silent`, no "called Omari".
- **Extraction guard.** `worthExtracting` is false for under 12 characters or filler. Those turns
  still reach `event_log` (the thread record) and are NOT enqueued.
- **After the call, never a mid-call "reply yes" (7a1476d, 2026-11-06).** On an incoming owner call
  with no `REASON_CALL_PASSPHRASE` (or after `MAX_PASSPHRASE_TRIES` 2 wrong ones), `verify_caller`
  with `about` stores it as `calls.verify_deferred` and texts nothing; the after-call turn asks for
  the yes in their own thread (`onlyAnExplicitYes`). A call Reason placed to the owner's own number
  is verified already (`isVerified`, src/calls/verify.js:60-64). Tests: `test/call-addendum.test.js`.
- **Latency logging.** `voice_turn` log lines carry `first_word_ms` (speech to first content) and
  `turn_ms` (total); `first_word_ms` is `null` when no content was streamed. `http.js` also logs
  `call_llm_first_content_ms` per request.
- **Holding line on a slow turn (#269).** `FIRST_WORD_DEADLINE_MS` (6 s now, src/calls/voice.js:230;
  injectable as `firstWordDeadlineMs`): if nothing has been said by then, `voiceTurn`
  streams `HOLDING_LINE` ("Mm-hm, one moment.", :289) once as an ordinary content delta and logs `voice_holding_line`; never
  before the disclosure on a silent-opening third-party line, never to a machine. `voice_turn_nothing_said`
  with `after: "holding_line"` when that was all. Cage: not drivable (no model key, the turn fails
  in ~25 ms before any deadline) — proof is `test/call-voice.test.js` (stalled model, 100 ms deadline).
- **Silent endpoint paths log (#269).** `voice_llm_request {call, kind, messages}` on every arrival,
  `voice_llm_bad_json {call id from raw body, bytes}` on a malformed body, and `http.js`
  `call_llm_not_streamed` was the HTTP route's line — the route is gone since 2026-11-07 (the turn runs
  in process from GPT-Live), so a 400 now shows only as `voice_llm_bad_json`; pinned in `test/call-voice.test.js`.
- **Lost-call sweep window (#269).** `callLostAfterMs(state)` in `src/tools.js`: an `in_progress`
  call = `max(callMaxMinutes*60, callPlatformCapSeconds)` s + 15 min (`REASON_CALL_PLATFORM_CAP_SECONDS`,
  default 3600; a GPT-Live call is ended at it); it was 25 min, which swept long live calls. `placing`/
  `ringing` (never answered) keeps `callMaxMinutes` + 15 min. Pinned in `test/calls.test.js`.
- **Call metrics for the audit (#273).** `call_turns` (one row per turn, keyed UNIQUE on
  `(call_id, msg_count)` so a re-asked turn upserts and counts `attempts`; written by
  `db.recordCallTurn` only after the stream ends): `first_content_ms` / `first_content_kind`
  (`holding_line | filler | fallback | opening | dots | real`), `first_real_ms`, `total_ms`,
  `holding_line`, `tools` (names), `closed_early`, token use — timed from the top of `llmRequest`
  (`callMetrics.metered` in `src/calls/metrics.js`). On `calls`: `end_reason` + `end_detail`
  (`endReasonOf`: platform_error only for `metadata.error` or "custom_llm generation failed";
  "Call ended by remote party" → `remote_hung_up` both directions; `no_answer`, `inactivity`; the
  sweep writes `lost`, which a later post-call delivery or `fillLateDetails` replaces),
  `cost_cents` from `metadata.cost_fiat` (USD), `cost_credits` (`metadata.cost`), minimal `cost_raw`.
  `scripts/call-report.js` reads it all read-only (`DatabaseSync readOnly`), no words. Tests:
  `test/call-metrics.test.js` (14). Cage drive 2026-10-30 (via the since-removed `bin/call-turn.sh`): a new call + two turns →
  two `call_turns` rows (`fallback`, no key) and `call_turn_heard` in `serve.log`; an in-process
  signed post-call delivery (real field shapes, call 32's 1.193) → `remote_hung_up`, `cost_cents`
  119; a swept call → `lost`, then a late 1002 delivery → `platform_error` with code and reason
  (`call_end_corrected`); `call-report.js` on the cage DB prints the totals.
- **Re-asks join the running turn (#275).** ElevenLabs re-asks a turn it judged failed, 4–6 times
  ~1–1.5 s apart. In `llmRequest` (`sharedTurn` in `src/calls/voice.js`) a request whose history has
  nothing new from their side (`theirSideKey`: trailing assistant/system/quiet-line messages ignored)
  attaches to the in-flight turn — buffered chunks replayed (minus a holding line already handed out
  and minus the request's own trailing assistant text), then live; one model run, tools once, no
  `call_turns` row of its own; logs `voice_turn_attached {buffered, readers, since_first_ms}`. New
  words cancel it: `voice_turn_superseded {reason: new_from_their_side | socket_closed | aborted}`,
  and every reader still gets `finish_reason: "stop"` + `[DONE]`. A closed socket keeps the turn
  `ATTACH_GRACE_MS` (3 s) for a retry, with no side-effecting tool started while unread. An empty
  turn on hold leaves as `skip_turn` (`voice_empty_turn_waits`). Tests: `test/call-reask.test.js` (8).
  Cage drive 2026-10-30 (`/tmp/reask-drive/burst.mjs`, four identical posts at once, then a
  new-words pair): 1 turn + 3 `voice_turn_attached`, all four streams `stop` + `[DONE]`; the pair →
  `voice_turn_superseded new_from_their_side`, old stream `stop` + `[DONE]`.
- **Fillers and dead air (#274, then this fix).** `oneSec` ("One sec..." at a tool start ≥2.5 s into
  a silent turn) once per call; `HOLDING_LINE` at 6 s once per call; any later turn silent at
  `LATE_HOLDING_MS` (7.5 s, from `t0`) gets the next of `LATE_LINES` (six, in order, so never the
  same twice running). No call-turn line (`METER_KINDS`, the can't-pick-up refusal) says "sorry"
  (hold.js's give-up to a business on hold still does); `VOICE_RULES` forbid apologising on a call. Offline replay of stored owner calls at their recorded latencies, no model/phone:
  `bin/call-filler-drive.mjs` (fake model seam, real `llmRequest`; inputs = a private calls JSON
  export + journal `voice_turn` lines; `REASON_FILLER_ROOT` picks the checkout, so before/after is
  one script on two worktrees; counts only, via `bin/call-filler-count.mjs`). Tests:
  `test/call-voice.test.js` ("holding line: 6 s once per call…", "the code's own lines never
  apologise", the prompt test).
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
  rows; the guard is in `settleGptLive` (a row already settled is returned as is), not in the function.
- **"Call X again" carries the NEW purpose (#332, 2026-11-05, call 63 → call 74).** `call_place`
  builds this call's brief first (`freshBrief`) and hands it to `safeToRedial` (`src/calls/redial.js`);
  only the "did it go through?" rewrite of a dropped call that could have booked something replaces it,
  with booking off and this call's purpose carried after the check. A retry, an ask-only call that
  dropped (a plain retry now, not a check) or a friend rung with a new message goes with what it was
  asked to carry now — call 74 went to Yaw with the old Man U script. Attempts and voicemails count
  over the last 24 h, not forever. `call_status` with no id = the five most recent calls in full plus
  `earlier_calls`, one line per older call (60 days, 40 rows: `call_id`, `to` — "them (their own
  phone)" for an owner call — `placed`, `goal`, `ended`), so "call Yaw again" finds Sunday's call.
  Offline: `node --test test/call-again-new-purpose.test.js` (5). In process under `caged.sh env`,
  no model: insert a `calls` row on a throwaway `REASON_DB_PATH`, `runTool("call_status", {}, { conversationId, messages: [] })`
  → that call in `calls` with goal and outcome (2026-11-06, `c6ce172`).

## How to get to it (user POV)

Ring Reason or ask it to ring somebody. Say a fact on the call ("my landlord is Mr. Osei"); later by
text ask "who's my landlord?". Ask for something sensitive on an incoming call: Reason says it will
pick it up by text after the call, and the yes is asked in the thread once you hang up. Ask "what's the price of gold?", then "no, it's okay" — Reason searches once, answers, and never
takes the answer back.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/call-cross-channel.test.js \
  test/call-voice.test.js test/call-postcall.test.js     # 10 + 73 + 24 = 107 at 8113bcf
node --test test/call-addendum.test.js test/call-readback.test.js test/no-elevenlabs.test.js   # 52 + 13 + 4
```

The tests drive the real post-call path with a faked transcript and a scripted extractor, so the
queue behaviour is proven without a phone.

**A real call turn, in process (SKILL.md, Drive 5).** There is no HTTP route to a call turn any
more (the `/calls/elevenlabs/llm` endpoint and `bin/call-turn.sh` were removed 2026-11-07; GPT-Live
calls `llmRequest` in process). The no-model proof is `bin/call-filler-drive.mjs` (stored calls through
the real turn with a scripted model seam) and the tests above; the model-backed one is
`bin/call-identity-drive.mjs` on claude-cli (never the API). The 2026-10-23 lookups drive
(`web_search` on turn 2, remembered on turn 4 without a second search) was run through the old route
at `b2861c2`; to repeat it, drive the same four turns through `voice.llmRequest` in process on
claude-cli against a throwaway database.

**Live, read-only** (Hetzner is the live path; GPT-Live's Twilio webhooks go there):

```bash
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since '24 hours ago' \
  | grep -E 'voice_turn|call_written_into_thread|call_verify_deferred|call_llm_first_content_ms' | cut -c1-220 | tail -20"
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select count(*), sum(length(content)<12) from event_log where channel='call'\""
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select id, state, length(lookups) from calls order by id desc limit 3\""
```

**End state that proves it:** after a real call, a `call_written_into_thread` log line, `event_log`
rows with `channel='call'`, fewer `extraction_queue` rows than call turns (filler skipped), and
`voice_turn` lines with numeric `first_word_ms`. For a deferred check: `call_verify_deferred` in
the journal and no outbox row during the call. For a call where Reason searched: `lookups` longer than
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
- A model-backed call turn runs Reason's real tools: `web_search` hits the network and costs a
  search.
- `doctor.sh live` checksums every file under `src/` since 2026-10-24, `src/calls/*` included (SKILL.md, Launch C).
- Never place a live call to prove this. Never forward `voicemail_detection` (see the voicemail work).
- Hetzner timestamps are UTC; compare with ET carefully when matching a call to its rows.
- Never read call transcripts out of the live database into a report.
