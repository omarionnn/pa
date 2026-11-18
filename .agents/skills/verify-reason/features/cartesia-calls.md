# Cartesia calls — the voice on everyone's own calls (GPT-Live stays for free-tier callers and errands)

**Live state (switches.txt, 2026-11-14):** `REASON_CALL_CARTESIA=on` (everyone), `REASON_CALL_FEEL=classic`,
`REASON_CARTESIA_LOOKUP_MUSIC` set, `REASON_CALL_CARRYOVER=on`, Cartesia key + agent id set. Code defaults:
Cartesia `off`, feel `current`, music off, carryover `off`.

## Sub-features
- **Who gets the Cartesia voice** (`src/calls/calltrial.js` `cartesiaTrialFor`, #545 #575). `on`: every
  call between an account's own person and Reason (`is_owner=1`, either direction) when
  `CARTESIA_API_KEY` + `REASON_CARTESIA_AGENT_ID` are set. Never: a call to a business or another person,
  a call on someone's behalf, an event call, a stranger (Cartesia records every agent session; those
  people were not told). `owner` = the operator only, and only after he chose it with `call_voice_trial`;
  `off`/unset = never. GPT-Live carries the call as the automatic fall-back (agent not ready, refused,
  failed: `cartesia.js` `fallBack`, Twilio stream handed over by `passableSocket`).
- **Monthly free-tier callers are on Cartesia too, with no cut** (owner, 2026-11-15): `FREE_CALL_SECONDS` is null
  unless `REASON_FREE_CALL_MINUTES` sets one (unset live). With it set, those calls go back to GPT-Live with that
  limit and a wrap-up cue 30 s before the end (`FREE_CALL_GRACE_SECONDS`), the line closing with
  `endWhy="free_call_limit"` (`src/calls/gptlive.js`). The 2 calls a month still count and gate. Paying, free-for-good, the operator,
  strangers and errand calls: no limit. Every Cartesia call has the same platform ceiling as GPT-Live
  (`callPlatformCapSeconds`, `cartesia.js:550`).
