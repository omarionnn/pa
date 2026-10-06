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

### What has to be on the machine

Reason starts with nothing configured and says so rather than pretending: `capabilities` reports
every missing piece by name, and it never claims a tool it does not have. The full list of keys and
what each one unlocks is **Not connected, and what you have to supply**, further down. This section
is the other kind of dependency — programs on the machine, which no `.env` can fix.

| For | What is needed | Without it |
| --- | --- | --- |
| **An iPhone photo (HEIC)** | `/usr/bin/sips`, part of macOS | the photo is not seen, and gets one honest sentence saying it came through as a heic. **There is no Linux fallback** — see below |
| **Listening to a voice note** | `/usr/bin/afconvert`, part of macOS, or `ffmpeg` anywhere on the PATH — plus `GEMINI_API_KEY` for the model that listens | the note is reported as not listened to, with the reason; never guessed at |
| **Anything about a video** | `yt-dlp` on the PATH (`pipx install yt-dlp`) | the video tool says exactly what it cannot find out |

**This matters for hosting.** The HEIC conversion is `sips`, which exists only on macOS, so a Reason
on a Linux box cannot read an iPhone photo at all — it refuses honestly rather than failing, but it
refuses. Voice notes are fine there as long as `ffmpeg` is installed. `REASON_SIPS_BIN=none` makes a
Mac behave exactly like a Linux host, which is how that refusal is tested.

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

A task also carries an **outcome sheet**: the budget, the dates, the people, the place, the options
already turned down and why — everything that shapes the answer, on the row rather than in the
model's context, which is trimmed to the last sixty messages. The sheet is put in front of the model
on every wake and on every message while the task is open, so "including fees" said once holds for
the rest of the job. Three things about it are code's and not the model's: a rejected option is
filtered out before the model sees the options, so it is never offered again; a value they stated
cannot be overwritten by anything Reason found or assumed, only by a new thing they said, quoted; and
anything Reason assumed is marked as an assumption, to be stated once rather than asked about.

A task's state says **whose the loose end is**: `running`, `waiting_on_you` (it needs one answer only
they can give — and the state is refused unless the sheet carries that question with its tradeoff),
`waiting_on_other` (somebody else owes it something; it keeps a next check and Reason keeps checking
without being asked), or `blocked` (with what stopped it and what would unblock it). The original
`waiting` is kept, so older rows behave exactly as before. A task waiting on *them* does not wake the
model at all, and mentions itself exactly once more after `REASON_NEEDS_REMINDER_MIN` (default 24h) —
never a third time, because the stamp is on the row rather than in the model's sense of tact. "Where
were we?" is answered off `task_list` in one order: what is done, what is left, then the one ask.

**Steering is cheap, and corrections stick.** Every ordinary turn opens with what is open — each
job's whole sheet — and what is waiting on a yes, so "shorter", "wrong person", "actually Friday" or
"including fees" always has something to point at and nobody has to explain it twice. The correction
is recorded with their own words and what it changed, and it holds for the rest of the job rather
than for the next reply. A yes never carries over to an amended detail: when a reply reads as "yes
but different", nothing is authorized and nothing is refused — the details change and the ask goes
out once more as one line. "Wrong person" means the first number is never reached, on the old yes or
the new one. "Leave that alone" closes that one job and says what had already gone out, read off the
ledger, and touches nothing else.

**One obstacle is not the end of a job, and it is never a reason to change the job.** A route that
failed — a page that will not load, a site that refuses an automated browser, an empty search — is
written down with why, on the sheet and in the progress log, and Reason is told to take the next safe
route to the same goal and to name the ones it tried once they genuinely run out. The tempting
shortcut is quietly moving what was asked for, so that is refused in code: any attempt to change a
value they stated comes back `needs_them`, and the honest move is one question with the tradeoff on
it. A site that blocks an automated browser is still reported as the site's choice, never worked
around.

### Noticing things first

Everything above waits to be pointed at something. This is the one pass that goes looking.

Every couple of hours, for anybody whose mail and calendar are connected, Reason reads their next
two days and the mail since it last looked, and asks whether anything slipped: a meeting that
**moved deep in a thread**, something new or cancelled on the calendar, somebody new added to an
event, a **bill or an appointment** sitting unread with a date on it, a **reply somebody they know
has been waiting on** for over a day. Then one short line about the single best of them, or nothing.

The split is the whole design: **code decides when to look and how many times to speak; the model
decides what is worth saying.**

- **One a day.** The budget is a row in SQLite, not a line in a prompt — one unprompted text a day
  per person, counted when the message really goes out, reset at *their* local midnight. Something
  genuinely urgent can go past it with a reason on it, up to a hard ceiling of three. One great
  catch a day beats five generic ones.
- **The three questions.** Before any unprompted line, `notice_send` asks: is this specific to
  them, does it matter today, can they answer it in one word? A false answer refuses. So does a key
  that was already said, and a key nobody handed over.
- **The sweep cannot text.** It runs one event turn and the reply is **held back unless the model
  went through that tool**. A model that writes a lovely line and skips the gate sends nothing at
  all.
- **At the moment it is useful, not in a batch.** "your 2pm with dana moved to 3, it was buried in
  the thread" beats a morning summary that mentions it on line nine. A catch about something later
  is **parked on a one-off timer for about two hours before the thing** rather than said on
  whichever sweep found it — unless it moved and is inside the next six hours, which is too soon to
  sit on. The timer's turn goes through the same gate.
- **Quiet hours are theirs.** Nothing unprompted between 22:00 and 08:00 *in their time zone*, read
  off their own calendar's zone, unless it is urgent. In their night the sweep does not even pay for
  a model call.
- **Nothing is said twice.** Every candidate is a row keyed on the thing *and its state*, UNIQUE, so
  the same moved meeting is news once rather than on every sweep for two days — and the same meeting
  moving again is a new thing to say.
- **Held, not lost.** A catch that could not go — spent day, quiet hours — stays written down. It
  goes first on the next sweep, and it folds into the end of the next reply they are already
  reading: *"btw, your standup moved to 10 yesterday."* That rides along, so it costs them nothing.
- **What finishing something sets in motion.** A task finishing or a plan locking gets one follow-on
  turn: name the single most likely next thing — a ride to the airport, two lines on the person they
  are about to meet, a reminder before the thing — and **offer** it in a line they can answer with
  one word. Never do it unasked, never two.
- **Honest about it.** `notice_status` is the truth of what is being watched, how often, what was
  said, what was noticed and *not* said, and how much of today is left, so "why haven't you told me
  anything" has a real answer. With nothing connected the line is "i'm not watching mail or calendar
  for you", not a promise to keep an eye out.
- **Their call.** "text me less", "stop unless it's important", "check more often" are saved on
  their account (`notice_settings`). **None at all is a real answer and it is kept** — then nothing
  goes out on its own, ever, and what Reason notices only comes up when they text.

Every sent catch leaves a **receipt in the ledger**, so "what have you been up to" includes the
things nobody asked for. The knobs are the `REASON_NOTICE_*` block in `.env.example`.

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

#### Asking from a website

A website can have a "request access" box, and a number left there joins the same queue and is put
to the master the same way. `POST /access/web` takes `{"phone": "+14155559876"}` from the website's
**own server**, never from a browser:

- the body is signed (`x-reason-timestamp`, and `x-reason-signature: sha256=` HMAC-SHA256 of
  `timestamp.body` under `REASON_WEB_ACCESS_SECRET`). A signature is good for five minutes. With the
  secret unset the route answers 404 like any path that does not exist;
- only a plain E.164 number gets through, and nothing else may ride along with it;
- the same number never asks twice, and a number Reason already works for, has declined, or has
  blocked is not asked about. **Every accepted request gets the same `{"ok": true}`**, so the form
  cannot be used to find out whose number is a customer;
- the website may queue `REASON_WEB_ACCESS_PER_DAY` new numbers a day (30), then it is told `429`;
  the master is asked about at most `REASON_MAX_REQUESTS_PER_DAY` people a day (10) and
  `REASON_MAX_REQUESTS_PER_HOUR` an hour, one at a time. Whoever arrives over a ceiling waits and
  is asked about by the sweep when it lifts.

Because this person has never texted, three things differ from a first text. **They are sent
nothing until the master says yes.** The master's question says they asked on the website and
quotes nothing. And a no is silent: somebody who never texted is not sent a refusal.

