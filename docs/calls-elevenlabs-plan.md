# Calls, round two: Reason itself on the phone

Decided 2026-10-05 by the owner. Build starts Friday 2026-10-09, because every part of this
needs the API backend with paid credit (a phone turn cannot wait on a headless CLI start), and
nothing that touches the subscription backend or the live test numbers is to change before then.

## What is being built

- **People can call Reason.** A call from a number Reason knows lands in that person's own
  Reason: same memory, same open tasks, same tools, same voice rules as their texts. A call from
  a number it does not know gets one polite line and nothing else (same policy as a text from a
  stranger: the master is asked, no model turn for the stranger).
- **Reason's own brain is on every call**, both directions. The platform handles the phone
  line, hearing, speaking, interruptions and turn-taking; Reason generates every reply.
- **Reason switches language when the other person does** (added by the owner 2026-10-06). On a
  call in English where the person on the line answers in Spanish, Reason starts speaking
  Spanish, and the same for any language the agent is set up with. Two halves, both needed:
  the *voice* switch is ElevenLabs' `language_detection` system tool, which our custom-LLM
  endpoint triggers by answering with a standard function call (`{"language":"es","reason":…}`;
  the tool is not on by default and the agent's supported-languages list must include every
  language it may switch to — read from "Language detection", 2026-10-06); the *words* are
  ours, so the voice prompt says: reply in the language the person is speaking, and if they
  switch, switch with them. The recorded-call announcement is spoken again in the new language
  the first time the language changes, so the disclosure is never only in a language they did
  not understand. ElevenLabs' `only_at_conversation_start` option (switching confined to the
  first two turns) stays OFF, because the person who speaks Spanish is often not the one who
  picks up. Bar: a test call where the "restaurant" answers in Spanish and Reason finishes the
  booking in Spanish, with the announcement heard in both.
- **Calls to third parties keep today's guarantees.** Facts-only context (the goal and the
  approved facts, never the thread), the recorded-call announcement spoken first, no payment
  details ever, the audio sent to the owner with the summary. What changes is the voice and
  the brain behind it.
- **The call becomes part of the conversation.** After hangup the transcript is written into the
  person's thread as turns, so a text ten minutes later continues what was said on the phone.
- **A real phone call is mostly not talking to the person you wanted** (added by the owner
  2026-10-06, late evening, with reliability named as the thing that matters most: "reliable hold
  handling, complete quotes and no duplicate commitments"). Hold music, a phone menu, a
  receptionist who transfers you, a voicemail box, a line that drops the second after someone says
  yes. All of it is ordinary, and a call that handles none of it is a demo. The sections from
  "The call brief" down are that work.
- **Several calls can be one errand.** "Find me the cheapest place that can do it tomorrow" is one
  request that happens to need six phone calls. They ask the same questions, the answers compare,
  and at most one of them ends in a booking.

## Platform

**ElevenLabs Agents** with Reason as a **custom LLM**, and a **Twilio number imported into
ElevenLabs** for inbound + outbound. Chosen over Bland (no bring-your-own-model, no way to be
Reason), over Vapi/Retell (same custom-LLM shape, weaker voices), and over an own media loop
(would rebuild turn-taking and barge-in that the platform gives for free).

Facts from ElevenLabs' own docs, read 2026-10-05 (page names in parentheses):

- Custom LLM = an endpoint of ours implementing OpenAI **Chat Completions** (`/v1/chat/completions`)
  or **Responses** over **SSE**, chunks as `data: {json}\n\n`, ending `data: [DONE]\n\n`. The
  request carries `messages`, `model`, `stream: true`, `user_id`, optional `elevenlabs_extra_body`
  (our own fields, set per call), and `tools` for the platform's **system tools** (end_call,
  language detection) which we trigger by answering with a standard OpenAI function call.
  Returning a first chunk that ends in `"... "` (ellipsis + space) buys thinking time without
  dead air. ("Integrate your own model")
- Inbound: a **purchased Twilio number** imported on the Phone Numbers page gives inbound and
  outbound; a verified caller ID is outbound-only. ("Twilio native integration")
