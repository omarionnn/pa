# Reason

A personal assistant that lives in your texts. It handles what you hand it (looking things up, errands, calls, reminders, follow-ups, plans with your friends) and talks like a person.

MIT licensed. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

## Run it

```bash
npm install
cp .env.example .env     # ANTHROPIC_API_KEY; REASON_PUBLIC_URL if pages should open off-machine
npm run chat             # talk to Reason in the terminal; add --log to see tool calls
npm run serve            # Reason as a process that stays up (see below)
npm run test:offline     # the whole deterministic suite; needs no key and must be green
npm test                 # adds the live tests against the real model
```

Console commands: `/skip 2h` moves Reason's clock forward and fires anything that comes due, `/plans`, `/timers`, `/tasks`, `/ledger`, `/accounts`, `/reset`, `/log`.

### Working between messages

`npm run chat` only thinks while you are typing. `npm run serve` is Reason as a process that stays
up:

- it sweeps on an interval — timers that fire, **tasks** it is working on, watchers re-checking a
  page, plans that went quiet with questions still open;
- it listens on `http://127.0.0.1:8787` for inbound channel webhooks (`POST
  /channels/<name>/webhook`) and answers `GET /health` with what is really running;
- it starts cleanly with no credentials at all, and says what is missing rather than pretending.

A **task** is work that outlives a message: chasing a handyman, waiting on a reply, anything
multi-step. It is a row in SQLite with a goal, a next wake time and a short progress log, so
killing the process loses nothing — the next one picks it up. Reason speaks about a task only when
something actually changed; a step that moved nothing is held back by code, whatever the model
wrote. A step that keeps crashing is retried a bounded number of times and then reported honestly.
Ask "what are you working on" and the answer is read off that table.

### Everyone who texts it gets their own Reason

Not one owner and a crowd of strangers. Every person Reason works for has their own: their own
memory, plans, tasks, watchers, receipts, connected accounts, pages, call recordings and approvals.
Nothing one person stored, connected or agreed to is readable or usable from anybody else's
conversation, and a yes one person gives can never open a gate for another.

That is not a layer added on top — every table was already keyed by the conversation, and an
account **is** a conversation. The isolation is the scoping that was always there.

**Anyone may text the number. The master decides who gets one.**

`REASON_MASTER_NUMBER` is the master: a normal account with its own private Reason, plus admin
rights. (`REASON_OWNER_NUMBER` is still read, because that is what existing installs have.) When a
number with no account texts for the first time:

1. they get **one** line saying access is being asked for — and **no model turn is spent on what
   they said.** Their message is written down as a quote, not run;
2. the master gets a text: who is asking, their first message **quoted exactly**, and the question.

The master answers however people answer — "yeah go on", "nah not now", "who's that?" — and what
they meant is read by the same judge the confirm gate uses everywhere. Around it, code owns every
fact a model cannot be trusted with:

- the reply must be a real new message from the master's own number, after the ask;
- it is tied to **one** request, so a yes can never let in somebody it was not about;
- single use, with an expiry;
- only the master's number counts. Nobody can approve themselves, and somebody else texting "yes
  let them in" does exactly nothing.

`yes` creates the account and welcomes them; `no` sends one polite line; anything unclear grants
nothing and leaves the request waiting, with the master's own turn running as normal. Answering
costs no model turn and gets one reply, not two.

And the limits that stop this becoming a way to get at the master: a declined number is left alone
for a cool-off (`REASON_DECLINE_COOLOFF_DAYS`, default 7) and not raised again; only one request is
in front of the master at a time and the rest queue; there is an hourly ceiling on how many are put
to them; and somebody already waiting is told so once rather than on every message.

**What the master can do, by text:** see who is waiting (with their first message), see who has an
account and how much each has used, pause someone, resume them, remove them, block a number, or
delete somebody's Reason outright.

- **remove** stops Reason answering and **keeps their data** — "remove" sounds like deletion and is
  not. **delete** is the separate, irreversible one, and it goes through the confirm gate naming
  the person.
- **block** means no reply at all, and the master is never asked about that number again.
- **The master never sees another person's content.** Only the first message in a request, and
  usage counts. There is no tool that shows them anybody's conversation — not a missing one, a
  deliberately absent one.

**A daily limit per person**, on their messages (`REASON_MAX_TURNS_PER_DAY`), on how often Reason
may interrupt them (`REASON_MAX_PROACTIVE_PER_DAY`), and on phone calls both ways — how many they
get (`REASON_MAX_CALLS_PER_DAY`) and how many minutes of talking
(`REASON_MAX_CALL_MINUTES_PER_DAY`). Counted in the database, so a restart does not reset it, and
0 means uncapped. You pay for every turn, and a call is the only thing here that bills by the
minute: it runs at a per-minute rate for as long as whoever picked up keeps talking, which is why
it is capped twice rather than once. Minutes are counted when a call ends, because that is the
first moment its real length exists — so the last call of a day can run over by up to one call's
length, and the cap stops the next one.

**Export and delete are per person.** **Single-owner self-hosting is unchanged:** one number in
config and it behaves exactly as it did, with your existing data as the master's account — nothing
moved to get there.

"owner" inside Reason means *whoever's Reason this is*. Texting or ringing anybody else is still
acting on a third party and still goes through the confirm gate.

### Texting

**Texting is on Sendblue.** Sendblue (iMessage / SMS / RCS) is the texting channel; the Linq
adapter below is kept but superseded. Put `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`,
`SENDBLUE_FROM_NUMBER` (your Sendblue number, with country code) and `SENDBLUE_WEBHOOK_SECRET` in
`.env`. In the Sendblue dashboard, under Webhooks, set the signing secret to the same value and add
`https://your-host/channels/sendblue/webhook` as the endpoint for **Inbound Messages**. With any of
the four empty, Sendblue reports `not_connected` and Reason says texting is unavailable. With the
webhook secret empty, every inbound webhook is refused.

On Sendblue's free plan the number is shared, there is a ceiling on contacts, and a person has to
text the number once before Reason can message them; Reason says so in words when a send is
refused for that reason.

**Tapbacks, effects and voice notes are things Reason can choose to use.** All three are tools, with
the limits Sendblue states, and the judgement about *when* lives in the system prompt rather than in
code:

- **`react`** puts a tapback on a message it received — one of `love`, `like`, `dislike`, `laugh`,
  `emphasize`, `question`, or exactly one emoji (`-` in front removes one). The prompt's rule is
  that when the whole answer would be "ok" or "got it", a tapback beats another bubble in the
  thread; never a tapback *and* a text saying the same thing, and never instead of an answer
  somebody is waiting on. The grammar is checked before the request, because Sendblue publishes it:
  names are case-sensitive, and "exactly one emoji" has to count composed ones as one, so 👍🏽
  (two code points), 👨‍👩‍👧‍👦 (seven), `1️⃣` and 🇬🇭 all pass while `hello🔥` and `🔥🔥` are refused
  without spending a round trip. The handle comes off the thread, not from the model, so a tapback
  cannot land on the wrong message.
- **An effect** (`style` on `message_send`) is one of the 13 Sendblue lists. iMessage only: on an
  SMS thread the effect is dropped and **the message still goes**. It rides on the outbox row too,
  so a message retried an hour later goes out the way it was meant to. The prompt's rule is that an
  effect is for a real moment — the table finally confirmed, a birthday — never an ordinary reply,
  never twice in a row, never on bad news.
- **A voice note** needs `.caf` — Opus in a CAF container, the only thing Apple plays inline with a
  waveform. On a Mac that needs nothing installed: `afconvert`, which ships with macOS, writes
  exactly that format and reads it back. Anywhere else it is ffmpeg, and with neither the tools
  refuse by name rather than half-working. `voice_note_send` sends audio that already exists as a
  file; **`voice_note_say` is Reason's own voice** — it writes the words, Gemini's speech model says
  them, and the result goes out as a real voice memo. It is for when you ask to hear it, or when
  hearing it is the point; a few sentences at most, and anything you would need to copy also
  arrives as text. The speech model is handed the words and nothing else, because a direction in
  front of them ("say this warmly:") gets read out loud — it did.

Two of these fail per-line rather than per-message, and those refusals are remembered the same way
read receipts are: a `422 unsupported_on_this_line` is written down against the **line**, so it is
not asked again on every message, while a `422 unsupported_target` (an SMS, an App Card, an
attachment handle) is about that one message and is **not** remembered.