One more thing a yes will not do: on the owner's subscription backend only the owner's test numbers
are answered, so "you're in" would not be true. The approval is kept, the person is not texted,
and the master is told why.

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

  **A tapback is never the whole answer to a question.** `react` asks the model one thing —
  `they_asked`, its own reading of whether anything in the message is waiting on a reply — and that
  reading is the one thing only the model can supply, because "can you look at this?" and "look at
  this 😂" differ by intent and not by any pattern worth matching. Code does not second-guess the
  reading; it holds Reason to it. A tapback on a question is the worst failure in this feature: it
  acknowledges somebody and ignores them in the same gesture, and it looks deliberate. So that
  tapback is **held**, not sent: the model is told to answer in words, and the held tapback then
  rides out alongside those words. Text wins and the tapback comes with it. A turn that held one
  and then said nothing sends neither — silence with a ❤️ on the question is worse than silence.
  The hold is parked on the thread row rather than in memory, so a crash mid-turn loses a tapback
  instead of leaving one armed for whatever the next reply happens to be. A missing reading is not
  defaulted either way: it is asked for again, because both defaults are wrong.
- **An effect** is one of the 13 Sendblue lists, and there are two ways to put one on a message.
  `mark_moment` puts it on **Reason's own reply**: called before the reply is written, it leaves the
  effect on the thread and the runtime spends it at the moment of sending — the same shape
  `reply_to` uses for a pin, and necessary for the same reason, since the reply is written by the
  model and sent by the runtime rather than by any tool. (This is what the live flow test found:
  told good news, Reason wrote a real reply, and an effect that could only ride on `message_send`
  had nowhere to go.) `style` on `message_send` is the same thing for a message sent with that
  tool. Either way the effect rides on the outbox row, so a message retried an hour later still
  goes out the way it was meant to and a failed send is retried like any other message. On a reply
  that splits around a link it goes on the part with the words in it, never on the bare URL.

  iMessage only: on an SMS thread the effect is dropped and **the message still goes** — a lost
  message is a far worse outcome than a missing animation. The prompt's rule is that an effect is
  for a real moment — the table finally confirmed, a birthday, the thing chased all week landing —
  never an ordinary reply, never twice in a row, never on bad news.

  **One effect per conversation per hour, enforced in code.** This is a product rule and not
  Sendblue's: their docs set no limit on `send_style` at all. It is here because *rare* is the whole
  of what makes an effect mean anything, and rare is not something a model can hold across a day of
  separate turns — each one looks, on its own, like the moment that earns confetti. So the model
  decides *whether* a moment deserves one and code decides *how often* one can happen. The count is
  read off the outbox rows that carried an effect, which is what makes it survive a restart: the row
  IS the record. Past the hour the text still goes and the effect is quietly left off, with the
  reason on the tool's result so Reason never claims an animation that did not play. An effect
  dropped for being on an SMS thread is not counted, so the next real moment still gets one.
  Capabilities says when the next one is available, so nobody gets promised confetti.

  Effects play when the message is **opened**, not when it arrives, so the words have to stand up on
  their own; the prompt forbids pointing at the animation ("watch this").

  Both a tapback and an effect get a row in the action ledger with a receipt in words. A tapback
  leaves no bubble behind, so that row is the only record that anything was answered at all, and
  "why did it do the confetti" is answerable months later from the moment the model named. A held
  tapback is its own outcome (`blocked`), and the one that later rides out with the words gets its
  own row.
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

**Both backends look at pictures.** On the `claude-cli` backend the picture is handed to the CLI
as an image block on its streaming JSON input, so the built-in tool that could open a file off disk
stays denied and a Reason turn still cannot succeed using Claude Code's tools instead of Reason's.
Until 2026-10-05 that backend handed the model no picture at all and answered every photo with "i
can't open photos on this setup" — which was the live Reason, on a real phone.

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

### How a reply arrives

A text thread draws no markdown. `**grind finer**` arrives as four asterisks, `## Grind` arrives as
two hashes, and a `| phone | price |` table arrives as pipes that do not line up. A reply is also
one bubble by default, so a prompt you were meant to paste comes wrapped in "here you go, just fill
in the brackets:" and press-and-hold copies both.

So three things are guaranteed in code on the way out, in `src/plain.js`, for every channel that
does not say it renders markdown — which is every channel Reason has:

- **No markers.** Emphasis, headings, inline code, fences and both markdown link forms come off.
  Tables become the same information as lines a person would say ("Pixel 9a / price: $499"). The
  rules are deliberately narrow, because the hard part is not the stripping: `report_final_v2.txt`,
  `2 * 3 = 6`, `a*b`, `snake_case`, `C#` and every emoji come out exactly as they went in, and a
  URL is never touched at all, because an underscore in an address is part of the address.
- **Anything to paste leaves as its own message, whole.** The model marks it with a plain fenced
  block; the fence comes off, the inside is untouched, and it is the only thing in that bubble. The
  words around it go out as their own messages either side, so press-and-hold copies the prompt and
  not Reason's lead-in with it. An unclosed fence is left as prose rather than guessed at — taking
  everything after it as pasteable would put Reason's own commentary inside the thing somebody
  pastes into another AI, which is the exact failure this is here to prevent.
- **A cap on bubbles.** Four, `REASON_MAX_BUBBLES`. Over it, neighbouring bits of prose are
  **merged**, never dropped. A link is not merged into anything, because a bubble of its own is
  what makes it tappable, and nor is something to paste. So the cap can sometimes not be met — a
  reply with three things to paste is four bubbles whatever happens — and in that case it yields:
  everything still goes out, in order, and the overflow is logged. Shipping five bubbles is a worse
  message; dropping the fifth is a worse product.

The ordinary reply has none of those things in it and is still exactly one message, byte for byte
as the model wrote it. A call summary travelling with its recording is the one thing that is never
split — it stays a single message carrying both — but the markers still come off its text.

**It does not reformat the answer.** No reflowing, no re-wrapping, no bullets invented out of
sentences, no sentences invented out of bullets. Writing the reply is the model's job, and the
system prompt asks for the same three things plus the layout itself: the answer in the first line
rather than a preamble, short paragraphs with a line of space between them, bullets only when the
points really are separate things, numbers only when the order matters, length matched to the ask,
and sections as the signal that it wants to be a page instead. The prompt is the polish and this
layer is the floor — a rule that only holds when the model remembers it does not hold.

Whether markers come off is **asked of the channel** (`rendersMarkdown` on the adapter) rather than
assumed. Sendblue answers no: `content` is plain text and there is no parameter that says otherwise
anywhere in its documented send payload. That Messages itself renders none of them is the one part
only a real iPhone can settle, and it is in `docs/unverified.md`.

### What they send: photos, voice notes, links

A message is not always words. A photo, a screenshot, a voice note, a file, a link — each is
handled as the thing it is, and each one leaves a row saying what was actually got out of it.

**A photo.** It is downloaded, checked for size twice (the header, then the real bytes), and
identified by its **magic numbers rather than its filename** — so a `.jpg` that is really an
iPhone HEIC is still converted. HEIC, BMP and TIFF go through `sips -s format jpeg` on the way
past, because an iPhone shoots HEIC by default and the vision model does not take it. The address
is validated and **re-validated at every redirect**, so a CDN link that redirects to `127.0.0.1`
is stopped at the hop. What cannot be read gets one honest sentence naming the reason, never a
guess. Both backends do this — the API path and the `claude-cli` one — because they call the same
code.

```bash
# nothing to install on a Mac: /usr/bin/sips is part of the OS
```

A picture is three things at once and Reason is told to keep them apart: what is in it, what you
told it, and what it is guessing. A car photo after "i'm thinking about buying a car" gets "is this
one you're looking at?", never "congrats on the new car" — and nothing a photograph does not
contain may be stated off one: not a model, a year, a price, who owns it, or that anybody bought
it. A reading off a picture never becomes a saved fact about you either: `remember` takes a source
and refuses anything but "they said it".

**A voice note.** Apple's `.caf` is converted (`afconvert`, or `ffmpeg` if it is there) and
transcribed by a model that takes audio (`GEMINI_API_KEY`). It arrives as the words in it and is
answered like any other message. Five states, all distinct, because they mean different things:
waiting, being worked on, transcribed, **no speech in it** ("that one came through silent"), and
could not be listened to, with the reason. `[inaudible]` means a stretch nobody could make out, and
the rule is to ask about that bit and only that bit — never to put in a word that would fit.

Their words are kept on the item, so "what did i say in that voice note" three days later is
answered from the record and not from Reason's memory of the conversation — the conversation's own
history only holds the last sixty messages. A note over thirty seconds keeps real timestamps; a
short one does not, because `[0:00]` in a twelve-second "running late" is noise. Length is measured
off the bytes of the WAV, so it is a fact rather than an estimate.

**A link Reason sends** goes out as its own message, with the words about it as the message after
it. One outbox row each, chained, so the summary is not even due until the link has been sent — and
if the link never goes, the summary does not go either, with a reason saying why. Sendblue
documents no rich-link parameter and App Cards need an Apple Team ID and an installed Messages
extension, so the URL goes bare and Reason is forbidden from promising a preview card, a title or a
picture of the page. Whether iMessage draws one is the phone's business; see
`docs/iphone-checklist.md`.

