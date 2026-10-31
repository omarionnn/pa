# GPT-Live calls — OpenAI's voice in front of Reason, owner-only trial

`REASON_CALL_VOICE=gptlive` puts OpenAI GPT-Live (`gpt-live-1`; voice `REASON_GPTLIVE_VOICE`, live =
`willow` since 2026-10-31, default `marin` which is asked for a light British accent) on the **operator's own** calls, in place of ElevenLabs, so the two can be compared.
Unset: every call is ElevenLabs byte for byte — `withGptLive` hands back the provider itself and the
upgrade listener and the two Twilio routes are not registered. Another person's calls and every
business call stay on ElevenLabs whatever the flag says.

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
TwiML; status at `/calls/gptlive/status/{token}`. Inbound: `/calls/gptlive/inbound` (owner → stream,
everyone else `<Redirect>` to `REASON_GPTLIVE_INBOUND_FALLBACK_URL`, ElevenLabs' own Twilio URL), live
only if the number's voice webhook is pointed there. **Needs `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`
in `.env`** — the number lives inside ElevenLabs and its keys were never on the box; without them an
owner call quietly stays on ElevenLabs (`missingForGptlive`).

Metrics: the row's `provider` = `gptlive`, `tts_model` = `gpt-live-1/marin`, `cost_cents` = voice
seconds at 5¢/min (Reason's own turn tokens are on its call_turns rows as before), `end_reason` as
ever. Each turn's call_turns row (written by Reason's turn) gets `voice = 'gptlive'` and what the
caller HEARD: `first_content_ms` = first voice audio after the delegation (usually its own ack),
`first_real_ms` = first audio after Reason's answer reached the voice. `scripts/call-report.js`
prints a `voice elevenlabs:` and a `voice gptlive:` line. The recording is the bridge's own mix
(`CallTape`, 16-bit 8 kHz WAV).

Source: `src/calls/gptlive.js`, `src/calls/wsserver.js`, `src/http.js` (upgrade + two routes),
`src/serve.js` (`withGptLive`), `src/tools.js` (`call_place` writes `placed.provider`), `src/db.js`
(`call_turns.voice`, `markCallTurnHeard`, `provider` updatable), `src/calls/report.js` (`voices`),
`src/config.js` (`callVoice`, `gptlive*`, `twilio*`).

Tests: `node --test test/gptlive.test.js` (27).

Who made Reason (#295, superseded by #296 maker.js): `agent.js builtByLine(me)` — "built by Omarion Nyarko" only to the operator; every other user hears "made by the Reason team", no name (text and both call voices, via `systemFor`; GPT-Live via `whoFor().operator`). Drives: `gptlive-drive made.ulaw 16 --expect made --as user|owner`; `call-identity-drive.mjs` cases `user-made` / `owner-made`. Not changed: the first-chat onboarding classifier (src/onboarding.js, dark) still names him.

Drive (real GPT-Live session + Reason's real turn on claude-cli, fake Twilio stream through the real
upgrade route, throwaway db, no phone; ~2¢ of OpenAI voice) — on Hetzner from a copy of the code, as
the `reason` user, keys read from `/opt/reason/.env`:

```bash
sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason USER=reason LOGNAME=reason \
  OPENAI_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… REASON_DB_PATH=$(sudo -u reason mktemp -d)/gl.db \
  node .agents/skills/verify-reason/bin/gptlive-drive.mjs q.ulaw 30 [--expect identity] [--cold] [--ring 5000]
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

## Maker = Saafi Interaction Labs (#297, 2026-10-31)

`config.makerName` defaults to "Saafi Interaction Labs" (REASON_MAKER only overrides); `src/maker.js`
is the one answer for texts (`systemFor`), onboarding and both voices, for every user, not gated. The
"he built you, smart guy" deflection is gone: probed further, Reason says it's still the company and
invents nothing. Test: no string literal under src/ or assets/ says Omarion/Nyarko, and the built
prompts (text, ElevenLabs own/third-party, GPT-Live) don't either. Left on purpose: the repo address
`github.com/omarionnn/pa` on /privacy and /terms and in the web-lookup user-agent (a real link, not a
credit), code comments, test fixtures, drives' throwaway "Omari" operator, `config.ownerName` default,
LICENSE copyright, docs/usecases.json (internal).