**Coming the other way:** a voice note you send is listened to. It is downloaded, turned into
plain audio, transcribed, and reaches Reason as the words in it — so you can talk instead of type.
When one cannot be heard, the turn is told exactly why (the download failed, the model was busy)
and Reason says that instead of guessing at what you said. With no model that takes audio it is
described as a voice memo Reason has not heard.

An effect they used reaches Reason too — `send_style` is on the documented receive payload, so
"we got the table" with fireworks on it is read as them being emphatic. **A tapback somebody
puts on a message of Reason's does not reach it at all**: there is no reaction webhook type, and
neither the `receive` nor the `outbound` payload has a reaction field. Sendblue can send a tapback
and documents no way to hear about one.

**It can reply under a specific message.** `reply_to` pins Reason's next message under one earlier
message in the thread, the way holding a bubble and tapping Reply does — for an answer to something
that is no longer the last thing said: the second of three questions, or the table it went off to
find an hour and twenty messages ago. The model picks the message by quoting a few of its words;
code finds the most recent one in *that conversation* carrying them and uses Sendblue's handle for
it (`reply_to: { message_handle }` on the send, guides/inline-replies). The handle never passes
through the model, a reply to the message right above is refused as just a reply, and a pin is used
for exactly one message. iMessage only. **A refused pin never costs the message:** Sendblue answers
a rejected reply with a 400 and sends nothing, so the same message goes once more without the pin
— only after a 400, never after a timeout, where a second request could be a second text.

**A reply that would land under the wrong bubble is pinned without being asked.** If you text
again while Reason is still answering your last text, or a reminder goes out in between, its answer
is pinned under the text it answers — code checks, at the moment of sending, whether that text is
still the last thing in the thread (`answerTarget` in `src/replies.js`). And when you send several
texts in a row about different things, the turn is told they were separate texts and each gets its
own answer under its own text; texts that are one thought still get one ordinary reply. That part
is the model's reading, and `test/flow-replies.test.js` runs both cases against it.

**Coming the other way,** a message you send as an inline reply reaches Reason with the message it
was sent under quoted in front of it, so "that one" means something. A reply under a message there
is no record of says exactly that, and Reason asks rather than guesses.

**It can look at pictures.** A photo or a screenshot you text arrives as something Reason actually
sees: the image is fetched from Sendblue's link and handed to the model as an image, ahead of your
words, so it answers from what is *in* it. It used to say "if it was a pic, i can't open those" to
everything with an attachment on it, which is most of what people send.

What it still cannot read is said in one sentence, once, naming the real reason — never "that came
through blank", and never a running count of blanks. Claude reads JPEG, PNG, GIF and WebP, so the
common miss is **HEIC**, which is what an iPhone shoots by default: Reason says it came through as a
HEIC and asks for a screenshot instead. Same for a photo over the size ceiling (7 MB of real bytes,
under Anthropic's 10 MB base64 limit — `REASON_IMAGE_MAX_BYTES`), a link that has expired (inbound
links live 30 days), or a download that fails. Anything that is not a picture — a PDF, a vCard — is
described honestly as a file Reason cannot open.

The picture is looked at on the turn it arrives and is **not** kept in the thread's history; what
is kept is a line saying it was looked at and cannot be looked at again. A stored image would be
resent on every later turn in the thread, and its link would expire anyway.

**On the `claude-cli` backend a picture cannot reach the model at all** — the CLI takes its prompt
as a string, and the one built-in tool that could open an image off disk is denied on purpose so a
Reason turn cannot succeed using Claude Code's tools instead of Reason's. There, Reason is told in
words that a photo arrived and that it cannot see it, and says so. Photos work on the API backend.

**Two texts seconds apart are one thought.** Reason used to answer the first half of a message
before the second half arrived — "which ones? looks like the rest of your message got cut off" to a
text whose link was pasted a second later. Now an arriving message waits a short quiet window
(`REASON_BURST_QUIET_MS`, 2.5s) to see whether more is coming; each new text from the same person
restarts the window, and everything that landed runs as **one** turn, in order. A hard ceiling
(`REASON_BURST_MAX_MS`, 8s from the first text) answers somebody who never stops typing. A burst
costs one turn off the day's allowance, not one per text, and a lone message is never held longer
than the window.

Held messages are **rows**, so a process that dies two seconds into somebody's burst loses nothing
— the next one's sweep finds them past their ready time and answers. Two people texting at once are
two bursts. The "…" bubble goes up when the first text lands, so it is showing *while* they are
still typing, and comes down only after the reply has gone. `GET /health` shows what is being held
and whether it is due. Set `REASON_BURST_QUIET_MS=0` to turn holding off entirely.

**Parts of one message are one message.** Paste a link into iMessage and your phone sends one
bubble — but Sendblue delivers it as several webhooks ten seconds apart: your words and the link,
then the link card's preview images, each with its own handle ending `_1`, `_2`. Reason used to
answer every one of them, so a single pasted link got a real answer followed by "that one came
through blank on my end too" and then "still getting blanks on my end, that's 3 now 😅".

Now a part with no words whose only content is a preview image of a link already in the message's
own text is dropped silently: you never knew your phone sent it, so you never hear about it. It
costs no turn and nothing off the day's allowance. What is *not* dropped: part 0 ever, a part that
carries words, a part holding anything that is not a picture, a picture sent with a caption that
has no link in it, and a part whose message was never seen — answering about a photo nobody sent is
a smaller failure than silently eating one somebody did. Every drop is logged with its reason.

Sendblue's docs confirm the shape without describing it: `api-v2/reactions` says a message with
attachments has one "primary `message_handle`" plus parts selected by `part_index`, and that an
attachment-specific handle is a different string that returns `422`. They never say what one looks
like, and nothing documents one message arriving as several webhooks — both are read off that one
real night here, and the payload carries no field that tells a preview thumbnail apart from a
photo. See `docs/unverified.md`.

