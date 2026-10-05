# Reason — feature list (draft, 2026-09-30)

_Companion to design.md. Nothing here is built yet unless marked._

> **Before this repo goes public:** the sections above **Decided 2026-10-04** were written while
> looking at another company's assistant and name it throughout. The current decisions, from
> **Decided 2026-10-04** down, are in Reason's own words and name nobody. Omari's call whether to
> scrub the older sections or drop them — not something to rewrite without asking, since they are
> his notes.

## What Instinct gets right (say it plainly)

1. **It has a body.** A persistent cloud computer with a browser and cached logins. That is why it can book, order, check in, and negotiate. Everything else is decoration without this.
2. **No interface.** Text or call. Thirty seconds to start. We already agree with this.
3. **It works between messages.** A task can span hours without the user babysitting it.
4. **It follows up on its own.** Dropped threads, unanswered asks, things it promised.
5. **It can make phone calls.** To places and to the user. Text is not enough for a restaurant with no booking page.
6. **It is tuned for small life stuff.** Not "write me an essay", but "the handyman never replied".

## Where Reason is different, and better

- **Group-native.** Instinct is one person and their assistant. Reason is the assistant in the group chat too: shared plan, DM fan-out, report back, split the bill.
- **Trust you can see.** Instinct's main criticism is silent, always-logged-in credentials. Reason confirms before it spends or sends on someone's behalf, keeps a receipt for every action, and lets you revoke a connected account in one tap.
- **Open source, self-hosted.** Your machine or your account, your keys. Instinct cannot be self-hosted.
- **iMessage-native UI.** Polls, tappable cards, tapbacks, effects, voice notes, real link cards. Instinct is plain text.
- **Honest about limits.** Reason has a capabilities tool and says what it cannot do. Instinct's marketing says "everything".

## Feature list

### A. Doing things (the body)

- **Browser tool.** A real browser Reason drives itself (Playwright) in a per-user sandbox. First errands: book a table, order for pickup, buy tickets, check in to a flight.
- **Connected accounts.** Email (read and send), calendar, the browser's saved logins. Each one is opt-in and revocable.
- **Phone calls out.** Reason calls a place or a person, holds, reports back. Also calls the user when text is not enough.
- **Lookups.** Web search, venues, movies and showtimes, weather, directions.
- **Money.** Pay links, split a bill, refunds. Only a tool result may say "paid". Spending cap per person, explicit yes before any charge.
- **Errand ledger.** Every action Reason took, with what it saw and what it got back. "What did you do today?" reads from this.
- **Long tasks.** A task keeps running between messages. Reason reports progress only when something changed.

### B. Proactive

- **Dropped threads.** Reason notices an ask nobody answered and follows up, or asks "want me to nudge em?".
- **Watchers.** Flight status, delivery, price drop, a reply landing. Timers already exist; watchers are timers with a condition.
- **Day-of and morning-after.** Reminders before, one "how was it?" after.
- **Rate-limited.** Proactive messages are capped so it never feels like spam.

### C. Group-native

- **Shared plan object** the whole group can change. Anyone can move a detail; Reason applies it and tells the group.
- **DM fan-out.** Reason asks people privately, collects answers, reports back once.
- **Speaks only when addressed** in groups. Summon word or mention.
- **Group decisions as polls,** not text votes.
- **Split payments** with per-person links and a live "who paid" card.

### D. iMessage-native UI (the Apple things)

- **Polls** for every choice with more than two options.
- **Tappable cards** (Linq iMessage app cards) for confirm, pick a seat, pick a time.
- **Tapbacks** as acknowledgments instead of "got it" texts.
- **Effects** for moments: confetti when a plan locks, fireworks when the group is all paid. On-device test first; effects play on open, not on arrival.
- **Real link cards.** Pay and plan links show the real date, time, place, and price in the preview. Never a placeholder image.
- **Voice notes** in and out.
- **Location** in, so "near me" works without asking.
- **Typing indicator** while a long task runs, so silence is not confusion.

### E. Trust and control

- **Confirm before commit.** Anything that spends money or messages a third party gets an explicit yes, for exactly the details you were shown. Approve but move the time and nothing goes through: it comes back with the new time and asks again.
- **Receipts.** Every action leaves one. Undo where the service allows it.
- **Connected-accounts page.** See what Reason can reach, revoke in one tap.
- **Your data.** Memory is local to your install. Export and delete are one command.
- **Allow lists.** Who may move someone else's plan, who may spend.