- Inbound personalization: before the audio connects, ElevenLabs POSTs
  `{caller_id, agent_id, called_number, call_sid, conversation_id}` to our webhook (configured
  on the Agents settings page, enabled per agent under Security), and we answer with
  `dynamic_variables` + `conversation_config_override` (opening line, prompt). Fetched in
  parallel with the ring, so it is free in latency terms. ("Twilio personalization")
- Outbound: `POST /v1/convai/twilio/outbound-call` with `agent_id`, `agent_phone_number_id`,
  `to_number`, `conversation_initiation_client_data` (`dynamic_variables`,
  `custom_llm_extra_body`, `conversation_config_override`), returns `conversation_id` +
  `callSid`. ("Outbound call via twilio")
- Audio: `GET /v1/convai/conversations/{conversation_id}/audio` is a file download, with the
  API key. Post-call webhooks (`post_call_transcription`, `post_call_audio`,
  `call_initiation_failure`) are HMAC-signed in `ElevenLabs-Signature`; the JS SDK's
  `constructEvent` verifies them. ("Get conversation audio", "Post-call webhooks")
- Pricing page 2026-10-05: Agents speech engine **$0.08 per minute**; v4 Turbo TTS listed at
  about 100 ms. Twilio per-minute voice rate still unread (their pricing page is script-rendered):
  check in the console before budgeting.

Read 2026-10-06 for the call-handling work below ("System tools", and the page per tool):

- **Seven system tools**, all of them triggered the same way — our endpoint answers with a standard
  OpenAI function call, and the platform changes the state of the call rather than calling out
  anywhere. Each has to be enabled on the agent (dashboard, or `built_in_tools` over the API) or
  the function call is ignored: `end_call` (`reason`, optional `message`), `language_detection`
  (`reason`, `language`), `skip_turn` (optional `reason`) — stay silent and wait without speaking,
  `play_keypad_touch_tone` (`dtmf_tones`) — DTMF for phone menus, `voicemail_detection` (`reason`),
  `transfer_to_number` (`transfer_number`, `client_message`, `agent_message`), and
  `transfer_to_agent` (`agent_number`), which we do not use: there is one Reason.
- **DTMF**: valid characters are `0`–`9`, `*`, `#`, and `w` / `W` for a 0.5 s / 1.0 s pause. Tones
  go as in-band audio on Twilio; out-of-band DTMF (RFC 4733) is SIP-trunking only and is *ignored*
  on Twilio Native, and their own page says some IVRs miss in-band tones because of audio
  compression. So a menu may need the tone sent twice, and "I pressed 2" is not the same as "the
  menu took 2". ("Play keypad touch tone")
- **Transfer to a number** is a *conference* transfer by default: the platform rings the
  destination, puts them in a conference, and the agent **removes itself**, leaving the two humans.
  `agent_message` is the one thing the person receiving the transfer is told (Twilio only), and
  their page does not document the conversation history going anywhere. `blind` (Twilio) and
  `sip_refer` are the other two types; SIP REFER has no warm message at all. ("Transfer to number")
- **Voicemail detection** is pattern-based on the greeting, takes an optional voicemail message with
  dynamic variables, and their page reads as though detection ends the call, with no documented
  toggle to stay on the line. No accuracy figures, nothing about non-English voicemail.
  ("Voicemail detection")
- **Turn-taking** is configuration, not prompting: `conversation_config.turn.turn_timeout`
  (1–30 s) is how long silence runs before the agent speaks again;
  `conversation_config.turn.turn_eagerness` is `patient` | `normal` | `eager`;
  `conversation_config.turn.soft_timeout_config` (`timeout_seconds` 0.5–8.0, default `-1` off,
  `message` up to 200 chars, default `"Hhmmmm...yeah."`) is the filler when our endpoint is slow —
  which is a better answer than our `"... "` chunk and is used instead of it where both would fire.
  Interruption is a client event switched on in the agent's Advanced tab; there is no API path on
  that page. ("Conversation flow")
- **A hard stop exists**: `conversation_config.conversation.max_duration_seconds`, 60–7200,
  **default 600** (ten minutes). This is the platform cutting the call off, so it has to be set
  above the hold budget plus the time the actual errand takes, or a long hold ends the call in the
  middle of the booking it was waiting for. ("Conversation flow")