**A reply that fails to send is not lost.** Every outbound message on a real channel is a row in
an outbox before it is an HTTP request, with its state, attempts and last error. A failure that can
work later (a dropped socket, a 5xx, a 429) comes back on its own — five attempts, backing off from
5s to a 5-minute ceiling. A failure that cannot (a bad number, an opted-out contact, "cannot send to
self", an unverified contact on the free line) is never retried, because retrying those is how a
system texts somebody who said stop. Tune with `REASON_OUTBOX_MAX_ATTEMPTS`,
`REASON_OUTBOX_BACKOFF_MS`, `REASON_OUTBOX_BACKOFF_MAX_MS`.

When a message finally cannot be delivered, somebody is told:

- **Reason is told.** Its next turn in that conversation opens with `[delivery failure]` and the
  reason, so it says "that never got there" instead of answering as though it had replied.
- **The owner is told** when the undelivered message was to anyone else — Reason said it would text
  Kofi, so the owner hears that Kofi never got it, in words code wrote rather than the model's.
- **`message_send` distinguishes "queued" from "sent"**, and the queued result tells the model in so
  many words not to claim it sent anything.

Nothing is ever sent twice. Sendblue's send endpoint has no idempotency key, so this is enforced
before the request: one row per idempotency key, one attempt in flight per row, and a row that
reached `sent` is never attempted again. The hard case is the process dying mid-send, where the
request may have landed and the answer was lost — so nothing is resent on a guess. The row goes to
`unknown` and Sendblue is **asked** (`GET /api/v2/messages`, matched on content inside the attempt's
own time window). If Sendblue cannot say, the message is marked failed and reported: losing one
message loudly beats texting somebody twice. `GET /health` shows what the outbox is holding.

**The conversation is marked read the moment Reason really takes the message** — after the sender
is admitted and after the event id is claimed, so a delivery the provider sent twice is marked read
once and a message Reason is never going to answer is never marked read at all. It works on any
service, not just iMessage, though only iMessage and RCS show a "Read" status. `REASON_READ_RECEIPTS=off`
turns it off.

Two of its failures are permanent facts and are remembered rather than re-asked on every message: a
line that cannot send read receipts at all (`422`) is remembered against the **line**, and an
unverified contact on the free plan (`403`) against that **contact** only — so one unverified person
does not switch the feature off for everybody. A `503` or `429` is "not now" and is deliberately
forgotten. Either way nobody is told but the log, once: a read receipt that could not be sent is a
detail about Reason's plumbing, not news for whoever texted. `GET /health` lists what the install
has learned it cannot do.

**The "…" bubble shows while a turn runs.** A turn can take twenty seconds, and without it a text
to Reason gets nothing at all until the whole answer lands. It goes up before the turn, is renewed
in 30-second chunks for as long as the turn takes (Sendblue's bubble expires after 60 seconds on its
own), and comes down *after* the reply has gone — stopping first would leave a gap with no bubble
and no message. A turn still running after five minutes stops claiming to be typing.

It is iMessage-only and best-effort, per Sendblue, and it can never delay or block a reply: an SMS
or RCS thread is skipped rather than refused, a line that cannot show one is asked once and not
again, and a typing call that fails or throws is logged while the reply goes out regardless. Tune
with `REASON_TYPING_CHUNK_MS` and `REASON_TYPING_MAX_MS`.

Three limits the adapter enforces because Sendblue states them, and they are easy to get wrong:

- A message must be **fewer than** 18,996 characters, so 18,996 itself is refused.
- An attachment has **two** ceilings: 100 MB over iMessage but **5 MB over SMS**. A text to someone
  without iMessage falls back to SMS, and Sendblue then compresses the file and fails the whole
  message if it cannot get under 5 MB. A file over 5 MB is still sent, with that said on the record.
- The typing bubble **expires after 60 seconds** when no duration is given, so a longer turn needs
  it refreshed rather than set once.

**Partly proven against the real thing.** One real night of inbound traffic has run through this
adapter: webhooks arrive, the shared-secret check passes on the default header, and a send where
`number` equals `from_number` comes back HTTP 400 "Cannot send messages to self". Everything else
is written from Sendblue's public docs and tested offline against their example payloads. Their
docs do not name the header the webhook secret arrives in; the adapter uses the default their own
Chat SDK adapter documents (`sb-signing-secret`, overridable with
`SENDBLUE_WEBHOOK_SECRET_HEADER`) and refuses anything that does not match. See
`docs/unverified.md` for the full list, including what the free shared line cannot do.

Reason reaches people through a **channel**. The console is one; **Linq** (iMessage / RCS / SMS) is
the real one. Put `LINQ_API_KEY` and `LINQ_WEBHOOK_SECRET` in `.env`, point a Linq webhook
subscription at `https://your-host/channels/linq/webhook`, and set `REASON_OWNER_NUMBER` to your
own number in E.164.

`REASON_MASTER_NUMBER` is the master, read from config — nothing a message says can put a number on
it. Everyone else needs the master's yes (above). A conversation with no account behind it cannot
open the confirm gate, connect an account, submit anything, text anyone or place a call — refused
in code before the tool runs.

Nothing in the Linq adapter has ever run against the real API. It is written from Linq's public
Partner API v3 docs and its signature verification follows the Standard Webhooks spec they
document. Until a real key sends a real text, treat it as unproven — see `docs/unverified.md`.

### Phone calls, and the recording

Reason does not dial. It hands a provider a goal — "ask if they have a table for 4 at 8 on
Saturday, and if not the nearest time" — plus the short list of facts that call is allowed to
share, and gets back something quotable: what happened, what was said, how long, what it cost, and
**the recording**. Calling anyone but you goes through the confirm gate first, with the exact
number and the exact goal shown to you before you say yes.

Every call is recorded and announces itself, and Reason never pays by phone — those are rules
rather than settings, and **The rules it keeps** below says where each one is enforced. The
mechanics:

**The audio arrives with the summary, in one message.** When a call ends, its recording is copied
into `data/recordings/` as a file Reason owns, and the next message Reason sends you carries both
the summary and the audio as a single message — attached by code reading the calls table, not by
the model remembering. So it cannot be forgotten, cannot be sent twice, and cannot be claimed when
it does not exist. Audio that fails to send stays queued rather than being marked delivered.

**A missing recording is a fault, and it is treated as one.** If a call was answered and the audio
is not there, the call row is marked `missing` with the reason, an **error** row goes on the action
ledger (`RECORDING MISSING for call #N`), and Reason is told to say plainly that the recording is
missing rather than quietly leaving it out. "Every call is recorded" is a promise, and a promise
that breaks silently is worse than one never made. A call nobody picked up is a different thing —
there was nothing to record — so it is marked `not_applicable` and raises no alarm, which is what
keeps the real fault visible.

A phone call is the worst possible place for a card number — it is recorded, the provider may
transcribe it, and the person on the other end is unverified — so the payment rule is enforced on
the request itself and again inside the call. Details below.

**Bland is the provider that is built** (`src/calls/bland.js`). `REASON_CALL_PROVIDER=bland` plus a
`BLAND_API_KEY` is the whole of turning it on, and until both are there `capabilities` says phone
calls are not connected and Reason says so to anyone who asks. Without them the only provider that
runs is a fake one that dials nothing and hands back a 4.8 KB test WAV, which is what the offline
tests assert against. **`docs/call-providers.md`** compares the real options on the three things
that differ — does it record, how you fetch the recording, what it costs.

Four things about the adapter are worth knowing, because each one is a decision rather than
plumbing:

- **Bland's `record` parameter defaults to `false`.** So `record: true` is on every single request
  Reason sends it, with no setting that removes it. A provider whose dangerous value is its default
  is one the code has to be loud about, and this is where it is loud.
- **The opening line is Bland's `first_sentence`,** which is a field for saying one exact phrase —
  not a line pasted into the prompt and hoped for. The prompt separately tells the voice the
  opening line is already set and not to reword it.
- **The standing rules go into the prompt ahead of the goal,** and a prompt that will not fit under
  Bland's 2,000-character guidance is **refused rather than trimmed.** What would have to be cut to
  make it fit is the part that must not be.
- **The audio is fetched from Bland's own `GET /v1/calls/{id}/recording`,** not from the
  `recording_url` on the call — in Bland's own examples that URL is sometimes `api.twilio.com`, and
  sending this account's API key to whatever host is in that field would hand the key to a third
  party. `recording_url` is read only as the yes/no of whether a recording exists.

**No call has ever been placed through it.** There is no Bland key on this machine. Every one of
the 38 offline tests drives the adapter with an injected `fetch` and asserts on the exact URL and
request body; `docs/unverified.md` lists what that leaves unproven, which is everything that only
a real call can settle.

### Pages

Some answers are not texts. A gift shortlist with pictures and prices, three days in Lisbon, a
plan with sections — sending that as a wall of messages is worse than useless on a phone. So Reason
can make a **page**: a small web page you open from a link, keep, and come back to.

**How a page looks.** Every page carries Reason's own header (the wordmark and a Private or Shared tag), a serif title, and the same blocks drawn the same way: a comparison table, picture cards with a price tag, tappable choices, and a source list. It follows the phone's light or dark setting, uses only the fonts already on the device, and loads nothing from anywhere else, so opening a page tells no third party about it. The look lives in one place, `src/pages/render.js`; the model still supplies data only, never markup. It has been looked at in Chromium at phone size, not yet on a real phone. The line above the title reads "Put together for" and the person's first name, and says "for you" only when Reason has not been told a name. A person's name goes on their own account the moment they give it (the `my_name` tool), so pages, greetings and the master's list of accounts all use it.

- **It gives data, not markup.** The model picks from a fixed set of blocks — a heading, text, a
  picture, a comparison table, links, a row of cards, a question with options — and Reason's own
  template draws the HTML. There is no block that takes HTML or a script, every string is escaped
  on the way out, and content that is not one of those blocks is refused rather than rendered.
- **A picture has to be real.** An image can only go on a page if its address came back from a
  tool in that conversation — a page Reason actually read. It cannot type one from memory, because
  it would produce plausible dead ones. `web_lookup` now returns the real image addresses on a page
  it reads, which is where they come from.
- **The link does not change.** `page_update` edits the same page at the same link, so a link
  already sent still works. Reason is told to prefer that over making a second page.
- **The link is short.** Ten letters and digits for the page, twelve for your key, and nothing
  else — no `-` or `_` to get clipped off the end of a link in a text. Links made before this were
  about forty characters longer; they still open.
- **Your link just opens.** The link Reason texts you carries its own key, so tapping it shows the
  page, first time, on any browser, with nothing to type; that browser then stays signed in. The
  link is yours: whoever holds it can open the page and press its choices, so it is not the one to
  forward. (There used to be a six-character code here. Nothing ever sent it, so a page could not
  be opened at all.)
- **Private to everyone else.** The same address without your key does not open a page that has
  not been shared. The code path remains as a fallback for that case; wrong codes are rate limited
  — five in fifteen minutes and that page locks, counted in the database so a restart does not
  reset it. A page that does not exist and a page you may not see answer identically, so the link
  space cannot be probed.
- **Shareable only when you ask.** Sharing gives a second link, without your key, that anyone can
  read. Unsharing takes effect on the very next request. Through the shared link the questions are
  read-only, so nobody can answer for you.
- **You can tap an answer**, and it comes back to Reason as an event turn — exactly once, claimed
  before the turn runs, still waiting in the table if the process was down when you tapped.

Set `REASON_PUBLIC_URL` to the address the listener is reachable at. Without it pages still work,
but only on this machine — and `capabilities` and `page_list` both say so rather than handing you a
link that will not open on your phone.

### Research, with a real pick

Reason could already read one page it was handed. That is not research. Asked **"iPhone 17 or 18?"**
it read Apple's own page, could not get a price, and had nothing to recommend — because the step it
was missing came *before* reading: finding out which pages to read.

`web_search` is that step, behind a provider interface: a query in, ranked results out (title, link,
a snippet pulled from the page, a date when the provider has one). `research` is what you actually
want:

1. **The model plans a few genuinely different queries** — the thing itself, the thing against its
   alternative, what owners say, tested reviews.
2. **Each one is searched**, and every result goes into a source log as a snippet straight away.
3. **The best sources are read in full** with `web_lookup` — one per site before any site gets a
   second, because four pages off one blog is one opinion wearing four hats.
4. **The answer is written from that log and nothing else.**
5. **A choice is answered on a page.** When the question is this-or-that or which-should-i-get, the
   model says so (`kind: "choice"`), and the result tells it the next step: put the comparison and
   the sources on a page, then text the pick in a line or two with the link. The comparison itself
   never goes out as one long text. A plain fact stays a plain text.

What comes back is three lists, and the difference between them is the point:

| | what it means |
| - | - |
| `sources` | **fetched.** `said` is text that really came back off the page. |
| `snippets_only` | the search found it, nobody read it. Quotable *as a snippet*, and labelled that way. |
| `skipped` | it would not load, or the site forbids being read — with which, and why. |

**The answer's shape** (guidance in `src/agent.js`): the pick first, in a line or two, with the
reason. Then what would change it. Then two to four sources named plainly — site names, not raw URLs
unless you ask. Long or genuinely comparative, and it becomes a page with the comparison and the
links. One source is never called research, and it says what it could not find.

**Budget, so one question cannot run away.** Five searches, eight pages and 90 seconds per run by
default, counted across the whole run however many turns it spans. **When a cap is what ended it, the
result says which cap and Reason says the look was partial** — an answer off four of nine sources
that reads like an answer off all nine is the exact failure the caps exist to prevent.

**A big question runs as a durable task.** `deep: true` and the run is a row plus a task: it survives
a restart with its whole source log, works through the remaining queries when it wakes, and reports
once — only when something actually changed.

#### Reddit and review sites, honestly

This was the part worth finding out rather than assuming, and the answer is not the convenient one.

**Reddit cannot be fetched, and Reason does not fetch it.** `reddit.com/robots.txt` is, in full,
`User-agent: * / Disallow: /` — everything, for everyone. So `src/robots.js` asks before every
research read, and a host that says no is skipped with the reason in the log. Checked on 2026-10-05,
it would not have worked anyway: the HTML holds **six characters** of readable text (it is a
JavaScript shell), the old `.json` route answers **403**, and so does `oauth.reddit.com` without a
token. The official unauthenticated route is gone; what is left is a Reddit app credential under
their Public Content Policy, which nobody has signed up for here.

So what Reddit threads say arrives as **search snippets** — the provider fetched them, not Reason —
and Reason calls them that: *"a couple of reddit threads say…"*. The snippet may be quoted. Nothing
beyond it may be described. **Every quoted opinion comes from a source in the log; there is no path
by which Reason can invent one**, because the log is the only thing it is handed to quote from.

**Review sites are fine.** rtings, Tom's Guide, CNET, Consumer Reports, The Verge, GSMArena, Yelp,
Trustpilot and Hacker News were each checked on 2026-10-05: none has a blanket disallow, so these are
fetched and read properly.

### Videos

Somebody sends a YouTube link and asks what it covers. Reason goes and finds out: `video_understand`
pulls the video's title, channel, length, description and chapters, and **what is in it** as
timestamped lines. So the answer can quote the thing with a real time against it, and "what does he
say about the junction box" has an actual place to look.

**Three things can produce those lines, and the result always says which — because what Reason may
then claim differs.**

- **It reads the captions** when the video has them. Creator-written first, auto-generated otherwise,
  and the result says which, because an auto track is a machine's guess at the audio and gets names
  and numbers wrong. Free, needs nothing but `yt-dlp`, and answers most asks. `tier: "captions"` —
  words only.
- **It watches the video** when the captions will not do and the link is YouTube. The URL goes
  straight to Gemini, which fetches and watches it, picture and sound. Nothing is downloaded.
  `tier: "watch"` — **this is the one case where Reason may honestly say it watched something**, and
  the receipt records which model did the watching.
- **It listens to the audio** when the site is not YouTube, because Gemini takes uploaded audio
  rather than an arbitrary page. Reason pulls the **audio track only**, uploads that, and gets a
  transcript. `tier: "listen"` — words only, so nothing visual may be described.

Needs `GEMINI_API_KEY` for the last two; with it empty a caption-less video comes back saying there
is no way to know what is in it, and Reason says exactly that.

**The honesty is in the result, not in the model's memory.** Every successful result carries a `how`
line in plain words — "read the captions", "WATCHED this video", "LISTENED to this video's audio" —
and the two word-only tiers spell out that nothing looked at the picture. A model that cannot tell
reading from watching will describe a scene that was never in front of it, so it is handed the
sentence rather than left to recall which tier it used.

**Careful with money, and with the audio.** The model tiers are billed per minute, so: the captions
win whenever there are any; there is a length cap (`REASON_VIDEO_MAX_MINUTES`, default 60) and a
longer video is refused in plain words rather than quietly charged for; and every account the model
produces is **cached by video and by tier**, so the second person to send the same link pays nothing
— while a request for one stretch is deliberately never cached, since an account of 14:00–16:00 is
not an account of the video. The audio file goes into a scratch directory under the data dir and is
**deleted the moment the transcript is stored**, whether the transcription worked or not. The video
stream is never downloaded, and `--extract-audio` is never used — the audio stream is taken exactly
as the site served it, which is why **ffmpeg is not needed**.

**A long result is cut short, loudly.** What came back and what did not are both reported as real
clock times, with the follow-up spelled out: call it again with `from` and `to`. Reason is told not to
say a word about the stretch it does not have.

**What it cannot get, it reports.** An age gate, a private video, a members-only video, a region
block, or a URL that is not a video — each comes back as the reason, and that is the answer. Gemini
only takes public videos either, so a gated video is not a case for trying the other way, and the
result says so. Nothing here signs in, works round a gate or pays for a membership. With `yt-dlp`
missing there is nothing Reason can find out about any video, and the tool and the `capabilities`
tool both say so.

```bash
# the one thing to install; it needs no key
pipx install yt-dlp          # or brew install yt-dlp, or the standalone binary
```

What Google's docs say this costs, read 2026-10-05: a video is **~100 tokens per second** at default
media resolution (6,000 a minute), audio is **32 tokens per second** (1,920 a minute). On
`gemini-3.8-flash` at its current $0.75 / M input tokens that is roughly **0.45 cents a minute to
watch** and **0.14 cents a minute to listen**, plus output. There is a free tier, capped at 8 hours of
YouTube a day.

Knobs: `REASON_YTDLP_BIN` when it is not on the PATH; `GEMINI_API_KEY` and `REASON_VIDEO_MODEL`
(default `gemini-3.8-flash` — their docs name 3.8 Flash, 3.7 Flash, 3.6 Flash and 3.5 Flash Lite as
taking YouTube URLs); `REASON_VIDEO_MAX_MINUTES`; `REASON_AUDIO_TMP`;
`REASON_VIDEO_TRANSCRIPT_CHARS` (default 20000) for how much comes back at once.

**Optional and not configured:** an OpenAI speech-to-text transcriber for the audio path and a local
Whisper, both in `src/transcribe.js`. They are built and offline-tested but Gemini is what the audio
path uses; they run only if `REASON_TRANSCRIBER` says so, and the local one would want a ~1.5 GB model
and ffmpeg, so it is documented rather than installed.

### Saved sign-ins and real sites

**You sign in yourself, once per site, and Reason never sees a password.** `npm run signin --
opentable` opens a visible browser window on that site's own sign-in page, in the same saved
profile Reason's browser uses for you. You sign in however you normally do — password manager, a
code by text, a passkey — and close the window. Reason then opens the profile again and asks the
*site* whether it is signed in, by loading the account page; only if the site agrees is it recorded
as connected. `--list` shows what is signed in and when it was last checked, `--check <site>`
re-checks without a window, and `--forget <site>` clears that site's cookies.

**You can sign in from your phone.** Text "sign me into Amazon" and Reason sends a private link
(`signin_link`). The page shows you Reason's own browser, live, on that site's real sign-in page:
you tap the picture to tap the page, type in a box, and tap Done. The site sees one browser the
whole time, so the session it grants lands in your saved profile, and Reason texts you what the
site said. This is what makes sign-in work for people who are not at the machine.

What that costs is said plainly, because it was decided with it in view: **on this path what you
type passes through Reason on its way to the site.** It is relayed and forgotten — never logged,
never stored, never put in a conversation, never shown to the model, and a test checks every table
and every log line for it. No picture of the browser is kept either. A password typed into a
*message* is still refused; that one stays in your messaging app for good.

The link works once: the first device to tap Start gets a cookie and nobody else can use the link
after that, so a link preview or a forwarded link takes nothing. An unopened link lapses in ten
minutes and launches nothing; a started session lasts ten more; a new link cancels the old one.
A password, or a code by text or email, works. Face ID, passkeys and security keys do not, because
the browser is on the machine and not on your phone. With no `REASON_PUBLIC_URL` the link only
opens on the machine itself, and Reason says so.

**At the machine, there is also a window.** `signin_open` opens the same sign-in page as a real
browser window on the screen of the machine Reason runs on, and texts you what the site said once
you close it. On that path nothing you type goes anywhere near Reason. A window nobody closes is
closed after 15 minutes so it cannot hold your saved profile.

If anybody offers a password in a message, Reason refuses in words and says why: a password in a
text is in the messaging app and the logs for good, and a password to one site is usually the
password to an email account too. That refusal is written in code, not left to the model.

**A password form is the one way of doing this that is ruled out, and it is not built.** Reason
never has a page of its own that asks for your password to a site: what you see through the link is
the site's own page, in a real browser, and the site is what you are typing into.

**Each site has a playbook** (`site_playbook`): where to start, whether it needs a sign-in, how to
tell signed-in from signed-out, what that site calls the button that commits ("Complete
reservation", "Place your order", "Request ride", "Buy tickets"), and its known limits. Those labels
feed the confirm gate, so the click that commits needs your yes whatever the site calls it.
Browsing and filling in are free.

**What actually loaded**, from a signed-out headless browser with no stealth, on 2026-10-05
(`npm run probe:sites`, results in `docs/site-probe-2026-10-05.json`):

| Site | Loads for Reason? | What happened |
| --- | --- | --- |
| Uber | yes | `m.uber.com` loads and shows the ride form; prices and cars need a sign-in |
| Lyft | partly | `lyft.com` loads, but the ride page only offers to text you an app link |
| Amazon | yes | loads, and order history redirects to sign-in as expected |
| Fandango | yes | loads, and the account page redirects to sign-in as expected |
| OpenTable | **no** | drops the connection on an automated browser; 403 to plain curl |
| DoorDash | **no** | 403 on every page |
| Uber Eats | **no** | 403 on every page |
| Delta | **no** | "Access Denied" (HTTP 444) on every page |
| United | **no** | drops the connection, on curl too |
| Ticketmaster | **no** | 403 on every page |

A site that refuses is reported as the site's choice. Nothing here tries to get round a bot check,
a CAPTCHA or a login wall, and nothing will. Where a site documents another way, that is built
instead: **`uber_link`** makes Uber's own public link with the destination filled in, which you tap
and then request the ride yourself — no account and no key.

**A daily spending limit sits on top of the yes each thing needs.** `REASON_MAX_SPEND_PER_DAY`
(default 300 dollars, 0 for none) is counted per person per day in the database from the amounts in
what you approved, and checked *before* a commit goes through. Over it, nothing is committed and
Reason says the limit, what is already committed and what is left. On these sites a page that shows a price cannot
be committed on an approval that named none, which is what stops something large slipping past the
count. `spend_today` reads the day's lines back.

### Spotify

Built from Spotify's current Web API and authorization docs, the documented way: authorization
code flow, redirecting to Reason's own listener at `/spotify/callback` under `REASON_PUBLIC_URL`
(localhost works on the machine Reason runs on). Tokens are stored per person, refreshed when they
expire, and revocable. With no `SPOTIFY_CLIENT_ID` it is **not connected** and says so.

Tools: search, what is playing, play / pause / skip / queue, make a playlist and add to it, and
recently played and top items. The ones that change playback need Spotify Premium and a device with
Spotify open; Spotify's error for both is the same bare 403/404, so the result names the likely
cause rather than pretending to know which. One person's Spotify can never be reached from another
person's conversation. **Nothing has been sent to Spotify** — every test runs against a fake
server built from their documented responses.

### Your data

```bash
npm run data:export > reason-export.json   # everything: pages, call recordings (base64), the lot
npm run data:export -- dm:owner            # one conversation
npm run data:export -- --no-audio          # the rows, without the recordings' bytes
npm run data:delete -- --yes               # wipe it, recordings deleted off disk too
```

A delete removes the audio files, not just the rows. An export carries the bytes inside it with
each recording's sha256, and says `missing: true` for any file the database claims to have but
cannot find.

## Where this actually is

Three honest buckets. Nothing is in the first one unless a test passes on it.

### Working today

All of this is covered by the offline suite — **816 tests, 785 passing, 0 failing, 31 skipped**.
The 31 skipped need a real model; they all pass through the `claude-cli` backend (see below), and
have not been run against the API for want of credit.

- **An account per person**, fully separate, with the master approving each one by text — and a
  daily limit each, so nobody can run up the bill.
- **Plans.** Make one, change any detail, lock it, cancel it, mark it done. It tracks what is still
  open and will not lock while something is.
- **Reminders and timers** that fire real turns at real times.
- **Tasks that outlive a message.** Chasing someone, waiting on a reply, a multi-step errand. A row
  in the database with a goal, a next wake time and a progress log, so killing the process loses
  nothing. Reason only speaks about one when something actually changed.
- **Watchers.** Watch a page, come back when a specific thing changes on it.
- **Follow-ups.** When a plan with open questions goes quiet for hours, Reason picks it back up on
  its own — at most once per plan per day, twice per conversation.
- **Memory about people.** Facts, preferences, who someone is; read it all back, or forget a person
  outright.
- **A real browser** it drives itself: open a page, read it, click, fill a form, screenshot. One
  profile per conversation so logins stick between turns. The final commit click always needs your
  explicit yes.
- **Reading one web page** and answering from what it actually says.
- **Research with a real pick** — several different searches, the best sources read in full, a source
  log of what each one said and when, then a recommendation with what would change it. Capped so one
  question cannot run away, and it says when a cap cut it short. A big question runs as a durable
  task. The provider interface and the whole flow are offline-tested against a fake provider and
  fixture pages; the Tavily request shape is tested against its documented contract but **has never
  been sent to Tavily** — no key. **Reddit is never fetched** (its robots.txt forbids everyone);
  what threads say arrives as search snippets, labelled as snippets.
- **Finding out what is in a video.** A YouTube link (and many other video sites) → the title,
  channel, length, description, chapters and what is in it as timestamped lines. It reads the captions
  when there are any; a long one is cut and says which stretch is missing, and a follow-up reads that
  stretch. An age gate, a private video or a region block comes back as the reason. Every result says
  which of three things produced it, so "watched" is only ever said when something really watched.
  Proved against real YouTube videos as well as offline fixtures; see the manual checks in
  `docs/unverified.md`. The **video model** tiers — watching a YouTube link, and transcribing audio
  from anywhere else — are built and offline-tested but need `GEMINI_API_KEY`. The audio-only download
  and the delete-after are proved for real; nothing has ever been sent to Google.
- **Messages arriving the way people actually send them.** Two texts seconds apart are one turn;
  the parts of one iMessage (a pasted link and its preview card) are one message rather than three;
  a photo or screenshot reaches the model as a picture to look at, and anything that cannot be read
  is explained once, by name, instead of being called "blank". Against the real failing shapes from
  a real phone.
- **Tapbacks, screen effects and voice notes** as tools, with Sendblue's own grammar and limits
  checked before any request — including the awkward part, which is that "exactly one emoji" has to
  treat a skin tone, a family, a keycap and a flag as one.
- **A voice, and ears.** Reason can say something as a real voice note and listen to one you send,
  with every failure a named reason. The whole path has run on this machine with the real speech
  model — spoken, converted, served back and transcribed word for word — but no voice note has
  been sent to or received from a real phone. See `docs/unverified.md`.
- **Saved sign-ins, site playbooks, a daily spending limit and Spotify**, against local fixture
  pages and a fake Spotify server: browsing is free, the committing click is gated whatever the
  site calls it, a changed total asks again, and one person's sign-in or token is never usable from
  another's conversation. No real site has been signed in to and nothing has been sent to Spotify.
- **A message Reason starts reaches the phone.** A reminder, a task's news, a watcher or a
  picked-up thread goes to the thread that conversation lives in. Until 2026-10-05 these had no
  channel and were printed into the server's log instead — written, recorded as said, and never
  texted. `src/deliver.js`, pinned by `test/deliver.test.js`.
- **Inline replies**, both ways: a reply pinned under the message it answers, a refused pin that
  falls back to an ordinary message instead of losing it, and an inbound reply that arrives saying
  which message it was sent under. Never sent to a real phone — see `docs/unverified.md`.
- **The confirm gate**, the **action ledger** ("what did you do today" is read off a table, never
  from memory), and the **connected-accounts registry**.
- **`npm run serve`** — the long-running process with its sweep and webhook listener.
- **Export and delete**, call recordings and pages included.
- **Pages** — made, updated at the same link, opened by the owner's own link with nothing to type,
  closed to the bare link until shared, shareable on request through a separate read-only link,
  with a tapped answer coming back as one event turn. Against the HTTP handler, no browser needed.
- **Phone calls** as far as they can go without an account: the provider interface, the recorded
  announcement, the recording store, the audio arriving with the summary in one message, the
  never-pay-by-phone guard, and the per-person daily caps on calls and on call minutes. Against a
  fake provider that dials nothing.
- **The Bland adapter**, driven by an injected `fetch` that could not reach the network if it
  wanted to: the exact request body (`record: true`, the announcement as `first_sentence`, the
  standing rules ahead of the goal), every one of Bland's call statuses mapped onto Reason's,
  the audio fetched from Bland's own authenticated endpoint rather than from `recording_url`, and
  the signed call-finished webhook. No call has been placed.

### Built, but never run against the real thing

Written carefully, offline-tested, and **unproven**. Do not treat any of it as working.
`docs/unverified.md` is the full ledger, test by test.

- **The Bland call provider.** Written from Bland's own docs (`POST /v1/calls`,
  `GET /v1/calls/{id}`, `GET /v1/calls/{id}/recording`, their webhook-signing page), read
  2026-10-05, with the page named next to every field in `src/calls/bland.js`. There is no
  `BLAND_API_KEY` on this machine, so **no phone has ever rung**: 38 tests drive it with an
  injected `fetch` and assert on the exact URL and body. What only a real call can settle — that
  the opening line is really spoken word for word, that it really declines when asked for a card,
  that a recording really comes back, that a webhook really arrives — is all listed in
  `docs/unverified.md`.
- **The Linq channel** (iMessage / RCS / SMS). Written from Linq's published Partner API v3 docs,
  signature checking per the webhook spec they document. No key has ever sent a real text.
- **Sending an attachment over Linq** — their documented pre-upload flow, so a call recording can
  ride along with the summary. Same caveat: never run.
- **The API path.** All 25 live tests now pass — but through the `claude-cli` backend on a Claude
  subscription, not through the Anthropic API that Reason actually ships on (there is no credit on
  this machine). Same prompts, same tools, different backend: no prompt cache, and the CLI owns the
  tool loop. So the behaviour is proved with a real model; the path it will run on is not. In this
  repo "live tested" means *via claude-cli*, and `docs/unverified.md` says so test by test.
- **The video model.** `src/gemini.js`, written from Google's current docs (POST to
  `models/<model>:generateContent`, a YouTube URL as `file_data.file_uri`, a time range as
  `video_metadata.start_offset`/`end_offset`, and for audio the Files API's two-step resumable upload
  then `file_data` with a `mime_type`). There was no `GEMINI_API_KEY` in the environment when this was
  written, so **nothing has ever been sent to Google** — it has only answered an injected fetch. The
  tests pin the request shape header for header, which is all that can be checked without a key. The
  halves either side *are* proved for real: the audio-only download, the file on disk, the deletion
  afterwards, and the cache spending nothing on a second ask were all run against a real YouTube
  video. Also unverified: the optional OpenAI transcriber in `src/transcribe.js`, same reason.