### F. Memory and personality

- **People.** Preferences, usual spots, past plans, who is flaky.
- **Voice.** Short, slangy, funny when it fits. Owns its mix-ups out loud.
- **Context first.** Reads the thread, never phrase-matches.

### G. Open source

- **License:** MIT. _Decided 2026-09-30. `LICENSE`, Copyright 2026 Omari Nyarko._
- **One-command self-host.** Bring your own Anthropic key and a channel (Linq or WhatsApp adapter).
- **Public evals.** The real-message eval sets ship with the repo so contributors can prove a change helps.
- **Scrub before publishing.** The repo has notes that mention Sidekick lessons. Lessons stay, names go.
- **Name.** **Reason** — antonym of Instinct. _Decided 2026-09-30. Renamed throughout: code, docs, package name, console prompt._

## Proposed build order

_Superseded by **Decided 2026-10-04** at the end of this file. Kept for the record._

1. **Body v0.** Browser tool plus one errand end to end in DM (book a table), with confirm-before-commit and a receipt. This is the thing Instinct has that we do not.
2. **Dropped-thread follow-up.** The first proactive behavior that is not a timer.
3. **Linq channel plus the iMessage UI.** Polls, cards, tapbacks, effects. This is when Reason leaves the console.
4. **Groups.** Shared plan, fan-out, report back.
5. **Open-source prep.** License, README, scrub, rename, one-command install.

## Decided (2026-09-30)

- **Name:** Reason. **License:** MIT.
- **Build order for this round:** rename + MIT → trust primitives (E) → body v0 (A) → proactive (B) → memory and voice (F) → open-source prep (G). Channel adapter comes after; console stays the surface until then.
- Repo stays private until Omari flips visibility himself.

## Still needs Omari's word

- Whether the public repo stays under the personal account.
- Credentials for phone calls out and Gmail/calendar OAuth. Until then those live in the connected-accounts registry as `not_connected` and the capabilities tool says so.

## Decided 2026-10-04

Omari's call. This replaces the proposed build order above. Three waves, in order; nothing from a
later wave gets started while an earlier one is unfinished.

### Wave 1 — the assistant you text

- **Texting.** Reason lives in a text thread. That is the whole interface.
- **Calls, with the recording.** Reason rings a real phone with a goal and comes back with what was
  said. **Every call is recorded**, every call announces at the start that it is an AI assistant
  calling on someone's behalf and that the call is recorded, and **the recording is sent to the
  owner after the call**, with the summary. No switch, no exceptions: a provider that cannot record
  cannot be used, and a recording that goes missing is reported as a fault.
- **Research that ends in a real pick.** Not a list of options and a shrug — go and look, then come
  back with one answer and the reason for it.
- **Places and weather.** Where things are, whether they are open, what it will be like out.
- **Memory and reminders.** Remember people, preferences and the small facts that make the next
  answer better. Remind at a real time.
