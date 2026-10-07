# Friday: switching the phone on

Everything is built, tested and dormant. Nothing in this is a code change — it is accounts, keys and
seven lines in `.env`. Until the keys exist Reason says it cannot ring anyone and cannot be rung, and
means it.

Takes about half an hour, most of which is waiting for Twilio.

## 1. Accounts and keys

- **ElevenLabs** — sign up, then profile → API keys → create one. That is `ELEVENLABS_API_KEY`.
- **Twilio** — sign up, Phone Numbers → Buy a number, pick one with **Voice**. Also note the Account
  SID and make an API key (SID + secret); ElevenLabs asks for those to import the number.
- **Anthropic API credit** — console.anthropic.com. A phone turn cannot wait on a headless CLI start,
  so calls run on the API backend; the rest of Reason can stay on the subscription.

## 2. The number

ElevenLabs → Agents → **Phone Numbers** → **Import**, and give it the Twilio number plus those Twilio
credentials. The id it hands back is `ELEVENLABS_PHONE_NUMBER_ID`.

Import it, don't "verify a caller ID": a verified caller ID is outbound only, and half of this is
people ringing you.

## 3. The agent

ElevenLabs → Agents → create one. Its id is `ELEVENLABS_AGENT_ID`. Then, on the agent:

- **LLM → Custom LLM.** URL `https://reason.tail3753c7.ts.net/calls/elevenlabs/llm`, and a secret of
  your choosing as the bearer token. That same secret is `ELEVENLABS_LLM_SECRET`. This is the whole
  trick: every word said on every call comes from Reason itself through that URL.
- **Voice.** Listen to a few and pick one. Its id is `ELEVENLABS_VOICE_ID`. One voice, every call.
- **Languages.** Add every language it may speak — Spanish at least, for the test below. The list has
  to include a language for it to be able to switch to it.
- **Tools → add system tool → Detect language.** Without it, Reason asking to switch language is a
  function call ElevenLabs ignores. Leave **"only at conversation start" OFF**: the person who speaks
  Spanish is often not the one who picks up.
- **Tools → add system tool → End call.**
- **Security → enable the personalization webhook**, URL
  `https://reason.tail3753c7.ts.net/calls/elevenlabs/inbound`. This is what makes a call from your
  number reach your own Reason, and a call from a number you have not approved get one line.
- **Post-call webhook** (Agents settings), URL
  `https://reason.tail3753c7.ts.net/calls/elevenlabs/post-call`, and set a signing secret — that is
  `ELEVENLABS_WEBHOOK_SECRET`. Required, not optional: this delivery writes a transcript into
  somebody's own conversation, so an unsigned one is refused.

## 4. `.env`

Into `~/Desktop/pa/.env`:

```
REASON_CALL_PROVIDER=elevenlabs
REASON_CALL_BACKEND=api
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_PHONE_NUMBER_ID=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_LLM_SECRET=...
ELEVENLABS_WEBHOOK_SECRET=...
```

Then restart Reason. `curl -s localhost:8787/health` and ask it "can people call you?" — it reads the
answer off the keys that are really there, so if it says no, something above is missing and it names
which.

`REASON_CALL_PROVIDER=bland` puts it straight back. Nothing is lost either way.

## 5. The two calls that say it works

**Ring it from your own phone.** It should pick up and open with something that is actually going on
— "you're in the middle of finding somewhere for Friday" — not "how can I help". Then: cut it off
mid-sentence and it should stop cleanly; ask it about something you texted it that morning and it
should know; ask it to do one real thing and say yes out loud, and the ledger should show it. Hang up,
then text it — the text should carry on from the call rather than starting again. First call only,
you also get one text saying calls are recorded.

**Have it ring a restaurant, and have them answer in Spanish.** Ask Reason to call somewhere for a
table. It should open with the recorded-call line in English, switch to Spanish when they answer in
Spanish, say the recording line once more in Spanish, finish the booking in Spanish, refuse a card if
they ask for one, and come back to you with the summary and the audio.

If either of those is wrong, the thing to send me is what it said, not what went wrong — the
transcript is on the call row either way.

## What to watch for, because none of it has run yet

Everything above the keys is built against ElevenLabs' docs and tested against fakes; nothing has
touched the real platform. The four most likely things to be wrong on Friday, all in
`docs/unverified.md` with more detail:

- **Does it accept our SSE?** The framing is what their docs describe, byte for byte, but a platform
  that wants something slightly different will show up as a call that connects and says nothing.
- **Can an inbound turn find its call?** Outbound calls carry Reason's own ids; inbound ones are
  matched on ElevenLabs' conversation id, under whichever field name their request really uses. If
  inbound calls answer with "I can't pick this one up", that is this.
- **Which field says "voicemail".** Read from several of their names at once. If a voicemail gets
  reported as a conversation, that is this, and it is the one worth telling me about immediately.
- **Latency.** Should be about a second to the first word. If it is three, the thing to try first is
  a smaller model for voice turns.

## Before Friday, if you want to hear it

```
npm run rehearse:calls
```

Plays both scenarios through the real endpoint with a scripted other side and a real model, prints
the transcripts, and writes Reason's half of each as a voice note under `rehearsal/`. No account
needed. It is the words that are real there, not the phone.
