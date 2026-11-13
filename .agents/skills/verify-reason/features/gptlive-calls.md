# GPT-Live calls — the only voice Reason has

**Now (2026-11-07, ElevenLabs removed):** `REASON_CALL_PROVIDER=gptlive` makes GPT-Live the call
provider (`GptLiveCallProvider` in `src/calls/gptlive.js`): every call — own, business, ring-back,
inbound — is OpenAI GPT-Live (`gpt-live-1`; voice `REASON_GPTLIVE_VOICE`, live = `willow`, default
`marin`) over Twilio. Live once `missingForGptlive()` is empty: OPENAI_API_KEY, TWILIO_ACCOUNT_SID,
TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, REASON_PUBLIC_URL (no ElevenLabs key of any kind). The
`/calls/elevenlabs/*` routes are gone (404). Inbound never redirects anywhere: a caller GPT-Live
cannot take (keys missing, routing threw) gets Twilio `<Reject/>`. `REASON_CALL_VOICE` /
`REASON_THIRD_PARTY_VOICE` (below) only matter in front of another provider (`withGptLive`); a GPT-Live
dial it cannot make returns `{ok:false}` rather than falling back. Proof: `test/no-elevenlabs.test.js`.
The sections below are the build history (2026-10-31); where they say "ElevenLabs" for the
non-GPT-Live branch, that branch no longer exists.

GPT-Live is only the voice. It delegates with **client delegation**; each `session.delegation.created`
runs Reason's own call turn (`llmRequest`, the same one ElevenLabs' custom-LLM requests run: context,
tools, memory, harm screen, confirm gate, NO_REPLY / spoken-args filtering) on the call transcript, and
the answer goes back as `session.commentary.append`. Code fillers ("One sec...", holding lines) are
dropped; `end_call` hangs up after its goodbye plays; `skip_turn` sends a silent thinking note.

Honesty guard: a spoken "done / booked / sent / you're all set" (`claimsDone`) while a delegation is
pending, or when Reason's latest answer did not itself say so, drops Twilio's unplayed audio
(`clear`), mutes the voice and sends `GUARD_CORRECTION` by `session.instructions.append`. The same for
a spoken NO_REPLY. Barge-in: caller speech with no new voice audio for 350 ms clears Twilio's buffer.