### What the platform does not do

Four things the owner asked for have no feature behind them. They are ours, and they are written
here rather than assumed, because the failure mode of assuming is a call that sounds fine and
achieves nothing.

- **Being put on hold.** There is no hold detection and no "they're back" signal. ElevenLabs' *hold
  audio* and *call queueing* (`platform_settings.queueing_config.wait_timeout_seconds`, 1–1800,
  default 180) are the opposite direction: audio played to people queued for *our* agent when it is
  at its concurrency limit. Their IVR announcement (read 2026-10-06) claims menu navigation and
  explicitly claims nothing about detecting hold music or noticing a human return. Worse, hold music
  is *audio*, so `turn_timeout` — which measures **silence** — may never fire during it, and the
  agent can hear music as if it were someone talking. So Reason judges hold itself, from what it
  hears, and code holds the budget and the clock.
- **Recognising that a different human is now on the line.** A receptionist transferring us
  internally is one continuous call to the platform. Nothing marks the handover.
- **Knowing whether a booking already went through.** Nothing on the platform ties a redial to the
  call it is a retry of. State for that is ours or it does not exist.
- **Anything across two calls.** Comparable quotes, one-booking-only, a per-errand summary: the
  platform has one conversation at a time and no concept of an errand.

## Shape in this repo

Follows the existing provider pattern (`src/calls/provider.js`, `src/calls/choose.js`), plus
one new piece Bland never needed: Reason answering for the voice, turn by turn.

1. `src/calls/elevenlabs.js` — a `CallProvider`: `status()` honest about
   `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`; `place()` calls
   the outbound endpoint with `requireAnnouncement` + `requireCallRules` enforced exactly as
   Bland's does, the announcement as the agent's first message (`conversation_config_override`),
   the call's identity in `custom_llm_extra_body` (our call id, the conversation id of the owner,
   `kind: third_party`); `check()` reads the conversation; recording via the audio endpoint
   (bytes, not JSON — the Bland lesson). Shape-tested with an injected fetch.
2. `src/calls/voice.js` — the custom-LLM endpoint, `POST /calls/elevenlabs/llm` on the existing
   listener. Authenticated by a bearer secret ElevenLabs is configured to send
   (`ELEVENLABS_LLM_SECRET`). Looks up the call by `elevenlabs_extra_body`, builds the right
   context, runs ONE Reason turn with the API backend, streams the reply as SSE. Two context
   builders, same tool registry:
   - **owner call** (inbound from a known number, or Reason ringing its own person): the
     person's normal system prompt + memory + open tasks + the last N thread turns, all tools,
     the confirm gate works by voice (the model judges the spoken yes, code enforces, same
     `recordConfirmation` path as text).
   - **third-party call**: the goal, the facts, the rules, nothing else. No thread, no memory,
     no tools except `end_call`. Enforced by what is *built*, not by asking the model.
3. `src/calls/inbound.js` — the personalization webhook `POST /calls/elevenlabs/inbound`:
   `caller_id` → account via `src/accounts.js`; known → `dynamic_variables` with the person's
   name + a `conversation_config_override` with their opening line; unknown → the one-line
   stranger greeting and `end_call` allowed, plus the master is told exactly as for a text.
   Must answer fast (it runs during the ring).
4. `src/calls/postcall.js` — the post-call webhook `POST /calls/elevenlabs/post-call`, signature
   verified; writes the transcript into the thread as turns, fetches/stores the audio through
   `src/calls/recordings.js`, closes the `calls` row, counts minutes in `usage` (both directions,
   same caps as today), and for third-party calls queues the summary + audio to the owner as
   today.
5. A **voice prompt** (`src/calls/voice-prompt.js`): short turns, no emoji/markdown/links, numbers
   and times as words, "I'll text you the link" instead of reading one, admit a miss out loud,
   use the `"... "` filler before a tool call rather than silence. Text persona rules still apply.
6. `choose.js` gains `elevenlabs`; `capabilities` reports calls in both directions only when all
   three env vars are set; `README.md` updated in the same commit (standing rule).
