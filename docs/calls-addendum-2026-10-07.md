# Calls addendum — 2026-10-07, from Omari's consolidated product prompt

This is an **addition to `docs/calls-elevenlabs-plan.md`**, not a replacement. It comes from the
full product prompt Omari wrote for Reason (messaging-first personal assistant). Only the
voice/call-relevant parts are here; the photo, image-generation, email and website sections of that
prompt belong to other sessions and are deliberately left out.

**Read this first:** most of his written call spec is already in the plan — hold, phone menus,
voicemail, transfers, read-back of exact details, commitment limits, honest outcomes, never-book-twice,
callbacks, shopping around, one useful result, and the open-decision defaults (hold budget, parallel
calls, retries, quiet hours, languages, recording as an owner-setup item). **Where this addendum
repeats the plan, treat it as confirmation and do not rebuild anything.** The items below are the
real deltas.

His stated priority for calls is unchanged: *"reliable hold handling, complete quotes and no
duplicate commitments."* Everything here stays dormant until Friday 2026-10-09 when he puts the keys
in, and everything is shape-tested against injected fakes — no real network calls.

---

## 1. The default voice is now decided in character, not in ID

Confirmed: the default voice should sound like a **young adult British woman**, English. Exact voice
ID is still open and must not be guessed.

- Keep the one-pinned-voice decision (`ELEVENLABS_VOICE_ID`, never varies per call).
- The Friday checklist line "a voice picked" becomes specific: pick an **English / British /
  female / young-adult** voice by **listening to real samples in the TTS model we actually ship**,
  including **phone-quality audio** and **Spanish** (the language switch has to survive the voice).
- Voice-library metadata carries accent, gender and age, but metadata is not proof it sounds right —
  auditioning is required.
- Check usage rights, plan access and removal/notice terms for the voice before pinning it.
- **Never name a voice ID from memory or hardcode one.** Dormant without the env var, as with the
  other keys.
- Eleven v3 Conversational has a documented **Professional Voice Clone fidelity limitation**, so the
  voice *type* matters: check it before relying on a cloned voice's identity.

## 2. The TTS model is a choice we have to make and expose, not a given

- Start the naturalness trial on **`eleven_v3_conversational`** (this is what enables expressive mode
  in ElevenLabs Agents). Compare against **`eleven_flash_v2_5`** for responsiveness.
- Do **not** treat generic offline Eleven v3 as interchangeable with the conversational model.
- Vendor figures in the model docs are roughly **280 ms (v3 Conversational)** and **75 ms (Flash
  v2.5)** for *speech synthesis alone*, excluding application and network delay. These are not our
  end-to-end call latency and must not be written down as if they were.
- Expressive mode's docs say v3 Conversational has **the same TTS pricing as other models inside
  Agents**. Do not infer Agents call cost from standalone TTS per-character discounts. Real plan,
  telephony, LLM, concurrency and hold-time cost all have to come from the account on Friday.
- Make it `ELEVENLABS_TTS_MODEL` with a documented default, one line in the README setup table, and a
  line in the owner's Friday list, exactly like the other open-decision settings.

## 3. Spoken-number normalization, under whichever model is chosen

The read-back section stands. Add explicit normalization for **spoken** output of dates, amounts,
addresses, phone numbers and confirmation numbers — **Flash v2.5's default number normalization has
documented limits**, so this cannot be left to the model. The *written* record keeps the exact
values; only the spoken form is normalized. Test it against whichever model is selected.

## 4. Two turn-tuning profiles, not one

The plan tunes `turn_eagerness: patient`, a long `turn_timeout` and a large `max_duration_seconds`
for **business lines**. Owner conversations need their own profile — faster turn-taking, shorter
silence timeout, a different max duration. Tune them **separately** and say which profile a call is
using in the call record. Part of this is distinguishing **a hesitation from the end of a turn**;
that belongs in the owner profile and in the tests.

## 5. Interruption is more than "it stops cleanly"

- Stop audio the moment he cuts in (barge-in, already on the Friday list as a client event).
- **Keep what he actually heard**, plus his correction.
- **Resume the updated request** — never re-read the abandoned answer from the top.
- Add this as its own test: speak, interrupt mid-sentence with a correction, and assert the next turn
  answers the corrected request and does not repeat the discarded one.

## 6. Caller ID: his prompt is stricter than the plan

The plan says *"Caller ID = identity, for now"* and files the spoofing risk in `docs/unverified.md`.
His prompt says plainly: **caller ID alone is not sufficient authentication for exposing private
context or accepting consequential instructions.**

Resolution to build (not just document):

- Ordinary conversation on a known number stays as it is — that default is fine and keeps the
  experience good.
- **Gate the consequential path.** Anything that spends money, sends to a third party, books, or
  changes state needs a second factor on voice: the spoken passphrase the plan already names as the
  obvious next step, or a confirm-by-text to the same number.
- A spoken "yes" counts as approval **only** when the caller is authenticated and the yes is tied to
  the scope that was actually read back.
