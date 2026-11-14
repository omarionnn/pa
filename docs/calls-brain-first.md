# The speaking brain: every sentence on a call written by Reason (prototype, off)

**Switch**: `REASON_CALL_BRAIN` = `off` | `owner` | `on`. Unset or anything else means `off`. With `off`, nothing can be reached: `/calls/brain/turn` answers 404 and no call is touched. Merging this changes nothing.

## Why

Today a Cartesia managed agent runs its own small model on a call. That model answers most turns by itself and only sometimes asks Reason through the `ask_reason` client tool. Calls 113-116 asked Reason between 0 and 11 times. Every bad moment on those calls came from that split:

- "it's done" about a booking that never happened
- "I only know what's been said in this call"
- memory questions answered by the voice model itself

GPT-Live, the fall-back, has the same split: its realtime model answers and delegates through a tool, with 0 delegations on most calls.

The reason for the split is speed. Reason's full call turn sends a prompt of about 187k tokens: a 36k system prompt plus 151k of tool definitions for 325 tools. On live calls it reached the first word at p50 4.4 s and p90 7.6 s (46 turns). The voice model answers in 0.69 s p50.

## Options (Cartesia docs read 2026-11-13)

| Way to make our endpoint the brain | Available on Pro? | Streaming | Barge-in / end of turn | Cost |
|---|---|---|---|---|
| Managed agent with a custom LLM URL | **No.** `config.model.id` must come from their catalog; there is no endpoint field | n/a | n/a | n/a |
| Per-turn webhook that writes the reply | **No.** Call webhooks only notify; webhook and client tools feed the managed model, which is today's split | n/a | n/a | n/a |
| Line SDK agent, self-hosted (`self_hosted_deployment_url`) | Yes. Self-hosted keeps working after Cartesia-hosted Line ends on 2026-12-01 | Yes: `AgentSendText` chunks go to Sonic | Cartesia's: `UserTurnStarted` cancels the running turn; eager end of turn | $0.03/min agent rate; the model tokens are ours (Anthropic) |
| Ink-2 STT + Sonic TTS WebSockets, our own turn logic | Yes | Yes (TTS contexts and continuations) | Ours to build. Ink-2 `/stt/turns` has semantic `eager_end` and `end` (about +0.5 s for `end`) | ~180 STT credits/min plus ~750 TTS credits per spoken minute. Roughly $0.03-0.05/min past Pro's 100K credits. Pro TTS concurrency is 3 |

## Design (built here)

`src/calls/brainfirst.js`:

- **Speaking turn** (`speakTurn`): uses Reason's own call context, the same `contextFor` build a call turn has today:
  - the persona and hard rules from the text prompt, without its 70k-character tool manual
  - profile, rules, today so far, earlier calls, what memory saved lately, open work, pages, purchases
  - the thread

  It runs on a fast model (Haiku 5.5 by default; `REASON_CALL_BRAIN_MODEL` overrides). It has one tool, `think_it_through`, and streams its first sentence the moment that sentence is complete. The prompt is about 15k tokens, cached.
- **Preload** (`preloadFor`, `openBrain`): while the call connects, it reads the facts and history closest to:
  - the last call's summary
  - their newest lines today

  That gives up to 14 lines. It also warms the cache. The preload measured 0.86-1.28 s, inside the ring.
- **Hand-off**: the speaking turn says a few words that promise nothing, then calls the tool. `brainTurn` emits `hold`, so the existing lookup music can play, then runs today's full brain (`reasonTurn`), which has every tool and every gate. The safety half of today's Cartesia `ask` is carried over:
  - the passphrase ask in its fixed words
  - the deferral line when something was put off
  - markers taken out
- **Guards in code**, at the one place words leave (`guardSentence`, `speakTurn`):
  - A done-claim, or a bare yes to "is it done?", is never said. The turn hands over to the full brain instead.
  - Any "is it done / did you send / have you booked" question goes to the full brain before any model word.
  - Money, cards, codes, passwords, logins and bank questions go to the full brain at once.
  - `forVoice` takes markers out.
  - While Reason waits for a passphrase, the caller's words are screened by `calltrust.hear` and only the marker goes on. Owed trust lines are said in code.
- **Endpoint**: `POST /calls/brain/turn`. It needs the `x-reason-brain` header (`REASON_CALL_BRAIN_SECRET`, at least 24 characters) and the call row's `webhook_token`. It accepts a person's own call only (`brainFirstFor`, which mirrors `cartesiaTrialFor`) and answers NDJSON events: `say`, `hold`, `end_call`, `done`.

## Measured (replay of calls 113-116 as text, scratch copies rolled back to each call, no phone)

Time to first sentence, from the model request (the speaking turn, warm cache):

| Model | First sentence | Full answer |
|---|---|---|
| Haiku 5.5 | 0.55-1.38 s, p50 ~0.84 | 0.67-2.3 s |
| Sonnet 5.5 (`between_tools`) | 1.25-2.31 s | 1.7-3.8 s |
| Opus 5.5 (adaptive, low effort) | 1.54-2.67 s | 1.7-3.5 s |
| today's full call brain (live log, 46 turns) | p50 4.4 s, p90 7.6 s | p50 4.8 s |
| today's Cartesia voice model (live log, 83 turns) | p50 0.69 s, p90 0.98 s | n/a |

- **Per-turn memory search**: 0.22-0.74 s, p50 about 0.29 s. Raced for 250 ms it was rarely in time, and the preload carried the memory instead.
- **What the caller would wait**:
  - end of turn: Cartesia's eager end, or about +0.5 s for a final `turn.end`
  - plus about 0.84 s to the first sentence
  - plus Sonic's first audio (under 90 ms model time, plus network)

  That comes to about 1.2-1.5 s on Haiku. Sonnet and Opus do not meet 1.5 s.

