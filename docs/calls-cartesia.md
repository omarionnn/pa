# Cartesia for Reason's calls: what was found, and how to test it

**2026-11-12. An owner-only experiment. Nothing on the call path has changed.** Calls are GPT-Live over
Twilio exactly as before (`src/calls/gptlive.js`). This page and two scripts are all there is: no
code in `src/` reads a Cartesia key, and no call can reach Cartesia.

Why look at it: Cartesia is said to be very fast, expressive, and able to laugh. The short answer
from the reading and measuring below: **the voice itself is the likely win (laughter and feeling on
demand, exact words, names said right); a faster call end to end is not proven**, because speech
synthesis is not where a call's wait is today.

Every provider fact below was read on 2026-11-12 from the page named beside it. Guesses say so.

## 1. Two tests the owner can run now

Both read `CARTESIA_API_KEY` from the environment, else `./.env`, else `~/Desktop/pa/.env`, and never
print it. One standard key (it starts `sk_car_`, from https://play.cartesia.ai/keys) covers speech,
hearing and their hosted agents. No other key is needed. (An admin key exists, only for their usage
endpoints; neither script uses it.)

**The listening test** — eight short lines in Reason's phone voice (a greeting, a time, bad news
and the alternative, a real laugh, a soft "mm-hm", a number read back, a heavy moment, a goodbye), in
five Cartesia voices, each made twice: exactly as a call carries it (8 kHz μ-law in a .wav) and at
full quality. It times how long each took to start sounding and writes one page to play them from.

```bash
node scripts/cartesia-listen.mjs --dry-run     # the plan and its size; calls nobody
node scripts/cartesia-listen.mjs               # makes ~/Desktop/reason-cartesia-listen/<date>/index.html
node scripts/cartesia-listen.mjs --emotion     # also each line with its feeling asked for (beta)
node scripts/cartesia-listen.mjs --today       # also today's call voice, when OPENAI_API_KEY is set
node scripts/cartesia-listen.mjs --voices gemma,lucy,fiona,pippa    # a British-only pass
node scripts/cartesia-listen.mjs --list-voices                      # British women's voices; free
```

The full set is 80 clips and about 6,700 credits (the Free plan has 20,000 a month). Run from a
terminal it just runs; from a script or an agent's shell it wants `--yes`, so a key sitting in a
file is never by itself a decision to spend.

