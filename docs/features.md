# Reason — feature list (draft, 2026-09-30)

_Companion to design.md. Nothing here is built yet unless marked._

## What an assistant like this has to get right

1. **It has a body.** A browser it drives itself, with saved sign-ins. That is what lets it book, order, check in, and negotiate. Everything else is decoration without this.
2. **No interface.** Text or call. Thirty seconds to start.
3. **It works between messages.** A task can span hours without the user babysitting it.
4. **It follows up on its own.** Dropped threads, unanswered asks, things it promised.
5. **It can make phone calls.** To places and to the user. Text is not enough for a restaurant with no booking page.
6. **It is tuned for small life stuff.** Not "write me an essay", but "the handyman never replied".

## Where Reason is different, and better

- **Group-native.** Not only one person and their assistant: Reason is the assistant in the group chat too. Shared plan, DM fan-out, report back, split the bill.
- **Trust you can see.** No silent, always-logged-in credentials. Reason confirms before it spends or sends on someone's behalf, keeps a receipt for every action, and lets you revoke a connected account in one tap.
- **Open source, self-hosted.** Your machine or your account, your keys.
- **iMessage-native UI.** Polls, tappable cards, tapbacks, effects, voice notes, real link cards. Not plain text only.
- **Honest about limits.** Reason has a capabilities tool and says what it cannot do. It never claims "everything".

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
- **Inline replies**: an answer pinned under the message it is about, when the chat has moved on.
- **A voice**: Reason can say something as a real voice note, and listens to the ones you send.
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
- **Name.** **Reason**. _Decided 2026-09-30. Renamed throughout: code, docs, package name, console prompt._

## Proposed build order

_Superseded by **Decided 2026-10-04** at the end of this file. Kept for the record._

1. **Body v0.** Browser tool plus one errand end to end in DM (book a table), with confirm-before-commit and a receipt. This is the piece everything else depends on.
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

**Built: one tool, `video_understand({ url, question?, from?, to?, watch? })`, with three things that
can answer and a result that always says which.**

1. **The captions tier — live, needs no key.** `yt-dlp` returns the video's title, channel, upload
   date, length, description, chapters and one caption track: the creator's when there is one,
   auto-generated otherwise, labelled either way. Timestamped lines (`[14:02] …`), so an answer can
   point at a real moment. Free, so it answers whenever it can.
   - Auto-generated captions roll — each cue repeats the line before it, with a timing tag on every
     word — so the parser strips the tags and emits each line once. Raw, a three-minute video is six
     pages of the same sentence.
   - A long video is **trimmed and says so**: what came back and what did not, as clock times, plus
     the follow-up to read the rest (`from`/`to`).
2. **The watch tier — built, needs `GEMINI_API_KEY`.** A YouTube link goes straight to Gemini as a
   `file_data` part; Gemini fetches and watches the video itself, picture and sound. Nothing is
   downloaded. **This is the only place Reason may honestly say it watched something**, and the
   receipt names the model that did it.
3. **The listen tier — built, same key.** Gemini takes uploaded audio rather than an arbitrary page,
   so for any site that is not YouTube Reason pulls the **audio track only**, uploads it through the
   Files API, and has it transcribed. Audio means no picture, so nothing visual may be claimed off
   it; the result says "listened to the audio".

Tier 2/3 run when there are no usable captions, when the owner wants the video actually watched or
listened to, or when the question is about something only in the picture — that last judgement is the
model's, made by passing `watch: true`, because the house rule is that the model reads meaning and
code enforces facts.

- **Audio only, borrowed not kept.** `-f bestaudio[ext=m4a]/…` takes a stream that is already a single
  audio file, so nothing is re-encoded and **ffmpeg is not needed**; `--extract-audio` would need it.
  The video stream is never asked for. The file goes into a scratch directory under the data dir and
  is deleted in a `finally` as soon as the transcript is stored.
- **Careful with money.** Per Google's docs: a video is ~100 tokens a second at default media
  resolution, audio is 32 a second — roughly 0.45 and 0.14 cents a minute on `gemini-3.8-flash`. So
  captions win whenever there are any; there is a length cap (`REASON_VIDEO_MAX_MINUTES`, 60) and a
  longer video is refused in plain words; and accounts are cached **by video and by tier**, not per
  person. A request for one stretch is deliberately never cached, because an account of 14:00–16:00 is
  not an account of the video.
- **Optional, and not what runs:** an OpenAI speech-to-text transcriber for the audio path and a local
  Whisper, both in `src/transcribe.js`, both offline-tested. Gemini does the audio; these run only if
  `REASON_TRANSCRIBER` says so. The local one would want a ~1.5 GB model and ffmpeg, so it is
  documented rather than installed.

**The rule the whole thing is built around:** the result always says which tier answered, and the two
word-only tiers' `how` lines spell out that nothing looked at the picture. A model told `video: live`
will say "I watched it" after reading a transcript and then describe a scene that was never in front
of it. So:

- `tier` is `"captions"`, `"watch"`, `"listen"`, `"metadata"` (page facts only — nothing worked) or
  `"none"`.
- `src/agent.js` tells Reason to match the tier: *read it*, *watched it*, *listened to it*; and never
  to describe anything visual off captions or audio. A machine-heard transcript also must not be
  quoted as exact.
- The ledger receipt records the tier, which model watched or transcribed, whether anything was spent,
  and that the audio was deleted.

**What it will not do.** No signing in, no age-gate bypass, no membership, no region workaround. An
age gate, a private video, a members-only video, a region block, a deleted video and a URL that is not
a video each come back as the reason — and since Gemini only takes public videos either, a gated video
is not a case for trying the other way, and the result says so rather than dangling a second chance.

## Research with a real pick (added 2026-10-05)

**Omari's ask:** "Deep web research across many sources, including Reddit and review sites, with a
real pick at the end." The thing that prompted it: asked **"iPhone 17 or 18?"** Reason read Apple's
own page, could not get a price, and had no recommendation. It had `web_lookup` — fetch *one* page —
and no way to find out which pages were worth fetching.

**Built: two tools and a guard.**

1. **`web_search({ query, max_results?, sites?, recent? })`** — behind a `SearchProvider` interface:
   `name`, `status()`, `search(query, opts)`, and nothing else. Query in, ranked results out: title,
   url, snippet, and a date when the provider has one. One real provider (Tavily), one fake for the
   tests. Swapping in Brave later is a new file and a config line, not a change to the flow.
2. **`research({ question, queries, deep?, research_id? })`** — plan a few genuinely different
   searches → search each → read the best sources in full with `web_lookup` → keep a source log of
   url, what it said and its date → answer from that log. `deep: true` makes it a durable task.
3. **`src/robots.js`** — does the site allow being read? Asked before every research fetch.

**Tavily, and why.** 1,000 API credits a month, free, **no credit card** (docs.tavily.com, read
2026-10-05); a basic search costs 1 credit. That last part decided it: Brave Search's free tier is $5
of monthly credit on a billing plan, and the whole point is a key Omari can go and get in two minutes
without approving spend. Tavily also returns a `content` snippet pulled from each source and takes
`include_domains`, so "what does Reddit say" is one parameter. Past the free tier: $0.008/credit
pay-as-you-go, or $30/mo for 4,000. Env name `TAVILY_API_KEY`, as their docs and SDKs use.

**The division of labour, which is the whole design.** The model plans the queries and writes the
pick, because those need judgement. Everything that decides what is *true* is code: a source exists
only if a search returned it or a fetch succeeded; `said` is text that came back, trimmed, never
summarized on the way in; the caps are counted on the row; a run is a database row, so a deep one
survives a restart with its log intact. The model answers from a log it is handed and cannot cite
what is not in it.

**Three lists, and the difference between them is the honesty.**

- `sources` — **fetched.** `said` is real page text.
- `snippets_only` — the search found it, nobody read it. Quotable *as a snippet*, labelled that way.
- `skipped` — would not load, or the site forbids being read, with which and why.

**The answer's shape** (guidance in `src/agent.js`): the pick first in one or two lines with the
reason; then what would change it; then 2–4 sources named plainly as site names. Long or genuinely
comparative → a page with the comparison and the links. Never one source called research, never a
price or spec that is not in the log, and it says what it could not find.

