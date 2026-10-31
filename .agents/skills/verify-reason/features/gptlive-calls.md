# GPT-Live calls — OpenAI's voice in front of Reason, owner-only trial

`REASON_CALL_VOICE=gptlive` puts OpenAI GPT-Live (`gpt-live-1`, voice `marin`, asked for a light
British accent) on the **operator's own** calls, in place of ElevenLabs, so the two can be compared.
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

Tests: `node --test test/gptlive.test.js` (15).

Drive (real GPT-Live session + Reason's real turn on claude-cli, fake Twilio stream through the real
upgrade route, throwaway db, no phone; ~2¢ of OpenAI voice) — on Hetzner from a copy of the code, as
the `reason` user, keys read from `/opt/reason/.env`:

```bash
sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason USER=reason LOGNAME=reason \
  OPENAI_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… REASON_DB_PATH=$(sudo -u reason mktemp -d)/gl.db \
  node .agents/skills/verify-reason/bin/gptlive-drive.mjs q.ulaw 30
```

`q.ulaw`: `say -o q.aiff "Hi, can you check what is on my calendar tomorrow morning?" && ffmpeg -i q.aiff -ar 8000 -ac 1 -f mulaw q.ulaw`.
Expect `ok`: one delegation, a result with chars, the turn tagged `gptlive` with `first_real_ms`, row
`completed` / `gptlive` / `recording: stored`. First run 2026-10-31: ack heard at 38 ms, Reason's
answer (calendar_events) 10.8 s, spoken right after; 28 s, 2¢; guard trips 0.

Never: drive the live service's routes, or place a real call to test it (that rings the owner).