- Keep the limit in `docs/unverified.md` too, but it should no longer be the only mitigation.

## 7. Context continuity, and honesty when it fails

Mostly already in the plan (owner context builder). Add:

- Load the relevant recent thread, established preferences, **pending tasks** and **scoped
  approvals** into the voice session; fetch newer context mid-call when needed.
- **Write call outcomes and corrections back** so the next text or call knows what happened on the
  phone. A correction made by voice must apply to the text thread afterwards.
- **If context cannot load, say so.** Offer a safe retry or plain general conversation — never
  pretend to remember. Silence or a confident guess is the failure mode to avoid.
- Never mix two people's context. Already the rule; keep it enforced in code, not by prompt.

## 8. NEW capability: "make this call for me", said during a call with him

This is not in the plan and is the biggest addition. He is on the phone with Reason and asks it to go
call somewhere.

- **Accept and clarify the errand while still talking to him.** Carry the request into the outgoing
  business call without making him repeat it.
- Ask only for the missing details that matter: verified recipient/number, the outcome wanted,
  constraints, what may be disclosed, timing, and any commitment approval.
- **Review the final recipient and the brief with him before dialing**, unless an explicit standing
  grant covers that exact kind of call. Casual discussion is not approval. A website, another caller,
  or the fact that he rang Reason is not approval.
- **One persisted task** carrying the call brief and the authorization state. The dial starts through
  a **server-side authorized workflow, not a model command**: the backend enforces who may request a
  dial, which recipients are approved, spend/commitment limits, deduplication and cancellation. A
  webhook tool may ask; only our code decides.
- Tell him which state it is in: **preparing / dialing / waiting / needs approval / verified result**.
  A queued request is not a completed call.
- Let him choose: keep talking, hang up and get the result by text, or join when needed. **Do not
  promise a conference or bridge, or simultaneous calling, without verifying platform support and
  limits** — if it is not verified, it goes in `docs/unverified.md` and the honest option is
  "I'll text you the result".
- Keep the outgoing call **and any callback** attached to the original task. After a transfer or a
  reconnect, reuse the approved brief — but **check first whether the earlier call already
  committed** (the never-twice rule already in the plan).
- Honour stop/revoke before any new effect. If a booking already happened, say so and give the
  cancellation options.
- On completion, **one** result back into the same conversation: who was reached, what they
  confirmed, dates/times/prices, confirmation evidence, what failed, and what decision still needs
  him. Every section-20 rule still applies inside this flow.

## 9. Fallbacks: his prompt's version is mostly moot on our path — ours isn't

His prompt says keep ElevenLabs' automatic LLM fallbacks on, and benchmark a low-latency model
(Gemini 3.7 Flash) against a stronger one (Claude Sonnet 5) from ElevenLabs' supported-LLM list.
**On our path that is largely moot: we are the Custom LLM.** The platform's model list and its
fallback chain do not apply to `/calls/elevenlabs/llm`.

What does apply, and should be built and tested:

- If **our** endpoint errors, times out, or the backend model is unavailable mid-call, there must be a
  tested degraded path that keeps the same task, the same approvals and the same safety boundaries,
  never invents a commitment, and says something honest on the call rather than going silent.
- Write the moot part down in the plan so nobody re-opens it as a decision he still owes an answer on.

## 10. Testing and release gates

Keep his eight call-handling tests. Add:

- Use ElevenLabs' **simulation, next-reply and tool-call tests** for conversation logic, with
  **mock/test-only destinations and fail-closed mocks** so no test can ever dial or commit. Repeat
  each scenario to measure **variation**, not a single pass.
- New cases: a **wrong caller** (a number that is not the owner); **hesitation vs a finished turn**;
  **background noise**; **duplicate tool requests**; **cancellation mid-errand**; a
  **context-service outage**; an **endpoint/model fallback**; and a **disconnect immediately after a
  possible booking**.
- Measure: end-to-end response latency **median and p95**, interruption stop delay, context accuracy,
  correct tool parameters, outcome success, **false-success reports**, duplicate effects, and cost per
  completed task.
- **Baseline first, thresholds with Omari after.** Do not invent a guarantee.
- **Block release on:** any unauthorized effect, any cross-user disclosure, any duplicate commitment.
- A transcript simulation alone never proves audio quality or phone reliability — that part waits for
  Friday and goes in `docs/unverified.md` until proven.

## 11. Live delivery, for the owner's own calls

Short spoken answers, warm and clear, natural pauses, brief acknowledgements. Do not overdo laughter,
fillers or emotional performance. Quiet waiting during hold music, with brief progress feedback only
when it is actually useful. Natural delivery never means claiming to be human — the disclosure rules
already in the plan stand.

## 12. Written summaries follow his normal message rules

A call result texted to him opens with plain bullets: what happened, what it means, and the one thing
(if any) that needs his word. Any link goes in its own message, never buried in a paragraph.
Technical detail goes underneath.