Speaking first (2026-10-31, after call 53's 3.1 s of dead air): `place` starts a `WarmSession`
(`prewarm`) before it asks Twilio to dial. The session starts with the greeting asked for, is fed
100 ms silence frames (its clock only runs on input audio — no input, no greeting), keeps the
greeting's audio, and is paused (no more input) once the voice has been quiet 700 ms after speaking;
no greeting after 4 s → asked once more; 9 s → feeding stops; 60 s unanswered → closed (also on a
no-answer/busy/failed status). When the stream starts, `GptLiveCall.adopt` plays the kept greeting at
once on the same session and carries on live. Only calls with an opening line get one; a call that
opens silent never reaches GPT-Live. Log: `gptlive_warm` (ready), `gptlive_warm_used`,
`gptlive_first_voice` (stream start → first speech frame), `gptlive_warm_dropped`.

Who it is (2026-10-31, widened the same day to EVERY user): `whoFor(call)` derives it per call from the
account whose conversation it is. On a call with their own user (`is_owner`): `ownCallIdentity` (shared
with the ElevenLabs owner frame in `voice-prompt.js`) — "you are Reason, <name>'s own Reason; they are
<name>, the person you work for", answered directly, never delegated; an unnamed user is told honestly
it has no name yet. Plus who rang whom and their own profile block (`ownerProfileNote`, ≤3,000 chars,
"for them only"); the install city only for the operator. On a call for them to anyone else:
`thirdPartyIdentity` — "I'm Reason, an AI assistant calling for <name>", nothing of their profile (the
ElevenLabs `thirdPartyFrame` carries the same line; before it said only "an AI assistant"). The
GPT-Live voice itself stays operator-only (`gptliveFor`). Tone section: warm, relaxed, contractions,
small reactions, light humour, no corporate phrasing.

The line: Twilio Media Streams (μ-law 8 kHz straight through to `audio/pcmu`), WebSocket at
`/calls/gptlive/stream/{call webhook token}`. Outbound: `place` asks Twilio to dial with that stream as
TwiML; status at `/calls/gptlive/status/{token}`. Inbound: `/calls/gptlive/inbound` (every caller
served on GPT-Live, `<Reject/>` if it cannot), the number's Twilio voice webhook. **Needs the TWILIO_*
keys in `.env`**; without them GPT-Live reports not connected (`missingForGptlive`).

Metrics: the row's `provider` = `gptlive`, `tts_model` = `gpt-live-1/marin`, `cost_cents` = voice
seconds at 5¢/min (Reason's own turn tokens are on its call_turns rows as before), `end_reason` as
ever. Each turn's call_turns row (written by Reason's turn) gets `voice = 'gptlive'` and what the
caller HEARD: `first_content_ms` = first voice audio after the delegation (usually its own ack),
`first_real_ms` = first audio after Reason's answer reached the voice. `scripts/call-report.js`
prints one `voice <provider>:` line per provider on record. The recording is the bridge's own mix
(`CallTape`, 16-bit 8 kHz WAV).

Source: `src/calls/gptlive.js`, `src/calls/wsserver.js`, `src/http.js` (upgrade + two routes),
`src/serve.js` (`withGptLive`), `src/tools.js` (`call_place` writes `placed.provider`), `src/db.js`
(`call_turns.voice`, `markCallTurnHeard`, `provider` updatable), `src/calls/report.js` (`voices`),
`src/config.js` (`callVoice`, `gptlive*`, `twilio*`).

Tests: `node --test test/gptlive.test.js` (45 at `8113bcf`, 2026-11-07; 27 at first).

Who made Reason (#295, superseded by #296 maker.js): `agent.js builtByLine(me)` — "built by Omarion Nyarko" only to the operator; every other user hears "made by the Reason team", no name (text and both call voices, via `systemFor`; GPT-Live via `whoFor().operator`). Drives: `gptlive-drive made.ulaw 16 --expect made --as user|owner`; `call-identity-drive.mjs` cases `user-made` / `owner-made`. Not changed: the first-chat onboarding classifier (src/onboarding.js, dark) still names him.

Drive (real GPT-Live session + Reason's real turn on claude-cli, fake Twilio stream through the real
upgrade route, throwaway db, no phone; ~2¢ of OpenAI voice) — on Hetzner from a copy of the code, as
the `reason` user, keys read from `/opt/reason/.env`:

```bash
E=$(sudo -u reason .agents/skills/verify-reason/bin/drive-env.sh OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN)   # keys never on argv
sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason USER=reason LOGNAME=reason \
  REASON_DB_PATH=$(sudo -u reason mktemp -d)/gl.db node --env-file="$E" \
  .agents/skills/verify-reason/bin/gptlive-drive.mjs q.ulaw 30 [--expect identity] [--cold] [--ring 5000]; rm -f "$E"
```

`q.ulaw`: `say -o q.aiff "Hi, can you check what is on my calendar tomorrow morning?" && ffmpeg -i q.aiff -ar 8000 -ac 1 -f mulaw q.ulaw`.
Expect `ok`: one delegation, a result with chars, the turn tagged `gptlive` with `first_real_ms`, row
`completed` / `gptlive` / `recording: stored`. First run 2026-10-31: ack heard at 38 ms, Reason's
answer (calendar_events) 10.8 s, spoken right after; 28 s, 2¢; guard trips 0.

Speak-first + identity (2026-10-31, `who.ulaw` = say "Hey. Do you know who I am? What's my name?"):
`--cold` first_voice_ms 2,021; warm (5 s ring) 10 ms, answer "You're Omari, the person I work for",
0 delegations, 1.35 s after the question. Willow, `q.ulaw` "who are you + calendar": first voice 10 ms,
"Oh that's me. I'm Reason. Lemme just check your morning.", 1 delegation (calendar_events), guard 0.

Identity drives (2026-10-31, all ok): `gptlive-drive.mjs who.ulaw 18 --expect identity --as owner|user|third`
→ "You're Omari, the person I work for" / "Yeah, you're Ama! The person I work for." (nothing of Omari's) /
"Hey, I'm Reason, an AI assistant calling for Omari." (none of his profile). ElevenLabs path, every
user's today: `bin/call-identity-drive.mjs` (claude-cli, throwaway db) — owner, Ama and a business; on
main before the change the business heard "I'm an AI assistant calling on behalf of Omari" (no Reason).

Never: drive the live service's routes, or place a real call to test it (that rings the owner).

## Rollout gate + isolation + maker (#296, 2026-10-31)

- `REASON_CALL_IDENTITY` (`voice-prompt.js callIdentityFor`): `owner` = the operator's calls only (live),
  `on` = everyone, unset = every prompt as before #293/#294, byte for byte (checked against 89b6227).
  Gates `ownCallIdentity` in `ownerCallFrame` (ElevenLabs), `thirdPartyIdentity` in `thirdPartyFrame`,
  and the GPT-Live identity/profile block (`whoFor().identity`; off = the old one line, profile not read).
- Isolation: identity, profile (`ownerProfileNote`), greeting, delegation context are all read from the
  call row's own `conversation_id`; warm sessions/streams keyed by call id. Tests: user B's ElevenLabs
  context (system + messages) and GPT-Live instructions never contain user A's name/profile/thread, for
  every flag value. Drives: `call-identity-drive.mjs` (Omari + Ama, Omari's thread seeded with a locker
  code; `user-probe` asks Ama's Reason for it and about Omari) and `gptlive-drive --as user` with
  `REASON_CALL_IDENTITY=owner|on` and `probe.ulaw` ("…what do you know about Omari?").
- Maker: `src/maker.js` from `REASON_MAKER` — one answer in texts (`systemFor`), onboarding and both
  voices; unset = "Omarion Nyarko" wording as always. The #295 "Reason team" split is gone.
- Known, not fixed (pre-existing): `strangerLine` (inbound.js, voice-prompt.js) tells blocked/paused/
  removed/unknown callers "an AI assistant for <operator>", naming the operator to other people.

## Maker = Saafi Interactions Lab (#297, 2026-10-31)

`config.makerName` defaults to "Saafi Interactions Lab" (REASON_MAKER only overrides); `src/maker.js`
is the one answer for texts (`systemFor`), onboarding and both voices, for every user, not gated. The
"he built you, smart guy" deflection is gone: probed further, Reason says it's still the company and
invents nothing. Test: no string literal under src/ or assets/ says Omarion/Nyarko, and the built
prompts (text, ElevenLabs own/third-party, GPT-Live) don't either. Since security run-3 (2026-11-10) the
home, /privacy and /terms pages name only Saafi Interactions Lab (no repo link, no "the code is public") and
the web-lookup user-agent is `ReasonBot/1.0 (+https://heyreason.com)` (test/site.test.js). Left on purpose:
code comments, test fixtures, drives' throwaway "Omari" operator, `config.ownerName` default,
LICENSE copyright, docs/usecases.json (internal).

## Call 56 fixes (2026-10-31)

Call 56 (291 s, 9 delegations): "Checking" before nearly every reply, "how are you?" not returned, "where am I?" answered with the identity line (its ASR heard "who"), flat "Bye." and the line stayed open until Omari hung up, and a "yeah" to Reason's own train-check offer answered "Okay." without reaching Reason (the after-call note caught it: timer 389, 7:45 pm ET).
- Prompt: call 53's lines untouched; identity line now "Only if they ask who you are, who they are or their name … Where they are, or any other question, goes to Reason; if you're not sure whether they said who or where, ask." plus `CALL56_LINES` (4): holding phrase only for a real hand-off (since call 79: `NO_HOLDING_LINE`, the voice never holds the line itself — see "Call 79 fixes"), small talk returned, a yes/no to Reason's offer passed on, warm brief sign-off.
- Hang-up: the voice says its goodbyes itself, so Reason's `end_call` never came. A goodbye-sounding voice line (`soundsLikeFarewell`, a cue only) → `judgeEnding({kind:"goodbye"})` on claude-cli (askJson, haiku) → mutual goodbye → hang up once its SPEECH stops (the session streams silence between words, so `lastOutAt` never goes quiet; that left end_call on the 15 s cap). Words while it waits are read again ("bye — oh wait" calls it off). null (no CLI) never hangs up. Row: `end_reason=end_call`, detail `end_call (mutual goodbye)`. Log: `gptlive_goodbye_read`, `gptlive_goodbye_called_off`.
- Cut-off: their words after Reason's goodbye are read (`kind:"cutoff"`; "bye"/"you too" = no); with no words, ≥300 ms of their speech in the last 1.5 s of a hang-up Reason made counts. `live.cutOff` → `ownerEvent` adds one "sounded like you were saying something as we hung up, what was it?" line (owner thread, normal after-call path, once). Log `gptlive_cut_off`.
- `ownerEvent` (GPT-Live calls only): a yes to something offered for later that isn't set up → set it up now or say it couldn't.
- **Their goodbye (call 77, 2026-11-08, PR #389):** their lines are cues too — their own sign-off (hint list now has "call you later", "gotta go", "let you go") or anything within 20 s of Reason's goodbye, after a 500 ms settle (`CALLER_BYE_SETTLE_MS`). The question is "is Them, in their last words, ending the call to Reason" (any sign-off, with or without "bye"; no for "bye — oh wait", the room, Reason alone). Newer words start a new read at once (latest wins, ≤2 out, `overtaken` in the log); a no read before the voice's own bye is re-read with it; a started CLI is kept ready from stream start (~2.0 s vs ~2.7 s cold). After a yes the hang-up waits ≤3 s from their words for the voice's goodbye, then drops the line BEFORE the 3 s usage wait. Drives (11-08, `--cold`, all ok, hang-up after their clip ends): `goodbye` ×3 4.0–4.3 s (was 5.4–6.1), `bye-only` "okay, bye-bye" ×2 4.2/4.2 s, "let me call you later. okay" 4.1 s (was 8.7), `room-bye` + "okay bye. oh wait, …train" not hung up, own question delegated. `--expect bye-only` passes on a mutual-goodbye hang-up within 6 s; output `bye_timeline`.
Drives (2026-10-31, all ok, `--cold`): `where.ulaw 35 --expect where` (went to Reason, get_location, no identity line); `bye.ulaw 30 --expect goodbye` (hung up 5.4 s after "okay, bye", read=true); `room.ulaw 30 --expect room-bye` ("bye Mum…" → not hung up).

## Everyone's own calls (2026-10-31, Omari: "make this available for everyone that has Reason")

`REASON_CALL_VOICE`: `gptlive` (or `on`) = every account's OWN calls (calls Reason places to its own
person, `kind: owner`, any account with a row); `owner` = the operator's own calls only (the trial);
anything else = off. Third-party / business calls stay on ElevenLabs. `REASON_CALL_IDENTITY=on` gives
every user's GPT-Live and ElevenLabs call the identity line ("you're Reason, they're <their name>").

Full-call drive for ANOTHER user (Ama), with Omari's thread seeded with a locker code:
`gptlive-drive.mjs q.ulaw 45 --then b.ulaw --then-at 24 --expect full --as user --cold` with
`REASON_CALL_IDENTITY=on` — passes only if the turn ran on her conversation, the call hung up on the
mutual goodbye, the transcript is in her thread, every after-call event went to her conversation for
this call, cost_cents > 0, recording stored, and nothing of Omari's was said, sent or written (his
thread byte-identical). 2026-10-31: ok — peanut allergy from her memory, hung up on "bye", 30 s, 3¢.

## Calls IN on GPT-Live (2026-10-31, Omari's OK)

The number's Twilio voice URL → `<REASON_PUBLIC_URL>/calls/gptlive/inbound`; its Twilio **voice fallback
URL** was ElevenLabs' own inbound URL until 2026-11-07; with ElevenLabs removed it must be cleared
(or set to a Twilio-only TwiML), and `REASON_GPTLIVE_INBOUND_FALLBACK_URL` is no longer read.
`inboundTwiml` (REASON_CALL_VOICE=gptlive):
- account whose own calls are GPT-Live → their own Reason (row on THEIR conversation, identity, greeting
  `openingLineFor` spoken when the stream starts — nothing made before connect); over the day's cap
  (`inbound.overCallCap`, 10 calls / 30 min) → Twilio `<Say>` the cap line, hang up;
- blocked / paused / removed → Twilio `<Say voice=Polly.Amy-Neural>` `stranger.neutralLine()` + `<Hangup/>`;
- unknown / withheld → the #303 pitch on GPT-Live: `strangerInstructions()` (voice only, names nobody,
  maker line) + every answer from `stranger.strangerReply` (no tools, public facts only, turn caps);
  master asked (`inbound.strangerIntake`), words kept (`strangercalls.open` external_id `gptlive:<CallSid>`,
  settled at end); no call row; the audio is kept on the stranger row (phase 3, below);
- a place ringing back about an errand → the third-party line on GPT-Live; GPT-Live not set up, or
  routing threw → `<Reject/>` (no redirect, no second voice; since 2026-11-07).
The honesty guard skips the opening line while it is the greeting's own words (`fromLine`): the
stranger intro's "getting things done" tripped it in the first drive.

Drive: `gptlive-inbound-drive.mjs --who user q.ulaw 45 --then b.ulaw --then-at 26` · `--who stranger
s.ulaw 50 --quiet 13 --then b.ulaw --then-at 36` · `--who blocked` (as the reason user, keys from .env,
same env -i wrapper as above). 2026-10-31 all ok: user first voice 2.4 s, peanut allergy from her memory,
hung up on bye, 33 s / 3¢, event to her conversation; stranger first voice 1.8 s, full intro, "no price
listed… hey reason dot com", master asked, words kept, no row; blocked: the neutral line only.

## Phase 3: calls to businesses and other people on GPT-Live (2026-10-31)

Flag `REASON_THIRD_PARTY_VOICE` = `gptlive`/`on` (everyone's errands) · `owner` (the operator's only) ·
unset (ElevenLabs, as before). Also opens the GPT-Live routes on its own (`gptliveOn`). Own calls are
untouched (`line` is false on `is_owner` rows; covered by a test with the flag on).

"A line call" (`GptLiveCall.line`, non-owner rows): the LINE drives every turn, the voice only speaks.
- Placing (`withGptLive.place`, kind third_party): Twilio `Calls.json` with the stream TwiML and async
  AMD (`MachineDetection=DetectMessageEnd`, `AsyncAmd=true`, callback `/calls/gptlive/amd/<token>`);
  returns `openingWaits` so the row gets `opening_waits=1`; the row's opening line becomes
  `lineAnnouncement()`: "" (the default since 2026-11-12: nothing is said first by code, and the call is
  not audio-recorded) or the recording notice with `REASON_THIRDPARTY_RECORDING=on`.
- Silent opening: no greeting. Their words (input transcript) → after 1 s of pause (8 s max on a line
  that never pauses) one `lineTurn` = `reasonTurn` with `reason_kind=third_party`, i.e. the SAME
  voice.js turn ElevenLabs runs (third-party context, brief, commit gate, readback, hold, machines,
  `openingOwed` disclosure prepended by code). One at a time; words heard meanwhile are covered by the
  answer if it spoke, read again if it did not; a key press counts as an answer.
- The gate (`gateOpen`): the voice's own audio is DROPPED unless it is saying words Reason handed over
  (`speakLine` → `session.commentary.append`, on the voice's open delegation when it made one; empty
  `thinking.append` cancels its auto-ack; `acknowledgement_delay_ms: 800`). If the voice was mid-speech
  of its own when the words went in, audio waits for `session.commentary.appended`. Gate shuts 1.5 s
  after the speech goes quiet (30 s cap). Dropped speech is not in the transcript or the tape.
- Keypad: `play_keypad_touch_tone` from the turn → `press` → Twilio call update
  `<Play digits="w<d>"/><Connect><Stream …same token/></Connect>`; the old stream's stop is ignored
  (`rejoining`), `acceptStream` hands the new socket to the running call (same voice session); voice told
  "Reason pressed N" (thinking); 20 s without the stream back → call ended.
- AMD (`amdRequest`, Twilio-signed): `human`/`unknown` nothing; `fax` → dead end + hang up;
  `machine_end_*` → a bracketed note for Reason's turn (it decides menu vs mailbox with its own
  `machine_on_the_line` rules; IVRs also read as "machine" to Twilio). A voicemail written before the
  verdict (`reachedMachine` + end_call message) is held until the beep (20 s max). Verdicts before the
  stream is up are kept (`amdEarly`).
- Hold: `skip_turn` from the turn = silence (its `noteWaiting` starts `hold_since`); `holdTick` every
  15 s asks Reason's turn once more only when `holdLeft` is 0 → its own give-up line + end_call
  (`hold_gave_up`). A person back = words → next turn (`noteSpeaking` ends the hold). A line where
  nobody says anything for 45 s is ended.
- `transfer_to_number`: its `client_message` said, then Twilio `<Dial>` (Reason leaves the call).
- Settle: `settleGptLive` + `noteThirdPartyTurns` (call events into memory, as ElevenLabs' delivery).
- Ring-back: `routeInbound` → `ringBackRow` (not owner; errand goal/facts/brief/errand/hold budget),
  greeting `ringBackLine` = "Hi there!" (or the recording notice, recorded mode only) + "You're calling back about …" spoken at once.
  Who counts as ringing back (`callingBack`, src/calls/inbound.js): only a call Reason PLACED to that
  number (direction out) in the last 24 h, not settled `confirmed`/`refused_by_them`; ring-back rows
  never reopen the window. At most `MAX_RING_BACKS` (3) ring-backs per placed call, then the number
  gets the stranger line (the operator's daily call caps are exempt, so this is the bound; audit lead
  30). Test: `node --test test/call-inbound.test.js` ("a few ring-backs", "does not slide the window").
  Drive in a cage: seed an outbound call row to a number, POST four Twilio-signed rings from it to
  `/calls/gptlive/inbound`: 1-3 answer `<Stream>` + an `in`/is_owner 0 row, the 4th the stranger stream.

Stranger recordings (item 6, the consistent option): the intro says "this call is recorded", so the
GPT-Live stranger stream now KEEPS the audio at `recordings/stranger-<row id>.wav`,
`stranger_calls.recording_path`; dropped with their words (`prune`, keepContentDays) and with the row.
Withheld callers get a row with phone '' (matches nobody).

Drive (no phone; real GPT-Live + Reason's real third-party turn on claude-cli; fake Twilio stream and
REST; AMD posted to the call): `bin/gptlive-line-drive.mjs <clips dir> --scene ivr|hold|voicemail|human`,
same env -i wrapper as above. Clips (Mac):
`say -v Samantha -o x.aiff "…" && ffmpeg -i x.aiff -ar 8000 -ac 1 -f mulaw x.ulaw` for ivr-menu ("For
reservations, press 1…"), ivr-connecting ("Reservations. Please hold…"), human-after-hold, receptionist,
voicemail-greeting, hold-recording; music and the beep are synthesised in the drive.

Review fixes (#316): a voicemail held for the beep is the call's last word (no more turns) and, if the
line goes before a word of it plays, the row is put back to `voicemail_no_message`; a turn that speaks
and presses says its words first; no overlapping turns while a press goes to Twilio, and late menu words
during the re-attach are not a turn; an AMD verdict during a turn that spoke is read after the words;
every background turn caught (`runLine`); stranger audio is in `recordingFiles` (data export/delete);
the hold.js first-person floor applies to `provider='gptlive'` rows only (ElevenLabs unchanged — the
same gap exists there: after a menu + hold the model may skip the disclosure to the first person).
Drive results 2026-10-31 (final code): human — silent until "…this is Sam", then "Hey, hi — this is
Reason, an AI assistant calling for Omari. Just so you know, this call is recorded…" + the question;
ivr — pressed 1 once, stream back, held ~24 s silent, the same disclosure to Sam; voicemail — nothing
over the greeting, message after the beep, `voicemail_left=1`, state voicemail; hold (20 s budget) —
silent through music, give-up line, `hold_gave_up`. Latency: their last word → Reason's first ~7–9 s on
claude-cli (1 s pause + the turn + ~0.6 s voice start); the live backend (api) is faster. Hold give-up
overshoots the budget by up to one 15 s tick plus a turn.

## Business calls TALK (2026-10-31, after call 59) — `REASON_LINE_TALK` (default on; `off` = the puppet line above)

Call 59 (Chelsea Bodywork) failed on the puppet line: their "can I help you?" got Reason's first word
8 s later (1 s pause + a Reason turn + the voice), "hello? hello?", 8 Reason turns in 39 s each cutting
the last off, `LINE_STOP_OWN` sent while the voice was saying words they HAD heard (rawSpeechAt counted
played audio → it repeated the intro), Twilio AMD's 30 s timeout said `machine_end_other` on the
receptionist and a turn re-introduced the call over her; the recap blamed "a bad line". Guard: 0 trips.
Voice was gpt-live-1/marin (the "male" label was the transcriber's guess).

Now (placed third-party calls; ring-backs keep the puppet line): `lineTalkInstructions` = brief + rules;
silent until somebody speaks (`callerVoiceAt` = frame RMS ≥ `VOICE_RMS` 2000, hiss stays under; the
transcript lags ~2.7 s); the voice's own answer to a person is let through (`ownOpener`) and
`startTalking` → own-call style (voice talks, `delegate` runs Reason's turn, keys/transfer from it), no
more line turns; a line turn overtaken by the voice is not said (its key/transfer/hang-up only if
nothing was said since). Nobody speaks 3 s (`LINE_OPEN_AFTER_MS`) → "Hi there, hello?" then waits (not
counted as a person; since #379 only when no pickup opener clip played — see "Pickup opener" below). AMD non-beep ignored once they have spoken since the talk began; beep →
`stopTalking`. Mailbox rows never talk. Opener style: "Oh hey, hi! I'm calling to find out…". Since 2026-11-12 (replaces the
11-11 "this is Reason, an AI assistant calling for <first> … may be recorded" opener) EVERY call with a
business or another person, every account and state, starts NORMALLY: hello, then what it is about — the
row's announcement is "" (`lineAnnouncement`), the pickup clip is "Hi there! I'm calling …", the voice and
Reason's turn carry `manner.plainOpenLine` + `manner.askedLine` (asked who/what is calling → "I'm an AI
assistant calling for <first>", at once; never human, never a made-up name). A ring-back hears "Hi there!
You're calling back about … — thanks for ringing back." These calls are NOT audio-recorded
(`manner.callRecorded`; `GptLiveCall.recorded` false → the tape keeps the clock and no bytes; the result
carries `notRecorded`, the row is `recording_state=not_applicable`, `recording_why` = `NOT_RECORDED_WHY`).
Transcript text, summary and outcome are still kept. `REASON_THIRDPARTY_RECORDING=on` brings back, together:
the notice "Hi there — just so you know, this call may be recorded." (row, clip, first reply; said yet is
checked 9 s in, `checkNotice`), the recording, and the objection read (`readObjection`, by meaning; stops
the tape from before their words; `gptlive_recording_declined` in the journal).
`test/call-plain-open.test.js` (default), `test/call-manner.test.js` (recorded mode). Hold in talk mode: voice silent; its own silence past
the budget → give-up line + hang-up. Recap gets `howItWent` (first sound, first word, overlaps, end) +
"never guess a bad line".

Drive: clips = the `say` set above + `make-tts-line-clips.mjs <dir>` (OpenAI TTS receptionist,
`tts-*.ulaw` + `-noisy`). `gptlive-line-drive.mjs <dir> --scene greet|hello|noisy|quiet|interrupt|robot`
(+ ivr|hold|voicemail|human). Results 2026-10-31 (real GPT-Live, claude-cli): greet first word 0.97 s
after their greeting, one opener, replies ~1.2 s; hello 0.9 s, no second hello needed; noisy (CA) 1.1 s,
"just so you know, this call's recorded" said; quiet opened at 3.9–4.3 s, then 0.7 s; interrupt stopped,
"Sure.", silent through 6 s hold, resumed 0.75 s; robot "Yes, I'm an AI assistant calling for Omari."
~1.1 s; ivr pressed 1, silent through menu + hold; hold `hold_gave_up`; voicemail `voicemail_left=1`.
The last review fixes (person after hold answered at once, voicemail never "talking", opener ≠ person)
are unit-tested only: the OpenAI account hit `credit_balance_exhausted` before the re-drive.

One opener (2026-10-31, after #321): the greet re-drive heard 2 — a GPT-Live "Mm." into the
receptionist's mid-sentence pause (and, an earlier run, into silence ~1 s after its own opener). Talk
mode now holds a sound that starts <650 ms after their last loud frame, or 0.6–3 s after its own speech
with nothing from them (no delegation pending, no result in the last 4 s): 450 ms of speech plays it
whole, a shorter sound or one they talk over is dropped with its transcript (`heldSound`, `BC_*`; log
`gptlive_sound_dropped|played`, `sounds_dropped` on call end) + a "no listening sounds" line. Replies to a
finished sentence (~1 s later) are never held. Owner calls untouched (`talk` only). Re-drive, all ok:
greet ×3 0.94/1.30/1.01 s one opener; hello 0.54; noisy 1.06; quiet open 3.96 s then 1.07; interrupt
1.13 (resumed 0.92); robot 1.14; ivr, hold (`hold_gave_up`), voicemail (`voicemail_left`), human ok;
own `gptlive-drive bye.ulaw 30 --expect goodbye --cold` mutual goodbye, first voice 1.8 s.

## Calls 65–67 fixes + warmth + ambience (2026-11-01)

- **One phone, one call:** `call_place` checks `db.liveCallTo(number)` (any conversation, placing/ringing/in_progress, <75 min) right before `createCall` with no await between — same conversation → `already_on_the_call`, the new goal/facts appended to the row and handed into the voice (`gptlive.tellLive`, queued until the session starts); another conversation → `line_busy` only when it is a person's own phone (a business has many lines), nothing of either side in the refusal; a GPT-Live row still `in_progress` with no running voice (`gptlive.isRunning`) is ignored. Only a person's own GPT-Live call is "handed" the note. A goal over 600 chars is fitted (`fitCallBrief`: overflow → facts), never "Bad input".
- **Mid-turn photos fold** (router `#readMidTurn`): kind `image` with a `media_id` joins the running turn as "[they sent a photo, #id: photo_look id …]"; the picture rides as `_image` on the turn's next tool result (`withFoldedPhoto`). Voice notes/files still keep their own turn.
- **Purpose everywhere:** `call_place.opening` → greeting "hey <name> — <opening>."; without it a GPT-Live own call is told the goal for its first breath (`openingPurpose` + `greetingInstruction(greeting, purpose)`); the call turn gets `placedCallNote` (goal, facts, recent photos with ids).
- **Pre-call brief** (`preCallBrief`, own calls only, that conversation only): why it rang + facts, ≤6 recent chat lines (no stamps, nothing bracketed), and — only while they share location (live share, or a pin <3 h) — a neighbourhood/city via `notePlace` (looked up while it dials, never waited on). `OWN_CALL_LINES` (warm/chatty) sit after call 56's lines; prompt tests pin the order.
- **Honesty:** "Just texted." (no subject) is a claim; a result claiming sent/texted/emailed/messaged with no send tool that turn has the sentence replaced with "I'll text that to you." (a send said as earlier stays) (`withoutUnbackedSends`, log `gptlive_unbacked_send`). A `message_send` to their own number/`owner` skips the caller check (`verify.isConsequential(name, input, { toSelf })`).
- **Ambience** (`src/calls/ambience.js`, `REASON_CALL_AMBIENCE` owner|on, unset/off = none): café on own calls, office on errands; synthesized beds `assets/calls/ambience-{cafe,office}.ulaw` (20 s, `scripts/make-ambience.mjs`, deterministic, soft-limited so the room alone never passes the 1500 speech peak), mixed at gain 0.01875 (≈ −56 dBFS, about 26 dB under the voice at ≈ −30; 0.12 ≈ −40 until #330 on 2026-11-02, 0.075 ≈ −44 until 11-08, then 0.0375 ≈ −50 by .env until call 77 "still loud, reduce it by 50%") into every outgoing media frame — `REASON_CALL_AMBIENCE_GAIN` tunes it with no code change (`ambienceGain`: a number clamped 0–0.2, unset or not a number = 0.01875; live leaves it unset) and topped up 80 ms ahead between words on its own clock (never the call's playhead). Off on voicemail (AMD machine_end*), never on stranger calls, not in the recording. Drive: `AMB=on` + `gptlive-drive.mjs … --heard out.ulaw` saves what the caller heard.
- Tests: `test/call-warmth-ambience.test.js` (25 since #330; 25/25 on 2026-11-06 at `c6ce172`). In process, no call: `node -e 'import("./src/calls/ambience.js").then(m=>console.log(m.ambienceGain(""), m.ambienceGain("0.5"), m.ambienceGain("x")))'` → `0.01875 0.2 0.01875`.

## A call to a person speaks TO them (#333, 2026-11-05, call 74)

The goal is Reason's note from the owner's side ("ask Yaw whether he has heard…"); call 74 read it down the line as "Has Yaw heard…?" — to Yaw. Both third-party voices now carry `speakToThem({ ownerName })` (`src/calls/voice-prompt.js`) right after the goal — Reason's call turn (`thirdPartyFrame`) and GPT-Live talking for itself (`lineTalkInstructions`, `src/calls/gptlive.js`): whoever answers is who the errand is about, so "you"/"your"; their name only to greet or check it is them; somebody else answers → ask for that person, give the message only to them.

- Offline: `node --test test/call-speaks-to-callee.test.js` (4; reads both prompts). 4/4 on 2026-11-06 at `c6ce172`.
- Real voice: `bin/gptlive-line-drive.mjs <clips> --scene hello --goal "Ask Yaw whether he has heard how United are doing" [--fact "…"]` on Hetzner (real GPT-Live + claude-cli, no phone); read Reason's first line for "you". Not runnable from the cage (no model there).

## Pickup opener — first word ~0.6 s after pickup (#379, 2026-11-07) — `REASON_PICKUP_OPENER` (default on; `off` = the opening above exactly)

Calls 59–74 to businesses/people: pickup → first word 4.0–10.1 s (stream start → GPT-Live
`session.started` alone 1.2–1.9 s, and their early words were dropped), so receptionists said "hello?
can you hear me?" or hung up. Own calls (1.7–2.8 s) are unchanged and keep their live greeting.

- **The clip.** `dialGptLive` fires `opener.prepare(row)` and never waits (src/calls/gptlive.js:2510).
  `src/calls/opener.js`: `openerFor` (:58 — `config.pickupOpener` + `config.lineTalk`, not own, not
  inbound) → `openerText` (:48) = `Hi there! I'm calling <about>.`, or `Hi there!` alone (kind `hello`),
  or `Hi there — just so you know, this call's recorded.` where `src/calls/consent.js` needs it; `about`
  over 140 chars, with a URL/`@`/brackets, or with payment details (`findPaymentDetails`, R2-C) is dropped. Never "I'm an AI" / "calling for X". `makeClip`
  (:128, OpenAI TTS `REASON_OPENER_TTS_MODEL` default `gpt-4o-mini-tts` (src/config.js:654), same voice
  name as the live voice) → `pcm24ToUlaw` (:114, 24 kHz PCM → 8 kHz μ-law, 3:1), cached by text under
  `data/call-openers/`, swept after two days (`CLIP_KEEP_MS`, `sweepClips` :76). The hello-only clip is
  made beside it as the fallback. `take(callId)` (:178) hands it to the stream once
  (src/calls/gptlive.js:973); not ready at pickup → the old opening.
- **`call_place.about`** (src/tools.js:4123): the model's few words finishing "I'm calling …", only when
  ringing somebody else; screened for card/bank details with every other field before dialling (`checkCallForPaymentDetails` `about`, R2-C → `payment_details_refused`); stored as `calls.pickup_about` (src/tools.js:11421, ≤200 chars; column
  src/db.js:2104).
- **When it plays** (`pickupFrame`, src/calls/gptlive.js:1537; constants src/calls/opener.js:23–40):
  `OPENER_AFTER_THEM_MS` 550 ms after their hello ends, or `OPENER_SILENT_MS` 600 ms into a silent line;
  skipped if their greeting runs past `OPENER_MAX_THEIRS_MS` 3.5 s (recording/menu/mailbox) or the line
  never pauses within `OPENER_GIVE_UP_MS` 5 s. They talk in the first `OPENER_REPLAY_WINDOW_MS` 1.5 s →
  Twilio `clear`, replay once from the top after they finish; talked over `OPENER_TALKED_OVER_MS` 0.9 s
  later → cut, and the voice is told they may not have heard. Sent ~`OPENER_OVERLAP_MS` 240 ms ahead of
  its playing pace. After the clip, `OPENER_QUIET_AFTER_MS` 3 s of silence → one "Hello — can you hear
  me okay?" instead of the quiet-line "Hi there, hello?".
- **No double opener.** The voice gets `session.instructions.append` ("code just said … don't greet again")
  before their early audio (≤5 s, now kept and replayed into the session) goes in; the voice's own audio
  stays off the line until they speak after the clip (`ownOpener` :1761); their late hello transcript is
  placed before the clip and starts no line turn (`openerAnswers` :1693, `beforeOpener` :1701).
- **Logs:** `call_opener_ready`, `gptlive_pickup_opener` (`kind`, `ms`, `session_up`),
  `gptlive_pickup_opener_again|_cut|_skipped`; `gptlive_first_voice` gains `opener`.
- **Timing on the row + /ops.** At call end `calls.first_audio_ms` + `calls.pickup_opener` (`about`/`hello`/"")
  (src/calls/gptlive.js:2390; columns src/db.js:2102–2103). /ops row **"Calls: pickup → first word"**
  (`call_pickup`, money group, src/ops.js:633; `pickupCheck` src/ops.js:665): typical (median) and
  slowest of the last 20 timed calls, the latest call, "opener clip on N/M errand calls"; amber when
  typical > 2 s, "no calls timed yet" with none.
- **Outcome + mailbox:** the after-call read's `how` labels ([call-goal-met.md](call-goal-met.md)); an
  unset/full mailbox → one code-worded text ([call-machines.md](call-machines.md)).

Tests: `test/call-pickup.test.js` (15: words, μ-law, silent pickup, hello first, long greeting skipped,
replay, cut, no clip, /ops row, outcome mapping, calls 62/63). Real voice: `bin/gptlive-line-drive.mjs
<clips> --scene greet|hello|quiet` on Hetzner (real GPT-Live + OpenAI TTS + claude-cli; needs a real
`OPENAI_API_KEY`, so **not runnable offline or on the cage**). PR run: greet 4.74 s → 0.64 s, hello
2.72 → 0.65 s, quiet 4.07 → 0.65 s; their greeting end → first word greet 0.39 s ×3. Known: one drive
run leaked a stray fragment ("low back") of the voice's dropped reply after the clip.

Driven offline 2026-11-07 (rel-1107 `8bbcb96`, throwaway `REASON_DB_PATH`, `env -i`, no key, no
network): `openerText` about/hello/notice/URL-refused, `pcm24ToUlaw` 4,800 B → 800 B, `prepare` with a
stub TTS (both texts asked for, kind `about`), `take` once, own call and `REASON_PICKUP_OPENER` off →
no clip, `pickupCheck` on three timed rows → `warn · last 3: typical 2.1 s, slowest 4.7 s … opener clip
on 1/2 errand calls`: all ok, rc 0. `node --test test/call-pickup.test.js test/call-goalmet.test.js
test/call-machines.test.js` 42/42, rc 0. Not proven: a real business pickup (clip sounding like the
live voice, a real receptionist's hello against the 0.55 s / replay timing).

## What it hears (call-hearing, 2026-11-08, call 76)

Call 76 (Omari's own, 55 s): his quiet words (around −45 dBFS, about 20 dB under his loud ones) came
through as "Kibaga", "Right. Tell me." after he'd said "going home", and he got "what's that bringing
up for you?". The ambience mixes into the outbound audio only (his side sits at −74 dBFS between turns).

- **Quiet-speech lift** (`src/calls/hearing.js` `Hearing`, wired in `GptLiveCall.fromTwilio`): every
  inbound 20 ms μ-law frame passes through an AGC + noise gate + limiter on the copy that goes to
  GPT-Live only. The recording (`CallTape`), `hasSpeech`/`hasVoice` and the pickup timing still read
  the raw line. Speech = ≥10 dB over the line's floor (10th percentile of the last 3 s) and ≥ −55 dBFS.
  It's brought toward −26 dBFS with at most +20 dB, and never cut. The floor is never lifted past
  −55 dBFS (`NOISE_CEIL_DB`), so a noisy line gets less lift. The lift is held through 400 ms gaps and
  then eased to 0, the peak is limited at 26000, and the gain ramps per sample. While Reason's audio
  plays plus 700 ms (`ECHO_TAIL_MS`), the lift drops within 5 ms to +3 dB max, so their phone's echo
  is never lifted into a false barge-in. A frame at 0 dB lift is passed byte for byte.
  `REASON_CALL_HEARING=off` sends the raw line (default on). GPT-Live's `session.start` takes no
  input settings: no noise reduction, no VAD knobs, no transcript confidence (live API reference,
  read 2026-11-08). So it's done here.
- **Ask, don't guess** (`HEARING_LINES` in `src/calls/gptlive.js`, on own, line-talk and stranger
  prompts; plus the owner call turn's frame in `src/calls/voice-prompt.js` `ownerCallFrame`; errand
  turns already had it in `voice.js` `thirdPartyRules`): ask briefly about the unclear part
  ("sorry, you cut out — where?") at most once, then go with the best reading said aloud.
- **Friend, not therapist** (`OWN_CALL_LINES`, `ownerCallFrame`): "chatty … ask natural follow-ups" is
  replaced with "easy, practical and short" plus a guard that bans "what's that bringing up for you",
  "how does that make you feel" and feelings-probing.
- **Per-turn log** `calls.turn_log` (JSON; `turnLog()` written at call end, not for stranger calls):
  `{who, text, from_s, to_s, session_ms?, level_db?, boost_db?}`, timed from stream start. `session_ms`
  is the transcript delta's own `start_ms`/`end_ms`. `level_db`/`boost_db` are the median raw level and
  lift of their speech frames in the turn's window (from − 2.5 s transcript lag). It lives on the
  person's own row only: never journaled, not on /ops. The retention sweep empties it with the
  transcript (`dropped.call_turn_logs`); a delete or export takes the row.

Recipes:
- Offline: `node --test test/call-hearing.test.js` (16: lift, loud untouched, hiss/gust not lifted,
  noisy-line ceiling, limiter, echo cap, fast drop, long stretch, flag off byte-for-byte, recording raw,
  turn_log + no words in the journal, retention, prompt lines).
- Levels on a real call, **on Hetzner only** (a recording never leaves the box):
  `node bin/call-hearing-levels.mjs /opt/reason/data/recordings/call-N.wav --repo <checkout>`, run as
  `reason`, which prints each speech stretch before and after the lift. Call 76: quiet stretches
  −45.0 → −30.4 dBFS median (6), loud −26.1 → −25.6 (6), silence ≥1 s from speech −78.7 → −78.7,
  0 samples at the rail.
- Real voice: `bin/gptlive-drive.mjs <clip.ulaw> 18 --expect hearing --words "Kumasi,Kejetia"` with
  `REASON_CALL_HEARING=off` then on (real GPT-Live, claude-cli via the test token and a scratch
  CLAUDE_CONFIG_DIR, no phone). 2026-11-08, a clip at −51 dBFS + pink noise: off heard "the mathy … Khadija
  Market" / "Gamathi … Gadisha Market" (2/2 wrong), on heard "Kumasi … Kejetia Market" (2/2). A −45 dBFS
  clip was heard right both ways. A 0.7 s dropout over a place name is transcribed as clean text ("I'm in.
  Right now.") and the voice doesn't ask about it (2/2); one backend turn asked where but guessed "the gym".
  **Not proven: a real phone call.** Whether the voice asks once about a truly garbled word on a real call
  is also unproven.

## Call 79 fixes (2026-11-08) — holding lines by code, short answers, today so far, limits, warm first turn, talk-over

Call 79 (Omari's own, 187 s, 6 hand-offs, no tool run on any): every reply opened with "let me check /
looking that up"; the last two answers ran 25 s / 32 s; "I don't have anything saved" about Bo Peep, its
own pick by text that day; "I'm —" over his "how are | you" at 0:07; first answer 4.3 s vs ~2.3 s later;
"aim for after 9" when he'd said "7 or later".

- **Holding lines (`src/calls/gptlive.js` `holdLine`, `holdLineFor`, `NO_HOLDING_LINE`, `WAIT_NOTE`):** every
  non-line call's session has `delegation.acknowledgement_delay_ms: 800`; on each hand-off a quiet
  `session.thinking.append` (`WAIT_NOTE`) cancels the voice's automatic acknowledgement. Answer back within
  `HOLD_LINE_AFTER_MS` (1.5 s): no line at all. Later: one commentary "Say only this…" with `QUICK_HOLD_LINES`
  ("Mm, one sec." …), or `CHECK_HOLD_LINES` ("Let me check." …) only when `onTool` (new hook through
  `reasonTurn` → `llmRequest` → `voiceTurn`, tool_start/tool_use of Reason's own non-platform tools) reported
  a lookup (`isLookup`: sends/bookings/timers are not "checking"). The first line waits while they or the voice
  are speaking (voice quiet 1.2 s). At `LATE_HOLDING_MS` (7.5 s) one late line from `LATE_LINES` ("Still
  checking." only with a lookup). Line calls unchanged. Log `gptlive_hold_line {kind, ms, tool, line}`.
- **Named hand-off line (Omari 11-08, #406, after the paid replay):** on their own call the voice says one short
  line naming the lookup/action AS it hands over (`HANDOFF_ACK`: "Weather near work, one sec.", "Pulling up
  Nigeria headlines."; never a bare "one sec"/"let me check", never before a passed-on yes/no or something
  unclear, never twice in a row); `OWN_NO_HOLDING_LINE` / `OWN_NO_FILLER` / `OWN_WAIT_NOTE` replace the relay's
  versions there. `turn.preAck` (voice words since their latest words began) or `turn.ack` → `voiceAcked` → code
  says no first line. Code's first line, when the voice said none, names the tool (`toolHoldLine`: "Getting the
  weather.", "Checking where you are.", "Searching the web for that.", "Sending it now."); a tool with no named
  line gets none (QUICK_/CHECK_HOLD_LINES are gone). The platform's automatic acknowledgement is still
  cancelled at once: left to play (drive v4) it came ~1 s later and stock ("Working on it."). Drive v3 (CLI,
  OVH): named lines on 4/5 lookup turns at 1.5–2.0 s after his words; "No" answered by the voice, no line.
  Headlines/lists: the top one or two in two short sentences, then the offer (`ownerCallFrame`; the paid
  replay's 24 s Nigeria read ran into the next clip = its 1.6 s talk-over). The cq drive prints `played` and
  `speech_runs` (ms) for talk-over.
- **Short answers:** `ownerCallFrame` says one or two short sentences, then offer more. Floor in code
  (`shortForPhone`): a spoken answer over `LONG_REPLY_CHARS` (180, ~12 s at ~15 chars/s) on their own call is
  said as whole sentences up to `SHORT_REPLY_CHARS` (150) + `TEXT_REST_OFFER`; one ending on a question keeps
  that question word for word and adds no offer; never cut when `sayWhole` (confirm/commit/propose/readback/
  quote/send tools, or end_call). The whole answer rides as `textOfferNote` on the voice's own words for the
  next 2 hand-offs (never on the caller's — the harm screen reads those); Reason texts it with
  `message_send` to "owner" if they want it; a send spends it. False "sent" still blocked by `withoutUnbackedSends`.
  Log `gptlive_reply_cut`.
- **Today so far (`src/calls/brief.js` `todaySoFar`, `todaySoFarNote`, `namesIn`; `db.messagesBetween`):** the
  call's own conversation only, local midnight (≥6 h back) up to the row's `created_at`, ≤1600 chars, names
  (Bo Peep, The Ragtrader); thread fallback when REASON_WEB is off (lines stamped today). Read once per call
  id (prompt stable for the cache). In `ownerContext`'s system prompt; names in the voice's `preCallBrief`.
  Rules in `ownerCallFrame`: look (today, thread, memory/message search) before saying there's nothing; match
  odd words to today's names; a limit they set ("7 or later") is said back once and kept to.
- **Warm first turn (`warmTheTurn` → `voice.warmCallCache`, `REASON_CALL_CACHE_WARM`, default on):** own calls at
  dial (`dialGptLive`) and at inbound routing; errands at stream start (`GptLiveCall` `warmTurn`, the opening
  line is only settled then). API backend only. Prefix: own ~118k tokens (266 tools), errand ~6k (12 tools).
  Log `call_cache_warmed {cache_write, cache_read}`.
- **Talk-over (`overTalk`, `overRelease`, `overDrop`, `overNudge`; `Hearing.speech`):** a run of the voice's
  speech that starts while their speech (over the line's floor, not the echo of the voice's last words) is
  under `TALKOVER_QUIET_MS` (300) old — `FIRST_EXCHANGE_QUIET_MS` (700) on their first reply to the greeting —
  is held, then played whole once they have been quiet that long. Still talking at `TALKOVER_MAX_MS` (2 s) with
  their words coming through: dropped, its words taken off the transcript, `OVER_NOTE` to the voice, and
  `OVER_NUDGE` if it hasn't answered once they've been quiet 0.9 s; no words through (noise): played by 3.5 s.
  A ≤2-word unterminated fragment the voice gave up on is dropped, not replayed. Only SPEECH keeps a dropped
  run alive (the session streams silence between words — the 2026-11-08 drive caught every later reply being
  muted). Guard clear throws a held run away; a barge-in clear leaves it waiting; never while ending (a held
  goodbye is released first). Logs `gptlive_talkover_held|dropped|nudged`.

Recipes:
- Offline: `node --test test/call79-fixes.test.js` (30: each behaviour above, incl. byte-identical warm/first-turn
  prefix, nobody else's thread, the silence-keeps-drop-alive regression).
- Whole-call replay, **on Hetzner** (real GPT-Live + Reason's real turn on claude-cli, fake Twilio, throwaway db
  seeded with a "today" thread; ~3–4 min, ~15¢ of voice): `bin/call-quality-drive.mjs <clips-dir> --out x.json`
  from a copy of main and of the branch (keys via `bin/drive-env.sh` + `node --env-file`, never on argv). Clips 1–6 = call 79's
  lines (`say -v Samantha`, "how are [[slnc 450]] you?" for the cut-in). Prints per reply latency, seconds of
  speech, talk-over ms, holding phrases, and a timeline. claude-cli turns are 4–11 s, so most hand-offs get a code
  holding line in the drive; on the live API (~2–4 s) more answers land inside 1.5 s.
- Not drivable without the API: the warm cache hit itself (check `call_cache_warmed` + the first `voice_turn`
  first_word_ms on the next real call). **Not proven: a real phone call.**

## Call 80 fixes (2026-11-08) — say the answer, Reason's own voice, same memory as texts, weather by coordinates

Call 80 (Omari's own, 104 s): "weather where I'm at" → code cut Claude's 476 chars to the pre-tool narration
("I'll grab your location first…") + "want me to text you the rest?"; the weather was heard 79 s in, half-said;
work (430 W 17th) and "works Thu–Sun" were in memory but not in the call turn; no "how to treat me" rules on calls.

- **No code cut (`src/calls/voice.js`):** `shortForPhone`/`TEXT_REST_OFFER` are gone. Words written before a
  tool round are dropped (`voice_lead_in_dropped`); only what comes after the last tool is said; a silent final
  round falls back to the last lead-in (`voice_lead_in_said`). "Text you the rest" only from the prompt, when
  the content is naturally long (headlines, lists).
- **Streamed (`gptlive.js` `speakPiece`, `readTurn({onContent})`, `PIECES_LINE`):** each finished sentence goes
  to the voice as a commentary piece; `gptlive_result {pieces, first_piece_ms}`.
- **Real tools (`onTool(name, "start"|"done", {ok})`):** "Let me check" only while a lookup is running; the
  unbacked-send guard uses tools that really ran (`turn.ran`).
- **Same memory (`src/calls/callmemory.js`):** saved places + schedule facts by meaning (`prepareCallMemory`, while
  it rings, memo per call, 2.5 s cap) in `whereaboutsNote`; per-turn recall `memoryHits` (≤`CALL_RECALL_WAIT_MS`
  700 ms); rules via `src/rules.js` `rulesNote`, fresh every turn.
- **Fix 2 — Reason's own voice on own calls (`liveInstructions` owner branch: `OWN_VOICE_PERSONA`,
  `OWN_VOICE_SPLIT`; `preCallBrief` adds profile ≤2500, rules, today, places):** the voice answers small talk
  itself; any lookup, action or live fact goes to Reason. Errands and anyone else's call keep the relay ("You
  are only the voice") with nothing of his. OpenAI receiving his profile/rules: owner-approved 2026-11-08.
- **Rules everywhere (`src/rules.js` `RULE_READERS`):** one reader; contract test fails on any model-reaching
  file not listed. Missing before: Claude's call turn, GPT-Live, event turns (API + CLI), Web daily greeting,
  onboarding's one-line answers.
- **Weather (`src/weather.js`, tool `weather`):** open-meteo by lat/lng (6 s timeout), `REASON_WEATHER_BASE`.
- **Sound:** talk-over wordless cap `TALKOVER_WORDLESS_MS` 1000 (transcripts trail speech 0.5–1.5 s); `fadeOut` (240 samples) on a run's last frame;
  `AMBIENCE_GAIN` 0.009375; `NO_FILLER` (no uh/um, no own "one sec").
- **Shared with the time-to-first-word work:** `callNotes(call)` (callmemory.js: rules + where, sync, own only)
  and `voiceInstructionsFor(call, {line})` (gptlive.js: the exact session instructions).

Recipes:
- Offline: `node --test test/call80-fixes.test.js test/rules-everywhere.test.js` (incl. rule after call N in call
  N+1, nothing of his on Ama's call or an errand).
- Replay, on the live box: `bin/call-quality-drive.mjs <clips> --seed call80 --out x.json` (his places, week, rule;
  texts to a stand-in; per reply `first_piece_ms`, totals `hard_stops`, `lead_ins_dropped`, `tools_ran`), main vs
  branch. 2026-11-08: replies_cut 4→0, hard_stops 2→0, longest reply 12.4→9.3 s, weather said whole on the
  first ask (before: never). claude-cli turns 6–31 s in the drive, so the 7.5 s late line still fires there.
- Not proven: a real phone call; the news turn (search keys absent in the drive env).
