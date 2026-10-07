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
- **Tools → add five more system tools.** These are the ones that make a call survive a real phone
  system rather than a demo, and the failure when one is missing is the quiet kind: ElevenLabs ignores
  a function call for a tool the agent does not have, so the call carries on sounding completely fine
  while hold, menus or voicemail silently stop working. Add all of them:
  - **Skip turn** — staying silent on hold. Without it Reason talks to hold music.
  - **Play keypad touch tone** — phone menus.
  - **Voicemail detection** — a machine answering.
  - **Transfer to number** — handing a call to you in person. Add a transfer **rule** for your own
    number as well; the tool only dials destinations that match a configured rule, so without the rule
    the hand-over cannot fire.
- **Advanced → Client Events → make sure `interruption` is selected.** This is barge-in. "I can cut it
  off and it stops cleanly" is on the done list, and it is a checkbox.
- **Turn settings.** Set **turn eagerness to `patient`** and the **silence timeout towards the long
  end**: a business line is slower than a person's phone, and `eager` talks over receptionists. Leave
  **soft timeout** on with its default filler — that is their own version of the "one sec..." pause, and
  it is better than ours.
- **Max call duration.** Their default is **ten minutes**, and that is the one setting likely to bite:
  a call that waits five minutes on hold has five left to do the errand in, and the platform cutting
  the line the moment somebody finally picks up looks exactly like a dropped call. Reason sends its own
  value per call (talking time **plus** the hold budget), but set the agent's own ceiling generously —
  say an hour — so nothing is capped twice.
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
ELEVENLABS_PHONE_NUMBER=+1...
```

That last one is the Twilio number again, in `+1...` form, and it is a different thing from
`ELEVENLABS_PHONE_NUMBER_ID`. It is what a call **gives out** when a busy place offers to ring back —
and when a place does ring back on it, Reason recognises them as that errand continuing rather than
answering them as a stranger. Leave it empty and "can I take a number?" has no good answer.

### The numbers that are yours to decide

None of these are needed on Friday; they all have defaults, and the defaults are live either way. They
are here because they are **your** calls to make, not mine — I picked each one and none of them is a
finding. `docs/calls-elevenlabs-plan.md` has the reasoning for each.

```
REASON_CALL_MAX_HOLD_SECONDS=300        # 5 min on hold, per call, then it rings off politely
REASON_CALL_MAX_PARALLEL=3              # inquiry calls at once (bookings are always 1, not settable)
REASON_CALL_MAX_RETRIES=1               # so two attempts at a number, total
REASON_CALL_QUIET_HOURS=21:00-08:00     # third parties only; your own phone is never held
REASON_CALL_LANGUAGES=en,es             # also has to be enabled on the agent, or it does nothing
REASON_CALL_MAX_ERRAND_CENTS=           # deliberately empty: I did not invent a budget for you
```

A call blocked by the quiet window is **reported** to you, never silently dropped — "I didn't ring them
because it's half eleven" is a useful sentence.

### One thing that is not a setting

**Recording and disclosure law.** Every call already opens by saying it is an AI assistant and that the
call is recorded, verbatim, built in code, and there is no switch for it. What there is no code for is
any guess about *where* you are calling: whether those places sit in all-party-consent states, or what
the rules are where a call terminates. Code that guessed would be worse than none. So the item is
yours: **check the disclosure and recording requirements for the kinds of places you will be ringing.**
If somewhere needs more than the announcement gives, that is a conversation, not a flag.

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

**Have it ring somewhere busy, on purpose.** A clinic or a garage at lunchtime — somewhere with a menu
and a queue. It should listen to the whole menu before pressing anything, go quiet on hold rather than
talking to the music, pick up where it was when a human finally answers, and ring off politely at five
minutes rather than sitting there. Then ask it what happened: "nobody came to the phone in time" is the
right answer and is not a failure. "Could not reach them" would be wrong, and worth telling me.

**Have it ring a restaurant, and have them answer in Spanish.** Ask Reason to call somewhere for a
table. It should open with the recorded-call line in English, switch to Spanish when they answer in
Spanish, say the recording line once more in Spanish, finish the booking in Spanish, refuse a card if
they ask for one, and come back to you with the summary and the audio.

**Have it ring round four or five places for one thing.** "Find me the cheapest X that can do it this
week." What comes back should read like your own example: how many of them were reached, each price
with fees in it, which are firm and which are estimates, who never answered, and a question at the end
rather than a decision. Nothing should be booked without you saying which.

If any of those is wrong, the thing to send me is what it said, not what went wrong — the transcript is
on the call row either way.

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
- **Does `skip_turn` really stay silent through hold MUSIC?** The hold handling rests on it. Their
  silence timer measures silence, and hold music is audio, so the platform may keep handing Reason turns
  as though somebody were talking. It would show up as Reason chatting to hold music — tell me straight
  away if you hear that.
- **Can voicemail be survived?** Their page reads as though detection ends the call, with no documented
  way to stay on. If so, "leave one message" is their behaviour and not ours.
- **Do the IVRs you call actually hear our key presses?** Their own docs say some systems miss in-band
  tones on Twilio, and the out-of-band fix is SIP-only. Reason re-sends a tone once and then speaks
  instead of pressing a third time.

## Before Friday, if you want to hear it

```
npm run rehearse:calls
```

Plays both scenarios through the real endpoint with a scripted other side and a real model, prints
the transcripts, and writes Reason's half of each as a voice note under `rehearsal/`. No account
needed. It is the words that are real there, not the phone.