- **Classic feel** (`REASON_CALL_FEEL=classic`, `src/calls/callclassic.js`, 07bc056b #574): every
  account's own Cartesia call gets the rule words and keyterms exactly as the build of call 112
  (`REF_COMMIT` 752a9e72) gave them, with only that caller's own slots (name, notes, brief); the opening
  line is the one written ahead for them (next bullet), never a pick-up from the last call. Kept on top:
  earlier-call notes, what was texted since, the passphrase line (call trust on), the honest quiet turn and
  the done-claim check. Read-back is off in the owner frame under classic (`voice.js:549`).
- **The opening line is written ahead for each person** (#586/#587, 2026-11-15, `src/calls/greetings.js`).
  The agent speaks `{{greeting}}` as its first message: `openingLineFor` (`src/calls/inbound.js`) →
  `greetingFor` (`src/calls/carryover.js`) → `pickGreeting`, a synchronous read of lines the side model
  wrote for them by time of day (`BANDS`: morning/afternoon/evening/night, "again" within 30 min; a
  `salute` for calls Reason places), checked by `greetingOk` (≤12 words; no number, time, price, place,
  claim, "what did we miss", wind-down or goodnight; a hello in it; never their last three or the
  assistant's nickname), else plain `Hey <first name>.`. No fixed lists, no code lead-in ("yo,").
  Written after each own call (`refillSoon` from `settleGptLive`) and when a band runs low; lines that
  no longer pass are dropped at pickup (`purgeStock`). Current feel with carry-over: a call back within
  30 min still opens from the last call's notes. Log `{"call_greeting":…,"from":"written"|"plain"}`.
  Offline: `test/call-greetings.test.js`.
- **Soft music during lookups** (#543, `src/calls/lookupmusic.js`): a loop fades in only after a lookup has
  run 700 ms (`MUSIC_DELAY_MS`), ducks under speech, own calls only, never when the room is already music.
  `REASON_CARTESIA_LOOKUP_MUSIC` = a variant name or on/1/true/yes (default variant); empty = no music.
- **Done is Reason's word** (#563, `cartesia.js` `saysDone` `:190`, `confirmsDone` `:200`, check `:725`):
  when the voice says "it's done / submitted" (or a bare "yes" to "did it go through?") and no answer of
  Reason's in the last minute said so, it is logged (`cartesia_unbacked_claim`), counted, and a note is
  written into the call record so Reason's next turn and the after-call text correct it. Questions,
  "no worries", futures and offers are not claims. A "I don't remember earlier calls" line is flagged the
  same way (`cartesia_memory_claim`).
- **How a call feels** (2d5e8b70, call 113): internal markers ("Skipping for now.", tool names) never
  spoken (`VOICE_MARKERS`, `forVoice`), a talked-over answer offered again, a deferral said out loud, a
  missed turn picked up after "hello?", openers never repeated (221d9b30).
- **Calls remember the last call** (`src/calls/carryover.js`, af87c764 #500, 733d2f77): when an own call
  ends, a short read (what they said, what Reason said it would do, what is open) is kept on
  `calls.summary`; the next calls for two days start with it (`earlierCallsNote`), plus the day and time
  and what was texted since; a call back within 30 min opens from those notes (`PICKUP_MS`). Instructions
  are fitted by priority (`fitprompt.js`): honesty rules are never cut.
- **Model API refusing mid-call** (#495, `src/calls/voice.js:329`): credit/billing/key refusals end the
  call with "I'm having trouble on my end, so I'll text you instead. Talk soon." (on someone else's call:
  "I'm sorry, I have to go. Thanks for your time.") and Reason carries on by text. Cartesia's own refusal
  maps to `refused_out_of_credits` (`cartesia.js:311`) and falls back.

## How to get to it (user POV)
Call Reason's number from your own phone, or text "call me" / set a scheduled call. A paying or
free-for-good account and a monthly free-tier account both hear the Cartesia voice, with no 5-minute cut. Ask for a lookup ("what's the weather")
and soft music plays while it runs. Ring back within half an hour and the opening picks up from the last call.

## Driving it with the harness
Offline (no model, no network) — through the slot gate:
```bash
bash /tmp/verify-upkeep/slot.sh <log> -- node --import ./test/paid-key-guard.js --test \
  test/call-cartesia.test.js test/call-cartesia-everyone.test.js test/call-classic.test.js \
  test/call-classic-everyone.test.js test/call-cartesia-feel.test.js test/call-cartesia-music.test.js \
  test/call-carryover.test.js test/call-memory.test.js test/call-credit-refusal.test.js \
  test/call-greetings.test.js
```
No-model probe (routing matrix incl. free tier, done-claim words, music delay; throwaway db, fake keys):
`node .agents/skills/verify-reason/bin/call-probe.mjs cartesia` → `all ok`.

Live: **paid**. Only a real call proves the voice, the music and the wrap-up cue: one own call on the live
server (OVH, root@15.204.113.250) from a test phone, ~2–3 min ≈ $0.30–0.50 (Cartesia agent minutes +
Twilio); a free-tier call is no longer cut, so it is bounded only by the platform ceiling (60 min). Read-only after a call:
`journalctl -u reason | grep -E 'cartesia_|gptlive_free_call_wrap|free_call_limit'` on that server.

## Gotchas
- `on` reads nothing stored: `call_voice_trial` and `accounts.call_trial` only matter at `owner`.
- Free tier needs `REASON_PAYWALL=on` + monthly free tier and an account created after the ship time;
  the operator is never limited.
- The done-claim check cannot stop words already spoken (the agent socket takes no correction); it fixes
  the record and the text after, so prove it from the record/log, not the audio.
- Without the Cartesia key or agent id, `on` silently means GPT-Live for everyone.