- **Video sites other than YouTube.** `yt-dlp` covers hundreds of them and the code treats them all
  the same, but only YouTube has been tried. Expect the metadata to be thinner elsewhere and
  captions to be missing more often.
- **Whether a real call keeps its promises.** Code can prove a call request cannot carry payment
  details and cannot be placed without the recorded announcement. Whether a real voice agent says
  the announcement first and holds the line when a restaurant pushes for a card is a property of
  whichever provider gets bought — and it is the first thing to test on the first real call.

### Not connected, and what you have to supply

Reason says all of this itself when asked: the `capabilities` tool and `account_list` report every
one of these as not connected, with what is missing. It starts up fine with none of them.

| What | What you must supply |
|---|---|
| **The model** | `ANTHROPIC_API_KEY`, with credit. Everything needs this, and a hosted install cannot use the subscription backend instead. |
| **A server to run on** | A host with a persistent disk and 1–2 GB of memory, plus `REASON_DATA_DIR` pointed at the mounted volume. See **Running it on a server**. |
| **Page links that open on a phone** | `REASON_PUBLIC_URL`, the address this listener is reachable at. Pages work without it; their links just only open on this machine, and Reason says so. |
| **Texting** | Sendblue: `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (or, superseded, Linq: `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_FROM_NUMBER`), plus `REASON_OWNER_NUMBER` set to your own number and a webhook subscription pointed at your host. |
| **Phone calls** | A [Bland](https://app.bland.ai) account, then `REASON_CALL_PROVIDER=bland` and `BLAND_API_KEY`. Their published Start-plan rate is **$0.14 a connected minute**, free to sign up; `REASON_MAX_CALLS_PER_DAY` and `REASON_MAX_CALL_MINUTES_PER_DAY` are what stop one person running that up. Optional: `BLAND_FROM_NUMBER` (without it Bland dials from its own pool), and `BLAND_WEBHOOK_SECRET` from their dashboard so the call-finished webhook is verified by signature rather than only by the unguessable token in its URL. With no `REASON_PUBLIC_URL` there is no webhook at all and outcomes are polled, which Bland's own docs call the right answer rather than a workaround. `docs/call-providers.md` compares the alternatives. |
| **Web search, and therefore research** | `TAVILY_API_KEY`, from [app.tavily.com](https://app.tavily.com). **1,000 API credits a month, free, no credit card** (their docs, read 2026-10-05). A basic search costs 1 credit, so that is about 1,000 searches a month, and one research run spends up to 5 of them — roughly 200 questions a month on the free tier. Past it: **$0.008 a credit** pay-as-you-go, or $30/mo for 4,000. Reading the pages afterwards is free (a plain fetch, not a Tavily extract). Without it, `capabilities` says search is not connected, `research` refuses rather than guessing, and Reason reads a page whose address it can name itself and says that is all it did. Brave Search is the alternative and is **not wired**: its free tier is $5 of monthly credit on a billing plan. |
| **Videos at all** | Nothing but `yt-dlp` on the machine (`pipx install yt-dlp`, `brew install yt-dlp`, or the standalone binary), or `REASON_YTDLP_BIN` pointed at it. No key, no account. It is what fetches a video's details, its captions and its audio, so with it missing there is nothing Reason can find out about any video — and the tool and `capabilities` both say so. |
| **Watching a video, or reading one with no captions** | `GEMINI_API_KEY`, from aistudio.google.com. Per Google's docs (2026-10-05): a video is ~100 tokens per second at default media resolution, audio is 32 tokens per second, so on `gemini-3.8-flash` at $0.75 / M input that is roughly **0.45 cents a minute to watch** and **0.14 cents a minute to listen**, plus output. Free tier capped at 8 hours of YouTube a day. Public videos only. Capped at `REASON_VIDEO_MAX_MINUTES` (60) a video and cached per video and tier. No ffmpeg needed. Without it, a caption-less video comes back saying there is no way to know what is in it, and Reason says that. |
| **Payments** | `REASON_PAYMENTS_KEY`. |
| **Gmail, Calendar, Drive** | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` — and note the credentials are only half of it: there is no email, calendar or documents tool written yet, so supplying these does not make them work. |
| **Spotify** | A developer app from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard): put its id and secret in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and add `{REASON_PUBLIC_URL}/spotify/callback` to the app's Redirect URIs. Then each person taps the link Reason sends and approves on Spotify's own page. Playing, pausing, skipping and queueing need Spotify Premium. |
| **OpenTable, Uber, Lyft, DoorDash, Uber Eats, Amazon, Delta, United, Ticketmaster, Fandango** | You, signed in once yourself: `npm run signin -- <site>` opens a real window, you sign in, you close it. Reason never sees a password. **Six of the ten refuse an automated browser today** — see "Saved sign-ins and real sites" above for which. |