**The record.** Everything that was not words — every photo, voice note, file and link — is one row
with the message it came on, which one it was on that message, and what coverage was got out of it:
looked at, transcribed, no speech, read, watched, heard, metadata only, failed with the reason,
or dropped with the reason. `media_reviewed` is how Reason resolves "this one" and "the second
photo", and how it answers "did you really read that". A picture is in front of the model for one
turn and then gone, so its memory of having looked is not evidence and that row is.

One known loss, written down rather than hidden: a photo attached to a message whose text contains
a link is dropped as a link-card thumbnail, because the provider's payload has no field that tells
a thumbnail from a photo. It is recorded as a drop with its reason, so the record shows a photo was
eaten instead of it never having existed.

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
  party. `recording_url` is read only as the yes/no of whether a recording exists. That endpoint
  does not answer with the audio: it answers with JSON naming a second address
  (`https://api.bland.ai/v1/recordings/<id>`), which needs the key too. The pointer is followed
  once, and only when it is on Bland's own host. Whatever comes back is checked before it is filed
  — its content-type, its first bytes, and its size against the call's length — and a body that is
  not audio is a **missing recording**, reported as a fault, never a saved one.
- **The cost and the summary arrive a few seconds after the call ends.** Until Bland has priced a
  call its `price` is null, which is written down as "not known", not as $0.00; `call_status` goes
  back for both for up to a week after the call.

**No call has ever been placed through it.** There is no Bland key on this machine. Every one of
the 38 offline tests drives the adapter with an injected `fetch` and asserts on the exact URL and
request body; `docs/unverified.md` lists what that leaves unproven, which is everything that only
a real call can settle.

### Pages

Some answers are not texts. A gift shortlist with pictures and prices, three days in Lisbon, a
plan with sections — sending that as a wall of messages is worse than useless on a phone. So Reason
can make a **page**: a small web page you open from a link, keep, and come back to.

**How a page looks.** A page reads like a printed guide, not an app screen. One quiet column: a top line that scrolls away with the page ("Reason · Made for Omari · Oct 6" and a Private or Shared tag), a serif title at a regular weight, a one-line subtitle under it, then the blocks, then a grey closing line ("Written Oct 6, 2026. Start easy for the first two weeks.") and the footer. Headings get 48px of air above them and no decoration; tables, links and cards sit on hairlines rather than in shadowed boxes; nothing is uppercase except a table header. The same blocks are drawn the same way on every page: numbered steps one per row, plan rows (a bold name, a grey detail, a value on the right), callouts (a thin rule, a soft box, or a soft box with a red title for safety), a comparison table, picture cards with a price tag, tappable choices, and a source list. This came from putting a Reason page next to an Instinct "Files" page with the same gym plan on it (2026-10-06): theirs read calmer and had a block for everything, ours had a numbered list collapsing into one paragraph. It follows the phone's light or dark setting, uses only the fonts already on the device, and loads nothing from anywhere else, so opening a page tells no third party about it. The look lives in one place, `src/pages/render.js`; the model still supplies data only, never markup. Three things about it are now measured in Chromium at 390×844 rather than eyeballed on a laptop (`test/pages-phone.test.js`): the blank line the model wrote between two ideas is a gap a person sees, a three-column table fits the screen so no column hides behind a sideways swipe, and a long prompt in a copy block is capped so the page it sits on can still be scrolled past it. A four-column table of prose does **not** fit 390px and no wrapping makes it — that overflow goes into the table's own box and never drags the page sideways, and **the edge fades on whichever side there is more table**, so a hidden column says so instead of being a swipe nobody knows to make. The fade is four background layers rather than a script: two in the card colour that scroll with the table and cover two fixed shadows at the ends, so it appears only when something really is hidden, on the correct side, with nothing to keep in sync. A table that fits has no fade at all, and that is pinned by reading the pixels off a screenshot rather than a style rule. Still not seen on a real phone. The top line reads "Made for" and the person's first name, and says "for you" only when Reason has not been told a name. A person's name goes on their own account the moment they give it (the `my_name` tool), so pages, greetings and the master's list of accounts all use it.

- **It gives data, not markup.** The model picks from a fixed set of blocks — a heading, text, a
  picture, a comparison table, links, a row of cards, a question with options, numbered steps,
  plan rows, a callout, a piece of text to copy or download as a `.txt` (a prompt for another AI,
  a message, a bio) — plus a one-line subtitle and a one-sentence closing line that belong to the
  page itself, each capped at 160 characters — and Reason's own template draws the HTML. There is no block that takes HTML or a script, every string is escaped
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
(`signin_link`). The page shows you Reason's own browser, live, on that site's real sign-in page,
and you use it the way you use any website: **tap a box and your own keyboard comes up on it**,
type, and tap the site's own Continue or Sign in button. There is no toolbar and nothing to learn.
The site sees one browser the whole time, so the session it grants lands in your saved profile,
and Reason texts you what the site said. This is what makes sign-in work for people who are not at
the machine.

Underneath, a tap that lands on one of the site's text boxes puts a real input of your phone's own
over that exact spot, so the keyboard opens inside the same tap and carries the right hints: a name
box asks for a saved login, a password box asks for the saved password, and a verification code box
asks for `one-time-code`, which is what makes iOS offer the code straight out of Messages. What you
type goes into the site's box as you type it, so you watch it land where you tapped. When the site
shows a signed-in page, Reason notices and finishes on its own; there is still a button to finish
or cancel by hand, and a Back.

**Your saved password will probably not come up by itself, and the page says so.** A phone files a
saved login under the website's own address, and this page is on Reason's address, not Amazon's. So
the login is not offered automatically — you reach it in a tap or two through the **Passwords** key
above the keyboard, and the page tells you that before you start rather than leaving you hunting.

What that costs is said plainly, because it was decided with it in view: **on this path what you
type passes through Reason on its way to the site.** It is relayed and forgotten — never logged,
never stored, never put in a conversation, never shown to the model, and a test checks every table
and every log line for it. Nothing travels the other way either: the page is told where the site's
boxes are, what kind they are, what the site calls them and how many characters are in them, and
never a character of what is in them. No picture of the browser is kept. A password typed into a
*message* is still refused; that one stays in your messaging app for good.

If a picture cannot be fetched — a weak signal is the usual reason — the page says so in a sentence
and keeps trying. It never sits there blank, which is exactly what the first version of it did.

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

**Your own two limits, which you set and it asks for.** The daily one above is the *operator's*
safety net for the whole install. Yours are a per-purchase limit and a monthly limit, and there is no
default for either — a number Reason picked would be a limit nobody agreed to. So the first time
anything would really spend money, it asks, once, in one line:

```
Reason: before i spend anything — what's the most i should ever spend on one
        thing without checking with u, and what's the max per month?
you:    $200 a thing, and keep it under 1500 a month
```

Then the purchase that was waiting goes through on the yes you already gave: you are not asked about
it twice. `caps_show` answers "what are my limits" with both numbers, what is committed this month
and what is left; "raise my limit to $500" sets them again and keeps your words.

They are limits on what Reason may do **on its own**. Something over the per-purchase number, or
that would cross the month, stops and asks — *including* something you said not to ask about, which
is the one place a standing permission loses. With your yes it goes through, and the limit is
**unchanged**: saying yes to one purchase never raises a cap.

**A payment whose outcome nobody knows is never retried.** A commit that breaks after the button has
been pressed may have gone through — including the one that does not look like a failure at all,
where the connection drops and the browser shows its own error page. Reason records that the outcome
is unknown, says so in plain words, tells you to check your email or the shop, and asks. *Enforced in
code*: the same action is blocked until a yes given **since** that moment, which an older yes and a
standing permission both fail to be, and the block is checked before the gate so the first thing you
hear is that nobody knows rather than a request to approve it again. The ledger outcome is `unknown`,
not `error`, because those two lead to opposite next moves.

### What it may do without asking

A gate that asks once per action is right the first time and wrong the twentieth. Somebody who has
said *"you can reorder groceries without asking"* has answered the question, and being asked again
every Sunday is not caution.

So they can say it once and it is kept — **in their own words**:

```
you:    you can reorder groceries without asking, up to $80
Reason: got it — groceries under $80, i'll just do it.
        anything over that, or anything else, i'll check
```

What is saved is two different kinds of thing. Their sentence, **verbatim**, which is what goes on
every receipt and what gets read back to them. And next to it the narrow reading of that sentence —
which gated action, who or what for, up to how much, until when — which is the only thing the gate
compares against. The model reads the sentence; code enforces the reading.

- **`permission_grant`** saves one. **`permission_list`** answers "what can you do without asking
  me". **`permission_revoke`** takes one back, and the record of having granted it stays.
