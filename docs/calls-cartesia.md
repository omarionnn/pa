# The Cartesia call voice: how it is wired, and what must be true before it is on for everyone

The research behind this (Cartesia's plans, limits and data handling, three designs compared, the
listening and call-feel scripts) is on the `cartesia-explore` branch (commit 749fda71), not on main.
Section 5 is the design that was built; its number is kept so the code's references to it hold.
Unproved parts are in `docs/unverified.md`.

## 5. Design 3, bridged: built (`owner` #538, `on` for everyone in this change)

**The switch**: `REASON_CALL_CARTESIA` = `off` | `owner` | `on`; unset (or anything else) is `off`.
- `off`: nothing is reachable: no tool, no Cartesia call, whatever anyone has stored.
- `owner`: exactly as it was before `on` existed. It changes nothing by itself; it makes the choice below
  available to the operator's account only, and that account's stored choice turns it on.
- `on`: the Cartesia voice is simply the voice of every account's own calls with Reason. There is no
  per-person choice: nobody is shown the tool below (the operator neither) and nothing stored is read.
  The old voice (GPT-Live) is only the automatic fall-back when Cartesia is not ready in time, refuses
  the session or fails mid-call. **Do not set it until every item in
  "Before `on` is set" below is true.** Merging the code changes nothing until the switch is set.