7. `src/calls/brief.js` — the call brief (below): built in code, enforced like the announcement.
8. `src/calls/hold.js` — hold, menus, voicemail, a new person on the line; the budget and the clock.
9. `src/calls/readback.js` — the exact details, said as words and kept as values.
10. `src/calls/commit.js` — what the call may agree to, and what pauses it.
11. `src/calls/outcome.js` — the outcome taxonomy, and what "it worked" has to be backed by.
12. `src/calls/errand.js` — one request, several calls, one comparable answer, at most one booking.

## The call brief

Today `place()` takes a goal, facts, rules and an announcement. That is enough to ask a question and
not enough to hold a conversation to an agreement, so the brief becomes a real object, built in code
from what the owner approved and passed as its own argument. Same pattern as `requireAnnouncement`
and `requireCallRules`, for the same reason: a provider — or a refactor, or a model — must not be
able to drop the part that keeps a call honest.

A brief carries, and a call without one is refused before the dial:

| Field | What it is |
|---|---|
| `goal` | the outcome wanted, specific enough that the result settles it (already there) |
| `facts` | the only things this call may say (already there) |
| `cannotAgree` | the things it may never agree to, whatever it is asked |
| `approved` | the envelope it *may* agree inside: a price ceiling, the terms the owner okayed, and whether this call may book at all or is only asking |
| `questions` | the core questions, asked of every provider on an errand so the answers compare |
| `readBack` | which details have to be said back before anything counts as agreed |
| `maxHoldSeconds` | how long it may wait on hold on this call |
| `returnNumber` | the number to give out for a callback — the Twilio line, so a callback comes home |

Two things follow from `approved` that are worth stating plainly, because they are the owner's own
words: **asking about availability is not permission to book.** An inquiry call gets
`approved.book: false` and cannot commit to anything, which is enforced by what is built rather than
by a sentence in a prompt. And a call carries the appointment requirements with it, so once a human
finally answers after eight minutes of hold it never has to go back to the owner to ask what name to
put it under.

## Hold, menus, voicemail, transfers

The platform gives turn-taking, barge-in, DTMF, voicemail detection and transfer-out. What it does
not give is the judgement, so the judgement is Reason's, with code holding the clock.

- **Interruption.** Platform behaviour: barge-in stops the speech. Our part is only the prompt rule
  that it does not then re-deliver the sentence it was cut off in the middle of.
- **Silence.** `turn_timeout` and `turn_eagerness: patient` are set on the agent rather than guessed
  at per call. A business line is slower than a person's phone and `eager` talks over people.
- **Hold.** Reason decides from what it hears that it is on hold, and answers with `skip_turn` —
  which is the platform's own "wait without speaking", and is the whole reason that tool is enabled.
  Code does the rest: `hold.js` stamps when hold began, totals it across the call, and when the
  budget the brief carries runs out it answers with `end_call` and a polite line, with an outcome of
  `hold_gave_up` rather than a failure. Because hold music is not silence, the budget is wall-clock
  on our side and is never left to the platform's silence timer. `max_duration_seconds` on the agent
  is set above the budget so the platform is not the thing that hangs up.
- **Menus.** `play_keypad_touch_tone`, with the caveat from their own page written into the prompt:
  listen to the whole menu before pressing anything, and if the menu does not react, send the tone
  again before concluding it did not work. `w`/`W` pauses go in the sequence rather than being
  simulated by waiting.
- **Voicemail.** `voicemail_detection` is enabled on the agent so the model has the word for it, but
  Reason never forwards it (2026-10-13): at the platform, detection hangs up, speaking only the
  agent's canned `voicemail_message`, and ours is different on every call. Instead the tool is fed
  back with how to leave the message, and the message rides in `end_call`'s documented `message`
  argument — spoken by the platform, then the line goes. The row says `voicemail_no_message` from
  the moment a machine is known and `voicemail_left` only once there were words. One voicemail per
  number per errand, ever — enforced in `redial`, not remembered by a model, and counted only on
  messages that were actually said. Neither outcome is success and neither is reported as one.