- **Nothing is stretched.** An action goes through without a yes only when a saved permission covers
  exactly that action, exactly that target and exactly that amount. A bigger amount, a different
  person, a different kind of thing: refused exactly as before, and the refusal **quotes what they
  had said and says why this is not it**.
- **It is never a way around a yes.** Permissions are consulted only when nothing was asked at all.
  A yes that is spent, stale, refused or pointed at somebody else is a question about that yes.
- **Money needs a number.** A standing permission that would authorize a charge and names no amount
  is refused when it is granted, rather than saved and then never applying. The limit is checked
  again against the total on the page, which is what would really be charged.
- **Two things can never be given away in advance**: deleting somebody else's whole Reason, and
  approving a risky action a builder on this machine asked to do.
- **Every action taken under one says so.** The receipt reads
  `No yes was asked for — under: "you can reorder groceries without asking"`, and Reason tells them
  it is done and that this is why. It never pretends it asked.

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

### What's new, mentioned in passing

When something gets built, the people already texting Reason have no way to know. So Reason tells
them — not as a changelog and not as a text out of nowhere, but as one short line on the end of a
reply it was already sending. "oh btw you can connect your gmail now", and that is all.

Two things have to be true before anybody hears about a feature, and both are checked in code
rather than left to the model (`src/whatsnew.js`):

- **Somebody has used it end to end on the live Reason.** Each entry carries a `verified` record —
  the day it was seen working and one sentence saying what was actually done. No record, or a record
  with the evidence left blank, and the entry is invisible to the model for everybody. A person adds
  that record by hand after using the thing themselves; it is not something a passing test can do,
  and `docs/unverified.md` has to have stopped listing the feature first. The file header is the
  checklist, and a test fails on a half-filled record.
- **It is live for the person being told**, read from the same `capabilities` the model gets. Saying
  "you can connect your Gmail now" to somebody whose Reason would then answer "not connected" is
  worse than saying nothing.

After that it is the model's call, because only the model can tell an upset message from an idle
one: the turn carries a note saying there is one new thing, what it is, and that it can go at the
end of this reply *if the moment suits* — in its own words, one line, skipped entirely if they are
upset, in a hurry, mid-errand or waiting on an answer. Code owns everything else. At most one thing
per reply and one per person per day; never on a turn where a confirmation is open; never on a
message Reason started itself (a timer, a watcher, a task, a dropped thread); and nobody is told
about something that was already there when they arrived.

**Marking it heard is honest.** The model calls `whats_new_said` when its reply really does say the
line, and that is a *claim*, not a record: the row is only committed once the reply has actually
gone out, the same way a yes is only spent when the action is really attempted. A turn that ends in
silence, a send that fails, or a crash in between leaves it unheard and it comes round again. If the
model leaves the line out, it says nothing and the thing waits — the cost of that is one more
chance, which is the right direction to be wrong in.

Asking outright works too: "what's new", "what can you do now" is answered from the same list
through the `capabilities` tool — verified, and live for that person — rather than from the model's
memory of this file.

Seeded with exactly one entry, **Gmail**, with no `verified` record — and it stays announced to
nobody even now that Gmail is built, because nothing has been sent to the real Google yet. That is
the gate working rather than a gap in it: "built" and "seen to work" are different claims, and only
the second is worth telling somebody about. It fills in once Omari has connected a real inbox and
read a real email through it.

### Their email

Each person connects their own inbox. Nobody gives Reason a password: they ask, Reason texts them a
link, they tap it and agree on Google's own page, and Reason texts back which address is now
connected. One Google connection covers their mail and their calendar together. Built from Google's
current docs, the documented way: authorization code flow redirecting to Reason's own listener at
`/google/callback` under `REASON_PUBLIC_URL`, the access token refreshed when it expires, and
revocable from the conversation. One person's mail can never be reached from another person's thread.

**As many Google accounts as they have.** A personal Gmail and a work Gmail, both on at once. "connect
my work email too" gets a second link; Google shows them the account chooser, they pick the other one,
and both are connected — tapping a link for an address they already have just refreshes that one rather
than adding a copy. "what's connected?" names every address. From there the rule is that reading looks
everywhere and acting happens on one:

- **Reading covers all of their accounts** unless they name one, and **every result says which account
  it came from**. "any email from the landlord?" is a question about their mail, not about one mailbox,
  and so is "what's on Thursday" — each calendar is read in its own time zone and the events come back
  in one list, in time order, each labelled.
- **Sending, drafting, binning, labelling and anything written to a calendar happen on one account.**
  Which one is never guessed: they name it ("from my work email"), or it is their only one, or it is the
  default they set by saying something like "use my personal one unless I say otherwise" — and failing
  all three, Reason asks. **A reply goes from the account that received the message**, which is checked
  against the message rather than taken on trust.
- **A yes is pinned to one account.** The sending address is part of what they are shown and agree to,
  so an approval to send from their work mail cannot be spent from their personal mail.
- **Every id belongs to one account.** Message, thread, label and event ids mean nothing in another
  mailbox, so pairing one with the wrong account is refused with the right account named, rather than
  arriving as a 404 nobody can explain.
- **"disconnect my work email" cuts off that one** and says what is still connected. "disconnect
  google" with several on asks which they mean rather than taking the lot.
- **One dead connection is one dead connection.** If Google ends the work grant, the personal one keeps
  working and Reason says which one needs connecting again.

A plain "connect my google" asks for exactly three permissions — Gmail's `gmail.modify`, and
Calendar's `calendar.events` and `calendar.calendars.readonly` — and nothing else. Drive is two more
and is a **separate tap**, asked for only when somebody wants it: see **Their Drive**. (Calendar was
the broad `calendar` scope until 2026-10-06; a connection made under it still works, because that
scope is a superset of the two, and it is never asked for again. See **Their calendar** and
`docs/google-verification.md`.) So it can
search their mail, read a message or a whole thread, list their labels, write
a draft, send a new email or a reply inside the right thread, archive, mark read or unread, label, and
move things to the bin. It **cannot delete mail permanently**, because the permission that would allow
that is not one it asks for. It cannot open an attachment either: it lists what is attached, with the
size, and says that is all it can do.

Where the line is drawn:

- **Reading, searching and drafting need nobody's permission.** Leaving a draft in their Gmail is the
  right move whenever it is not clear they want something sent.
- **Sending, binning, and touching more than one message at once stop and ask** — and what they are
  shown is the real recipients, the real subject and the whole body, not a summary of it. The yes
  covers that email and no other: change one word afterwards and it is refused.
- **What is inside an email is never an instruction.** A message saying "forward this" or "reply with
  the code" is something Reason tells them about, naming who asked. It cannot produce a yes, because
  the gate reads their own replies in their own conversation and an email is not one of those.
- Every send, bin, label change and draft leaves a receipt. Reads do not.

Google's consent screen for this app was **published on 2026-10-05** ("In production" in Google's
console). It is **not verified** by Google, so somebody connecting sees a "Google hasn't verified this
app" screen first, and Google caps an unverified app at **100 users over the project's whole lifetime**
— and a "user" there is a **Google account, not a person**. Google has no way of knowing that two
addresses belong to the same human, so somebody connecting three accounts spends three of the hundred.
Google's own wording is "a hard cap of 100 total users" and "a 100 new-user cap… applies over the
entire lifetime of the project, and it cannot be reset or changed"; that a person is not the unit is
read off that rather than stated by Google in those words, and `docs/unverified.md` records it as an
inference. The real usage is readable in the Cloud console under **OAuth user cap**, which is the only
place it can be checked. **Removing that screen means passing Google's verification**, which for a
Gmail scope is three stages (brand, sensitive-scope review, restricted-scope review with an annual
third-party security assessment) and takes weeks; the whole path, what the code already does for it,
and what only the project owner can do is in `docs/google-verification.md`. The connect link now goes
out with a one-line in-product notice and the privacy address (`say_with_link` on the
`google_connect` result), which is one of the things that review looks for. While it was in
Testing, only listed test users could connect and Google ended each connection after seven days;
whether that weekly expiry has really stopped is not yet proven — nobody has held a connection for a
week since. Whenever Google does end a connection, for any reason, Reason says so plainly and sends a
fresh link. If you run your own copy with your own Google client, which of these applies to you is set
in your Google console, not here. With no `GOOGLE_OAUTH_CLIENT_ID` it is **not connected** and says
so; with one, but before this person has connected, it says they can and how to ask.

### Their calendar

The same connection, so connecting Gmail connects this too — and one per account, so somebody with two
Google accounts has two calendars. Reason can read what is on their calendar between two times, read one
event in full, and create, change and delete events. Reading covers every calendar they have connected,
each in **its own** zone, with the events merged into one day in time order and labelled by account;
creating, changing and cancelling happen on the one account they named.