**Caps, because one question must not run away.** 5 searches, 8 pages, 90 seconds per go, counted
across the whole run however many turns it spans. **A cap that ends a run is reported** — the result
names it and Reason says the look was partial. The first version of this silently truncated the
source list when the page cap bit and reported nothing; the offline test caught it, which is the
reason that test exists.

### Reddit and review sites: what actually works

Worth finding out rather than assuming, and the answer is not the convenient one. Checked 2026-10-05:

- **Reddit forbids all fetching.** `reddit.com/robots.txt` is `User-agent: * / Disallow: /` — the
  whole site, every agent. So Reason does not fetch it, and `src/robots.js` is what makes that a
  guard rather than a good intention.
- **It would not have worked anyway.** `www.reddit.com/r/…/comments/…` answers 200 with **six
  characters** of readable text (a JavaScript shell). The old `.json` route answers **403 Blocked**.
  `oauth.reddit.com` answers **403** without a token.
- **There is no official unauthenticated route left.** What remains is a registered Reddit app under
  their Public Content Policy, which is an account and an agreement nobody here has signed up for.
- **So Reddit arrives as search snippets** — the provider fetched the thread, Reason did not — and
  Reason says exactly that ("a couple of reddit threads say…"). The snippet may be quoted; nothing
  beyond it may be described.
- **Review sites are fine.** rtings, Tom's Guide, CNET, Consumer Reports, The Verge, GSMArena, Yelp,
  Trustpilot and Hacker News: none has a blanket disallow, so all are fetched and read properly.

**Every quoted opinion comes from a source in the log, and there is no path by which it could not** —
the log is the only thing the model is handed to quote from, and nothing can add a source to it by
hand.

### Still open on this

- **The robots guard only covers research reads.** `web_lookup` and the browser are unchanged, so the
  model could still fetch a disallowed page directly. Extending the guard to `web_lookup` is the
  consistent move but changes behaviour other errand flows depend on — **Omari's call.**
- **Link URLs on pages are not checked against `seen_urls`.** Images are. So a source link on a
  research page is only as honest as the model, where a picture is enforced. Same shape of fix,
  same risk of breaking existing page flows.
- **Nothing has been sent to Tavily.** No key. The request shape is tested against their documented
  contract; whether Tavily returns usable Reddit snippets in practice is **unproven** and is the
  first thing to check when a key exists. See `docs/unverified.md`.

## Saved sign-ins, real sites and Spotify (added 2026-10-05)

**Built.** The design the owner approved: a person signs in themselves, once per site, in a real
browser window; Reason keeps that session and never sees a password.

- **`npm run signin -- <site>`**, with `--list`, `--check` and `--forget`. Signed-in is what the
  site says when asked, never what was hoped.
- **`signin_status`** for the model, which also carries the refusal for anybody offering a password.
- **Ten site playbooks** (`site_playbook`): OpenTable, Uber, Lyft, DoorDash, Uber Eats, Amazon,
  Delta, United, Ticketmaster, Fandango — entry page, sign-in need, signed-in probe, commit labels,
  limits, and whether the site loads for Reason at all. Six of the ten refuse an automated browser
  today, and that is reported rather than worked around.
- **`uber_link`**: Uber's own public link with the destination filled in, for the person to finish.
- **A daily spending limit** per person, enforced in the gate before a commit (`spend_today`).
- **Spotify** by the documented authorization-code flow, per person: search, now playing, playback
  control, queue, playlists, listening history.

**Not built, on purpose:** any way to sign in for somebody who is not at the machine. It needs a
hosted browser they can see; a password form is ruled out.

**Still to do:** the owner signing in to the sites that load, which is the first real test of every
probe; a Spotify developer app; and a decision about the six sites that refuse — a phone call, an
official API where one exists, or leaving them.


## Telling people what's new (added 2026-10-05)

**Built.** When something lands, the people already texting Reason are told — casually, in passing,
on the end of a reply Reason was already sending. "oh btw you can connect your gmail now." Never a
text out of nowhere, never a changelog, never twice to the same person.

The list is in code (`src/whatsnew.js`): one entry per announceable thing, each naming the
capability it rests on and a plain fact for the model to phrase in its own words.

**The two gates, both in code rather than in the prompt:**

- **It must have been used end to end on the live Reason.** An entry carries a `verified` record —
  the day somebody saw it work and one sentence of what they actually did. Without that record, or
  with the evidence left blank, the entry never reaches the model, for anybody. Marking is a
  person's job after really using the thing, and `docs/unverified.md` has to have stopped listing
  the feature first; the file header is the checklist and a test fails on a half-filled record.
- **It must be live for the person being told**, read from the same per-conversation `capabilities`
  the model gets. Nobody is told about something that would answer "not connected" when they try it.

**What code owns:** one thing per reply, one per person per day, nothing while a confirmation is
open, nothing on a message Reason started itself (timers, watchers, tasks, dropped threads), and
nothing announced as new to somebody whose account is younger than the feature. The turn carries the
fact as a note; the row saying they have heard it is written only once the reply has actually gone
out, so a turn that ends in silence or a send that fails leaves it unheard.

**What the model owns:** whether this is the moment. It is told to skip the line entirely if they
are upset, in a hurry, mid-errand or waiting on an answer, and to write it as one short line in its
own voice. If it leaves it out, nothing is recorded and it comes round again.

"What's new" / "what can you do now" asked outright is answered from the same list, through
`capabilities`.

**Seeded with one entry: Gmail, unverified.** Nothing for Gmail is built, so it stays silent. It is
there as the working example of the gate.
## Gmail, per person (added 2026-10-05)

**Built.** "I want Reason to be able to access its user's email account" — each person's own inbox,
by Google's documented authorization-code flow. Nobody gives Reason a password.

- **`google_connect`** gives a link to text them. They tap it, agree on Google's own consent screen,
  the callback page says it worked in Reason's own look, and Reason texts back which address is now
  connected. One trip through it covers their mail and their calendar together.
- **`google_disconnect`** revokes at Google and deletes the tokens here, and says honestly when
  Google would not confirm the revoke rather than claiming it is fully gone.
- **Exactly two scopes**, the ones enabled on the client: `gmail.modify` and `calendar`. The
  connected address comes from Gmail's own profile endpoint, so no identity scope is asked for.
- **Mail tools:** `gmail_search` (Gmail's own query syntax), `gmail_read` (one message or a whole
  thread, HTML stripped, attachments listed by name and size and never downloaded, long bodies cut
  short and said so), `gmail_labels`, `gmail_draft`, `gmail_send` (new, or a reply with the threading
  headers taken off the real message), `gmail_archive`, `gmail_mark`, `gmail_label`, `gmail_trash`.
- **Reading, searching and drafting need no yes. Sending, binning, and touching more than one message
  at once go through the gate**, and the confirm shows the real recipients, subject and whole body.
  The yes is pinned to a target computed from what is really about to be sent, so changing a word, a
  recipient or the thread after the yes is refused.
- **An email's contents are untrusted input**, marked as such in every result that carries mail, with
  the rule in the system prompt. A flow test proves an email ordering a forward and a verification
  code produces no send without the person's own reply.
- **Receipts** for every send, bin, label change and draft, and for every refusal. Not for reads.
- **A dead connection is its own state.** Google can end a grant at any time (access removed, a
  password change, or seven days after consent while a consent screen is in Testing; this app's was
  published 2026-10-05 and is unverified, with a 100-**Google-account** lifetime cap): `invalid_grant`
  drops that account's grant, marks that address as needing a reconnect, and gets one plain line with a
  fresh link. It never retries, and it never touches another account of theirs.
- **Export and delete** cover it: the token values never leave the machine, and a delete revokes at
  Google first, best effort, reported honestly.

**Not built, on purpose:** permanent deletion of mail. `users.messages.delete` requires the
`https://mail.google.com/` scope and Reason does not ask for it, so the bin is as far as it goes and
the capability text says so. Attachments are listed, never downloaded or opened. Drive stays not
connected: it would need a scope on the consent screen that buys nothing today.