- **A transfer, inbound.** The receptionist says "let me put you through to catering". The platform
  sees one call; `hold.js` marks a new party, and two things happen that are easy to get wrong.
  First, the context survives: Reason re-states the ask in one compact sentence and carries
  everything already established, rather than starting the call over. Second — and this is the part
  the owner's spec implies rather than says — **the announcement is spoken again.** The new human has
  not been told they are talking to an AI assistant and that the call is recorded. The disclosure
  belongs to the person, not to the call, so `announcement_parties` tracks who has heard it, the same
  shape as the existing per-language `announcementOwedIn`.
- **A transfer, outbound, to the owner.** `transfer_to_number` to his own number, and his own words
  bind here: *never leave the other person expecting him when he is unavailable.* So the order is
  fixed — text him first, wait for him, and only transfer once he has answered. If he does not, the
  call says honestly that it will have him call back, and does not transfer. Note what their docs
  say: a conference transfer **removes the agent from the call**, and nothing documents the history
  going with it. So `agent_message` is written to carry the state in one breath, and the call row
  keeps it, because after the transfer Reason is no longer on the line to be asked.

## Exact details, read back

`readback.js`. Numbers, times, prices, addresses and confirmation numbers are the part of a call
that a pleasant tone hides a mistake in. Two rules, and they pull in opposite directions, which is
why this is a module and not a prompt line:

- **Spoken as words.** "Tuesday the fourteenth of October at three in the afternoon, Eastern",
  "a hundred and eighty dollars". The voice prompt already says numbers as words; the dates and
  prices are formatted here so it is not the model's arithmetic.
- **Written as values.** The record keeps `2026-10-14T15:00` with the time zone, `18000` cents, the
  confirmation string character for character. The summary the owner reads is the written side.

"Tuesday at 3" is not an agreement. A detail is not settled until the actual date and the time zone
are both clear, and a confirmation number is read back **and spelled** when it has letters in it. The
same applies in the other direction: when Reason cannot make out a key detail it asks them to repeat
it or spell it, and `[inaudible]` in a read-back blocks the agreement rather than being guessed
through. That is the noisy-line acceptance test.

## What it may agree to

`commit.js`, and a `call_commitments` row per attempt, because this is the part that spends the
owner's money.

A commitment is checked against `approved` before it is made. Inside the envelope it goes ahead.
Outside it — a new fee, a deposit, a cancellation term, a price above the ceiling, anything he did
not approve — the commitment **pauses**, and then, in this order:

1. Reason says on the call that it has to check, and holds. It does not agree and it does not refuse.
2. The owner is texted the exact difference, mid-call, through the existing `queueMidCall` path.
3. If he answers in time, the call acts on his answer.
4. If he does not, **the call ends without committing**, and the summary says exactly that — not
   that it failed, and not that it was done.

The states are `proposed`, `paused_for_owner`, `committed`, `released`, `declined`. `released` is
there for the errand case below: a call that was asked to hold an option and is then told to let it
go has to actually let it go, politely, and the row records that it did.

## Honest outcomes

`outcome.js`. The owner's distinction, as a closed set rather than a sentence in a summary:
`confirmed`, `voicemail_left`, `no_answer`, `dropped_before_confirmation`, `refused_by_them`,
`needs_owner`, `hold_gave_up`, `could_not_understand`.

The rule with teeth: **`confirmed` requires evidence.** A read-back that the other side agreed to,
and a confirmation number or an email where one exists. Without that the outcome is
`dropped_before_confirmation` or `needs_owner`, however warm the transcript reads. A call that
sounds like a success is not one, and the code that decides which word the owner sees does not get
to read the vibe.

## Never twice

`redial.js`, and the only question it answers: *did this already happen?* Before any redial to a
number, it reads the commitments and the call history for that errand and that number, and refuses
the redial when a commitment is `committed`, when a voicemail has already been left there, or when
the retry limit is reached. A call that dropped right after someone said "yes, you're booked" is the
case this exists for: the next action is **not** calling back to book again, it is calling back to
*ask whether it went through*, which is a different goal and is placed as one.

## Callbacks

A brief gives out `returnNumber` — the Twilio line — so a busy place can ring back. When it does,
`inbound.js` has a caller id that belongs to no account, which today is a stranger and one polite
line. So before that: look the number up against **open call requests**, and when it matches, the
call joins that errand with its goal and its established state instead of being greeted as a
stranger. The owner's own number keeps priority; a business calling back gets the errand context
and nothing else — no thread, no memory, exactly the third-party rules.