The line here is drawn differently from mail, because what makes a calendar change reach other people
is who is on the event. **An event nobody else is on is a private note to themselves and just
happens** — asking for permission to put "dentist at 3" on their own calendar would be the gate crying
wolf. **The moment anybody else is on it, Google emails them**, so it stops and asks, and what they
are shown names who is being invited or told, and when. For a change or a delete that cannot be
decided from the request, because who is on an existing event is a fact only Google has: Reason fetches
the event first and then asks, having changed nothing.

Times are read and written in **their calendar's own time zone**, fetched from Google on every call,
not the one the server happens to run in. An event an hour out is worse than no event.

**Nothing has been sent to Google** — every test runs against a fake server built from their
documented responses. `docs/unverified.md` says so test by test, including the two things a fake
cannot settle: whether a reply really lands in a real Gmail thread, and whether `sendUpdates` really
controls who gets an invitation email.

### Their Drive

"we should also make it such that users can connect their drive." Built 2026-10-06, on the same Google
connection and the same client — and the one thing worth saying first is that **it is a separate tap**.
Connecting Gmail did not connect Drive, and everybody who connected before this was built has mail and
calendar and no Drive. Reason says exactly that rather than reading an old grant as permission to go
through somebody's documents.

So "can you find my lease" from somebody with Gmail already on gets one line and one link: Google asks
them about their files on its own screen, they agree, and nothing they already had is touched —
**adding a permission never costs them the ones they already gave**, because the link carries Google's
`include_granted_scopes`, which their own docs say makes the new token cover everything previously
granted. Google's advice is to ask for a permission at the moment it is needed rather than up front,
and Drive is the example they use for it.

Three things it does:

- **Find a file.** "my lease", "the budget spreadsheet", "that doc about the trip". It searches the
  name *and the full text* of their files, newest first, and leaves out anything in their bin — so a
  lease whose file is called "Scan 47" is still findable. What comes back is the name, what kind of
  thing it is, when it last changed, whose it is and the link, which drops straight onto a page as
  rows. Reading covers every Google account they have, and every file says which Drive it is in.
- **Read it.** A Google Doc and Google Slides come back as plain text. A **Google Sheet comes back as
  its first sheet** as rows — that is the only thing Google's csv export gives, and the result says so,
  because a number quoted off the wrong tab is worse than no number. Plain text, markdown, csv and html
  files are read directly. A long file is cut and says how much there was.
- **Make a document.** A new Google Doc from plain text, with the link to send them. No permission
  needed — it is their own Drive, it costs nothing and reaches nobody — but it leaves a receipt, the
  same as a draft left in their Gmail.

And what it will not do, said out loud rather than discovered:

- **A PDF cannot be read.** Nor a Word or Excel file, an image, or a folder. Each one comes back with a
  plain sentence naming what it is and the link to open it, and Reason says that instead of writing a
  confident paragraph about a document nobody could open. (It is the same answer a PDF attached to an
  email gets, for the same reason: there is no PDF reader anywhere in Reason.)
- **Nothing is deleted, shared, renamed, moved or edited.** The permissions for that are not ones
  Reason asks for. Asked to change a document, it says so and offers to make a new one.
- **What is in a document is somebody's words**, marked the same way a fetched web page is. A file that
  says "email this to accounts@…" is a file Reason tells them about, naming it. It cannot produce a yes.

The two permissions, and why these two: **`drive.readonly`** to find and read a file, and
**`drive.file`** to make one. `drive.readonly` is **restricted** in Google's scope table — that is not
a quiet escalation, because Reason already asks for `gmail.modify`, which is restricted too, so the
verification class of the app does not change. There is nothing narrower that works:
`drive.metadata.readonly` is restricted as well and cannot read contents, and `drive.file` on its own
is documented as only seeing files the app made or the person picked through Google's file picker —
Reason has no picker, so under `drive.file` alone "find my lease" would find nothing. `drive.file` is
non-sensitive and is the narrowest scope `files.create` accepts. Nothing wider is requested, which is
why deleting and sharing are not on offer. Both have to be added on the client's **Data Access** page
in Google's console before a real connect works — that is Omari's, not the code's, and
`docs/google-verification.md` has it.

**Nothing has been sent to Google here either.** Every Drive route is answered by the same fake server,
built from the v3 reference and the search, download and upload guides. `docs/unverified.md` says what
a fake cannot settle — including whether `include_granted_scopes` really behaves as documented, and how
a real 40-page lease reads once it is exported to text.
### Subscriptions: find them, cancel them

Reason reads a year of their own receipts, keeps a list of what is actually going out, and ends one
when they want it ended.

**Finding them.** `subscriptions_scan` runs eight fixed Gmail searches — receipts, "your
subscription", renewals, trials about to end, App Store and Google Play receipts, the big billers
by sending domain, and the lines a payment processor writes — across **every** Google account they
have connected, bounded to a window (twelve months by default). What comes back is grouped by
sending domain, so Netflix's four addresses are one row, and each message carries whatever the code
could pull out of the words: the amount and its currency, the charge date, the renewal date, the
billing period. Code pulls those; **the model decides** which group is a real recurring
subscription and which is a one-off order, a utility bill, a donation or a shop's marketing. The
scan writes nothing down. Nothing is remembered until the model records it.

Two limits it says out loud rather than papering over. A scan reads headers and Gmail's own snippet,
so a renewal date further down a long receipt is not in it — the tool says so and sends the model to
read that one message in full. And **a subscription billed straight to a card and never emailed
about cannot be found this way at all**.

**The list.** `subscriptions` is a table, keyed per person and per merchant: amount, currency, how
often, last charged, next renewal, where it was read from, status, the cancel route, and the
confirmation. "What am I paying for" is read from it and never from memory. The monthly total
normalises a yearly price and **names what it could not count** — anything without both a price and
a billing period is listed by name, with the note that the real figure is higher. The overview goes
on a page: the list comes back with `page_blocks` ready for `page_create`, so the page and the table
cannot disagree about the money.

**How each service wants it done.** `src/cancel-routes.js` is a registry like `src/sites.js`, for
fifteen services. Per entry: the rail (`web`, `email`, `letter`, `device`, `phone`, `unknown`), the
cancel page's own address and whether the service actually publishes it, the documented click path,
**the exact label of the button that commits**, the notice rules, the fee for leaving early, what
counts as a confirmation — and the source URL with the date it was read and whether the page itself
came back or only its help text through a search index. Every one was read on 2026-10-06.

Four of the web entries do **not** document the label on their last button, and that is recorded as
exactly that rather than guessed. One entry — The New York Times — could not be read at all, so its
route is `unknown` and Reason says it does not know and offers to open the account page with them.

**Cancelling: three rails.**

| Rail | What happens |
|---|---|
| **web** | Checks they are signed in **by asking the service**, and if they are not, stops and sends them a sign-in link they open themselves. Never asks for a password. Then opens the cancel page, hands over the snapshot, and the model walks it like any page. The last press goes through `subscription_cancel_commit`, which needs their yes for the exact details on the final screen. |
| **email / written** | Reason drafts the request — code writes it, so it says who is asking, that an assistant is writing *for* them and not *as* them, and asks for a reference number and an end date. Shown in full, left in their drafts or sent with `gmail_send` after a yes. |
| **phone** | **Not built.** Reason says so and offers to ring them once calling exists. It does not offer a workaround. |

An App Store subscription lives in Settings on their own phone, which Reason cannot tap: it says the
four taps instead. Apple does document a web page, and it needs two-factor on a trusted device, so
that is recorded too — and recorded as something Reason still cannot drive.

**Nothing is cancelled until something confirms it.** This is the rule the whole thing rests on.
`subscription_update` refuses to set `cancelled` with no confirmation on it, and after a real press
Reason reads the page for a cancellation number or an "ends on" date — if the page gives neither, the
row stays `cancelling` and Reason says "it's in, waiting on their confirmation" rather than "done".
That one word is the difference between somebody stopping checking their bank and somebody being
charged again. `subscription_confirmations` looks for the service's reply in their mail and hands
back what it found; **it moves nothing on its own**, because a marketing email with the word "cancel"
in it matches the same search.

Every commit label in the registry is folded into the browser's click guard, so `browser_click`
refuses to press "Finish Cancellation", "Cancel Membership" or "Yes, cancel" — none of which
contains a word the generic guard was looking for, so every one of them would have gone through
unasked. Two services' last press is a plain "Continue" or "Cancel"; those are deliberately **not**
in the guard (a guard that treated every Continue on the web as irreversible would spend a yes on
turning a page) and are gated by the tool that presses them instead.

**"Just cancel it, stop asking."** A standing permission can cover the press, bounded to a merchant
— the target a cancellation carries starts with the merchant's name, so a permission for one can
never let another through. The exception, enforced from the registry: a service that charges to
leave early goes back to needing a yes of its own, with the fee named. A permission to cancel
something is not a permission to pay a fee.