The voices: **Gemma** (British; Cartesia's pick for agents), **Skylar** (American; their first pick
for agents), **Lucy** (British; on their "Emotive" list), **Tessa** (American; on their "best
emotional response" list), **Fiona** (British; "chirpy and energetic... lively and engaging
conversations", the nearest by their own description to today's young, quick, warm persona). Cartesia
has 14 British women's voices and labels none of them young-and-London; `--voices` takes any of
them by name or id. `--today` speaks the same lines through OpenAI's speech model with the call's
voice name (`openerTtsModel`, `gptliveVoice`), which is how the pickup opener is made. It is not the
live voice's own timing or its own laugh; those only exist on a call.

**The call feel test** — one Cartesia Managed Agent with a short Reason-like persona on one Cartesia
US number, to ring from a phone and feel their whole stack: how fast it comes back, how it takes
being talked over, whether the laugh lands. It is not Reason: a stock model, no accounts, no memory,
and it says so. Dry by default.

```bash
node scripts/cartesia-call-feel.mjs                    # the plan and the cost; calls nobody
node scripts/cartesia-call-feel.mjs --yes              # makes the agent and the number; prints the number
node scripts/cartesia-call-feel.mjs --teardown --yes   # deletes the calls' data, the number, the agent
```

Cost, printed before anything is made: $0.03 a minute + $0.014 a minute on a Cartesia number + the
model's tokens (about $0.006 a minute on the fastest listed model): **about $0.50 for ten minutes**.
The Free plan includes $1.00 of agent use and one number. Cartesia keeps a transcript and a recording
of every agent call and has no switch for that, so the teardown deletes them.

## 2. What was read and measured

### Cartesia: plans and limits

| Plan | A month | Credits | Agent dollars | Speech at once | Hearing at once | Agent calls at once | Numbers |
|---|---|---|---|---|---|---|---|
| Free | $0 | 20K | $1 | 2 | 8 | 8 | 1 |
| Pro | $5 | 100K | $5 | 3 | 12 | 12 | 3 |
| Startup | $49 | 1.25M | $49 | 5 | 20 | 20 | 5 |
| Scale | $299 | 8M | $299 | 15 | 60 | 60 | 10 |

(cartesia.ai/pricing; docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts; /line/infrastructure/scaling; /line/integrations/telephony/cartesia-numbers)

- Speech is about 1 credit a character, 750–800 credits a spoken minute. Hearing (Ink 2) is 3 credits
  a second, silence included. Agents are dollars: $0.03 a minute, +$0.014 on a Cartesia number, plus
  the model's tokens (free until 2026-10-01, billed now). Over the allowance: $65 / $45 / $38 a
  million credits on Pro / Startup / Scale; no overage on Free, requests just fail. (docs.cartesia.ai/pricing; cartesia.ai/pricing)
- Speech "at once" counts live contexts, and their own rule of thumb is four conversations per slot.
  Over the limit Free gets a 429 at once; paid plans queue. Idle speech sockets close after 5 minutes,
  idle hearing sockets after 3. When text is streamed in pieces Sonic may wait up to 3 s for more
  before it speaks unless `max_buffer_delay_ms` is lowered. (concurrency page; /use-the-api/tts-websocket/buffering)
- **The Free plan** has full API access but is "personal, non-commercial use only"; the commercial
  licence starts at Pro. One Cartesia number (US only, calls to US only). Whether an agent call needs
  a card on file is not stated; the site says no card is needed to start. (cartesia.ai/legal/terms §4.1; cartesia.ai/pricing)

### Cartesia: what happens to the data

- **They may train on it by default**: inputs, outputs and interactions "may be used by Cartesia to
  train... its machine learning and artificial intelligence models", on a perpetual licence, unless
  agreed otherwise. The opt-out is a form at play.cartesia.ai/privacy/data-controls and only covers
  the future. (cartesia.ai/legal/terms §5.3(c), revised 2024-06-14)
- No retention period is published for text, generated audio, caller audio or transcripts. Zero Data
  Retention exists for Enterprise customers only, switched on for the whole organisation. (docs.cartesia.ai/enterprise/zero-data-retention)
- **Managed Agents save every call**, phone or WebSocket, with a transcript and a recording. There is
  no setting to turn that off below Enterprise. `DELETE /agents/calls/{call_id}` removes the
  transcript, recording and logs for good (finished calls only). (docs.cartesia.ai/agents/transcripts-and-recordings; /api-reference/agents/calls/delete-call)
- Generated audio always carries an inaudible watermark. SOC 2 Type II; DPAs and BAAs are Enterprise.
  The privacy policy says the service is "designed for users in the United States only".

### Cartesia: where it is, and how far from the server

`api.cartesia.ai` is one address that routes to the nearest of their regions (the status page lists
US, EU, APAC and AU for speech and hearing); dedicated regions are Enterprise. From the live server
(OVH, Oregon) it lands on a CloudFront edge in Seattle. Five fresh connections to the keyless status
route, medians: **connect 4.6 ms, TLS 35 ms, first byte 17.6 ms after that**. OpenAI from the same
server: connect 4.8 ms, TLS 35 ms, first byte 110 ms. So the network adds a few milliseconds a
message once a socket is open; it is not a factor either way.

**Sonic's own speed, measured**: 8 clips of "Mm-hm. Go on." (four voices, both formats), from the Mac
in New York over an open socket: **first audio 129 ms after the words were sent (worst 134)**, of
which Cartesia reports 32 ms as its own. Each clip then opens with about 130 ms of quiet (123–225)
before the first sound. Not measured from the server (no key is there), and only on a very short
line.

### Cartesia: voices, laughter, feeling, names

- **Laughter** is one documented line: put `[laughter]` in the words. Where it may go, how long it
  runs, which voices do it well and whether it is beta are not stated; no other sound tag is
  documented. "uh", "um", "hmm" in the words give a thinking pace; Sonic never adds its own. (docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion; /prompting-tips)
- **Feeling**: by default Sonic reads it from the words. It can be asked for per line
  (`generation_config.emotion`, or an inline tag): beta, English only, "highly experimental" when it
  changes mid-line, most reliable on voices tagged Emotive, and only when it fits the words. Cartesia's
  own advice for agents is the other way: "more stable, realistic voices perform better than... emotive
  voices". The listening test has both kinds for that reason. (/ssml-tags; /choosing-a-voice)
- **At phone quality**: they offer 8 kHz μ-law directly (their Twilio guidance), so nothing is
  converted on our side. Their docs say nothing about what an expressive voice loses at 8 kHz. A
  phone line carries roughly 300–3,400 Hz, so the breath in a laugh is the part at risk; the phone
  clips are there to hear it.
- **Names**: a pronunciation dictionary (a sounds-like spelling or IPA per word, one id on each
  request), and `<spell>` for codes. The IPA set documented is General American. (/custom-pronunciations; /phonemes)

### Cartesia: hearing (Ink 2)

- It takes the call's 8 kHz μ-law as it is, and tells turns apart itself: `turn.start`,
  `turn.update` (words so far), `turn.eager_end` (probably done), `turn.resume` (no, carrying on),
  `turn.end` (done). Thresholds are tunable. The only latency figure given: turn detection delays the
  final transcript by "something on the order of half a second or so". (docs.cartesia.ai/use-the-api/stt/turns; /stt/troubleshooting/auto)
- **Keyterms**: up to 100 words or phrases (1,200 characters) given when the socket opens, which
  bias the hearing toward them; advice is uncommon words, exact spelling, not too many. "Soho" heard
  as "the Savoy" is the kind of thing this is for, so it would plausibly help, with his places and
  people listed per call. Nothing in the docs measures it, and nothing warns how often a listed word
  is then heard wrongly. GPT-Live has no such setting at all. (/use-the-api/stt/keyterms)
- English, French, Hindi, Japanese, Spanish. About $0.007–0.009 a minute.

### Cartesia: Managed Agents

- **An agent cannot use our brain as its model.** The model comes from their catalogue only (OpenAI,
  Anthropic, Google; no endpoint of ours). Fastest today by their own average: `gpt-5.4-mini`, 552 ms,
  $0.75 / $4.50 a million tokens in / out. Reason can sit behind a **tool**: a webhook tool (they call
  our HTTPS endpoint; works on phone calls) or a client tool (asked over their WebSocket; **not
  offered on a phone call they carry**). Either way the agent's model says the result in its own
  words. A result may be 16 KiB; the wait allowed is up to 120 s. No latency figure is given for
  tools: it is the model deciding, our answer, then the model phrasing it. (docs.cartesia.ai/agents/models; /agents/tools; /agents/client-tools)
- The one way to supply every word ourselves is their older Line SDK run on our own server (Python;
  still supported when self-hosted). A new runtime beside Node; not looked at further. (/agents/migrate-from-line-sdk)
- **Our Twilio call can be bridged to an agent.** Their agent WebSocket takes `mulaw_8000` both ways,
  has a setting for a phone line's continuous audio, sends `audio_output_clear` when the caller
  talks over it, and reports each turn's text and timing. So the existing number and our own relay
  can stay in charge, and client tools are available that way. (/line/integrations/websocket-api; /api-reference/agents/agent-websocket)
- Importing the Twilio number into Cartesia is the wrong route for a test: it re-points the number's
  voice webhook, which is every call.

### OpenAI GPT-Live: can it listen while something else speaks?

- **It cannot be asked for text only.** The session takes a model, instructions, an audio format, a
  voice, delegation, history and triggers; there is no output setting beyond the voice. It always
  makes audio, and the bill ($0.05 a minute) is for session time whatever is played. (developers.openai.com/api/reference/resources/live/primary-websocket; /api/docs/models/gpt-live-1)
- The words it says come only as `session.output_transcript.delta`: "a transcript fragment for
  assistant output audio". A transcript of audio already made, with no end-of-line event. How far it
  trails the audio is not stated; the repo's own notes say it usually trails.
- Dropping its audio is allowed ("control playback at the client or media relay"), and it needs
  nothing back about playback. But what is dropped "remains in the model's conversation context", and
  there is no way to tell it where it was cut off except a note. (/api/docs/guides/voice-server-controls)
- **A hand-off result is paraphrased**: `session.commentary.append` is "trained to paraphrase the
  text", plain text, 500 tokens an append, no markup passed through, no say-exactly option. So
  Reason's words cannot carry a laugh through GPT-Live. (/api/docs/guides/live-delegation)
- No speed, turn-detection or vocabulary settings exist; those are prompt-only.

### Today's calls, from the server's own logs (2026-11-08 to 11-12, 22 calls)

| | n | median | p90 |
|---|---|---|---|
| Pickup to Reason's first word (`gptlive_first_voice`) | 22 | 1.76 s | 3.26 s |
| He stops talking to the voice's own reply leaving the server (turn gate rows) | 9 | 1.84 s | 3.83 s |
| ...of which: his words transcribed / the verdict / the voice starting | 11 | 0.92 / 0.14 / 0.95 s | |
| Hand-off to Reason's first sentence ready, no tools / with tools (`first_piece_ms`) | 42 | 2.43 / 5.42 s | 7.4 s |
| Reason's whole answer (`gptlive_result.ms`) | 45 | 3.7 s | 7.4 s |

Two things the logs cannot say. How long from the end of his words to the hand-off (OpenAI's own
example run shows 0.3 s; his transcript lands 0.9 s after he stops). And **how long GPT-Live takes
from being handed Reason's words to saying the first of them**: `call_turns.first_real_ms` looks
like that number but counts the first piece of audio after the hand-back whether or not it has
speech in it (median 53 ms, which is the stream's tick, not a voice). The only signs are a note in
the code from call 80 (1.5–3.3 s), OpenAI's example (1.4 s) and the 0.95 s above: call it 1–3 s,
unmeasured. That number decides whether another voice could answer sooner, so it is the first thing
to log (section 5).

One more thing the logs do show: GPT-Live often starts its reply while he is still finishing, and the
relay holds it until he has been quiet for 0.3 s (47 holds, median held 0.97 s). No chain of
hear-then-think-then-speak can do that.

## 3. Three ways to put Cartesia on a call

Times are from the end of his speech to the first audio leaving Reason's server; the phone network
is the same in all of them. **m** measured, **d** documented, **g** guessed.

| | Today (GPT-Live) | 1. Hybrid | 2. Full cascade | 3. Cartesia agent, bridged |
|---|---|---|---|---|
| What it is | GPT-Live hears, speaks, hands off to Reason | GPT-Live hears and hands off; Sonic speaks | Ink 2 hears, Reason answers every turn, Sonic speaks | Cartesia's agent hears and speaks on our Twilio leg; Reason behind a client tool |
| A quick reply | 1.84 s (m); as little as 0.3 s when it had already begun | 2.5–3.3 s: today's 1.84 (m) + its transcript after its audio 0.2–1.0 (g) + a few words gathered 0.2 (g) + Sonic 0.25 (m) | 3.2 s: turn end 0.5 (d) + Reason's first sentence 2.43 (m) + Sonic 0.25 (m) | 1.3 s: turn end 0.5 (d) + their model 0.55 (d) + Sonic 0.25 (m) |
| An answer from Reason, no tools | 3.7–6.6 s: hand-off 0.3–1.2 (g) + 2.43 (m) + GPT-Live starting to say it 1–3 (g) | 3.0–3.9 s: 0.3–1.2 (g) + 2.43 (m) + Sonic 0.25 (m) | 3.2 s, as above | 4.4 s: 0.5 (d) + model 0.55 (d) + Reason's whole answer 2.56 (m) + model 0.55 (d) + Sonic 0.25 (m) |
| ...with tools | 6.7–9.6 s | 6.0–6.9 s | 6.2 s | 7.2 s |
| Voice layer, a call minute | $0.05 | $0.065–0.07: $0.05 + Sonic for the half he is not talking | $0.022–0.029: Ink + Sonic, no GPT-Live; more of Reason's own tokens | $0.036: $0.03 + about $0.006 of tokens (g) |
| Who writes the words | GPT-Live, in its own words, even Reason's answers | Reason's answers word for word (they can carry `[laughter]`); GPT-Live's own lines re-voiced flat | Reason, every word, with laughter and feeling where it writes them | Their model, in its own words; a laugh only if their agent passes the tag through (the call feel test says) |
| Talking over it | GPT-Live's own, plus our Twilio clear | Ours to build for Sonic's audio; GPT-Live must be told by note what was really heard | Ours to build on Ink's `turn.start` | Theirs (`audio_output_clear`), plus our Twilio clear |
| The "mm-hm" turn gate | Yes | Rebuilt: today the sound is GPT-Live's own, held and released; it becomes a stored Sonic clip | Rebuilt on Ink's eager-end and resume, or dropped | No: his words arrive only when his turn has ended |
| Carryover, ambience, our own recording rules | Yes | Yes | Yes | Yes (our relay still mixes and tapes) |
| Honest "I'm an AI" when asked | Yes | Yes | Yes, from Reason's prompt | Yes, from the agent's instructions |
| The pickup opener | OpenAI clip | Remade in the Sonic voice | Remade in the Sonic voice | Not used on his own calls; the agent's first line |
| What Cartesia receives | nothing | the words Reason speaks | his voice and the words | his voice, the words, and **a stored recording and transcript until deleted** |
| Build, and risk | | Large; the riskiest: it re-plumbs the audio path inside the 4,900-line relay he likes | Largest: a second voice loop; everything keyed to GPT-Live's events needs a new home | Medium: one new relay file beside the old one; the old one is not edited |

What the table says, plainly:

- **Hybrid** is the natural idea and the facts are against it as a first step. GPT-Live has no
  text-only mode, so its own quick replies would have to be made, transcribed and said again: slower
  than today, at the highest cost, with two engines to keep in step. Its real gain is on Reason's
  answers, and only if GPT-Live's unmeasured 1–3 s to start speaking them is real.
- **Full cascade** gives the most control (every word Reason's, laughter anywhere, names by
  keyterm, the cheapest voice layer) and loses the most: every reply waits on Reason's brain, so
  small talk gets slower, and GPT-Live's listening-while-speaking is gone.
- **The bridged agent** is the nearest like-for-like swap for today's shape (a voice layer that hands
  off to Reason), is the cheapest to build, and is the only one whose feel can be tried tonight with
  no build at all.

## 4. Recommendation

In order, stopping wherever the answer is no:

1. **Listen** (tonight, free plan). Does any voice sound like Reason at phone quality, and is the
   laugh good?
2. **Ring the call feel test** (tonight, about $0.50). Does their turn-taking feel right, does being
   talked over work, how fast does it come back, and does the agent laugh when its model writes
   `[laughter]`? This is design 3's voice layer exactly, minus Reason.
3. **First real call: design 3, bridged, owner-only** (section 5). His number, his relay, Reason's
   brain behind a client tool, his own calls only.

Where Cartesia would beat today: the voice doing what it is told (a laugh where one is written, a
gentler read of a heavy line, exact words in designs 1 and 2), names said and heard right, and cost
in designs 2 and 3. Where it would not: listening while speaking, hearing his tone, and the quick
natural replies of one model doing both. Whether a call is faster end to end is open: Sonic starts
in about 0.13 s, but today's wait is the turn decision (about 1.1 s), the voice starting (about
1 s) and Reason's own thinking (2.4–5.4 s), and Cartesia shortens only the middle one.