## Shopping around: one errand, many calls

`errand.js`, and a `call_errands` table. One request, N numbers, `kind: inquiry | booking`.

- Every provider is asked the **same core questions**, from the brief: full price, fees, what is
  included, what is excluded, availability, and **how long the quote holds**. The questions live on
  the errand so the sixth call cannot ask a thinner version of them than the first.
- Each answer is recorded as **firm or an estimate**, with who said it and when. That distinction is
  the owner's and it is kept as a column, not an adjective.
- **Parallel is for asking, never for agreeing.** Several inquiry calls may run at once, up to a
  configured limit. Bookings are serialised behind a single lock per errand, so two places cannot
  both be told yes — the failure this is built to make impossible.
- **At most one commitment, after his approval.** The others are released or declined politely, and
  the rows say so.
- **"Best deal" is not the lowest number.** The comparison names the tradeoff — cheapest, earliest,
  best fit — and says what each one costs the others. Silently sorting by advertised price and
  calling the top row the best is the thing this is written to prevent.

## One useful result

What he gets, in his own example's shape:

> I reached 4 of 6 places. Clean Co is cheapest at $180 including fees; Bright can do tomorrow for
> $210. Two never answered. The $180 is firm until Thursday; the $210 was an estimate. Want me to
> book one?

So the summary carries: who was reached and who was not, what each call established, firm vs
estimate, the tradeoff named, and the one thing needing his word — and it ends with a question when
there is a decision, because committing is his.

## Decisions taken by default (owner can override)

- **Owner's own calls are recorded like every call** (always-recorded rule). The greeting does
  not recite the recording line to the owner; the first time their number ever calls, Reason
  texts them once afterwards that calls are recorded and sent to them. Third-party calls keep
  the spoken announcement verbatim.
- **One pinned voice** for Reason, chosen by the owner by listening, stored as
  `ELEVENLABS_VOICE_ID`; never varies per call.
- **Caller ID = identity, for ORDINARY conversation only.** ~~for now~~ — superseded 2026-10-07 by
  his own prompt, which says plainly that caller ID is not sufficient authentication for accepting
  consequential instructions. What that line now means: a known number still reaches that person's
  Reason and talks freely, because that default is what makes a call good. But anything that spends,
  books, sends to a third party or changes state takes a **second factor** first, built in
  `src/calls/verify.js` — a spoken passphrase (`REASON_CALL_PASSPHRASE`) or a yes to a text on that
  same number. Once per call, in front of the ordinary confirm gate rather than instead of it. The
  spoofing limit stays in `docs/unverified.md`, but it is no longer the only mitigation.

### Settled, so nobody reopens it: their LLM fallbacks are not ours

His consolidated prompt (2026-10-07) says to leave ElevenLabs' automatic LLM fallbacks on and to
benchmark a fast model against a strong one from their supported-LLM list. **On this path that is
moot, and it is written down here so it does not come back as a decision he still owes an answer
on.** Reason is the Custom LLM: every word on every call comes from `/calls/elevenlabs/llm`, so the
platform's model list, its fallback chain and its model benchmark are all about a component this
build does not use. Which model answers a voice turn is `REASON_CALL_BACKEND`, and that is ours.

What is not moot is the same risk pointed at our own endpoint, and that is built and tested rather
than deferred: if the context cannot be loaded, or the backend is unavailable, or a turn throws
mid-call, the call keeps the same job, the same approvals and the same boundaries, says something
honest out loud instead of going silent, and — the part that matters — is handed **no tools at all**,
so a degraded turn cannot book, send, agree or invent a commitment. See `degradedContext` in
`src/calls/voice.js` and the four tests on it in `test/call-addendum.test.js`.

## Open decisions — his, not mine

The owner listed these as **not decided** and said not to pick them silently. Each is built as a
setting with a default, every default is marked as a default here and in the README setup table, and
none of them is a number I am claiming is right for him. They are all one line in `.env`.

