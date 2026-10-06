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

## Decisions taken by default (owner can override)

- **Owner's own calls are recorded like every call** (always-recorded rule). The greeting does
  not recite the recording line to the owner; the first time their number ever calls, Reason
  texts them once afterwards that calls are recorded and sent to them. Third-party calls keep
  the spoken announcement verbatim.
- **One pinned voice** for Reason, chosen by the owner by listening, stored as
  `ELEVENLABS_VOICE_ID`; never varies per call.
- **Caller ID = identity, for now.** A spoofed caller ID would reach that person's Reason.
  Written into `docs/unverified.md` as a known limit; a spoken passphrase for actions that cost
  money is the obvious next step if it matters.

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

## Unverified until Friday

Everything above the "Facts from ElevenLabs' own docs" line is design, not behaviour. Nothing
here has been run. The exact fields of the personalization webhook response, the
`elevenlabs_extra_body` round-trip, the SSE framing the platform accepts, Twilio's per-minute
price, and whether a spoofed caller ID is as easy as it sounds are all to be proved on Friday.