## 5. Design for the first real call (design 3, bridged). Not built.

**The switch**: `REASON_CALL_CARTESIA` = `off` | `owner`; unset is `off`. There is no `on`: it cannot
be turned on for everyone until that is a decision. `owner` by itself changes nothing either; it only
makes the choice below available to the operator's account.

**How he opts in and out, by text**: with the switch at `owner`, the operator's account (and no
other; nobody else is shown it) gets one small tool, `call_voice_trial`, so "try the Cartesia voice
on my calls" turns it on and "go back to my usual call voice" turns it off. Stored on his account
(`accounts.call_trial`, empty by default). Reason says back which voice his next call will use.

**Which calls**: his own calls only (`is_owner = 1` on the operator's account), either direction.
Never a call to a business or another person, never a stranger's call: Cartesia stores a recording
of every agent session and those people were not told.

**How his normal calls stay untouched**:
- Off in two layers (the switch unset; his choice empty). With either off, `acceptStream` builds
  `GptLiveCall` exactly as now.
- One branch in `acceptStream`, and the new relay is imported only inside it. `GptLiveCall`, its
  prompts, the turn gate and the opener are not edited.
- If the Cartesia session is not ready within 1.5 s of the stream starting, or fails, that same call
  carries on with GPT-Live and the fall-back is logged. A broken experiment never costs him a call.
- A test pins all of it: switch unset, switch `owner` with the choice off, another account, a
  third-party row — each builds `GptLiveCall` and opens no Cartesia socket.

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
  keyterms from his places and people, `ask_reason` as a client tool that waits for its result,
  `end_call`), prints its id for `.env`.