| Decision | Setting | Default I chose, and why it is only a default |
|---|---|---|
| Max time on hold, per call | `REASON_CALL_MAX_HOLD_SECONDS` | **300** (five minutes). Long enough for an ordinary clinic queue, short enough that a wrong number does not burn ten minutes at $0.08/min plus Twilio. A busy place at lunchtime may well need more; the brief can override it per call. |
| How many inquiry calls at once | `REASON_CALL_MAX_PARALLEL` | **3**. Picked low on purpose: concurrency costs money per minute, and six simultaneous calls is also six voices that may all need him at once. Bookings are **always** 1 and that is not a setting. |
| Retry limit per number | `REASON_CALL_MAX_RETRIES` | **1** retry (so two attempts). More than that starts to look like harassment to the place being called. |
| Quiet calling hours | `REASON_CALL_QUIET_HOURS` | **21:00–08:00** local to the owner's zone, third-party calls only — his own phone is never silenced by this. A call blocked by the window is told to him, not dropped. |
| Languages beyond English and Spanish | `REASON_CALL_LANGUAGES` | **`en,es`**, which is what his spec named. Each one added also has to be enabled on the agent in ElevenLabs or the switch is a no-op, so this cannot be only an `.env` change. |
| Budget per errand | `REASON_CALL_MAX_ERRAND_CENTS` | **unset**, meaning the existing daily caps (`REASON_MAX_CALLS_PER_DAY` 10, `REASON_MAX_CALL_MINUTES_PER_DAY` 30) are the only ceiling. I did not invent a money number for him. |
| Recording and disclosure rules | see below | **Not a code decision.** |

**Recording and disclosure is an owner-setup item, deliberately.** Every call already opens by saying
it is an AI assistant and that the call is recorded, verbatim, built in code — that part is not
configurable and is the safe side of the line. What is *not* in code is any guess about jurisdiction:
whether the places he is calling sit in all-party-consent states, what the rules are where a call
terminates, or whether a given call may be recorded at all. Code that guessed that would be worse
than code that does not, so there is none. The item on his list is: **check the disclosure and
recording requirements for the places he will be calling**, and if somewhere turns out to need more
than the announcement gives, that is a conversation, not a config flag.

## Needed from the owner before Friday

| Item | Where | Why |
|---|---|---|
| ElevenLabs account + API key | elevenlabs.io → profile → API keys | `ELEVENLABS_API_KEY` |
| Twilio account + one purchased voice number | twilio.com console → Phone Numbers → Buy | the calls number; `TWILIO_ACCOUNT_SID`/API key SID + secret for the import |
| The number imported into ElevenLabs | elevenlabs.io/app/agents/phone-numbers → Import | gives `ELEVENLABS_PHONE_NUMBER_ID` |
| One agent created in ElevenLabs | elevenlabs.io/app/agents | gives `ELEVENLABS_AGENT_ID`; LLM set to Custom LLM pointing at `https://reason.tail3753c7.ts.net/calls/elevenlabs/llm` |
| A voice picked | the agent's Voice setting | `ELEVENLABS_VOICE_ID` |
| Languages enabled on the agent + the "Detect language" system tool added | the agent's Agent tab → languages; Tools → add system tool | without both, the language switch above is a function call ElevenLabs ignores |
| Anthropic API credit | console.anthropic.com | voice turns run on the API backend only |
| **Five more system tools enabled**: Skip turn, Play keypad touch tone, Voicemail detection, End call, Transfer to number | the agent's Tools tab → add system tool | each one Reason answers with but the agent does not have is a function call the platform silently ignores — hold, menus and voicemail all quietly stop working and the call still *sounds* fine |
| **A transfer rule for his own number** | the agent's Transfer to number setting | `transfer_to_number` only dials destinations that match a configured rule, so without this the "hand it to Omari" path cannot fire |
| **Interruption on as a client event** | the agent's Advanced tab → Client Events | barge-in; "he can cut it off and it stops cleanly" is on the done list below |
| **Turn settings**: `turn_eagerness: patient`, `turn_timeout` toward the long end, `max_duration_seconds` above the hold budget + errand time | the agent's settings, or the API | business lines are slow, and the platform's ten-minute default hard stop would cut a call off mid-booking after a long hold |
| Decide the open-decision defaults above, or leave them | `~/Desktop/pa/.env` | they are live as defaults either way; this is just his chance to disagree with my numbers |
| Check recording/disclosure rules where he will be calling | not code | see the note above — no flag guesses jurisdiction |