- **Follow-ups.** Pick a dropped thread back up without being asked.
- **Pages.** An answer turned into a small web page the owner opens from a link, for when a text
  would be too long to read on a phone or when pictures, a comparison or sections make it easier to
  use — a gift shortlist with prices, an itinerary, a plan, a guide. He can ask for one ("make this
  into a page I can keep coming back to") and Reason offers one when an answer is getting long.
  The same page can be updated later at the same link, so a link already sent still works.
  **Private by default:** the link on its own does not open it — the first time on a new browser
  needs a short one-time code that Reason sends him, and then that browser stays in. Shareable only
  when he asks, and unsharing takes effect immediately. He can tap an answer on his own page and it
  comes back to Reason as something to act on.

### Wave 2 — the assistant that acts for you

- **Google calendar and Gmail.** Read and write both.
- **Reason's own email address**, so it can be written to and can send as itself rather than as the
  owner.
- **Real bookings and checkouts** — with the **exact total approved** before anything is paid. The
  number the owner says yes to is the number that gets charged, or it does not happen.
- **Saved logins**, so the sites that need an account can be used without asking every time.

#### The apps, chosen

Two kinds, because they are reached two different ways.

**With the app's own API:**

- **Google** — Gmail, Calendar, and Drive: documents, spreadsheets, slides.
- **Spotify** — what the owner listens to, and playing something.

**Through the browser, as the owner would use the site.** Each one needs him signed in once, so
all of these come *after* saved logins exist:

- **OpenTable** — restaurant tables: book, change, cancel.
- **Uber** and **Lyft** — a ride.
- **DoorDash** and **Uber Eats** — food, delivered.
- **Amazon** — find something and order it.
- **Airlines** — flights, on the airline's own site.
- **Ticketmaster** — event tickets.
- **Fandango** — showtimes and cinema tickets.

None of this is built. Every one of them is in the connected-accounts registry today as **not
connected**, with what it would do and what the owner has to supply, so asking Reason what it can
reach gets an honest answer now rather than a guess. Nothing about any of their APIs has been
assumed: where the credentials are not known yet, the registry says that instead of naming one.

### Wave 3 — the assistant that makes things

- **Documents and decks.**
- **Group texts, with polls.** Reason in the group thread, collecting answers.
- **Plug-in apps**, so what Reason can reach is not fixed by what was built in.

### Everyone who texts Reason gets their own Reason

Not one owner and a crowd of strangers: every person Reason works for has their own — their own
memory, plans, tasks, timers, watchers, receipts, connected accounts, saved logins, pages, call
recordings and approvals. None of it readable, usable or actionable from anybody else's
conversation, and a yes one person gives can never open a gate for another. Export and delete are
per person.

**Anyone may text the number; the master says who gets in.** The master is a normal account with
its own private Reason, plus admin rights. A number with no account gets one line saying access is
being asked for — and nothing it said reaches the model. The master is texted who is asking and
their first message, quoted exactly, and answers in plain words. What they meant is read by the
same guard that reads every other yes; everything around it is enforced in code: a real new
message from the master's own number, tied to one request, single use, with an expiry. Nobody can
approve themselves, and somebody else saying "let them in" does nothing at all.

**Limits that protect the master rather than the budget:** a declined number is left alone for a
cool-off and not raised again, only one request is in front of the master at a time, there is an
hourly ceiling on how many are put to them, and somebody already waiting is told once rather than
on every message.

**Each person has a daily limit** on messages and on how often Reason may interrupt them, counted
in the database so a restart does not reset it.

**What the master can do by text:** see who is waiting, see who has an account and how much each
has used, pause, resume, remove, block a number, or delete somebody's Reason. Removing stops
Reason answering and keeps everything; deleting is separate and irreversible and goes through the
gate. **The master never sees another person's content** — only the first message in a request, and
usage counts. There is no tool that shows them anybody's conversation, deliberately.

A single-owner install is unchanged: one number in config and it behaves exactly as it did.

### Testing on a subscription, and what it may not do

The operator can run Reason through their own Claude subscription to prove live behaviour without
API credit. With a real texting channel connected, that mode answers **only the operator's own test
numbers** — everybody else, invited or not, gets one "not available yet" line and no model turn,
because those turns come out of one person's personal plan. With no test numbers set it refuses to
start at all. An API key with credit is required before anybody but the operator is served, and
that is enforced per message in code rather than written down and hoped for.

### Runs without anybody's laptop

Reason is a long-running process, and on a laptop it stops when the lid closes. It can be run on an
always-on host instead: one directory holding everything it keeps (database, call recordings, saved
logins, screenshots) so a host can mount a single volume, configuration entirely from the
environment, the public address it is told to use, a stop that finishes what it was doing and
leaves no task asleep, and a health check that reads real state. Nothing is deployed and no host is
chosen. The subscription backend cannot be used on a server — it needs a person logged in on their
own machine — so a hosted Reason needs an API key with credit.

### Standing rules that are not features

- **Never pay by phone.** Reason never gives payment details out loud on a call — no card number,
  no expiry, no security code, no bank details, no PIN, for any reason, including to hold a
  booking. If something needs paying, Reason asks for a payment link or another way and brings it
  back to the owner. Enforced in code: a call request carrying payment details is refused before it
  dials, and every call carries the rule with it.
- **No coding workspace.** Writing, running or shipping code is outside what Reason is for — no
  scripts, no repositories, no pull requests, no deploys. Not a missing integration, not planned.
  `capabilities` says so in its own words under `wont_do`.

### Texting channel: Sendblue (decided 2026-10-04)

Sendblue replaces Linq as the texting channel. The Linq adapter stays in the repo, superseded. Calls still need a separate provider.

## Video understanding (added 2026-10-05)

**Omari's ask:** "It needs to be able to go to a site like YouTube and watch a video and understand
it." Somebody texts Reason a video link, or asks about one Reason found, and Reason can say what it
covers, answer questions about it, pull out steps, picks and quotes with timestamps against them,
and say honestly what it could not get at.

**Built: one tool, `video_understand({ url, question?, from?, to?, listen? })`, with two tiers that
both produce words.**

1. **The captions tier — live, and needs no key.** `yt-dlp` returns the video's title, channel,
   upload date, length, description, chapters and one caption track: the creator's when there is
   one, auto-generated otherwise, labelled either way. The captions come back as timestamped lines
   (`[14:02] …`), so an answer can point at a real moment. YouTube is what has been tried; `yt-dlp`
   covers hundreds of other sites and the code treats them identically.
   - Auto-generated captions roll — each cue repeats the line before it, with a timing tag on every
     word — so the parser strips the tags and emits each line once. Raw, a three-minute video is six
     pages of the same sentence.
   - A long video is **trimmed and says so**: what came back and what did not, as clock times, plus
     the follow-up to read the rest (`from`/`to`). Reason is told to say nothing about the stretch it
     does not have.
2. **The listen tier — built, needs a speech-to-text key.** When a video has no usable captions, or
   the owner asks Reason to listen properly, Reason downloads the **audio track only**, has it
   transcribed, and returns the same timestamped lines. `OPENAI_API_KEY` is all it needs; with it
   empty, a caption-less video comes back saying there is no way to know what is in it and Reason
   says that. A `Transcriber` interface sits behind it (`src/transcribe.js`) with a fake for tests.
   - **Audio only, borrowed not kept.** `-f bestaudio[ext=m4a]/…` takes a stream that is already a
     single audio file, so nothing is re-encoded and **ffmpeg is not needed**; `--extract-audio`
     would need it. The video stream is never asked for. The file goes into a scratch directory under
     the data dir and is deleted in a `finally` as soon as the transcript is stored.
   - **Careful with money.** Billed per minute of audio ($0.006/min on `whisper-1`), so: captions win
     whenever there are any; there is a length cap (`REASON_LISTEN_MAX_MINUTES`, 20) and a longer
     video is reported rather than part-transcribed; and transcripts are cached **per video**, not
     per person, so the second person to ask about the same link pays nothing.
   - **Where ffmpeg would be needed.** Splitting a file over the transcriber's 25 MB limit. It is not
     on this machine, so an over-size file is reported instead of being part-transcribed. The 20
     minute cap exists to keep the normal path well under that limit.
   - **A local Whisper** is documented and deliberately not installed — it would want a ~1.5 GB model
     and ffmpeg, neither of which should land on somebody's machine quietly. `LOCAL_NOTE` in
     `src/transcribe.js` says what it would take.

**The rule the whole thing is built around:** the result always says which tier answered, and both
tiers' `how` lines spell out that nothing looked at the picture. A model told `video: live` will say
"I watched it" after reading a transcript and then describe a scene that was never in front of it. So:

- `tier` is `"captions"`, `"listen"`, `"metadata"` (page facts only — neither tier worked) or `"none"`.
- `src/agent.js` tells Reason to say *read it* or *listened to it*, never *watched* or *saw*, and
  never to describe anything that is only in the picture. A machine-heard transcript also must not be
  quoted as exact.
- The ledger receipt records the tier, whether listening cost anything, and that the audio was
  deleted — so "did you actually watch that" is answerable later, and the answer is always no.

**What it will not do.** No signing in, no age-gate bypass, no membership, no region workaround. An
age gate, a private video, a members-only video, a region block, a deleted video and a URL that is not
a video each come back as the reason — and for the ones listening could not get into either, the
result says so rather than dangling a second chance.

**Seeing the picture is a possible later step, not built.** A model that takes the video itself (Gemini
accepts a YouTube URL directly) would be how; it was considered on 2026-10-05 and deliberately left
out, because speech-to-text answers the actual ask — knowing what is in a video — and nothing in
Reason should be able to half-claim it saw something.