**No real service has been touched.** The web rail is proved against a fixture service on
127.0.0.1 shaped like the pages the real help articles describe, with a sign-in and a two-step
cancellation; the mail runs against the same fake Google as the rest. `docs/unverified.md` has the
full ledger.

### A home page, a privacy policy and terms

Three public pages on the same listener, in Reason's own look:

| Route | What it is |
|---|---|
| `GET /` | A few plain lines about what Reason is, who it works for, and that it never asks for a password. Ends with links to the privacy policy and the terms and, when `REASON_SITE_URL` is set, a link to a fuller website about this Reason. |
| `GET /privacy` | What is stored, what leaves the machine, how to disconnect, and how to export or delete everything. |
| `GET /terms` | What Reason is, what it promises (asks before spending or contacting anyone, never pays by phone, never pretends to be you), what it does not (no warranty), and that you can leave with your data at any time. |

When `GOOGLE_SITE_VERIFICATION` is set, all three carry Google's `google-site-verification` meta tag,
which is how the home page's domain is proved in Search Console for brand verification; the value is
kept to token characters so it can never become markup.

Google requires the first two links before a consent screen can be published, which is why they exist,
and its reviewers read the terms alongside them. The
privacy page is written against the code rather than against intention — including the two things
somebody would assume were not true: **text from an email Reason read for you is in your conversation
transcript** (tool results are saved with the turn, and the transcript keeps the last 60 messages), and
**your conversation goes to Anthropic's API**, because that is the model that reads it. It carries the
Limited Use statement Google's API Services User Data Policy asks for.

`docs/unverified.md` lists every claim on that page and what in the code it was checked against, plus
the handful that are commitments about how the install is run rather than things code can enforce.

### Your data

```bash
npm run data:export > reason-export.json   # everything: pages, call recordings (base64), the lot
npm run data:export -- dm:owner            # one conversation
npm run data:export -- --no-audio          # the rows, without the recordings' bytes
npm run data:delete -- --yes               # wipe it, recordings deleted off disk too
```

A delete removes the audio files, not just the rows. An export carries the bytes inside it with
each recording's sha256, and says `missing: true` for any file the database claims to have but
cannot find. Both reach everything: the messages that arrived and their parts, the outbox, research
and what each source said, task steps, cached video transcripts, pages, memories, the ledger. An
export that quietly omitted a table would not be a copy of your data, and a delete that did would
not be a delete.

**And it does not wait to be asked.** Two settings, printed when `npm run serve` starts and
readable by Reason itself, so "how long do you keep my voice notes" has a real answer:

```bash
REASON_KEEP_CONTENT_DAYS=30    # the stuff itself
REASON_KEEP_RECORDS_DAYS=365   # the fact that it happened
```

*Content* is the words in a voice note, a page or video Reason fetched, the body of a message it
sent, a call's transcript and its audio off disk, and the running history of a conversation nobody
has touched since. *Records* are the much smaller rows that say something happened — a voice note
arrived on the 3rd and was transcribed; this provider id was already answered. Those hold no
content and are kept longer on purpose: delete a dedupe key early and a provider redelivering a
three-month-old message gets a second real answer out of it.

Content goes first and the record outlives it deliberately. A note whose words have been dropped
says so, with the date, so Reason answers "I had them and they were deleted" instead of claiming
nothing ever arrived — or worse, filling the gap from memory. `0` on either means keep forever,
which is what every install did before this existed.

Not swept: the ledger, the confirmations, what was spent. Those are the record of Reason having
been given permission, and a privacy sweep that erased the evidence of what it did with that
permission would be backwards. They go when you delete.

`--log` does not write your media into a terminal. Every long string in a tool call is cut to a
length and a count — `[5000 chars, not logged]` — which is a cap rather than a list of fields to
hide, so the next tool that returns something long is covered without anybody remembering to add
it. `REASON_LOG_CONTENT=1` turns it off for a session where the content is what you are debugging.

### Handing work to the builders on this machine

**Off unless you switch it on, and the master's alone even then.** This is the one feature that
lets a text message start a program on the computer Reason is installed on, so the default is that
it does not exist: no tool, nothing in the capability list, and `wont_do` still says Reason does not
write, run or ship code. Somebody who clones this repo and texts their own number does not get a
remote control for their laptop because a default was convenient.

```bash
REASON_REMOTE_BUILD=1                  # the switch. Nothing below it exists without this
REASON_OPENCLAW_BIN=openclaw           # the command that reaches the assistant on this machine
REASON_OPENCLAW_AGENT=main             # which of its agents to hand work to
```

With it on, the master texts what he wants built. Reason hands it over and comes straight back —
the build runs for as long as a build takes, as a detached child process that outlives Reason
itself, and he gets one short text and a link when it moves. He is not waiting on a reply and
neither is his thread.

```
him   build me a page that shows what the macro tracker ate this week
      → handed to a builder on this machine. i'll text you when it moves: <link>
      ...
      → it's done — the week view is up and it pulls real entries. i haven't checked it
        myself, that's what the builder says: <link>
```

Four things in it are deliberate, and each one is the answer to a way this goes wrong:

- **Nothing blocks and nothing is held in memory.** The builder appends one-line JSON to a file in
  its own run directory, and a one-byte sentinel says the turn is over. A Reason that is restarted
  or redeployed mid-build comes back, reads the sentinel, and picks the result up.
- **The channel is a file, not a port.** No token, no listener, nothing to leak and nothing to add
  to anybody's config. It runs as the same user on the same disk, so the file *is* the channel. The
  runner is a file too, not an `sh -c` string, and the only values written into it are generated or
  pattern-checked — everything the master or the model wrote travels in `brief.md`, which no shell
  reads.
- **Nothing claims to be finished unless the builder said so.** The state is read off what is
  really on disk, in code (`stateFrom` in `src/remote.js`), never from the model. A run that exits
  without saying it is done leaves the job *working*, with the honest headline that it replied and
  did not say it had finished.
- **Risky things come back to him as a yes or no.** Going live, deleting, pushing to main, anything
  outside the repository it was pointed at: the builder writes the exact action down and stops. That
  action goes through the same confirm gate as sending an email — the string he is shown and the
  string the yes is checked against are one string, so a builder that changes its mind between the
  ask and the yes gets a mismatch and has to ask again. There is deliberately no button for this on
  the page: the gate reads his own words in his own thread, and a tap on a web page is not his words.

**What a builder is told about him.** A builder that knows nothing about the person builds the
wrong thing and has to be asked twice, so Reason looks things up before it hands over — the plan
the job belongs to, the people in it, what he has said about the project before — and writes a few
lines into the brief. Only what the job can use: what the thing is for, who else it is for, taste
he has already shown, a constraint he has stated. Not his calendar, his mail, his money or where he
is. It arrives in its own section explicitly framed as background, because a builder handed
somebody's preferences with nothing around them reads "he likes short copy" as a thing to go and do.

The deal that makes that fair is the other half: **he sees exactly what went**, word for word, on
the job's own page under *What I told them about you* — above the fold, not in the technical
section, because "shown" has to mean he reads it rather than that he could have gone looking. It is
his data like the rest, so an export carries it and a delete takes it off disk.

Each piece of work gets a page at a link that does not change, built by code rather than by the
model so it says the same things in the same order every time — where it is, anything waiting on
him, his own words back, what it changes for him, how it went, and the commit hashes folded shut at
the bottom. There is one more page listing everything in flight, with whatever needs him first.

Progress chatter waits out a quiet window (`REASON_REMOTE_TEXT_GAP_MIN`, five minutes) and only
updates the page; something finishing, breaking, or needing an answer always goes straight out,
because those are the three things that are useless late. At most `REASON_REMOTE_MAX_LIVE` jobs run
at once — a ceiling rather than a queue, so the honest answer to "start six more" is that there are
already this many going.

A job's run directory holds the brief it was handed, which quotes the master's own words. So it is
his data like anything else: `data:export` carries the rows, and `data:delete` removes the
directories off disk as well as the rows.

## Where this actually is

Three honest buckets. Nothing is in the first one unless a test passes on it.

### Working today

All of this is covered by the offline suite — **1,467 tests, 1,427 passing, 0 failing, 40 skipped**.
The 40 skipped need a real model; they all pass through the `claude-cli` backend (see below), and
have not been run against the API for want of credit. The four newest of them are the tapback and
effect judgements, run on that backend on 2026-10-05.

- **An account per person**, fully separate, with the master approving each one by text — and a
  daily limit each, so nobody can run up the bill.
- **Plans.** Make one, change any detail, lock it, cancel it, mark it done. It tracks what is still
  open and will not lock while something is.
- **Reminders and timers** that fire real turns at real times.
- **Tasks that outlive a message.** Chasing someone, waiting on a reply, a multi-step errand. A row
  in the database with a goal, a next wake time and a progress log, so killing the process loses
  nothing. Reason only speaks about one when something actually changed.