Keys go into `~/Desktop/pa/.env` the usual way (he pastes, or I take one from the clipboard
with `pbpaste`; never typed into chat).

## Bar for "done"

Judged by the owner on a real call, not from a transcript:

- picks up and speaks within about one second;
- he can cut it off and it stops cleanly;
- it knows something he texted it that morning without being told;
- it does one real thing mid-call (a calendar event, with his spoken yes) and the ledger shows it;
- a text after the call continues the same thread;
- a third-party call still opens with the announcement and still refuses a card number.

### The call-handling tests he listed

These are the owner's own list, and they are built against the fake platform and the rehearsal
harness (`npm run rehearse:calls`) because none of them can wait for Friday to be *designed* — only
to be proved on real audio. Each is a scenario the fake other-side plays, and a test that pins it.

| # | Scenario | What has to be true |
|---|---|---|
| 1 | The restaurant answers in Spanish | finishes in Spanish, task context intact, announcement heard in both |
| 2 | A key detail arrives unclear | asks them to repeat or spell it; never guesses through `[inaudible]` |
| 3 | He interrupts mid-sentence | stops; does not re-deliver the sentence it was cut off in |
| 4 | A receptionist transfers us | context carried in one sentence, **announcement spoken again** to the new person |
| 5 | A phone menu | listens to the whole menu, then DTMF; re-sends the tone if the menu does not react |
| 6 | Voicemail | leaves one message, outcome `voicemail_left`, and never a second one to that number |
| 7 | A long hold inside the limit | waits with `skip_turn`, notices the human return, picks up where it was |
| 8 | A hold that blows the budget | ends politely, outcome `hold_gave_up`, not reported as a failure |
| 9 | The price changes | commitment pauses, he is texted the difference, nothing agreed without him |
| 10 | The line drops right after "yes" | outcome `dropped_before_confirmation`; the next call **asks whether it went through** rather than booking again |
| 11 | Dates, zones, prices, confirmation numbers | read back as words, kept as exact values |
| 12 | Six providers, same questions | comparable summary, each quote labelled firm or estimate, the two unreached reported, **at most one booking committed** |
| 13 | A warm-sounding call with no confirmation | reported as not confirmed |

## Unverified until Friday

Everything above the "Facts from ElevenLabs' own docs" line is design, not behaviour. Nothing
here has been run. The exact fields of the personalization webhook response, the
`elevenlabs_extra_body` round-trip, the SSE framing the platform accepts, Twilio's per-minute
price, and whether a spoofed caller ID is as easy as it sounds are all to be proved on Friday.

The call-handling work adds its own list, and these are the ones most likely to surprise us, because
each is a place where our design rests on a reading of their docs rather than on a call:

- **Whether `skip_turn` actually holds through hold music.** Our hold handling assumes Reason can
  answer with `skip_turn` and the platform will stay silent while music plays. If the platform treats
  music as the other party speaking, it may keep handing us turns, and the budget logic will see a
  conversation rather than a hold.
- ~~**Whether voicemail detection can be survived.**~~ Settled 2026-10-13 on a live call (row 23):
  it cannot. Forwarding `voicemail_detection` ended the call at the beep with nothing said, because
  the agent's `voicemail_message` is empty. Reason now keeps the tool to itself and leaves the
  message through `end_call`'s `message` argument instead (see "Hold, menus, voicemail, transfers").
  Still unverified on a live call: that the platform speaks `end_call.message` in full before it
  hangs up on a mailbox.
- **Whether in-band DTMF works on the numbers he calls.** Their own page says some IVRs miss it on
  Twilio Native, and out-of-band is SIP-only. The re-send rule is a guess at a workaround.
- **What the human on the end of a conference transfer actually hears**, and whether anything beyond
  `agent_message` reaches them. If not, a transfer really is the end of Reason's involvement.
- **Whether the new person after an internal transfer is detectable at all** from the audio. Reason
  judging it from what it hears is the only mechanism there is; nothing marks it.
- **Every number in the open-decisions table.** Five minutes of hold and three parallel calls are
  defaults, not findings.