**Before `on` is set** (all of these, checked by a person, not by code):
1. **A paid Cartesia plan with a commercial licence.** The Free plan is "personal, non-commercial use
   only"; the commercial licence starts at Pro (cartesia.ai/legal/terms §4.1, read 2026-11-12).
   **Agent overages: OFF (the owner's decision).** On paid plans new calls stop once the agent balance
   reaches $0 (cartesia.ai/pricing FAQ, read 2026-11-13), so when the month's credit runs out, calls
   fall back to the old voice (`refused_out_of_credits`, or `closed_before_ready` if Cartesia says
   nothing) until the plan refreshes. The ops meter (PR #546) texts the owner at 50/80/100%.
2. **The training opt-out filed** at play.cartesia.ai/privacy/data-controls. By default Cartesia may train
   on inputs and outputs (terms §5.3(c)); the opt-out covers only what comes after it.
3. **The public privacy page updated.** Draft wording: `docs/privacy-drafts/2026-11-13-voice-and-bank.md`.
4. **The cost, expected per minute**: Cartesia bills agent calls at **$0.03 a minute**, plus the agent
   model's tokens, which "depend on the model your agent uses" (`GET /v1/agents/models` lists them); the
   +$0.014 telephony add-on is only for a Cartesia number, and these calls use our own Twilio leg
   (docs.cartesia.ai/pricing, read 2026-11-13). The token share measured on 2026-11-12 was about $0.006 a
   minute on the fastest listed model, so **about $0.036 a minute**, plus Twilio as on every call.
   `CENTS_PER_MINUTE` in `src/calls/cartesia.js` (3) is the agent rate alone.
5. **The plan's concurrency limit**, as their current docs state it: "Concurrent call limits by
   subscription tier: Free 8, Pro 12, Startup 20, Scale 60. These limits apply to concurrent Line agent
   calls—inbound, outbound, and batch. They are separate from TTS and STT concurrency limits"
   (docs.cartesia.ai/line/infrastructure/scaling, read 2026-11-13; the TTS/STT page,
   docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts, says "Managed agents have separate
   agent-call concurrency limits" and links there). What happens to an agent call over that limit is
   **not stated** on either page (for TTS and STT: Free gets a 429 at once, paid plans queue up to 10×).
   Over it, or out of credit, a call falls back to GPT-Live (below) and is counted by reason.
6. **The agent's saved keyterms are shared words only.** One agent carries every account's calls. If it
   was made with `--keyterms` while it was one person's, clear them first:
   `node scripts/cartesia-agent-setup.mjs --update <agent id> --clear-keyterms --yes` (each call still
   brings its own eight from that person's own chats).

**Per person, with `on`**: nothing in the relay or the agent is one account's. Each call's dynamic
variables come from that call's own row: their name (never the stand-in an unnamed account reads as),
their opening line, the GPT-Live own-call words with their own brief and carryover, their keyterms from
their own chats today, and their own clock (`clockLine`, and the whole build run on their zone,
`zonescope.runFor`), since the agent has one time zone set on it. Units come from Reason's answers, which
read their profile. A late answer is texted to that call's own thread ("From our call: …"); the end runs
the same settle as a GPT-Live call on that row. Several calls at once on the one agent each have their
own socket, turns, asks, tape and Cartesia call id (`test/call-cartesia-everyone.test.js`).

**The day's numbers**: `cartesia_daily` (numbers only: day, what, n), read in `/ops.json` as
`counts.cartesia`: `calls` tried, `ready`, and `fell_back` by reason (`not_ready`,
`refused_plan_limit`, `refused_out_of_credits`, `refused_auth`, `closed_before_ready`,
`error_before_ready`, `closed_mid_call`, `error_mid_call`, `could_not_open`, `not_loaded`, `other`).
No check, no text to anyone. The same reason is the `reason` field on each `cartesia_fell_back` log line.
A refusal is read from what Cartesia says (a close reason, an error code or message: 402/credit/balance,
429/limit/concurrency, 401/403/key); the exact words of a refused agent session are not documented, so
one that says nothing is `closed_before_ready`.

**The operator's trial choice (`owner` only)**: one small tool, `call_voice_trial`, shown only to the
operator's account and only at `owner`: "try the Cartesia voice on my calls" turns it on, "go back to my
usual call voice" turns it off (`accounts.call_trial`, "" or "cartesia"). At `on` nobody has it: there is
no per-person choice, and asking to change the voice finds no tool for it. At `off`, nobody either.

**Which calls**: a person's own calls with Reason only (`is_owner = 1`), either direction: the
operator's at `owner`, anyone's at `on`. Never, in any mode, a call to a business or another person,
a call on someone's behalf, an event call or a stranger's call: Cartesia stores a recording of every
agent session while it runs and those people were not told.

**How normal calls stay untouched**:
- Off unless the switch is set (and at `owner`, unless the operator's choice is on). Otherwise
  `acceptStream` builds `GptLiveCall` exactly as before.
- One branch in `acceptStream`, and the new relay is imported only inside it. `GptLiveCall`, its
  prompts, the turn gate and the opener are not edited.
- If the Cartesia session is not ready within 1.5 s of the stream starting, or fails, that same call
  carries on with GPT-Live and the fall-back is logged. A broken session never costs anyone a call.
- Tests pin all of it: switch unset, switch `owner` with the choice off, another account at `owner`,
  a business or third-party row in every mode — each builds `GptLiveCall` and opens no Cartesia socket.
  And at `on`, a stored "usual" (or anything else) does not take a person's own call off Cartesia.

**Files**:
- `src/config.js`: `callCartesia`, `cartesiaKey` (`CARTESIA_API_KEY`), `cartesiaAgentId`, `cartesiaVoice`.
- `src/calls/cartesia.js` (new): `CartesiaAgentCall`. Twilio media to and from the agent WebSocket
  (`mulaw_8000`, `continuous_input`, `speaking_pace`). `audio_output` goes out through the same
  ambience mixer and `CallTape`; `audio_output_clear` clears Twilio; `client_tool_call` for
  `ask_reason` runs `reasonTurn` and answers with `client_tool_result`; `turn_ended` gives the turns
  for the thread. It offers `settleGptLive` the same surface `GptLiveCall` does (turns, seconds,
  tape, why it ended), so carryover and the after-call text work unchanged. At the end:
  `DELETE /agents/calls/{call_id}`, checked for `redacted_at`.
- `src/calls/gptlive.js`: the one branch in `acceptStream`; no pre-opened GPT-Live session for a
  trial call.
- `src/tools.js`, `src/db.js`: the tool and the column.
- `scripts/cartesia-agent-setup.mjs`: makes the agent once (instructions that take the call's brief,
  shared keyterms plus eight per-call slots each call fills from that person's own chats, `ask_reason` as a client tool that waits for its result,
  `end_call`), prints its id for `.env`.
- `test/call-cartesia.test.js`, `test/call-cartesia-music.test.js`, `test/call-cartesia-everyone.test.js`
  (two accounts at once), with stand-in sockets as `test/gptlive.test.js` does.

**What gets measured on each call** (numbers only, in the log):
- They stop talking to the first agent audio with speech in it, per reply; plain replies and
  `ask_reason` replies apart.
- `ask_reason`: asked to answered (Reason's brain), and answered to first speech (their model + Sonic).
- Talked over: their first sound to `audio_output_clear` to our Twilio clear.
- Their own clock for each turn (`turn_ended`: end time, eager-end time) beside ours.
- Laughs written by the model, and by ear whether they were laughed.
- Any name or place misheard, with keyterms on.
- The cost of the call and proof its recording was deleted.
- **And the same day, the missing number on a normal call**: one log-only line in `audioOut` for
  the first audio *with speech in it* after a hand-back (`first_real_ms` is not that). Without it
  there is nothing honest to compare against, for this design or the hybrid.

**Recordings**: only Enterprise can stop Cartesia storing them (Zero Data Retention); below it the
relay deletes Cartesia's copy at the end of every call (`DELETE /agents/calls/{id}`, checked for
`redacted_at`, tried up to 4 times, logged as `cartesia_recording_deleted`), and a session that came up
after a fall-back is deleted too.