- `test/call-cartesia.test.js`, with stand-in sockets as `test/gptlive.test.js` does.

**What gets measured on the first call** (numbers only, in the log):
- He stops talking to the first agent audio with speech in it, per reply; plain replies and
  `ask_reason` replies apart.
- `ask_reason`: asked to answered (Reason's brain), and answered to first speech (their model + Sonic).
- Talked over: his first sound to `audio_output_clear` to our Twilio clear.
- Their own clock for each turn (`turn_ended`: end time, eager-end time) beside ours.
- Laughs written by the model, and by ear whether they were laughed.
- Any name or place misheard, with keyterms on.
- The cost of the call and proof its recording was deleted.
- **And the same day, the missing number on a normal call**: one log-only line in `audioOut` for
  the first audio *with speech in it* after a hand-back (`first_real_ms` is not that). Without it
  there is nothing honest to compare against, for this design or the hybrid.

**Before it is for anyone but him**: a paid plan (Pro, $5 a month, is the first with a commercial
licence; Startup at $49 covers about 1,300 agent minutes), the training opt-out filed, and a decision
about recordings, since only Enterprise can stop Cartesia storing them.

## 6. What has run, and what has not

Run for real, once, by mistake (2026-11-12): while checking the no-key path the script found the key
in `~/Desktop/pa/.env` and made 8 clips of "Mm-hm. Go on." (about 104 credits). That is where the
129 ms comes from, and why the script now wants `--yes` when no terminal is attached. Two free
catalogue reads followed, on purpose: their model list and their British women's voices.

Run only against a stand-in on this machine: the rest of the listening script (the full set,
`--emotion`, `--list-voices`, a refused key, credits running out mid-run) and every step of the call
feel script (`test/cartesia-explore.test.js`). **The call feel script has never touched Cartesia**:
creating the agent, the number and the teardown are written from their reference pages.
`--today` has never run: there is no OpenAI key on this machine.

## 7. Not known

- GPT-Live's time from Reason's words to its first spoken word; how far its transcript trails its
  audio; what it believes it said after being talked over.
- Cartesia's first-audio time from the server, and on a full sentence; Ink 2's turn-end time in
  milliseconds; any latency figure for agent tools; whether a managed agent laughs on `[laughter]`.
- How long Cartesia keeps API text and audio; whether a Free agent call needs a card; what happens
  to a call when the agent balance reaches $0; the size limit on an agent's instructions.
- Whether any Cartesia voice sounds like a young Londoner; what a laugh loses at 8 kHz. Both are
  for the ear.