Picked, and genuinely not started: everything in the table from Gmail downwards, plus Reason's own
email address, real bookings and checkouts with the exact total approved, group texts with polls,
documents and decks, and plug-in apps. `docs/features.md` has the agreed order under
**Decided 2026-10-04**.

## The rules it keeps

These are the point of the project rather than features of it. Each one says where it is actually
enforced, because a rule that lives only in a prompt is a hope.

**Only the click that really commits needs a yes, and a yes covers the details.** Picking a time,
opening a form and filling it in commit the owner to nothing, so they cost nothing — a yes spent
navigating to a form is a yes that is gone by the time the booking button arrives. *Enforced in
code* (`clickCommits` in `src/tools.js`): what gates a click is read off the element, not off
anybody's description of it. A link navigates and is free; anything else is judged by **the page's
own label**; a label that cannot be read is treated as a commit; a link that takes money is gated
anyway, because a one-tap charge cannot be undone. The model's own account of what a click will do
is recorded on the receipt and ignored by the guard. The booking Reason finally submits is checked
against the one the owner agreed to, so a yes for the 8:00 table will not book the 9:00 one.

**It confirms before it spends money or contacts anyone.** Anything that costs something or reaches
a third party stops and asks first, and the question names the exact thing — the number, the words,
the amount. *Enforced in the tool* (`src/trust.js`): the model cannot approve on your behalf,
cannot grant a confirmation in the same turn it asked, cannot spend one yes twice or after it goes
stale, cannot carry a yes over to details you never saw, and cannot point a yes for one person at
somebody else.