**Still to do:** the first real sign-in, which is Omari's with somebody watching — nothing here has
touched Google. Then the two things a fake server cannot settle: whether a reply really lands in a
real Gmail thread, and how a real marketing email reads once its HTML is stripped.

## Their calendar (added 2026-10-05)

**Built.** The same per-person Google connection as Gmail, so connecting one connects both.

- **`calendar_events`** between two times: recurring events expanded into real occurrences, in order,
  with an optional free-text search.
- **`calendar_event`** reads one in full and says whether changing it would email anybody.
- **`calendar_create`**, **`calendar_change`**, **`calendar_delete`**.
- **Who is on the event is what decides whether a yes is needed.** Nobody else on it: a private note
  to themselves, written without asking. Anybody else on it: Google emails them, so it goes through
  the gate with the people, the day and the time said back. Adding people to an event that had none
  counts as reaching them. `sendUpdates` is stated explicitly on every write, never left to default.
- **For a change or a delete the gate is inside the handler**, which is the only place in the repo
  that does this — who is on an existing event is a fact only Google has, so the event is fetched
  first, nothing is changed, and then it asks.
- **Times belong to their calendar's zone**, fetched from Google on every call, never the server's.
- **An invite's own text is untrusted input**, the same as an email's.

**Not built, on purpose:** any calendar but `primary`, and recurring-event writes. Nothing creates,
changes or deletes a repeating event or a single occurrence of one, and no tool lists their other
calendars.

**Still to do:** the first real use, with Omari. Above everything else, whether `sendUpdates=all`
really sends the invitations and `none` really sends nothing — a fake server cannot answer that, and
it is the one thing here that reaches other people's inboxes.

## Several Google accounts for one person (added 2026-10-05)

**Built.** "I want to make a setup a user can connect multiple Gmail accounts" — a personal Gmail and a
work Gmail, both connected and both usable, for one person texting.

- **One row per (person, account).** `oauth_tokens` is keyed `UNIQUE(conversation_id, provider,
  account_label)`, and the label is the address Google itself reported for the grant. Connecting a second
  account adds a row; connecting the same address again updates that row rather than making a copy. A
  provider that is still one-account-per-person needs no special case — Spotify never sets a label, so all
  its rows key on the empty string and there is still exactly one.
- **Migration from the one-per-person shape.** SQLite cannot alter a table constraint, so the table is
  rebuilt and the rows copied by name inside one transaction. Safe to run twice: the shape is read out of
  `sqlite_master` and an already-migrated table returns immediately. Tested against a database built in
  the old shape, in a separate process, twice — including that the refresh token that *is* somebody's
  live connection comes through untouched, so nobody has to reconnect.
- **`google_connect` adds another.** With an account already on, the link carries
  `prompt=select_account consent` so Google shows the account chooser instead of carrying on as whoever
  the browser is signed in as. Documented: `prompt` is "a space-delimited, case-sensitive list" and only
  `none` may not be combined. Passing an address instead sends `login_hint` and no chooser, which is for
  reconnecting a named dead account — a hint and a chooser would contradict each other.
- **`google_accounts`** is the answer to "what's connected?": every address, what each covers, which is
  used when they do not say, and any that have stopped working. It is also where the default is set
  (`set_default`), for "use my personal one unless I say otherwise".
- **Reading looks everywhere, acting happens on one.** `gmail_search`, `gmail_read`, `gmail_labels`,
  `calendar_events` and `calendar_event` fan out across every connected account unless one is named, and
  label every result with the account it came from. Calendars are each read in their own zone and merged
  into one list in time order. Everything that writes takes one account: named, or their only one, or the
  default — and failing all three it asks, rather than picking.
- **The yes is pinned to the account.** `sendTarget`, `messagesTarget` and `eventTarget` all carry it, and
  the address is resolved from the person's own rows *before* the gate runs, so the target the gate
  compares is the address they were shown. An approval to send from the work account is refused for the
  personal one.
- **A reply goes from the account that received the message**, checked against the message rather than
  trusted: a reply sent from the wrong account is refused with the right one named, and nothing is sent.
- **Every id belongs to one account.** Message, thread, label and event ids are per account, so a call
  pairing an id with the wrong one is refused with the account that really has it named — not left as a
  404. The mail-moving tools check every id *before* touching anything, so a half-right list is never
  half-applied.
- **One dead account is one dead account.** `invalid_grant` drops that row and marks that address;
  everything else keeps working, a read says which account it could not cover, and the status reports the
  live accounts and the broken ones separately.
- **`google_disconnect` takes one.** "disconnect my work email" cuts that one off and says what is still
  connected. With several on and none named it asks which rather than taking the lot; `all` is for when
  they have clearly said all of them. A delete of someone's data passes `all` explicitly.
- **Still keyed by conversation.** Every query is scoped by conversation id first and the label only
  narrows within it, so no address the model could pass reaches another person's account — tested from the
  fake Google's side, which records whose token every request carried.

**Not built, on purpose:** a second family of tools. One optional `account` parameter on the tools that
already existed, plus `google_accounts`, is the whole surface.

**Still to do:** everything here has only ever answered a fake Google that can be two accounts at once.
The first real second account is Omari's to connect. Specifically unproven: that
`prompt=select_account consent` really shows the chooser on Google's own page, that `login_hint` really
pre-selects an account, and that revoking one account's token really leaves the other's grant alive.
`docs/unverified.md` says so line by line.

## A home page and a privacy policy (added 2026-10-05)

**Built.** `GET /` and `GET /privacy` on the same listener, in Reason's own page look. Google requires
both links before a consent screen can be published.

- **The home page:** a few plain lines about what Reason is, that everyone who texts it gets their own,
  that it never asks for a password, and that anything reaching another person stops and asks first.
- **The privacy page is written against the code**, claim by claim: what is stored (the real table
  list), what leaves the machine, how to disconnect, how to export and delete. Including the two
  things somebody would assume were not true — email text sits in the conversation transcript, and the
  conversation goes to Anthropic because that is the model that reads it.
- **The Limited Use statement** Google's API Services User Data Policy asks for, with the four
  commitments under it in plain words.
- **The only two indexable pages in Reason.** Everything made for one person stays `noindex`.
- **Exact paths**, so neither can shadow a page link, a sign-in link, a webhook or `/health` — there is
  a test for each.

**Still to do:** Omari reading the privacy page before it is used — it makes statements on his behalf
about other people's mail. `docs/unverified.md` lists the few lines that are commitments about how the
install is run rather than things the code can enforce, and the one that is wrong on a host that
snapshots its volumes ("Reason has no backups").

## Context-aware multimodal: photos, voice notes, links (added 2026-10-05)

**Built.** Against Omari's spec of the same date. The audit that preceded it, with a verdict per
requirement and the before-and-after of each one, is `docs/multimodal-audit.md`; the things only a
real device can settle are `docs/iphone-checklist.md`.

- **An iPhone photo gets through.** HEIC is what an iPhone shoots by default and the vision model
  does not take it, so it is converted (`sips`) before anything looks at it. The format comes off
  the real bytes, not the filename, so a `.jpg` that is secretly a HEIC is still handled. The
  download address is validated and re-validated at every redirect.
- **A photo is read against the conversation it arrived in.** What is in it, what they told you and
  what you are guessing are three different things and stay apart. A car photo after "i'm thinking
  about buying a car" gets a question, never "congrats". Nothing a photograph does not contain may
  be stated off one — not a model, a year, a price, who owns it, or that anybody bought it. A
  question sent with a picture is answered first. A correction replaces the reading, and the
  reading can never become a saved fact: `remember` refuses anything but what somebody said.
- **Both backends.** The same photo code runs on the API path and on the `claude-cli` one. This was
  found the hard way: the first version worked on the API and did nothing at all on the backend the
  live Reason runs on, and it took a real phone to notice.
- **A voice note is answered as the words in it**, with five distinct states — waiting, being
  worked on, transcribed, nothing said in it, could not be listened to and why. Silence gets its
  own line, because "that one came through silent" and "I couldn't hear it" are different problems.
- **Unclear speech is asked about, never invented.** `[inaudible]` stretches are counted, and the
  rule is to ask about that bit and only that bit.