- **Watchers.** Watch a page, come back when a specific thing changes on it.
- **Subscriptions.** Read a year of their receipts and come back with what is actually going out,
  keep the list, show it as a page with a monthly total, and cancel one — on the web with their own
  saved sign-in, or as a written request from their own address. Both behind their explicit yes, and
  nothing is ever called cancelled until something confirms it. See **Subscriptions** above.
- **Follow-ups.** When a plan with open questions goes quiet for hours, Reason picks it back up on
  its own — at most once per plan per day, twice per conversation.
- **Noticing things first.** It goes looking, every couple of hours, at a connected mailbox and
  calendar: a meeting that moved deep in a thread, a bill sitting unread, a reply somebody is
  waiting on. One unprompted catch a day, counted in the database, sent at the moment it is useful
  rather than in a batch, nothing in their night, and the three-question bar in front of all of it.
  See **Noticing things first** above. The judgement side has only ever been exercised with a fake
  model: whether its sense of "worth interrupting somebody for" is any good is in
  `docs/unverified.md`.
- **Memory about people.** Facts, preferences, who someone is; read it all back, or forget a person
  outright.
- **A real browser** it drives itself: open a page, read it, click, fill a form, screenshot. One
  profile per conversation so logins stick between turns. The final commit click always needs your
  explicit yes.
- **Photos, voice notes and links** — an iPhone HEIC converted before anything looks at it, a
  voice note transcribed and answered as the words in it, a link sent as its own bubble, and a row
  for every one of them saying what was actually got out of it. See **What they send** above.
- **A keep-by date on everything**, with an export that is a real copy and a delete that is a real
  delete. See **Your data**.
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
- **Gmail, per person and as many accounts as they have**, against a fake Google server built from
  their docs: a link each person taps, tokens stored and refreshed against their own conversation and
  their own address, reading across every account they connected with each result labelled, sending and
  binning gated on the real recipients, the whole body **and the sending account**, an email's own words
  treated as data and never as an instruction, and a dead connection reported as needing a reconnect rather
  than retried. Nothing has been sent to Google — the client id and secret are on the machine and have
  deliberately never been used. See `docs/unverified.md`.
- **Their Drive**, against the same fake: find a file by its name or by what is inside it, read a Doc,
  a Sheet (first sheet, and it says so), Slides, a text or html file, make a new Google Doc and send
  back the link. A PDF, a Word file, an image and a folder each get a plain sentence saying Reason
  cannot read that one, with the link. Nothing is deleted, shared or edited, because the scopes for
  that are not asked for. And **an existing Google connection is not a Drive connection**: Drive is its
  own tap, and asking for it adds a permission without costing them the ones they have. Nothing has
  been sent to Google. See **Their Drive** and `docs/unverified.md`.
- **A message Reason starts reaches the phone.** A reminder, a task's news, a watcher or a
  picked-up thread goes to the thread that conversation lives in. Until 2026-10-05 these had no
  channel and were printed into the server's log instead — written, recorded as said, and never
  texted. `src/deliver.js`, pinned by `test/deliver.test.js`.
- **Inline replies**, both ways: a reply pinned under the message it answers, a refused pin that
  falls back to an ordinary message instead of losing it, and an inbound reply that arrives saying
  which message it was sent under. Never sent to a real phone — see `docs/unverified.md`.
- **Telling somebody what's new, in passing.** The gates are code's: nothing unverified is ever put
  in front of the model, nothing is mentioned that is not live for that person, one thing per reply
  and one per person per day, never while a confirmation is open, never on a message Reason started,
  and never to somebody who arrived after the feature did. Marked heard only once the reply really
  went out. What no test can prove is the part the model owns — whether it actually reads the moment
  right and writes one casual line rather than a pitch. See `docs/unverified.md`.
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
- **Handing work to the builders on this machine** — **one real hand-over has run end to end**, and
  that is the whole of it. 59 offline tests cover the switch, the master-only gate, the brief, what
  is read back off disk, the states, the pages, the quiet window and the delete; none of them start
  a process. On 2026-10-05 one real job was handed to a real `openclaw` session against a scratch
  data dir: the detached runner started, the builder read the brief and appended `progress`,
  `detail` and `done` lines in the shapes it was asked for, the sentinel landed with exit 0, the
  reply parsed out of the real envelope, the state settled to `done` from what the builder wrote,
  and both pages built. So the path works once, for a one-step job.

  What has **not** been run: a job long enough to be swept while mid-turn, a builder asking a
  question and the answer getting back to it, a risky action going through the gate to a real
  builder, two jobs at once, a restart mid-build, and the text itself (no channel is connected on
  this machine). Every state and page for all of those is offline-tested and none of them is proven.
- **Cancelling a subscription.** The registry in `src/cancel-routes.js` was read off fifteen
  services' own help pages on 2026-10-06 and **not one of those flows has been walked**. No account
  here has ever been cancelled and nothing in Reason has ever pressed one of those buttons: the web
  rail is proved end to end against a fixture service on 127.0.0.1 (a sign-in, a retention offer, a
  two-step cancellation, a confirmation number), and the mail rail against the fake Google. What a
  fixture cannot settle is whether Netflix's page still says "Finish Cancellation", whether any of
  these sites will talk to an automated browser at all, and whether a retention wall sits somewhere
  the registry does not know about. Four of the entries do not document their last button and say
  so; one could not be read at all and is `unknown`.
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
| **Handing work to the builders on this machine** | `REASON_REMOTE_BUILD=1` plus an [OpenClaw](https://github.com/openclaw/openclaw) install on the same machine (`REASON_OPENCLAW_BIN`, `REASON_OPENCLAW_AGENT`). Off by default on purpose and the master's alone even when on — see **Handing work to the builders on this machine** above. With it off there is no such tool and nobody is told one exists; Reason still writes code for anyone who asks, it just has nobody to hand the running of it to. |
| **Texting** | Sendblue: `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (or, superseded, Linq: `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_FROM_NUMBER`), plus `REASON_OWNER_NUMBER` set to your own number and a webhook subscription pointed at your host. |
| **Phone calls** | A [Bland](https://app.bland.ai) account, then `REASON_CALL_PROVIDER=bland` and `BLAND_API_KEY`. Their published Start-plan rate is **$0.14 a connected minute**, free to sign up; `REASON_MAX_CALLS_PER_DAY` and `REASON_MAX_CALL_MINUTES_PER_DAY` are what stop one person running that up. Optional: `BLAND_FROM_NUMBER` (without it Bland dials from its own pool), and `BLAND_WEBHOOK_SECRET` from their dashboard so the call-finished webhook is verified by signature rather than only by the unguessable token in its URL. With no `REASON_PUBLIC_URL` there is no webhook at all and outcomes are polled, which Bland's own docs call the right answer rather than a workaround. `docs/call-providers.md` compares the alternatives. |
| **Web search, and therefore research** | `TAVILY_API_KEY`, from [app.tavily.com](https://app.tavily.com). **1,000 API credits a month, free, no credit card** (their docs, read 2026-10-05). A basic search costs 1 credit, so that is about 1,000 searches a month, and one research run spends up to 5 of them — roughly 200 questions a month on the free tier. Past it: **$0.008 a credit** pay-as-you-go, or $30/mo for 4,000. Reading the pages afterwards is free (a plain fetch, not a Tavily extract). Without it, `capabilities` says search is not connected, `research` refuses rather than guessing, and Reason reads a page whose address it can name itself and says that is all it did. Brave Search is the alternative and is **not wired**: its free tier is $5 of monthly credit on a billing plan. |
| **An iPhone photo (HEIC)** | Nothing on a Mac — `/usr/bin/sips` is part of the OS. **On Linux there is nothing to supply:** the conversion is sips and has no fallback, so an iPhone photo is refused honestly rather than read. |
| **Listening to a voice note** | `GEMINI_API_KEY`, plus `/usr/bin/afconvert` (part of macOS) or `ffmpeg` on the PATH — on Linux that means installing ffmpeg. |
| **Videos at all** | Nothing but `yt-dlp` on the machine (`pipx install yt-dlp`, `brew install yt-dlp`, or the standalone binary), or `REASON_YTDLP_BIN` pointed at it. No key, no account. It is what fetches a video's details, its captions and its audio, so with it missing there is nothing Reason can find out about any video — and the tool and `capabilities` both say so. |
| **Watching a video, or reading one with no captions** | `GEMINI_API_KEY`, from aistudio.google.com. Per Google's docs (2026-10-05): a video is ~100 tokens per second at default media resolution, audio is 32 tokens per second, so on `gemini-3.8-flash` at $0.75 / M input that is roughly **0.45 cents a minute to watch** and **0.14 cents a minute to listen**, plus output. Free tier capped at 8 hours of YouTube a day. Public videos only. Capped at `REASON_VIDEO_MAX_MINUTES` (60) a video and cached per video and tier. No ffmpeg needed. Without it, a caption-less video comes back saying there is no way to know what is in it, and Reason says that. |
| **Payments** | `REASON_PAYMENTS_KEY`. |
| **Gmail and Calendar** | A **Web application** OAuth client from the [Google Cloud console](https://console.cloud.google.com/auth/clients), with the Gmail and Calendar APIs enabled on the project: put its id and secret in `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, and add `{REASON_PUBLIC_URL}/google/callback` to its Authorized redirect URIs, exactly — scheme, case and trailing slash all have to match. **No refresh token goes in `.env`**: that was the old shape, from before each person had their own Reason, and one refresh token there would mean everybody who texted reached the same inbox. Each person taps the link Reason sends and agrees on Google's own page, and their refresh token is stored against their conversation **and the address Google reported for it**, so one person can connect several Google accounts and each keeps its own grant. While the consent screen is in Testing, only listed test users can connect and Google expires each connection after 7 days. Published and unverified, the cap is 100 **Google accounts** over the project's lifetime, not 100 people — see **Their email**. |
| **Google verification (no "unverified app" screen)** | Nothing in `.env` makes this go away: it is Google's review of the project, done in the Cloud console by the project owner. The code side is ready — public home, privacy and terms pages, the Limited Use statement, the narrowest scopes, an in-product notice with every link, and `GOOGLE_SITE_VERIFICATION` for Search Console. What is left is a domain the owner controls (the Tailscale name counts as Tailscale's), Search Console, a demo video, the scope justifications, and for Gmail a paid annual security assessment. Step by step in `docs/google-verification.md`. |
| **Google Drive** | The same OAuth client, plus **two scopes added on its Data Access page** — `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/drive.file` — and the **Drive API enabled** on the project. Google rejects an app whose code requests a scope not declared there, so until those two are on the page a Drive connect fails at Google's own screen rather than here. Nothing goes in `.env`: the code side is built. Then **each person taps a Drive link of their own** — connecting Gmail does not connect Drive, so everybody already on needs one more tap, and nobody has to redo their mail. `drive.readonly` is a **restricted** scope, which is the same review class Gmail already put this app in, so it changes the verification work not at all; `drive.file` is non-sensitive. See **Their Drive**. |
| **Spotify** | A developer app from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard): put its id and secret in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and add `{REASON_PUBLIC_URL}/spotify/callback` to the app's Redirect URIs. Then each person taps the link Reason sends and approves on Spotify's own page. Playing, pausing, skipping and queueing need Spotify Premium. |
| **OpenTable, Uber, Lyft, DoorDash, Uber Eats, Amazon, Delta, United, Ticketmaster, Fandango** | You, signed in once yourself: `npm run signin -- <site>` opens a real window, you sign in, you close it. Reason never sees a password. **Six of the ten refuse an automated browser today** — see "Saved sign-ins and real sites" above for which. |