**Every call is recorded, and every call says so.** Before anything else, a call tells whoever picks
up that it is an AI assistant calling on your behalf and that the call is recorded. There is no
switch. *Enforced in code*: the line is built in `src/calls/provider.js` and passed to the provider
as its own argument, a provider handed a call without it refuses to dial, a provider that cannot
record cannot place a call at all, and a recording that goes missing on an answered call is
reported to you and written to the ledger as an error.

**It never pays by phone.** No card number, no expiry, no security code, no bank details, no PIN,
read out on a call, for any reason, including to hold a booking. *Enforced twice in code*: the call
request is scanned before the dial (`src/calls/payments.js`) and refused if it carries payment
details, and every call separately carries a standing instruction to decline, ask for a payment
link or another way, and report back.

**It says "watched" only when something really watched.** Captions and a machine transcript of audio
are both words; neither is a picture. *Enforced in the tool* (`src/video.js`): every video result
carries a `tier` — `captions`, `watch`, `listen` or `metadata` — plus a plain sentence saying which
happened, and the two word-only tiers spell out that nothing looked at the picture. So what the model
is handed is the honest wording, not a flag it has to interpret, and "watched" is only available to
say when a video model was actually given the video. The receipt on the ledger records the tier and
which model did the watching, which is what lets "did you actually watch that" be answered weeks
later. The half that is a prompt rule rather than a code check is the wording itself — Reason is told
to say *read*, *listened* or *watched* to match the tier, and told never to describe anything visual
off the first two — and that is listed here rather than claimed as airtight.