- **Their words are kept where a claim can be checked against them.** On the item, not in the
  conversation — a conversation only holds its last sixty messages, so a claim out of a note from
  three days ago had nothing left to check. Read back only by id, so transcripts do not pour into
  the context of a conversation about something else. Notes over thirty seconds keep real
  timestamps; shorter ones do not, because markers in a twelve-second note are noise.
- **A link goes out as its own message**, with the words about it after it, chained so the summary
  cannot arrive first and does not arrive at all if the link never does. Sendblue has no rich-link
  parameter and App Cards need an Apple Team ID, so nothing promises a preview card.
- **A record of everything that was not words**, with what was actually got out of each item, which
  is how Reason resolves "the second photo" and answers "did you really read that".
- **A keep-by date on all of it.** Content for 30 days, the record of it for a year, both settings,
  both printed at startup and readable by Reason itself. An export now reaches every table that
  holds somebody's words and a delete takes all of them. `--log` no longer writes a page or a
  transcript into a terminal.
- **A page and a video are marked as somebody else's words.** The confirm gate already could not be
  fed by them; now the model is told so in the same breath as the content. A voice note is
  deliberately not marked — it is the person's own message.

**Still to do:** the live-model half. Every rule above that is a judgement call lives in the prompt
with a test that it is in the prompt, which is as far as an offline suite can go — whether the model
obeys it needs a real run, and `docs/unverified.md` carries one line per behaviour. Then the device
list: whether an iPhone photo ever arrives as a HEIC at all (in the one live run Sendblue converted
it to JPEG), whether a bare URL draws a preview card, and whether two sends a fraction of a second
apart land in that order.

## Page kit (added 2026-10-06)

A Reason page and an Instinct "Files" page were put side by side with the same content on them, a
gym plan for bigger shoulders. Theirs read like a printed guide. Ours read like an app screen: a
sticky blurred bar, an orange stripe before every heading, shadowed cards, uppercase labels — and
a five-step list collapsed into one paragraph because there was no block for it.

**Three new blocks**, checked and escaped like the rest:

- **`steps`** — a numbered list, one step per hairline row, the number in grey. A "1." the model
  typed at the front of an item is taken off so numbers never double up. Two to twenty-four items.
- **`rows`** — a plan, a menu, a schedule, a shopping list: a bold name, a grey detail under it, an
  optional value on the right (a price, a rest time), an optional number slot or auto-numbering.
  The prompt now says this beats a table on a phone whenever an item has three facts or fewer.
- **`callout`** — a safety note, a caveat, or a line that echoes what the person said. Three tones:
  `plain` (a thin rule down the left), `note` (a soft box), `warning` (the box with a red title).

**Two new fields on the page itself**: a `subtitle` under the title and a `closing` sentence at the
end, each under 160 characters, both optional, both changeable on their own with `page_update`
(an empty string clears one). A page from before has neither and renders as before. The closing
line is always preceded by the date Reason adds: "Written Oct 6, 2026." or "Updated Oct 6, 2026."

**Calmer chrome.** The sticky bar is gone; a plain top line — "Reason · Made for Omari · Oct 6" and
the Private/Shared tag — scrolls away with the page. The "Put together for you" kicker is gone. The
title and section headings are set at weight 400 (28px and 21px on a phone) with 48px of air above
each section. Tables, source lists, cards and choices sit on hairlines with no shadow. Uppercase
lettering survives only on table headers. The one accent left is the dot in the wordmark; the only
red is a warning callout's title.

**The writing order**, now in the tool description and the prompt: title; one-line subtitle; a
two-sentence intro; "The short version" as steps; why; how; the plan as rows; common mistakes; a
callout for safety that quotes what they said; Sources as links followed by one honest line on
what is research and what is judgment; the closing line.

Tests: `test/pagekit.test.js` (12) plus the existing page and phone-size suites, all green.
Screenshots of the rebuilt page at iPhone 14 size were looked at in headless Chromium.

## Google Drive (added 2026-10-06)

**Built.** "we should also make it such that users can connect their drive." The same Google
connection, the same client, and three tools — but **a separate tap**, which is the part that decides
how this feels to somebody who already has Gmail on.

- **An existing Google connection is NOT a Drive connection.** Everybody who connected before today
  granted mail and calendar and nothing else, and `covers()` is what says so — one function, no second
  rule to keep in step. `capabilities` reports Drive as *connectable* for them, with the line "Drive is
  a SEPARATE permission" in it, so the model does not answer "can you read my Drive" with "you're
  already connected to Google".
- **Asking for Drive produces the ordinary consent link**, never a silent empty answer and never a
  retry: a Drive tool with the scope missing comes back `scope_missing`, names the scope in words, and
  hands the model the exact list to pass to `google_connect`.
- **Adding it costs them nothing they already gave.** The link carries `include_granted_scopes=true`,
  which Google's parameter table says makes the new token cover every scope previously granted. Without
  it, a Drive-only ask would have come back carrying only Drive — and since the stored scope string is
  the record of what a grant can do, their mail would have gone quiet. With one account connected the
  link also carries `login_hint` for that address and no account chooser, because the chooser is for
  picking a *different* account and here there is one account getting one more permission.
- **Two scopes, and why nothing narrower works.** `drive.readonly` (restricted — the same review class
  `gmail.modify` already put this app in, so the verification work does not change) to find and read a
  file; `drive.file` (non-sensitive) to make one. `drive.metadata.readonly` is restricted too and
  cannot read contents; `drive.file` alone only sees files the app made or the person picked through
  Google's file picker, and Reason has no picker, so under it "find my lease" would find nothing.
  Asked for as a pair, like the two calendar scopes: naming either asks for both.
- **`drive_search`** — `files.list` with a `q` built in code: every word has to be in the file's name,
  OR the phrase is somewhere in its text (`fullText contains`), and `trashed = false` always, so a file
  they deleted is not an answer. Newest first (`orderBy=modifiedTime desc`), `fields` always sent
  because without it Drive answers four fields and the modified time and link come back undefined.
  Rows that drop straight into a page's `rows` block. Reading fans out across every account, each file
  labelled with the Drive it is in. Apostrophes escaped the way Google's guide requires.
- **`drive_read`** — Docs and Slides through `files.export` as `text/plain`; a Sheet as `text/csv`,
  which Google's own export table marks **first-sheet only**, so the result says that in words rather
  than letting a number be quoted off the wrong tab; text, markdown, csv and html through
  `alt=media`, with html going through the same reader a fetched web page uses. Long files cut, with
  how much there was and the link. The text is marked `untrusted_content` the same way a page is.
- **What it refuses, out loud.** A PDF, a Word or Excel file, an image, a folder: each gets a plain
  sentence naming what it is plus the link to open it, and the result tells the model not to guess from
  the name. There is no PDF reader anywhere in Reason — a PDF in Drive gets the same answer as a PDF
  attached to an email.
- **`drive_create`** — a new Google Doc from plain text, by `files.create` with `uploadType=multipart`
  against the `/upload` host, the metadata part carrying
  `mimeType: application/vnd.google-apps.document`, which is what makes Drive convert it. No confirm
  gate: it is their own Drive, it costs nothing and reaches nobody. It does leave a **receipt**, like a
  draft left in their Gmail — and the receipt keeps the text as its length rather than a second copy of
  a file that is sitting in their Drive with its link on the row.
- **Nothing that deletes, shares, renames, moves or edits.** Not built, and the scopes for it are not
  requested. Asked to change a document, Reason says so and offers to make a new one.
- **A dead grant is still one grant.** `invalid_grant` on a Drive call drops that account and asks for
  a reconnect, once, with no retry — and a mail grant dying no longer reports Drive as having stopped
  working, because for almost everybody Drive was never connected in the first place.

**Still to do, and it is Omari's:** the two scopes have to go on the client's **Data Access** page and
the Drive API has to be enabled on the project before a real connect works. Nothing here has touched
Google. Tests: `test/drive.test.js` (38), plus Drive routes in the shared fake. See
`docs/unverified.md` for what a fake cannot settle.

## The trust line (added 2026-10-06)

Six things, from a personal-agent spec Omari pasted on 2026-10-06 with his decisions on it: *"do the
small prompt add for be a person. do the small prompt add for act dont suggest. very heavy on the
outside content is data. also represent them well. same for respect their data. do the standing
permissions. for the caps, we should let the users set it up: when they get to a situation for the
first time where they have to set this, we can ask them."*