Picked, and genuinely not started: Reason's own email address, real bookings and checkouts
with the exact total approved, group texts with polls, decks, and plug-in apps.
`docs/features.md` has the agreed order under **Decided 2026-10-04**.

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

**A standing permission is their sentence, and it is never widened.** When somebody says "you can
reorder groceries without asking", that sentence is stored word for word next to the narrow reading
of it — one action, one target, one ceiling — and the reading is the only thing the gate compares
against. *Enforced in code* (`src/permissions.js`, called from the gate in `src/tools.js`): a bigger
amount, a different person or a different kind of thing is refused exactly as it was before, a
permission is consulted only when nothing was asked, two actions can never be pre-authorized at all,
and every action taken under one leaves a receipt quoting the sentence that allowed it. What the
model does here is read the sentence; what code does is refuse to let the reading grow.

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

There is also a shorter one: **it does not run, ship or deploy code.** No terminal, nothing
executed, no repositories, no pull requests, no deploys. Not a missing integration, not planned —
Reason is not becoming a coding agent. The `capabilities` tool keeps this and the payment rule in a
`wont_do` list, separate from the things that are merely not connected, because "I can't do that
yet" and "I don't do that" are different answers.

**Writing code is not on that list, and used to be.** The rule read "write, run or ship", and an
entry that names only the near side of a line gets read as the whole subject: somebody asked for a
*prompt* to build an app and was told "writing a prompt to build an app counts as coding work, and
code isn't something i do". That is a refusal to do prose, which Reason does all day, and it makes
the real no look arbitrary. So the line sits where the missing thing actually is. Reason writes the
prompt, the spec, the snippet, the config, the query, the README, the copy, the build plan, and
reads an error or a snippet you paste and tells you what is wrong with it.

Two things carry that. Anything meant to be **taken away goes on a page with a copy block** — a
`Copy full …` button, a `Download .txt`, and the text itself — because a forty-line snippet in a
message bubble cannot be copied whole, which is the only reason anybody asked for it. And Reason
**says it has not run any of it**, every time, because it has no way to: untested code reads exactly
as confident as tested code, and this is the easiest place in the product to break the rule that
nothing is claimed to work unless it was checked. For the owner, when something really has to be
run, there is a builder who can (above); for everybody else that is simply the part Reason cannot
do, and it says so.

### The confirm gate, in detail

- **The gate reads meaning, not words.** What a reply means is decided by a separate narrow model call that sees only the action as described and the owner's answer, verbatim — no history, no tools, a forced `yes`/`no`/`change`/`unclear` verdict. Word lists cannot do this job: "no problem, book it" is a go-ahead, and "ok but make it 9 instead" is not, though it reads as a yes to any substring match and would book the 8:00 that was just rejected. A reply that approves but moves any detail comes back `change`, which authorizes nothing and sends Reason back to ask again with the corrected summary. Anything the judge cannot read — an error, a timeout, an off-schema answer — is `unclear`, and `unclear` never grants. Code still owns every fact a model cannot be trusted with: that a real new message arrived after the ask, single use, expiry, one action per yes, and the owner's exact words on the record.
- **A receipt for everything.** Every action that touched the outside world writes an append-only ledger row: what was attempted, what came back, when, and which yes authorized it. "What did you do today?" is answered from that table.
- **Nothing is faked.** A provider with no credentials on this machine reports `not_connected` and names the exact variables that are missing. An app that has been *chosen* but has no code behind it also reports `not_connected`, and says that nothing is built for it — credentials for an integration nobody wrote do not make it work, and `connectable` would be the quiet overclaim this registry exists to prevent. Trying to connect one is refused rather than recorded. `/accounts` shows what Reason can reach; `account_revoke` cuts it off with no second confirmation.

## Layout

```
src/agent.js     the brain: system prompt + tool loop (Claude via the Anthropic SDK)
src/tools.js     tool schemas, input validation, guards; the only way state changes
src/accounts.js  whose Reason is whose: admission, account state, per-person caps
src/access.js    asking for a Reason — by text or from a website's form — and the master's yes
                 or no read through the gate
src/trust.js     the confirm gate, the action ledger, the connected-accounts registry
                 (including the apps chosen but not built, so nothing claims to work)
src/permissions.js  standing permissions: their sentence kept verbatim, the narrow reading of it the
                 gate compares against, and the two actions that can never be pre-authorized
src/whatsnew.js  the announceable features and the two gates on them: a verified record somebody
                 filled in by hand, and the capability being live for the person being told
src/notice.js    noticing things first: what their calendar and mail say that slipped, the one-a-day
                 budget, their quiet hours, the moment a catch is worth sending, and the gate every
                 unprompted line goes through. Code decides when to look and how often to speak;
                 the model decides what is worth saying
src/db.js        SQLite (node:sqlite): conversations, plans, timers, tasks, people, calls,
                 threads, watches, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + the sweep: timers, tasks, watchers, dropped threads,
                 what finishing something sets in motion, and the watchful look at mail and calendar
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

**A photo from a real iPhone camera has never reached Reason as a HEIC.** In the one live run,
Sendblue delivered it as a JPEG — so the conversion path has only ever run against fixtures, and
the thing it exists for is unproved. Nor is it known whether a bare URL draws an iMessage preview
card, or whether two sends a fraction of a second apart arrive in that order on the device. Those
and the rest are a list to work through on a real thread: `docs/iphone-checklist.md`.

## Keeping this file honest

**Standing rule for this repo: every commit that changes what Reason can do also updates this
README, in the same commit.** Not afterwards, not in a cleanup pass. The README is the only place
somebody can find out what is real without reading the tests, so a commit that moves the line and
leaves this file behind has made the project less honest, whatever it added.

What it has to keep current: what Reason does today, what is built but unverified, what is not
connected and what you must supply by name, how to run it, and the rules it keeps. Nothing goes in
the "working today" list that has not passed a test. If something is built but unproven, it goes in
the second bucket with the reason — and into `docs/unverified.md`, test by test.