**A video's audio is borrowed, not kept.** Listening downloads the audio track only, never the video,
and the file is deleted as soon as its transcript is stored — in a `finally`, so a failed or crashing
transcription cleans up too. What is kept is the text. *Enforced in code* (`listen` in
`src/video.js`), and the receipt says "the audio was deleted" because that is a claim worth being able
to check.

**It is never you.** Reason is your assistant acting for you, and it says so. *Enforced in code for
calls* — the announcement says "on behalf of" and cannot be edited by the model. *A prompt rule for
texts*: it is told never to write as though you typed it and never to sign your name. That half is
not yet something code checks, and it is listed here rather than claimed as airtight.

There is also a shorter one: **it does not write, run or ship code.** No scripts, no repositories,
no pull requests, no deploys. Not a missing integration, not planned. The `capabilities` tool keeps
this and the payment rule in a `wont_do` list, separate from the things that are merely not
connected, because "I can't do that yet" and "I don't do that" are different answers.

### The confirm gate, in detail

- **The gate reads meaning, not words.** What a reply means is decided by a separate narrow model call that sees only the action as described and the owner's answer, verbatim — no history, no tools, a forced `yes`/`no`/`change`/`unclear` verdict. Word lists cannot do this job: "no problem, book it" is a go-ahead, and "ok but make it 9 instead" is not, though it reads as a yes to any substring match and would book the 8:00 that was just rejected. A reply that approves but moves any detail comes back `change`, which authorizes nothing and sends Reason back to ask again with the corrected summary. Anything the judge cannot read — an error, a timeout, an off-schema answer — is `unclear`, and `unclear` never grants. Code still owns every fact a model cannot be trusted with: that a real new message arrived after the ask, single use, expiry, one action per yes, and the owner's exact words on the record.
- **A receipt for everything.** Every action that touched the outside world writes an append-only ledger row: what was attempted, what came back, when, and which yes authorized it. "What did you do today?" is answered from that table.
- **Nothing is faked.** A provider with no credentials on this machine reports `not_connected` and names the exact variables that are missing. An app that has been *chosen* but has no code behind it also reports `not_connected`, and says that nothing is built for it — credentials for an integration nobody wrote do not make it work, and `connectable` would be the quiet overclaim this registry exists to prevent. Trying to connect one is refused rather than recorded. `/accounts` shows what Reason can reach; `account_revoke` cuts it off with no second confirmation.

## Layout

```
src/agent.js     the brain: system prompt + tool loop (Claude via the Anthropic SDK)
src/tools.js     tool schemas, input validation, guards; the only way state changes
src/accounts.js  whose Reason is whose: admission, account state, per-person caps
src/access.js    asking for a Reason, and the master's yes or no read through the gate
src/trust.js     the confirm gate, the action ledger, the connected-accounts registry
                 (including the apps chosen but not built, so nothing claims to work)
src/db.js        SQLite (node:sqlite): conversations, plans, timers, tasks, people, calls,
                 threads, watches, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + the sweep: timers, tasks, watchers, dropped threads
src/serve.js     the long-running process; src/http.js is its listener and serves pages
src/channels/    Channel interface (send, send-with-an-attachment, typing, receive) + console,
                 fake and Linq adapters, and the router that decides whose conversation an
                 inbound message belongs to
src/pages/       what a page may contain (content.js), our HTML template (render.js), and who
                 gets to see one — codes, cookies, rate limit (access.js)
src/calls/       CallProvider interface, the Bland adapter (bland.js), a fake, which one this
                 install runs (choose.js), the recording store (audio Reason owns), and the
                 never-pay-by-phone guard. docs/call-providers.md compares the alternatives
src/backends/    the owner's local claude-cli backend, the MCP server behind it, and the guard
                 that stops it serving anybody else
src/search.js    the SearchProvider interface (query in, ranked results out), Tavily, and a fake
                 for the tests. With no key: not_connected, said plainly, never guessed around
src/research.js  the research flow: plan the searches, read the best sources, keep a source log,
                 hold the caps. The model may only cite what is in that log
src/robots.js    does a site allow being read? robots.txt, fetched once per host and cached. This
                 is why Reason never fetches Reddit, which disallows everyone
src/weblookup.js fetch one page and read its text; no JavaScript, no cookies
src/video.js     going to a video: yt-dlp for its details, its captions and (for the audio path)
                 its audio track only. Every result says which of the three tiers answered
src/gemini.js    the video model: a YouTube URL handed over and watched, or uploaded audio
                 transcribed through the Files API. Nothing has ever reached Google
src/transcribe.js  OPTIONAL, not configured: an OpenAI speech-to-text transcriber for the audio
                 path, and a local Whisper documented but deliberately not installed
src/chat.js      terminal console
src/data.js      export / delete your data
test/            flow tests (assert DB state, never wording) + guard unit tests
docs/design.md   what Reason can do, what stays in code, milestones
docs/features.md the agreed feature list and build order (Decided 2026-10-04)
docs/call-providers.md  which telephony provider to buy, and why
docs/unverified.md      every live test that has not passed against the current code
```