## What gets worse

- First words are about 0.2-0.5 s later than today's voice model.
- A hand-off turn is as slow as today's ask: about 4-8 s behind the music.
- Haiku is a smaller model than the texts' Opus 5.5. It connects what is in front of it well. It also wrote one invented detail (a "screen replacement" on an AirPod) and asked again for a detail it had already been given.
- Barge-in and end of turn stay with Cartesia (Line). With DIY STT and TTS they would become ours.
- A second moving part, the Line agent, needs a public URL and a Caddy route.

## To go live (owner's calls)

1. Write the self-hosted Line agent: a small Python `process()` that posts history to `/calls/brain/turn` and yields `AgentSendText` for each `say`. Run it beside the server, like the fli sidecar.
2. Make a second Cartesia agent whose `self_hosted_deployment_url` is that agent. Point the relay (`CartesiaAgentCall`) at that agent when `brainFirstFor(row)`.
3. Tie the relay's `hold` to the existing lookup music.
4. Add a Caddy route for the Line agent, under the deploy lock.
5. Set `REASON_CALL_BRAIN=owner` and `REASON_CALL_BRAIN_SECRET`, then make test calls before `on`.

Recordings stay deleted per call (`DELETE /agents/calls/{id}`) as today.

## Openers (`src/calls/brainopener.js`, `REASON_CALL_BRAIN_OPENERS`, on with the brain)

How a turn starts:

- **Classify, then pick an opener.** Their turn is classified by fixed rules in under 3 ms: chat, question, lookup, request, memory or repair. A content-free opener is then picked from that class's bank.
  - No opener holds a fact, a number, a yes/no, "sure", "done" or "got it", or anything upbeat. A test pins this.
  - The opener is never one of the last 3 said on the call.
- **Two speaking turns start together.** One is plain. The other is told the opener is already said; Haiku refuses an assistant prefill, so this goes in as a note.
  - If the plain turn's first sentence is in by 700 ms (`OPENER_AT_MS`), no opener is said.
  - Otherwise the opener is said and the told turn's words follow it. `joinAfter` drops repeats.
- **Careful turns** (done questions, money, logins) open with a stand-alone line ("Let me see.") before the hold.

Measured on four replayed calls:

- Decision time: rules 0.02-2.9 ms; a tiny model 526-1301 ms.
- Class accuracy: rules 12/16 (14/16 after fixes made on the same turns); the tiny model 14/16.
- Continuation's first sentence: p50 ~0.85 s, the same as without an opener.
- Joins: 4/17 wrong before the fixes to `joinAfter` and the bank.

## Bank, bucket A (`src/calls/brainbank.js`, `REASON_CALL_BRAIN_BANK`)

Buckets of what a caller says, as data. Each bucket has cues to recognise it and lines to say. There are two kinds:

- **instant (bucket A)**: presence checks, greetings, thanks, "give me a second". A complete line from the bank is said at once, and no model is called.
  - It fires only when the whole turn is the cue.
  - It never fires when an earlier turn of theirs is still unanswered: "Hello?" after dead air is owed an answer, and the brain gives it.
- **opener (bucket B)**: a content-free opener, and the brain continues from it.

`REASON_CALL_BRAIN_BANK` names a JSON file (the bank mined from the owner's own calls). Without one, a small placeholder of the same shape is used. Every line is checked as it loads, and claims, numbers, promises and yes/no are dropped. A bank file can never put a "done" in Reason's mouth.

## Test line (experiment; `deploy/brain-test/`, `line-agent/`, `src/calls/braintest.js`)

- **Who speaks**: a Cartesia-hosted Line agent (`line-agent/main.py`, voice Gemma) keeps the ears, the voice, turn-taking and interruptions. For each turn it posts the history to `https://app.heyreason.com/brain-test/turn` with a bearer secret, held in the agent's Cartesia env and in `/etc/reason-brain-test/secret` (root 600, handed to the unit with `LoadCredential`). It speaks each streamed `say`.
- **The brain**: `reason-brain-test.service` runs `scripts/brain-test-server.mjs` as `reason`, from `/opt/reason-brain-test`, on 127.0.0.1:8790, with `MemoryMax=700M`.
  - Its environment is the live `.env` minus every sending, paying or acting key.
  - The database and keystore are opened read-only (`REASON_DB_READONLY=1`). Writes that modules make while loading are skipped; after that, every write throws.
  - The unit also mounts `/opt/reason` read-only.
  - No timers or sweeps start.
- **Who may use it**: only the owner's registered number with carrier attestation A (`gate`). Any other caller hears "This is a private test line." and the call ends; nothing about anyone is loaded for that call.
  - Cartesia's `CallRequest` carries `from` and `metadata` but no documented attestation field. A refused call logs its metadata key names (never values) so this can be checked.
  - `"gate": "number"` in the variant file accepts the number alone. That is an owner decision.
- **What it does**: it answers from memory, using the speaking turn plus the openers and bank.
  - Anything that would act, look up or check something gets an honest fixed line ("This test line can't do things yet. I've noted it…"). Notes go to a local file with mode 600.
  - Nothing from these calls is saved to Reason, and nothing is texted.
  - After each call, Cartesia's copy of the audio and transcript is deleted (`DELETE /agents/calls/{id}`).
- **Variants**: `/opt/reason-brain-test/state/variant.json` is read at each call's start, so changing it needs no restart.
  - `i`: Haiku, no opener.
  - `ii`: Haiku plus openers (the default).
  - `iii`: Opus plus openers.
- **Remove all of it**: run `bash /root/brain-test-teardown.sh` on the server. It deletes the test calls' data, releases the number and deletes the agent, then removes the unit and files, then removes the Caddy route (under the deploy lock, validated, with a graceful reload and checks).
