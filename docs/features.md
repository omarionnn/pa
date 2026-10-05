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
  published 2026-10-05 and is unverified, 100-person cap): `invalid_grant` drops the grant, flips `email` and `calendar` to
  "needs reconnect", and gets one plain line with a fresh link. It never retries.
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
