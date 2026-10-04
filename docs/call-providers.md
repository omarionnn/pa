# Picking a call provider

Reason's `CallProvider` interface (`src/calls/provider.js`) is deliberately small — place a call
with a goal, check where it got to, hand back a recording — so the choice below is a swap of one
file, not a rewrite. **Nothing here is wired up.** The only provider that runs is the fake one,
which dials nothing.

This is the decision Omari has to make, so it is written as the three things that actually differ:
**does it record**, **how you get the audio**, and **what it costs**.

## The hard requirement, first

**Reason records every call it places. A provider that cannot record every call, and cannot let us
fetch the audio afterwards, is disqualified — not a trade-off to weigh against price.**

This is not a preference. It is enforced in code: a provider whose status reports that it cannot
record is refused before the dial, `capabilities` reports phone calls as not connected, and the
announcement Reason speaks at the start of every call tells the other person they are being
recorded. A provider that cannot deliver the audio makes that announcement a lie.

So the question for each option below is pass/fail first and cheap second. All five pass; that is
worth knowing, because it means price and architecture are the only live questions.

Every figure below was read from the provider's own docs on **2026-10-04**, with the page named.
Where a provider does not publish a number, it says so rather than guessing.

## The two shapes of provider

They are not the same kind of product, and the difference matters more than the price:

- **A voice agent platform** (Vapi, Bland, Retell) gives you the whole call: speech in, a model,
  speech out, and a summary. You hand it a prompt and a number. Fastest to a working call, and the
  model on the phone is *theirs*, not Reason's — so the thing talking to the restaurant is not the
  thing that has Reason's tools, memory, or confirm gate.
- **Carrier plus your own voice loop** (Twilio, Telnyx) gives you a phone line and raw audio, and
  you bring the model. Much more to build, and the voice on the call can be Reason itself, with its
  own tools and its own guard rails.

For wave 1 — "call the restaurant, ask one question, report back" — a voice agent platform gets
there sooner. The moment a call needs Reason's own memory or its gate mid-conversation, the
carrier route is the one that can do it.

## Side by side

| | Records every call? (hard requirement) | How you get the audio | Cost (per their docs, 2026-10-04) |
|---|---|---|---|
| **Bland AI** | **Pass** — `record: true` on the call, and recording is **on unless you turn it off**, which is the right default for this. Their docs also list a `recording_disclosure` requirement: the call must disclose it is being recorded | `recording_url` on the completed call | Start plan **free, $0.14/connected min**; Build $299/mo at $0.12/min; Scale $499/mo at $0.11/min. Transfers billed separately ($0.03–0.05/min) unless you bring your own Twilio |
| **Retell AI** | **Pass** | `recording_url` on `GET /v2/get-call/{call_id}` — "available after call ends". Also a `scrubbed_recording_url` with PII removed, which is a genuinely nice extra | Credit-based prepaid; **no single per-minute figure published** — their billing doc breaks it into a platform per-minute cost plus the model's per-minute cost. Needs a dashboard look |
| **Vapi** | **Pass**, via `artifactPlan.recordingEnabled` (the old `recordingEnabled`/`recordingPath` properties are deprecated). Note the setting is **per assistant**, so it is possible to end up with an unrecorded call by misconfiguring one — a risk here, not a feature | `call.artifact.recording` on the call object / end-of-call report | $5 free credits, then pay per minute: their calculator shows transcriber ~$0.0095–0.0099/min + model ~$0.0077–0.0452/min + voice ~$0.0146–0.0238/min, **plus Vapi's own platform fee, which the pricing page does not state in text**. $29/mo Core tier for 30-day retention and 10 concurrent calls |
| **Twilio** (+ your own voice loop) | **Pass** — `Record=true` on the outbound call, or `<Record>`/`<Dial record>` in TwiML. It can also pause and resume mid-call; Reason does not use that, because every call is recorded end to end | REST Recordings resource: `GET /2010-04-01/Accounts/{sid}/Recordings/{rid}` (append `.mp3` or `.wav`), or a `RecordingStatusCallback` webhook | **Not readable from their pricing page** (JavaScript-rendered). Shape is per-minute voice + a separate per-minute recording charge + per-minute storage. Needs checking in the console before it goes in a budget |
| **Telnyx** (+ your own voice loop) | **Pass**, recording on the Call Control API | Recording URLs on the call-recording webhook | Not checked — only worth pricing if the carrier route wins on architecture first |

## What Reason needs from whichever one wins

The interface already expects these, so a provider that cannot do them needs an adapter that says
so honestly rather than a quiet gap:

1. **Record every call, with no way to end up not recording one.** The disqualifier above. Watch
   for per-assistant or per-plan recording settings (Vapi's `artifactPlan` is per assistant) —
   those are a way to accidentally ship a call that is not recorded while the announcement still
   says it is.
2. **Speak a fixed opening line, verbatim.** Reason builds the announcement in code
   (`announcementFor`) and passes it to `place()`; a provider that only takes a free-text system
   prompt can have it pasted in front, but it must be first and it must not be paraphrased. Bland's
   `recording_disclosure` and Vapi's Enterprise consent plans are both pointed at this problem,
   which is a good sign the requirement is normal.
3. **Hand over the audio after the call,** as a URL or a file. All of them do. How long they keep
   it matters too: Vapi's free tier keeps raw data **14 days** ($29/mo for 30, $999/mo for 180).
   Reason copies the audio onto this machine as soon as the call ends, so a short retention window
   is survivable — but it means a failed fetch cannot be retried a week later.
4. **Never pay by phone.** Omari's standing rule: no card details by voice, ever. That is Reason's
   rule to keep, not the provider's.
5. **A per-call cost figure**, so `cost_cents` on the call row is real rather than decorative.

## Recommendation

Start with **Bland** for the first real call. It is the only one where recording being mandatory
is the *default* rather than something you configure — recording is on unless you turn it off, and
their own docs already treat a recording disclosure as a requirement. Plus a free tier, one
`recording_url`, and a published per-minute rate that needs no sales conversation. Shortest path
from "no telephony account" to "a recording of a real call arrived in Omari's texts".

**Retell** is the better second look if the audio matters a lot — `scrubbed_recording_url` is the
only PII-stripped recording in the list — but its price needs a dashboard visit first.

Keep **Twilio** in mind for when a call has to be Reason itself rather than a hired voice: it is
the only one where the thing on the phone could hold Reason's own memory, tools and confirm gate.
Its pause/resume recording is not a reason to pick it — Reason records end to end.

Still only Omari can do the next step: open an account and put a key in `.env`. Until then
`capabilities` says phone calls are not connected, and Reason tells people so.