They are one feature in the sense that matters: each is about whether somebody can hand their life to
this thing. None of them is a new integration, and every one of them is a place the previous version
would have been wrong in a way the person would only find out afterwards.

### 1. Standing permissions

The confirm gate asks once per action. That is right for a first time and wrong for the twentieth:
somebody who has said *"you can reorder groceries without asking"* has answered the question, and
asking again every Sunday is not caution, it is not listening.

- **`permission_grant({ text, scope })`.** `text` is their sentence, **verbatim** — stored untouched,
  never tidied, never widened. `scope` is the model's reading of it in a fixed shape:
  `{ action, target?, max_amount?, until? }`. The model reads the sentence; the saved shape is what
  code compares against. There is no regex over anybody's words anywhere in this.
- **`permission_list`** answers "what can you do without asking me" out of their own rows, and
  quotes what they *said* rather than the reading. **`permission_revoke`** takes one back and keeps
  the record of having granted it.
- **The gate consults them before it stops** (`permissions.covering`, called from `runTool`). An
  action proceeds with no yes only when a saved permission covers exactly that action, exactly that
  target and exactly that amount. Everything else is refused as it was before — and the refusal
  **quotes the permission that nearly covered it and says why it did not**, so the model says "you
  told me X, and this isn't X" rather than asking blankly or talking itself into stretching one.
- **Only when nothing was asked.** A permission is reached only when there is no `confirmation_id` at
  all. A yes that is stale, spent, refused or pointed at a different person is a question about *that
  yes*, and a standing permission must never answer it.
- **Target matching, exactly as narrow as it reads.** No target covers the action whatever it points
  at. A phone number is compared as a number and nothing else, so a permission for one number can
  never cover another by being a substring of it. Anything else: the permission's words have to
  actually appear in what is about to be done — `groceries` covers "the usual groceries from Amazon
  Fresh" and does not cover "a desk chair".
- **Money needs a number or it is not saved.** A standing permission that would authorize a charge
  and names no amount is refused at the grant, because the alternative is telling somebody "ok, I
  won't ask" about a permission that would never once apply. `browser_submit` checks the limit a
  second time against the total **on the page**, which is the number that would really be charged.