## Testing on a Claude subscription (owner only, local)

The live tests prove the model reads real messages correctly, so they need a real model, so they
cost API credit. With none, they can be run through the `claude` CLI against a Claude subscription
instead:

```bash
REASON_BACKEND=claude-cli npm test
```

As of 2026-10-04 **all 25 live tests pass this way** — a booking really lands, once, after a real
yes, with a receipt, and a changed detail really is re-asked. That proves the behaviour with a real
model; it does not prove the API path, which is what Reason ships on. See `docs/unverified.md`.

**This is for the owner's own machine and nothing else.** It is not how Reason is deployed, it is
not supported for other installs, and the API backend in `src/agent.js` is untouched and remains
the default. Nothing here reads the CLI unless `REASON_BACKEND` says so.

That is not left to anyone's good intentions. With a real channel connected, the subscription
backend **only ever answers the operator's own test numbers**:

```bash
REASON_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234 npm run serve
```

**A number on that list is already approved.** Putting a number in `REASON_TEST_NUMBERS` is the master saying yes to it, so that person's first text creates their own Reason and gets a real answer, with no approval question sent to the master. A blocked number is still refused. Anyone not on the list is let in the usual way, by the master's yes over text.

Those numbers get answers. Every other number — including somebody who is invited — gets a single
"not available yet" line and **no model turn**, because every turn here comes out of one person's
personal plan rather than out of an install's budget. With `REASON_TEST_NUMBERS` empty there is
nobody it may legitimately answer, so it **refuses to start**:

```
$ LINQ_API_KEY=... REASON_BACKEND=claude-cli npm run serve
Refusing to start: REASON_BACKEND=claude-cli with linq set up and no test numbers.
…
Either set REASON_TEST_NUMBERS to Omari's own number(s) to test over linq, or serve other
people properly: set ANTHROPIC_API_KEY to a key with credit…
```

**An Anthropic API key with credit is required before anybody but the operator is served.** That is
the rule, it is in the startup log, and it is checked per message in code
(`servesOnThisBackend` in `src/backends/guard.js`) rather than trusted. A personal Claude
subscription is not a service: no per-install billing, no rate limit anyone else is entitled to, no
prompt cache. The console and the fake channel are always fine — they only ever reach the operator
— and the channel rule is an allowlist, so an adapter added later is treated as external by
default. `npm run chat` and `REASON_BACKEND=claude-cli npm test` are unaffected.

How it works: `src/backends/claude-cli.js` runs one turn as `claude -p` in headless mode and points
it at Reason's own tools, served over a loopback port by the Reason process itself
(`src/backends/mcp-http.js`, MCP streamable HTTP). The server is started for the turn and closed
after it, bound to 127.0.0.1 on a port the OS picks. Claude Code's own tools (Bash, Read, WebFetch
and the rest) are denied, so a turn cannot succeed by going around Reason. The confirm gate's judge
and the watcher's page check take the same route.

The point of serving the tools in-process rather than as a CLI-spawned subprocess is that the
tools are then *the same code in the same process*: one SQLite writer, one Chromium that stays open
across turns, and every tool call landing in the same log the API backend writes. The gate, the
owner check and the ledger are exercised, not simulated.

What it does not give you, honestly:

- **No prompt cache.** Each turn is a fresh process, so the system prompt is re-sent every time.
  Slower and more subscription tokens than the API path.
- **The CLI owns the tool loop.** `REASON_MAX_TOOL_ROUNDS` does nothing here; `REASON_CLI_MAX_TURNS`
  (default 30) is the CLI's own budget, and the loop's stopping rule is the CLI's, not Reason's.
- **History is text only.** The API path keeps the model's own tool calls and results in the
  message list; a fresh CLI process cannot. Open confirmations are spelled out in the prompt to
  restore that, but the model does not see what its earlier tool calls returned.
- **Tool names arrive prefixed.** Over MCP the model sees `mcp__reason__browser_submit` and will
  sometimes write that into `confirm_request`. The gate normalises the prefix away (`toolName()` in
  `src/trust.js`) so a yes still matches the tool it was for.

Knobs: `REASON_CLI_MODEL` (default `opus`, to match the API path — the gate tests pass on opus and
not reliably on sonnet), `REASON_CLI_MAX_TURNS`, `REASON_CLI_TIMEOUT_MS`, `REASON_CLI_BIN`, and
`REASON_CLI_DEBUG=<file>` to append every CLI result envelope for debugging.

## Running it on a server

Reason is a long-running process with a database and a browser. It does not need a laptop, and
leaving it on one means it stops when the lid closes. Nothing here is deployed anywhere — this is
what a host needs from you.

```bash
docker build -t reason .
docker run -d --name reason \
  -p 8787:8787 \
  -v reason-data:/data \
  -e ANTHROPIC_API_KEY=sk-... \
  -e REASON_OWNER_NAME=Omari \
  -e REASON_OWNER_NUMBER=+12025551234 \
  -e REASON_PUBLIC_URL=https://reason.example.com \
  -e LINQ_API_KEY=... -e LINQ_WEBHOOK_SECRET=... \
  reason
```

**The volume is not optional.** Everything Reason keeps lives under `REASON_DATA_DIR` (`/data` in
the image): the database, call recordings, saved browser logins and screenshots. Without a volume
mounted there, a restart forgets every plan, every memory and every login. One directory so there
is one thing to mount and one thing to back up.

**Config is environment only.** There is no config file, so there is nothing to copy and nothing
to leave behind. `REASON_HOST` and `REASON_PORT` are what it binds; `REASON_PUBLIC_URL` is the
address it hands out in page links, which is usually not the same thing. Without
`REASON_PUBLIC_URL` pages still work but their links only open on the box itself, and Reason says
so rather than texting you a dead link.

**What the box needs.** A persistent disk you can mount. Enough memory for Node plus a Chromium —
budget **1 GB and prefer 2 GB**, because the browser is the hungry part and a 512 MB box will kill
it mid-errand. One always-on instance; Reason is not built to run two copies against one database.

**Stopping it is safe.** The container takes `SIGTERM` straight to `node` — no npm wrapper to
swallow it — and `src/serve.js` then stops sweeping, lets the turn that is running finish, and
gives a wake time back to any task that was mid-step so nothing is left asleep for good. `/health`
answers from the database and the adapters rather than from uptime, so a host's health check is
checking something real.

**The `claude-cli` backend cannot be used on a server.** It shells out to a `claude` CLI that is
logged in as a person on their own machine; there is no such login in a container, and a personal
subscription is not a thing to serve other people from anyway. **A hosted Reason needs
`ANTHROPIC_API_KEY` with credit.** That is not a preference — with no key no turn can run, and the
startup log says so.

**Webhooks.** Point your texting provider's webhook at
`https://your-host/channels/linq/webhook`. That has to be HTTPS from the provider's side, which
means something terminating TLS in front — most hosts do this for you. Reason itself speaks plain
HTTP and does not want to hold certificates.

### What has not been tried

**The image has never been built.** There is no Docker on the machine this was written on, so the
Dockerfile is reviewed and unbuilt: the base image tag is checked against the `playwright` version
in `package.json` by a test, and the rest is read rather than run. Expect to fix something the
first time you build it. The properties around it — one data directory, environment-only config,
the public URL, the graceful stop, `/health` — are covered by tests that do run. See
`docs/unverified.md`.

## Keeping this file honest

**Standing rule for this repo: every commit that changes what Reason can do also updates this
README, in the same commit.** Not afterwards, not in a cleanup pass. The README is the only place
somebody can find out what is real without reading the tests, so a commit that moves the line and
leaves this file behind has made the project less honest, whatever it added.

What it has to keep current: what Reason does today, what is built but unverified, what is not
connected and what you must supply by name, how to run it, and the rules it keeps. Nothing goes in
the "working today" list that has not passed a test. If something is built but unproven, it goes in
the second bucket with the reason — and into `docs/unverified.md`, test by test.