- **Two actions can never be pre-authorized**, whatever anybody says: `admin_delete` (destroying
  somebody else's whole Reason) and `remote_approve` (approving a risky thing a builder asked to do).
  Both are irreversible and both are about somebody other than the person granting it.
- **Every action taken under one leaves a receipt that names it**, in their own words:
  `No yes was asked for — under: "you can reorder groceries without asking"`. The ledger row carries
  `permission_id` too, so "what has it done on its own" is one query, and a row that was really asked
  about has `confirmation_id` and no `permission_id`. The tool result tells the model to say that is
  why it did not check — never to pretend it asked.

Tests: `test/trustline.test.js`, five flow tests on a real fixture shop in `test/sites.test.js`, and
one all the way through the real tool loop with a scripted model in `test/trustline-loop.test.js`.

### 2. The limits are theirs, and they are asked for them once

The daily cap (`REASON_MAX_SPEND_PER_DAY`) stays exactly as it was: the **operator's** safety net, one
number for the whole install. What is new is the person's own two numbers, which is Omari's decision
in his words — *"for the caps, we should let the users set it up: when they get to a situation for the
first time where they have to set this, we can ask them."*

- **`per_purchase` and `monthly`**, in a `spend_caps` row per person, with the sentence they set them
  with (`said`). **No default and nothing guessed**: a number Reason picked would be a limit nobody
  agreed to.
- **Asked once, at the moment it matters.** The first commit that would really spend money for
  somebody with no caps comes back `needs_caps` with the one line to ask — *"before i spend anything
  — what's the most i should ever spend on one thing without checking with u, and what's the max per
  month?"* — and the model is told to ask for both in the same line, not to suggest figures, and not
  to spend anything until they answer. `caps_set` saves them and the same purchase then goes through
  on the yes they already gave: they are not asked about the purchase twice.
- **Where the check lives, and why it is not in the gate.** Whether a `browser_submit` spends
  anything is not knowable from its name — off the registry it is a restaurant booking form with no
  price on it. So the check is inside the tool, where the total on the page is in hand. Asking
  somebody for a spending limit before booking a free table would be the gate crying wolf.
- **Counted per calendar month** (`spentThisMonth`, off the `day` column the daily cap already
  writes). `caps_show` answers "what are my limits" with both numbers, what is committed this month
  and what is left. "Raise my limit to $500" → `caps_set` again, keeping their words.
- **A limit is a limit on Reason, not on them.** Over the per-purchase number, or crossing the month,
  needs a yes — **including for something they said not to ask about**, which is the one place a
  standing permission loses. With that yes it goes through, and **the limit is unchanged**: a yes for
  one purchase never raises a cap. The order of the three is their per-purchase, their month, then the
  operator's day.
- **Limits the wrong way round are not saved** (per-purchase above monthly), because one of those two
  numbers is not what they meant.
- **One sentence can do both.** "You can spend up to $40 on lunch without asking, and never more than
  $300 a month" is a permission and the limits; `permission_grant` takes an optional `caps` so the
  first lunch does not stop to ask for numbers they just gave.

### A payment whose outcome nobody knows is never retried

The one failure where doing nothing is right and trying again is the mistake.

- **The failure that does not throw, which used to read as a success.** Chromium answers a dropped
  connection with its own error page, so the click returns, the snapshot comes back as
  `chrome-error://chromewebdata/` with no words on it — and the result said `ok: true, committed`,
  with "read page_text and tell them what the site said" against an empty string. Found by the test
  written for this, not by reading the code. The shop may have the order. Nothing here can tell.
- **So it is an unknown outcome**, recorded in `unknown_outcomes` with what was being bought, and the
  same action is **blocked from being retried** until the person says otherwise. The ledger row's
  outcome is `unknown` rather than `error`, because "it failed" and "nobody knows" lead to opposite
  next moves, and the receipt reads `OUTCOME UNKNOWN … Not retried`.
- **What counts as them saying so is a timestamp**: a yes granted *after* the outcome went unknown.
  An older yes cannot — it was given before anybody knew there was a problem — and a standing
  permission cannot, because they have not been told. The check runs **before** the confirm gate, so
  the first thing they hear is that nobody knows, rather than the gate's "that yes was already used,
  ask again" sending the model off to collect a fresh one in silence.
- **Checking does not clear the block.** Only an attempt that got a real answer does, so a refusal
  between the check and the press cannot quietly lift something nobody resolved.
- **The money is counted anyway**, with `(OUTCOME UNKNOWN)` on the spend line. Over-counting a charge
  that never happened costs somebody a tight limit for a day; under-counting one that did leaves a cap
  that cannot see real money. `spend_today` shows every line, so an over-count can be seen for what it
  is.
### 3. Representing them well

Reason talks to its person like a sharp friend: short lines, lowercase, slang, a joke when it fits.
That voice is right in their thread and wrong everywhere else. An email to a landlord, a text to a
contractor, the facts given on a call — those are read by somebody deciding what to think about the
**person**, and a lowercase line with a 🔥 in it is a judgment about them they did not get to make.

- **The prompt rule** covers what is judgment: clear, polite, properly capitalized, full sentences, no
  slang, no abbreviations, no emoji, no jokes; signed plainly as `[name]'s assistant, Reason`; never
  as them and never as a person; and **only the details the message needs** — a time and a name, not
  where they work, not what else is on their calendar, not why they want it.
- **Two of those are facts about the characters in a string, so code checks them.** `gmail_send` and
  `message_send` to anybody but the owner refuse a body with an **emoji** in it (Unicode's own
  `Extended_Pictographic`, minus `© ® ™`, which are not emoji in any sense a person means) or with no
  **assistant line** on it. The assistant line needs both halves: that it is this person's assistant,
  *and* that the assistant is Reason — "Omari's assistant" alone reads like a human employee, and
  "Reason" alone reads like a stranger. With no name saved for the person yet, the word *assistant* is
  what is required instead.
- **Their own thread is untouched**, and so is mail to their own address: that is not a third party,
  and how Reason writes to them is their business.
- **`exactly_as_asked` is the way past it** — their sentence, verbatim, when they told Reason to send
  it exactly as it is. Nothing can verify that they said it, so it is never invisible: the receipt
  reads `Sent word for word, unchecked, because Omari said: "…"`. Being overridable by the person it
  protects is the point; being overridable silently is not.
- **The rewrite needs a new yes, and that is the gate working.** A body that has been fixed is a body
  they have not seen, and their yes was for the old words. The refusal says so rather than letting the
  model discover it as a `wrong_target` two steps later. The yes itself survives: a tool that refuses
  never spends one.
- **`gmail_send` now has a receipt of its own.** It used to fall through to `gmail_send ran.`, which
  left "did you send it, and what did it say" unanswerable from the ledger. The row names the
  recipients, which of their addresses it went from, and the subject.

**Important people: Reason drafts, they send.** Some people are not a message to get right, they are a
message not to send. A note to somebody's mother, their boss, an investor, their landlord, their
doctor: the cost of getting the tone slightly wrong is not a bad email, it is a relationship.

- **`important_add({ who, why, contact? })`**, `important_list`, `important_remove`. `why` is in their
  words and goes on the refusal, so it reads as their decision and not a rule of Reason's.
- **A send to anybody on it is refused** — "they're on your draft-only list" — and the draft is handed
  back whole, to go in a fenced block, or into their own Gmail with `gmail_draft` for an email. The
  model is told not to argue the list and not to offer to send anyway. A standing permission to text
  that person does not get past it: the permission gets it through the gate, and the list still stops it.
- **Matching is on what is actually comparable**: a saved number or address (on the to, cc or bcc
  line), or an email whose local part *is* their name — `mum@example.com` for "Mum". A name appearing
  *inside* an address is deliberately not a match, because "dad" inside `dadaist@gallery.com` would
  quietly stop a message to a stranger, and a list that blocks the wrong people gets switched off.
- **So an entry with no contact saved protects nothing**, and that is said out loud per entry rather
  than left for somebody to find out: `important_list` marks it `enforceable: false` and the tool tells
  the model to ask for the number and not to say it is covered until it is.
- **The prompt offers the list** the first time they mention family, a boss, an investor, a landlord or
  a doctor.

Tests: 13 in `test/trustline.test.js`, 6 in `test/google.test.js`. Adding this changed 15 existing
tests across `test/channels.test.js`, `test/google.test.js` and `test/google-accounts.test.js`, whose
third-party emails and texts had no sign-off on them — which is the rule biting, and is left visible
in the diff rather than worked around.

## Finish it, or bring back one decision (added 2026-10-06)

Omari's test, in his words: _"can I hand it something messy, put my phone down and trust it to either
finish or bring back only a decision that's genuinely mine?"_ And next to it: _"I have a big focus on
Reason not making the user feel like they need to steer."_ Everything in this section is one of those
two sentences made into a row, a guard or a refusal.

### The outcome sheet: a task carries the whole outcome

"Find an apartment" is not a request for links. It is a budget, a move-in date, whether fees are in
the number, the people involved, the two places already turned down and why. All of it now lives in a
validated `sheet` column on the task (`src/sheet.js`, migrated onto older rows as empty), and the
sheet is put in front of the model **on every wake and on every ordinary message while the task is
open** — so a correction made once holds for the rest of the job rather than for the next reply. The
model's own context is trimmed to sixty messages; a task outlives that, and the row does not.

What is on it: `constraints` (free keys — budget, fees_included, move_in, place, who — each with a
value, a `source` of `them` / `found` / `assumed`, and the time), `decisions`, `options` (id, label,
where it came from, `open` / `rejected` / `chosen`, and for a rejection **their words verbatim** plus
the model's one-word reading: price, vibe, timing, location, other), `waiting` (on whom, for what,
since when, next check), `left`, `needs`, `blocked`, `routes` that failed, and `steers`. `progress`
stays what it already was: the append-only task log.

**Three things code owns, and the model cannot work around:**

- **A rejected option is never offered again.** It is filtered out of `options` by id before the model
  sees the sheet, and comes back under `rejected_options` with their own words — ground already
  covered, not a candidate. Putting one back on the table is refused.
- **A constraint they stated is theirs.** Once a value is on the sheet with `source: "them"`, nothing
  Reason *found* or *assumed* can overwrite it: the write is refused with `status: "needs_them"` and a
  refusal that names the honest next step — a `waiting_on_you` question with the tradeoff in it. The
  only thing that moves it is a new thing they said, **quoted**.
- **An assumption is marked as one.** `source: "assumed"` is pulled out into `assumptions` with the
  instruction attached: say it once so they can correct you, do not turn it into a question.

A patch is validated before anything is written, so a refused sheet change loses nothing — not the
sheet, not the progress line that came with it.

Tests: `test/sheet.test.js` (14), offline, no model.

### States that say whose the loose end is, and "where were we?"

A task's state used to be `running` or `waiting`, and `waiting` did not say waiting on **whom** —
which is the whole difference between a loose end Reason is carrying and one the person has to pick
up. There are now four open states, and each one has to carry the thing that makes it actionable or
it is refused:

- `running` — Reason is working it.
- `waiting_on_you` — needs `sheet.needs`: the ONE thing needed, phrased so they can answer in a word
  or two, with one line on what each answer costs them. A question with no tradeoff on it is refused,
  because a question without one makes them do the thinking.
- `waiting_on_other` — needs a `sheet.waiting` entry: who (or what), for what exactly, and when
  Reason will look again. Reason keeps checking without being asked, and still only speaks when
  something changed.
- `blocked` — needs `sheet.blocked`: what stopped it and what would unblock it. The refusal says to
  try another safe route first.

`waiting` is kept forever: rows written before this are in it, and renaming them would be a migration
rewriting history about what Reason was doing. Those rows wake and update exactly as they did.

**No nagging, and it is a row rather than tact.** A task waiting on them does not wake the model at
all — there is nothing to do until they answer, and waking it risks a second ask. It rests, and
exactly once, after `REASON_NEEDS_REMINDER_MIN` (default 24h), the one thing it needs is said again
in words code wrote, with the tradeoff next to it. Never a third time: the stamp is on the sheet, so
two hundred wakes cannot turn owning the loose end into pestering. A *different* thing they need
later is a new ask with its own single reminder.

**"Where were we?"** `task_list` now hands back, per task, `done_so_far` (the real progress log),
`whats_left`, `needs_from_you` (the one question plus its tradeoff), `waiting_on` and `blocked_by` —
plus `on_them`, the jobs that are actually waiting on an answer. The prompt answers in that order and
no other: what is done, what is left, then the one ask. With nothing on them, the tool result says so,
so there is no question to invent. More than two open jobs goes on a page.

Tests: `test/loose-ends.test.js` (12), offline, no model.

### Cheap steering, and corrections that stick

"Shorter", "wrong person", "leave that alone", "actually Friday", "including fees" are corrections to
the thing in front of Reason, and they should cost two words. Every ordinary turn now opens with what
is open — each job's whole sheet — and what is waiting on a yes, so a short steer always has a
referent and there is nothing to ask them to repeat.

- **It is recorded, with their words.** `task_update`'s `steer` takes their words verbatim plus what
  changed on the sheet, appended so the correction is auditable months later. A steer with no words,
  or with no change named, is refused: it would not be a record of anything.
- **It holds for the whole job.** "Including fees" becomes a `them`-sourced constraint, and the sheet
  is in front of the model on every wake. Two days and a restart later the third apartment still
  comes with the fee in the number.
- **A steer cannot smuggle a change to something they said.** A steer carrying a `found`/`assumed`
  write over a `them` constraint is refused `needs_them`, and neither half lands.
- **A yes never carries over.** This path already existed and is now pinned down by tests: when the
  judge reads a reply as `change`, nothing is authorized and nothing is refused — the ask stays open,
  the refusal says *change the details, then ask once more*, and the stale ask cannot commit the old
  detail. The amended ask is one line, not a fresh explanation.
- **"Wrong person" means the first one is never reached.** Proved both ways round: the old yes cannot
  be pointed at a new number, and once there is a yes for the right person the *wrong* number is
  still refused. Nothing left the machine in either direction, and the ledger has one send.
- **"Leave that alone" closes one job and names what already went out.** `task_finish` with
  `cancelled` reads the ledger over the window the task was open and hands back the real receipts,
  with the window said out loud — the ledger does not know which errand a text belonged to, so a
  receipt is never presented as this job's with more confidence than that. Nothing else is touched:
  not the other jobs, not the plans, not the timers. With nothing behind it, the result says exactly
  that: nothing to undo.

Tests: `test/steering.test.js` (9), offline, with the judge injected.


### Graceful recovery, without changing the ask

The easy way out of a hard search is to quietly move what was asked for: a later date, a wider area,
a bit more money. That is the failure this part exists to make impossible.

- **A route that failed is written down.** `sheet.routes` takes what was tried and why it did not
  work, and the same line goes into the progress log — written from the sheet, so the two cannot
  disagree, and "what did you actually try" is answerable off the log weeks later. The tool result
  comes back with the count of dead ends so far and the instruction: take the next **safe** route to
  the **same** goal, do not stop at the first obstacle, and when the safe routes genuinely run out,
  say so and name the ones you tried.
- **A goal change is refused, in code.** Any `task_update` that moves a `them`-sourced constraint
  from Reason's side comes back `status: "needs_them"` with the constraint named and the honest next
  step spelled out: set the task `waiting_on_you` and ask one question with the tradeoff in it. The
  date, the place, the money, the people — all theirs. Proved for all four, from both `found` and
  `assumed`, with nothing written on a refusal.
- **Something Reason found about the world is not a goal change.** "One month's rent is standard
  round here", "441 Graham is 4 minutes from the L" go straight on as `found`.
- **`blocked` is the last resort and says what would unblock it.** The refusal for a bare `blocked`
  says to take another safe route first.
- **No stealth.** A site that refuses an automated browser has decided that, and it is reported as
  the site's choice — not routed around. That was already the house rule; the tool result now says it
  at the moment a route fails, which is when it matters.

Tests: `test/recovery.test.js` (6), offline, no model.

## Notice things first (added 2026-10-06)

**Built.** Omari's brief, verbatim at the top of `src/notice.js`: "Your job is not to wait for
instructions… Have a proactivity budget. One great catch a day beats five generic ones… Silence is
better than noise."

Everything else proactive in Reason waits to be pointed at something — a timer somebody set, a
watcher somebody asked for, a plan somebody started. This is the one pass that goes looking.

**The split, which is the whole design.** Code decides WHEN to look and HOW MANY times to speak.
The model decides WHAT is worth saying. Nothing in this feature reads intent out of anything the
person wrote.

- **The watchful sweep** (`Runtime.notice`), per person with a connected Google account, every two
  hours (`REASON_NOTICE_EVERY_MS`) in their waking hours. It gathers candidates with code and the
  Google reads that already existed: calendar events in the next 48 h that **changed since the last
  sweep** — moved, cancelled, new, somebody new on it; unread mail from the window where a **known
  contact** (on one of their events, or somebody they have written to) has been waiting over 24 h;
  mail with a **date on it** — a bill, an invoice, an appointment; and, as context only, anything a
  running task or watcher is due to check, because those have their own passes and report better.
- **A change needs a before.** "Your 2pm with Dana moved to 3" cannot be read off a calendar — it
  needs the 2pm. So `notice_events` is a snapshot of their next couple of days per account, and the
  diff against the live read is what moved/cancelled/new/new-attendee actually mean. Replaced per
  account and only for an account that really answered, so a failed read cannot look like a
  calendar's worth of cancellations. **The first ever look records and raises nothing**: nothing has
  changed, Reason has simply never looked before.
- **Nothing twice.** `notice_seen` is UNIQUE on (person, kind, key) and the key carries the *state*
  — an event id plus the time it moved to. So the same moved meeting is news once rather than on
  every sweep for two days, and the same meeting moving *again* is a second thing to say.
- **The sweep cannot text.** It runs ONE event turn with the bundle and a strict frame, and the
  turn's reply is held unless `notice_send` claimed something (`shouldSend` in `_turn`). A model
  that writes a lovely line and skips the gate sends nothing at all.
- **The budget is a table, not a prompt** (`notice_budget`). One unprompted catch a day per person
  (`REASON_NOTICE_PER_DAY`), keyed by their own **local day** so it resets at their midnight without
  a job that has to run at midnight. Urgent may pass it with a reason recorded, up to a hard ceiling
  of three (`REASON_NOTICE_HARD_CAP`). Counted **only when the text really went out** — claimed by
  the tool, committed by the runtime after the send, released if the turn ended in silence or the
  send failed. The whole of it is readable through `notice_status`, so "why haven't you told me
  anything" has an honest answer instead of a guess.
- **The three-question test** (`notice_send`): `what`, `why_now`, `specific_to_them`,
  `one_word_answerable`, optional `urgent` + `urgent_why`, and the `key`. Code refuses on a false
  flag, a key already said, a key nobody handed over, urgent without a reason, a spent day, the hard
  ceiling, quiet hours, and a person who asked for nothing at all. Every one of those is a fact, so
  none of them is left to the model to keep.
- **Momentary delivery.** A catch about something later is **parked on a one-off timer for ~2 h
  before the thing** (`REASON_NOTICE_LEAD_MIN`) rather than said on whichever sweep found it —
  unless it moved and is inside the next 6 h (`REASON_NOTICE_NOW_HOURS`), which is too soon to sit
  on. The timer's turn gets its own frame, is told to check the thing is still true, and goes
  through the same gate; `notice_seen.timer_id` is what ties the two together.
- **Quiet hours are theirs.** 22:00–08:00 read in the zone their own calendar is set to. In their
  night the sweep records what it found and pays for no model call at all, unless something is
  starting within hours.
- **Held, not lost.** A catch that could not go stays written down with `held_at`. It goes first on
  the next sweep, and on a turn **they** started it folds into the end of the reply they are already
  reading — which interrupts nobody, so it is explicitly **free** and not counted.
- **What this sets in motion** (`Runtime.followOn`). A task finishing or a plan locking gets one
  turn: name the single most likely next thing — a ride to the airport, two lines on the person they
  are about to meet, a reminder before the thing — and **offer** it in a line they can answer with
  one word. Never do it, never offer two. It costs the same one-a-day as anything else nobody asked
  for. On the sweep rather than hooked into the tools, so a task that finished while the process was
  down still gets its turn when it comes back up.
- **Their call.** `notice_settings` saves "text me less" / "check more often" on the account
  (`accounts.notice_per_day`, `notice_every_min`). `per_day: 0` means nothing unprompted at all and
  is honoured absolutely — NULL is "whatever the default is", which is a different thing.
- **Honest when it is not watching.** `CAPABILITIES` gains `notice`, rewritten per person from the
  mail and calendar rows so it can never disagree with them. With nothing connected the line is "i'm
  not watching mail or calendar for you", plus an offer to connect — never a promise to keep an eye
  out.
- **A receipt for every one.** A sent catch writes a `notice_send` row to the ledger, so "what have
  you been up to" includes the things nobody asked for and "why did you text me about that" is
  answerable weeks later from a row rather than from the model's memory.
- **Their data.** The four new tables are in the export and the delete, and the retention sweep
  drops the words while leaving the key spent — so a two-month-old meeting change can never come
  back round as news.

**No regex over anything the person said.** The two Gmail queries are Gmail's own search operators
aimed at mail **other people** sent, and they only ever decide what goes in front of the model.

Tests: `test/notice.test.js` (37), against the fake Google in `test/fixture-google.js` and a fake
model. **What a test cannot settle is whether the model's judgement of "worth interrupting somebody
for" is any good** — see `docs/unverified.md`.
## Subscriptions: find them, cancel them (added 2026-10-06)

Omari asked "how can reason help users cancel subscriptions?" and then "build the subscription
thing". The answer is in three parts, because they fail in different ways: finding them, keeping the
list, and ending one.

**Finding them.** `subscriptions_scan({ account?, months? })` runs eight fixed Gmail searches —
receipts, "your subscription", renewals, trials about to end, App Store and Google Play receipts,
the registry's billers by sending domain, and the lines a payment processor writes — across every
Google account connected, bounded to a window (twelve months by default, read off the clock as an
`after:` date so the run is reproducible). Results come back grouped by sending **domain**, so one
company's four sender addresses are one row rather than four.

Code pulls the facts: the amount and its currency ($ / £ / €, never a bare number — "ending in
4242" is not a price), the charge date, the renewal date, and the billing period. The renewal date
is identified by the words around it rather than by the number, because a receipt is full of dates
and only one of them is the renewal. **The model decides** which group is a real recurring
subscription and which is a one-off order, a utility bill, a donation or a shop's marketing, and
records each real one. The scan writes nothing down.

Two limits are in the tool's own result rather than in a footnote. A scan reads headers and Gmail's
snippet, so a renewal date further down a long receipt is not in it, and the tool says to read that
one message in full when the date matters. And a subscription billed straight to a card and never
emailed about cannot be found this way at all.

**The list.** A `subscriptions` table, one row per person per merchant (keyed on the merchant
squeezed and lowercased, so "Netflix", "netflix" and "NETFLIX.COM" are one subscription). It holds
merchant, service, amount, currency, cadence, last charged, next renewal, source, status, cancel
route, cancel page, cancel email, confirmation, notes and timestamps. `subscription_record` creates
or updates by merchant; `subscription_list` is the truth; `subscription_update` moves a status.

The monthly total normalises a yearly or weekly price and **names what it could not count** — a
subscription with no price, or with no billing period, is listed by name with the note that the real
figure is higher. Mixed currencies are totalled separately rather than added, because there is no
exchange rate here and inventing one would be inventing the answer. The overview comes back as
`page_blocks` ready for `page_create`: a `rows` block (merchant bold, cadence and renewal as the
grey detail, the amount on the right), the monthly total as a `callout`, and — when the model thinks
some look forgotten — a second callout titled **"A guess, not a fact"** that says receipts tell you
what somebody pays for and nothing about what they use.

**Five statuses, and one of them is the whole point.** `active`, `cancelling`, `cancelled`, `kept`,
`unknown`. `cancelling` means a cancellation has been started and **nothing has confirmed it**, so
the subscription may still take money. `subscription_update` refuses to set `cancelled` without a
confirmation on it, in code, and the row carries the sentence to say about it so a status word
cannot be quietly rounded up. A person told their subscription is cancelled stops watching their
bank; that is what the extra state is for.

**The registry.** `src/cancel-routes.js`, built like `src/sites.js`, fifteen services, every one
read on 2026-10-06: Netflix, Spotify, Hulu, Disney+, HBO Max, Apple (App Store), Google Play, Amazon
Prime, YouTube Premium, The New York Times, Planet Fitness, Adobe, Peloton, Audible, ChatGPT Plus.
Per entry: the rail, the cancel page's address and whether the service publishes it or merely
describes it, the documented click path, the exact label of the button that commits, the notice
rules, the fee for leaving early, what counts as a confirmation, the honest limits, and the source
URL with the date and **how** it was read — the page itself, or the service's own help text through
a search index because the page is drawn by JavaScript and will not render for a reader.

What is deliberately missing is as much the point as what is there. Four web entries (Hulu, Disney+,
Peloton, and Planet Fitness's portal) do not document the label on their last button, and that comes
back as `no_documented_button: read the page and say back what it says` rather than a guess. The New
York Times could not be read at all — its help centre bounces a reader to its front page and a
search for the article returned nothing — so its route is `unknown`, and Reason says it does not
know and offers to open the account page with them. It is widely said to need a chat or a phone
call; that is hearsay and the registry does not record hearsay.

**Three rails, all behind the existing gate, all leaving a receipt.**

*Web.* `subscription_cancel_start` asks the **service** whether they are signed in — through the
same probe the errand sites use, because a cookie that exists says nothing about whether the site
still honours it. Not signed in is not an error: Reason says so in one line, offers the sign-in link
they open on their own phone, and never asks for a password. Signed in, it opens the cancel page and
hands over the snapshot; the model walks it with the ordinary browser tools. The last press is
`subscription_cancel_commit`, which needs a yes for the exact details — and the details only exist
on the final screen, which is why a yes collected earlier would be a yes to something nobody had
seen. Afterwards it reads the page for a cancellation number, failing that an end date, failing that
the words "has been cancelled", and writes what it found onto the record. **No confirmation means
the row stays `cancelling`** and the result says so in those words.

*Written.* Where the service takes it in writing, code writes the request — so it says who is
asking, that an assistant is writing *for* them and never *as* them, the charge on record, and the
one thing that makes this rail work: a request for a reference number and an end date, with the line
"we will treat it as still active until that confirmation arrives". Shown in full, left in their
drafts with `gmail_draft` or sent with `gmail_send` after a yes, then the row moves to `cancelling`.
`subscription_confirmations` searches that merchant's own sending domain for the reply and hands
back what matched — and moves nothing, because a marketing email with "cancel" in it matches too.

*Phone.* Not built. `cant_do` with the honest line, and the offer to ring them once calling exists.
An App Store subscription gets the same treatment for a different reason: it is four taps in
Settings on their own phone, and Reason says the four taps.

**The click guard.** Every commit label the registry knows is folded into the browser's guard, so
`browser_click` refuses "Finish Cancellation", "Cancel Membership", "Yes, cancel" and the rest —
not one of which contains `submit`, `confirm`, `book` or `pay`, so every one of them would have gone
through unasked. Two services' real last press is a plain "Continue" (Google Play) or "Cancel"
(ChatGPT); those are deliberately kept **out** of the guard, because a guard that treated every
Continue on the web as irreversible would refuse to turn a page and spend somebody's yes on
navigation. They are gated by `subscription_cancel_commit` instead, which needs a yes whatever the
button is called. The guard also carries fifteen common cancel phrasings that are not off any one
service's page — a widening of a guard rather than a claim about a route, said out loud here and in
`docs/unverified.md`, because four entries can end on a button nobody has written down and an
unrecognised cancel button pressed unasked is the failure that costs somebody their subscription.

**Their data.** `subscriptions` is in `src/data.js`, so an export carries it (notes, sources and the
confirmation numbers a service gave them) and a delete takes it. It is not swept by the retention
pass, like plans and tasks and for the same reason: it is live state about somebody's money rather
than a copy of something that arrived.

**Standing permissions.** `subscription_cancel_commit` is in `GATED_ACTIONS`, with a category of its
own (`subscriptions`), so "just cancel the gym, stop asking me about it" is a thing somebody can
actually say once. The reasoning for allowing it, since the first instinct is not to: a cancellation
is irreversible in one direction — a grandfathered price or a year of unused credits can go and not
come back — but it is about the person granting it and nobody else, which is the line
`NEVER_STANDING` is really drawn on. The bound does real work: the target a cancellation carries is
the merchant followed by the details off the final screen, so a permission naming Hulu can never let
a Netflix cancellation through.

One thing a standing permission never covers, however widely it was granted: **a service that
charges to leave.** Adobe's annual plan and Planet Fitness's $58 buyout both put a charge on the
other side of that button, and a permission to cancel something is not a permission to pay a fee. It
is checked from the registry's `fees` field rather than from the amount on the action, because the
approved details for a cancellation always name the monthly price and that is not a charge —
treating it as one would make every cancellation permission refuse itself.

Tests: `test/subscriptions.test.js` (46), against the fake Google and a new fixture service on
127.0.0.1 (`test/fixture-service.js`) with a real sign-in gate, a retention offer, a two-step
cancellation and a confirmation number — including a mode where the service takes the press and says
nothing, which is what proves the `cancelling` half. The fake Google's query matcher grew to
understand the shapes a scan really sends (`field:(a OR b)`, quoted phrases, parenthesised OR
groups), which the old one silently matched to nothing. Two flow tests drive the real tool loop with
a scripted model: "what am I paying for every month" through scan, records and a page link, and a
cancellation through the route, the fixture site, the gate and a confirmed record.

No real service was touched. `docs/unverified.md` has the ledger.
