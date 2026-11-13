# Reason

Your personal concierge. It handles what you hand it (looking things up, errands, calls, reminders, follow-ups, plans with your friends) and talks like a person.

MIT licensed. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

Which is why **a messy goal is the input, not a well-written prompt**: "sort my drive out" is a complete
ask. Reason works out everything it can work out on its own, does that part, and comes back with one
short question about the decisions that are genuinely the person's — never a list of questions, and
never a request to word it better first. Every new person is told so in their first message, "what can
you do" says it, and it is a rule in the system prompt, so saying it and doing it cannot come apart.

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

- it sweeps on an interval — timers that fire, standing **check-ins** coming round again, **tasks**
  it is working on, watchers re-checking a page, plans that went quiet with questions still open;
- it listens on `http://127.0.0.1:8787` for inbound channel webhooks (`POST
  /channels/<name>/webhook`) and answers `GET /health` with what is really running;
- it starts cleanly with no credentials at all, and says what is missing rather than pretending.

A **reminder** is a real turn at a real time, and it is spent once its message is in the outbox and
not a moment before: a turn that throws or times out leaves it due, it is tried again on the next
sweep (three tries, `REASON_TIMER_MAX_ATTEMPTS`), the reply goes out under a key belonging to that
reminder so retrying cannot text twice, and if it still cannot be got out you get one line saying a
reminder was missed and what it was.

A **check-in** is the standing version of that, and the thing an assistant is actually for: "check in
with me every monday about the job search", "remind me every day at 7 to work out", "every weekday
morning ask me what's on", "every two weeks ask if I've invoiced". One row holds the arrangement —
what it is about in Reason's own words, the rule, your zone, where the rule has got to — and **every
firing is an ordinary reminder** pointing back at it, so everything in the paragraph above is still
true of each one. Nothing schedules "the next one" in response to a firing; the sweep looks at the
rows and arms one for any live series that has none, so a process that dies between a firing and the
next one loses nothing and two overlapping sweeps cannot both arm the same Monday.

It **tracks from what you say back**. The first thing you say after a check-in is kept as the report —
by code, inside a day, not by the model — and the next check-in is handed it, so Monday opens "last
monday you said two applications were out, any replies?" instead of the same sentence every week.
Three things are code's rather than the model's: the maths is walked in local days, so "every monday
at 9" is 9 o'clock on both sides of the clock change and "every month on the 31st" skips February
rather than inventing a date; nothing fires between 23:00 and 08:00 where you are unless you named
that time yourself; and three Mondays with the laptop shut produce **one** check-in, for the newest.
"Stop checking in about that" ends one, "pause the workout reminders" holds it, and a bare "stop"
with more than one running gets asked which. Ten per person (`REASON_MAX_SERIES`, 0 for no limit),
counted in the database. `src/series.js`, pinned by `test/series.test.js`.

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

**It remembers *why*, not just what.** "I want to move" is one job. "I want to move to save money"
and "I want to move for a shorter commute" are two different jobs out of the same five flats, and
before this the difference lived in one sentence that got trimmed out of the model's context after
sixty messages — so the fifth flat came back ranked the way the second one was, with a confident line
on top of it. A stated reason is now its own row (`why_note`): the subject, the goal in their terms,
and **their own sentence, verbatim**. It is kept apart from facts and from preferences on purpose — a
fact is what stays true about somebody, a preference is a reading of a no, and a reason is what they
are trying to achieve, which is the thing that decides what comes *first*. It outlives the task it
was said on and arrives on the sheet of every later job, with the instruction to rank by it and to
say so in one short clause ("cheaper, since you said this is about saving") rather than a paragraph
explaining somebody's own motives back to them.

Two rules on it are not the model's to bend. **A reason has to be quoted**: `why_note` refuses one
with no sentence behind it, because the failure this can otherwise produce is Reason inventing a
motive, sorting five options by it and sounding certain. And **a correction supersedes rather than
overwrites**: the new reason stands, the old row is kept pointing at the one that replaced it, and
the old wording is taken out of the thread and out of anything Reason already said — so "you told me
this was about money" stays checkable after they have moved off it. It is a goal and never a
permission: nothing learned this way lets Reason spend or send anything, and the gate has never read
that table.

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

**Reason checks its own work, and "done" has to be earned.** Four things fail quietly and all four
turn the person into quality control, so each is a refusal before anything leaves rather than an
apology after it (`src/verify.js`): a link is fetched and must answer 2xx; a total is refused when
they asked for fees in the number and the line quotes a price without them; a message or a call
aimed at somebody is checked against the people the job actually names, so the broker from the
other errand is never the one who gets texted; and a page is rendered and read back through the
same code the server uses before its link exists anywhere — one that comes out broken is taken away
again, and a change that would break a page they can already open is rolled back. The fee and
recipient checks run inside `confirm_request`, before the owner is shown anything, because a yes
covers the number and the name they were shown.

`task_finish` then refuses `done` three ways: while a step it asked them about has never actually
gone through (that "done" would mean "started", which is the lie they cannot catch without doing
the work themselves), on a link in the closing line that does not open, and on a total that still
does not show the fees. An ask with no task named on it still holds that task back, so forgetting
to name one is not an escape; a *refused* ask does not, because a no is a real answer. `failed` and
`cancelled` are never checked for any of that — an honest close must never be the blocked path.

**When it fails, it hands back the furthest point it got to.** Omari's line: "like a filled-in
checkout that just needs your tap or a ready draft, never a plain 'couldn't do it'." The failure is
not really a failure, it is a hand-off that never happened — a booking driven to the last button
with the name and number already in it, sitting in a browser on the machine, one tap from done,
reported as "couldn't get that booked". So the job's sheet carries a `furthest` record: what was
reached, the shape it is in (a filled form, a ready draft, a partial result, a browser sitting on
the right page), a link if there is one they can open, what is already filled in, the **one** thing
left for them to do, and why it stopped — from a fixed list, so "it didn't work" is never the
answer. Append-only, like the steers; the newest is what gets handed back.

Three parts of that are code's, not the prompt's. A job that got anywhere — options gathered with
the page each came from, prices found, terms read, a decision taken, a page or a draft it made —
**cannot** be closed `failed` or set `blocked` with none of it handed over; one `task_update`
clears it, and the refusal names that call. A job that produced nothing is refused nothing, because
there "couldn't do it, and here is what I tried" is the honest answer. A link on a hand-back is
fetched before it is written down and a dead one is refused, because a link that 404s stops them
believing the part that was true. And when a browser walk stops — at the commit click the gate will
not press, or on a step the site refuses — the address it reached and the fields already filled are
read **off the page** and written to the sheet by code, so the record does not depend on the model
remembering to write it at the one moment it is about to write a message instead. A password box is
never recorded and a value shaped like a card number is recorded as filled with the digits
withheld. The link is handed back as the page it is and never as the form it is not: what was typed
into a box is in the DOM and not in the URL, and code says which of the filled fields the address
really carries. The open-work page shows the point on a stuck job, with the link as a link. What
code cannot do is make the reply lead with it — see `docs/unverified.md`.

**How hard it is checked is how much it costs to be wrong.** Holding a lunch suggestion to a
lease's checks is its own failure: somebody who gets interrogated about a sandwich stops asking.
So the job's sheet carries one mark the model sets — `low`, `money` or `binding` — and code reads
it to decide how deep the check before `done` goes. `low` is a lunch spot or a quick fact: the
open-ask check and the links, and nothing else. `money` adds the fee check. `binding` is a lease,
a contract, a flight, and it adds the two things that only matter when nobody can walk away: the
**actual document** has to have been read and written down on the sheet — not a summary page about
it — and a price the job closes on has to have the page it came from on the sheet. An unmarked job
is treated as `money`, which is exactly what every job got before the mark existed, so the mark
makes nothing stricter by default: `low` has to be asked for and so does `binding`. A pass now
comes back with what **was** checked and what could not be, separately, because "the link opens and
there was no total to check" and "everything was checked" are different things to be told.

**An approval has to say what is being approved.** "Shall I proceed?" is a question somebody can
answer yes to without having agreed to anything, and the yes is just as real afterwards. So
`confirm_request` refuses, in code, an ask that does not carry what would happen — reading the
**structured fields** and never the wording, because judging the sentence would mean a model that
writes vaguely gets a wider yes. The action has to be something the gate really stops: a yes
collected for a tool that needed no yes is refused outright, since being asked to approve things
that need no approval is how somebody learns to say yes without reading. Anything that reaches a
person, or that commits on a site, has to carry its target — without one the yes is tied to nobody
and could never have authorized the send, so asking at all was a question with no answer. And the
one tool that can really spend money, on an ask that says money is involved, has to name a figure
somewhere in what the person would be shown. Each refusal lists exactly what is missing, and
nothing is asked and nothing is recorded while any of it stands.

How hard the thing is to take back now comes back with the ask as well, out of a table **code**
owns rather than from anything the model claimed — a text that has landed cannot be unsent, a
booking can be undone but not for free, connecting an account is a switch they can flip back — with
the line to put in front of them.

**A conflict is noticed before it is acted on.** "Cheapest flight" from somebody who once said
never basic economy is two instructions that cannot both be honoured, and quietly picking one is
the failure: they find out at the gate, having never been asked. So `conflict_check` writes the
collision onto the job's sheet and Reason asks which wins in one line with the tradeoff in it. The
row **holds the job**: nothing that spends, books, sends or commits goes through while the question
is out, because with it unanswered there is no version of going ahead that is not Reason deciding.
A conflict has to be against something really written down — a constraint on the sheet, an option
they turned down, a saved fact — so an invented one cannot become a stall. `conflict_resolve`
takes their own words, writes the answer onto the sheet as a constraint of theirs, and the same
collision is refused if it is ever raised again.

**Changing their mind is cheap.** "Forget the trip" should cost one sentence, and the expensive
version is worse than it sounds: somebody who has learned that changing their mind is a
negotiation stops saying it, and starts letting Reason finish things they no longer want. `let_go`
stops everything running for the jobs named — the job, its reminders, its watchers, the questions
it was about to ask — each with a ledger receipt, and quotes their own words on the receipt for the
whole never-mind. It comes back as **two lists**. *Stopped* costs nothing and gets one line of
acknowledgement. *Already committed* is what really went out, is **not touched**, and carries the
cancellation terms **the job wrote down** — or an honest "not written down on this job", because a
cancellation cost Reason invented is the number somebody would decide on. Nothing committed is
undone without a yes. A partial is just naming fewer jobs, and what was left alone comes back so
Reason can say it is still on. A never-mind for something that was never running says exactly that.

All of it is a lookup, not a guess: the task id goes onto a timer, a watcher, a confirmation and a
ledger row at the moment each is made, so none of it depends on the model remembering what it
started four hours and sixty trimmed messages ago. What is not tied is not claimed — a held
heads-up is only swept up when the timer it was scheduled on belongs to one of these jobs, and
nothing anywhere is matched on words.

**More than two open jobs is a page, not a wall of bubbles** (`activity_page`). Reason does not
write that page: every block on it is built in code from the task rows, so it cannot say a job is
running when the row says it finished. What is waiting on *them* is at the top, because it is the
only part they can act on; then a job each, with what really happened read off the progress log,
where it has got to now, and what they already ruled out folded shut; then what finished in the
last couple of days, which is what makes it answerable for "did that ever happen". It keeps one
link per person — the page is updated in place — so a link sent yesterday shows today. Throwing it
away is allowed and the next one is an honest new link.

**When a thing takes longer than a reply**, they are never left wondering whether it started. The
first thing out is one short line — what Reason is doing and roughly when they will hear back, as a
range rather than a promise ("on it, checking airbnb for nov 25-27. back in a few min"), with any
assumption it is working under said out loud. Then quiet: a progress line goes only when it carries
news — a finding that changes what they might want, a decision only they can make, a blown
estimate, a block — never a step narrated, never a line whose only content is that it is still
working. The result leads with the answer, says how fresh and how sure it is, and ends on the next
step; a stall says what was tried, what blocked it, what IS done and what is not, and offers one or
two real ways forward. Those are the model's manners, in the prompt. Three things are code's:

- **A late result lands under the text that asked for it.** A task keeps the handle of the message
  that started it, and anything said on its behalf hours later — the result, the one nag that its
  question is still open, the honest give-up — is pinned there once the thread has moved on, with
  the wake told to open with a few words of orientation ("back on the airbnb thing:"). A text that
  is still the last thing in the thread is just replied to; nothing is threaded for the sake of it.
- **A job's wake waits for their morning.** A task falling due in their quiet hours is put off to
  the first waking quarter hour, uncounted, unless they are plainly up — a text from them, or the
  job itself started, in the last two hours. What this holds back is the job that has outlived the
  conversation; a thing asked for at 11pm is a thing they are waiting on at 11pm.
- **A turn that dies says so.** The model call failing, the CLI hitting its ceiling, a tool throwing
  past every catch — all of it used to end as a typing bubble that simply stopped. Now it ends as one
  line of code's own, honest about the one thing code can check: whether anything had already gone
  out before it broke.

### What it has kept for you is part of the moment

The thread the model reads is trimmed to the last few dozen messages, and a guide Reason wrote for
you last night is forty messages back by the next evening. So on every turn *you* start, Reason is
handed one line of what it has kept for you: the pages it has made (title and the link that opens
on a tap, newest first, at most eight) and the reminders it has set and not yet sent (at most six,
soonest first). Titles and links only — what is on a page stays on the page. The note is true of
that turn and is not written into the thread, so a page deleted tomorrow is not still listed by a
copy of yesterday's note. An event turn — a timer, a sweep — is not your moment and carries none of
it.

What it is for: "Workout", eight minutes after Reason's own 7pm nudge, should get "want the back
guide or the shoulders one? here's back: <link>", not "go get it 💪" and nothing else (2026-10-06).
Two rules in the prompt go with it: a short message minutes after a text Reason sent is about that
text until proven otherwise — "about leaving" after a workout nudge means the workout, and "for
what?" when its own last line is the answer is the worst version of forgetting — and what it has
kept is offered in one line with the link when the moment touches it, never recited as a list and
never offered as a list. Replayed once against the real model: "About leaving" after the nudge got
*"nice, have a good one 💪 if today's a back day, here's your back guide: <link>"*.

The same incident showed the other half: the watchful sweep hands the model several kilobytes of
unread mail to make one decision, and that whole block was being written into the thread, where it
sat between the nudge and the reply to it for the next forty messages. The thread now keeps **one
line** for a sweep or a digest — that the look happened and how many things were in front of it —
and the model is still shown the whole frame on the turn it is deciding. Both backends do all of
this; the one the live Reason runs on (`claude-cli`) builds its own prompt and had been carrying
neither the open-work sheets nor what was kept, which is why a note only the API path knew about
was a note nobody got.

**A conflict is noticed before it is acted on.** "Cheapest flight" from somebody who once said
never basic economy is two instructions that cannot both be honoured, and quietly picking one is
the failure: they find out at the gate, having never been asked. So `conflict_check` writes the
collision onto the job's sheet and Reason asks which wins in one line with the tradeoff in it. The
row **holds the job**: nothing that spends, books, sends or commits goes through while the question
is out, because with it unanswered there is no version of going ahead that is not Reason deciding.
A conflict has to be against something really written down — a constraint on the sheet, an option
they turned down, a saved fact — so an invented one cannot become a stall. `conflict_resolve`
takes their own words, writes the answer onto the sheet as a constraint of theirs, and the same
collision is refused if it is ever raised again.

**More than two open jobs is a page, not a wall of bubbles** (`activity_page`). Reason does not
write that page: every block on it is built in code from the task rows, so it cannot say a job is
running when the row says it finished. What is waiting on *them* is at the top, because it is the
only part they can act on; then a job each, with what really happened read off the progress log,
where it has got to now, and what they already ruled out folded shut; then what finished in the
last couple of days, which is what makes it answerable for "did that ever happen". It keeps one
link per person — the page is updated in place — so a link sent yesterday shows today. Throwing it
away is allowed and the next one is an honest new link.

### Noticing things first

Everything above waits to be pointed at something. This is the one pass that goes looking.

Every couple of hours, for anybody whose mail and calendar are connected, Reason reads their next
two days and the mail since it last looked, and asks whether anything slipped: a meeting that
**moved deep in a thread**, something new or cancelled on the calendar, somebody new added to an
event, a **bill or an appointment** sitting unread with a date on it, and **every unread email from a
person** since the last look — newsletters and machines kept out by their headers, never by their
words — each carrying its age and whether they have ever written to that person. Whether any of it
matters today is the model's reading, not a subject-line filter's. Then one short line about the
single best of them, or nothing. The one-time "what hours suit you?" question does not count as that
line.

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
- **If they already handled it, there is nothing to say.** Before anything is raised, Reason checks
  the **live** mailbox and calendar: a reply they already sent, a bill they have already opened, a
  meeting that has moved *again* since. A handled thing produces no text at all and does not even
  cost a model turn. Checked twice — when it is found, and again when a parked catch comes due hours
  later, which is where staleness really lives.
- **Not sure is said as not sure.** When a check cannot settle it — a read that failed, a thread
  that would not answer — the doubt travels with the thing, the line has to be worded as the
  uncertainty it is, and code **refuses to let it be called urgent**. Reason does not manufacture
  urgency out of something it could not confirm.
- **One nudge per thing, then it waits.** A reply still unanswered after another day is not another
  licence to text about it. Reason raises a thing once and then leaves it alone; what re-opens it is
  **them** saying something, not another day passing.
- **Three modes, in their own words** (`notice_mode`). *Timely* is the default — the moment it
  matters. *Digest* keeps everything for **one batched line** at an hour they pick. *Off* means only
  ever answering when asked, and the **looking stops too**: reading somebody's mail every two hours
  to say nothing about it is not what they agreed to. Plus "snooze for today", which expires on its
  own so nobody has to remember to turn it back on. The model reads which one they mean, and their
  sentence is kept word for word.
- **"Stop" is honest about what it cannot take back.** The catches Reason had parked are really
  cancelled; the reminders **they** set are not, and are named back to them — turning initiative off
  was never a request to cancel their own alarms. And it is a real stop: not even urgent gets
  through it.
- **None of it is permission.** How often Reason may interrupt them is a different question from
  what it may do for them. No initiative setting lets it spend their money, send mail as them or
  book anything; those need the same yes they always needed.
- **Health, carefully.** A reminder is only ever a schedule **they** gave or confirmed — never one
  worked out from a prescription or a refill mail. Something that looks overdue it may *ask* about
  in one line. Never book it, and never name a dose back to them.
- **Nobody is assumed.** The first time there is anything to watch, Reason asks **one question** —
  your zone, and the hours you are happy being texted in — and never asks again. Until they answer it
  runs on a guess and says so out loud. Afterwards their zone beats the one read off their calendar,
  which is what travelling and still getting quiet hours where you actually are looks like.
- **Two lines on somebody you are about to meet** (`meeting_brief`). A meeting with somebody they
  have never emailed gets the **offer** of a brief, in one line they can answer with one word. The
  brief itself is written from **their own** threads and their own calendar, with every claim
  carrying its source — and anything looked up publicly has to bear on the meeting, never be a
  profile of the person.
- **Honest about it.** `notice_status` is the truth of what is being watched, how often, what was
  said, what was noticed and *not* said, what it noticed and found **already handled**, and how much
  of today is left, so "why haven't you told me anything" has a real answer. With nothing connected
  the line is "i'm not watching mail or calendar for you", not a promise to keep an eye out.
- **Their call.** "text me less", "stop unless it's important", "check more often" are saved on
  their account (`notice_settings`). **None at all is a real answer and it is kept** — then nothing
  goes out on its own, ever, and what Reason notices only comes up when they text. How many a day is
  a different question from how much initiative, and the two are kept apart.

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

One thing sits in front of all of this on Sendblue's **free shared line**: a text from a number
without a verified-contact route is dropped by Sendblue before it exists — no webhook, no row in
their message log, nothing for Reason to decide about. So on that line a stranger cannot start the
flow below by texting; the route has to be made first, by hand or from the Sendblue dashboard
(`POST https://api.sendblue.co/v3/verified-contacts {"phone_number": "+1…"}`, with the same two key
headers). It comes back `pending`, nobody can text them until it is `verified`, and the only thing
that verifies it is their own first text to the line — which then arrives as their first message and
runs as normal. A paid line has no such gate. `docs/unverified.md` has what was seen.

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
The small model (`REASON_HEAR_MODEL`, gemini-3.5-flash-lite) listens first and the big one
(`REASON_HEAR_FALLBACK_MODEL`, gemini-3.8-flash) is the fallback; videos keep `REASON_VIDEO_MODEL`.
A first model that is busy, over its limit, broken, or does not answer in time is not asked again:
the other model is the retry. One attempt waits ten seconds plus two for each second of audio
(never under fifteen, twenty when the length is unknown, never over `REASON_HEAR_TIMEOUT_MS`).
The usual case is one quick answer from the small model; a short note that neither model can
hear is given up on after two attempts (about 30–40 s), where it used to be four.
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

**Coming the other way,** a message you send as an inline reply reaches Reason with the thread it
was sent in quoted in front of it — the message the thread started with and what was said in it
since — so "that one" and "yeah" mean something. The thread's first message is what it goes by,
because the "parent" Sendblue names on a reply has pointed at the wrong thread on a real night. A
reply under a message there is no record of says exactly that, and Reason asks rather than guesses.

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
is kept is a line saying it was looked at, that it is not in front of Reason now, and how to see
it again. A stored image would be resent on every later turn in the thread.

**A photo is written down, and can be brought back.** Two things outlive the turn a photo arrived
on. First, a note: alongside the turn, a second quiet pass (`src/looked.js`, on a fast model —
`REASON_CAPTURE_CLI_MODEL`, default `sonnet`, on the claude-cli backend; `REASON_CAPTURE_MODEL`,
default `claude-sonnet-5`, on the API) writes down what the photo shows and every word legible
in it, verbatim — a form's questions, a
receipt's lines, a screenshot's error — and that note is handed to every later turn for a day as
the recent-photos note. Second, the picture itself: `photo_look` re-fetches the stored link (same
checks, same size ceiling, same HEIC conversion) and attaches the image to its result, on both
backends, for as long as the link lives. Until 2026-10-13 the only note was Reason's own chat
reply cut to 500 characters, and there was no way back to the picture: a photo of a caregiver job
form got "want me to answer all 8?", then one turn later "I can't see the photo anymore, and I
never wrote down the exact wording — can you send it again?" Both halves were true. The prompt
now says never to ask for a picture again, and that a photo of a form with blanks on it is a brief
to fill in, not a thing to offer to fill in (`test/flow-form.test.js`, real model).

**Both backends look at pictures.** On the `claude-cli` backend the picture is handed to the CLI
as an image block on its streaming JSON input, so the built-in tool that could open a file off disk
stays denied and a Reason turn still cannot succeed using Claude Code's tools instead of Reason's.
Until 2026-10-05 that backend handed the model no picture at all and answered every photo with "i
can't open photos on this setup" — which was the live Reason, on a real phone.

**Two texts seconds apart are one thought.** Reason used to answer the first half of a message
before the second half arrived — "which ones? looks like the rest of your message got cut off" to a
text whose link was pasted a second later. Now an arriving message waits a short quiet window
(`REASON_BURST_QUIET_MS`, 2.5s; a Reason Web message, which arrives whole, waits
`REASON_BURST_QUIET_WEB_MS`, 0.5s) to see whether more is coming; each new text from the same person
restarts the window, and everything that landed runs as **one** turn, in order. A hard ceiling
(`REASON_BURST_MAX_MS`, 8s from the first text) answers somebody who never stops typing. A burst
costs one turn off the day's allowance, not one per text, and a lone message is never held longer
than the window.

Held messages are **rows**, so a process that dies two seconds into somebody's burst loses nothing
— the next one's sweep finds them past their ready time and answers. Two people texting at once are
two bursts. The "…" bubble goes up when the first text lands, so it is showing *while* they are
still typing, and comes down only after the reply has gone. `GET /health` shows what is being held
and whether it is due. Set `REASON_BURST_QUIET_MS=0` to turn holding off entirely.

**Every reply writes one timing line** (`reply_timing`, src/replytiming.js): milliseconds for each
stage — the burst hold, voice notes heard, the prep, the queue, the memory lookup, pictures and files,
the notes, the history anchor, the tool server, the model run, the said check, a rewrite, the send,
and the total. Numbers only; never a word of the message or a figure from it. It is how the 11-11
slowdown was taken apart: 2.5 s of hold, ~0.5 s of memory lookup, 11–18 s of model depending on
whether the history anchor was a cache hit, ~2.6 s of said check, ~0.5 s of send.

**`REASON_FAST_REPLY`** (`off` default | `owner` | `on`; src/fastreply.js) is the reply-speed pass of
2026-11-11. The model is handed the same bytes in the same order; only the clock changes. Behind it:
the history anchor is *fitted* when the system prompt plus the whole window would pass the argument
limit (the oldest lines that fit are anchored, the rest ride in the message) instead of dropped — on
11-11 the drop (`history_anchor: too_long`) happened on 30 owner turns, each ~3.6 s slower in the
model and writing 40k tokens of cache against 15k; anchors are written to `data/cli-anchors.json` so a
deploy does not make the first turn of every thread write the whole history again; the turn's CLI is
spawned before the memory lookup and the notes are in and reads its message off stdin once they are
(its boot overlaps them); the said check is skipped when no tool acted and the draft shares not one
figure or content word with anything standing, closed or declined (`said_check_skipped`); and the
background lane (extraction) stays paused through the check and the send, not only the model's run.

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

**The words around a link keep the paragraphs they were written in.** Pulling the URL out leaves the
prose either side of it to be rejoined, and that join used to collapse every run of whitespace,
newlines included — so the message that goes with a page, the longest one Reason routinely sends,
arrived as one unbroken slab. Spaces and tabs still collapse; a blank line the model wrote stays a
blank line. A link on a line of its own separates two blocks and they stay two blocks, while a link
inside a sentence ("grab it at …/a before friday") is closed up with a space, because a blank line
there would break the sentence in half.

**A blank line between numbered steps**, which is the one piece of spacing decided here rather than
left to the model. Steps that run straight into each other are a paragraph with digits in it, and on
a phone you lose your place in them — eight jollof steps, several of them wrapping onto three lines,
is what showed it. The rule is one line: a step with a non-blank line above it gets a blank line put
in, which spaces the list and also separates it from its lead-in, and does nothing at all to a list
already written with space. Bullets are deliberately left tight, because a three-item bullet list
reads fine as it is and spacing it out makes a short answer look long. Nothing inside a fenced block
is touched, so a numbered prompt somebody pastes elsewhere arrives exactly as written.

**It does not reformat the answer.** Beyond that spacing: no reflowing, no re-wrapping, no bullets
invented out of sentences, no sentences invented out of bullets. Writing the reply is the model's
job, and the system prompt asks for the same things plus the layout itself: the answer in the first line
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
it. The one exception is words that end on a colon ("Privacy policy:", "here's the page:"): they are
pointing at what comes next, so they go first and the link goes under them, rather than leaving a
bubble that ends on a colon with nothing below it. One outbox row each, chained, so the summary is not even due until the link has been sent — and
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

#### What a real call is actually like

Most of a real phone call is not talking to the person you wanted. Hold music, a menu, a receptionist
who transfers you, a voicemail box, a line that drops the second after somebody says "yes, you're
booked". A call that handles none of that is a demo, so each of these is built and each is a thing the
code decides rather than a thing the model is asked to remember.

**Waiting.** Reason judges from what it hears that it is on hold and answers with the platform's own
`skip_turn` — stay silent, keep listening. Code does the clock: every consecutive `skip_turn` is hold,
the first time it speaks instead the hold is over, and when the budget runs out
(`REASON_CALL_MAX_HOLD_SECONDS`, **5 minutes by default**, overridable per call) it rings off with a
polite line. That is its own outcome — "nobody came to the phone in time" — and **not** a failure and
**not** "could not reach them", because it did reach them and that changes what you do next. The clock
is ours on purpose: no voice has hold detection, and a silence timer measures silence, which hold
music means never arrives.

**Menus.** It listens to the whole menu before pressing anything, then sends DTMF. Their own docs say
some phone systems miss in-band tones, so a key that gets no reaction is re-sent once; a third press is
refused and Reason speaks instead, which is what gets a human on most menus anyway. Prose where a key
sequence should be presses nothing rather than being salvaged into one — stripping the invalid
characters out of "press 1w1 now" yields `1w1w`, a pause nobody asked for, pressed into somebody's
phone system.

**Somebody different on the line.** When a receptionist puts the call through, the context survives:
Reason catches the new person up in one sentence and keeps everything already settled, rather than
starting over. And it **says the announcement again** — that person has not been told they are talking
to an AI on a recorded call. The disclosure belongs to the person, not to the call. (A hand-over back
to somebody who already heard it discloses twice; that is deliberate. Over-disclosing costs a sentence,
under-disclosing means a human who never knew.)

**Exact details, both ways at once.** A booking is read back before it counts, and the two halves pull
against each other, which is why `src/calls/readback.js` exists. Spoken: "Wednesday the fourteenth of
October at three in the afternoon, Eastern Time", "a hundred and eighty dollars" — no digits, because a
voice reading "15:00" aloud is the failure. Written: `2026-10-14T15:00` with its zone, `18000` cents,
the reference character for character. A confirmation number is read back **and spelled** ("K as in
kilo"), because B and D are the same sound down a phone line. "Tuesday at 3" is not an agreement until
both the date and the zone are clear, and a detail Reason could not make out **blocks** the agreement
rather than being guessed through — it asks them to repeat it, or to spell it.

**What it may agree to.** Asking what is available is not permission to book. A call carries a brief
(`src/calls/brief.js`) whose `book` is false unless somebody deliberately set it, and `propose_commitment`
refuses on that basis — not because the prompt says so. Inside what you approved it goes ahead. Outside
it — a deposit, a cancellation term, a price over the ceiling, anything — the commitment **pauses**:
Reason tells them it has to check, texts you the exact difference mid-call, and acts on your answer. If
you do not answer, **the call ends having agreed to nothing**, and the summary says that rather than
saying it failed or saying it was done.

**A machine is not a person.** On a call to anyone but you, the line opens silent: Reason hears what
answered before it says a word. A recorded message, a phone menu, hold music or a mailbox gets no
"hi, I'm an AI assistant…" — Reason stays quiet, presses the key that reaches a person when the menu
offers one, waits within the hold budget, and hangs up at once when the recording says nobody can be
reached by phone (keeping what it said, like an email address, for the recap to you). The disclosure is
said by code, word for word, in front of its first words to the first person who actually picks up.

**"It worked" has to be earned.** The outcome is a closed set
(`src/calls/outcome.js`): `confirmed`, `answered`, `voicemail_left`, `no_answer`,
`dropped_before_confirmation`, `line_silent`, `refused_by_them`, `needs_owner`, `hold_gave_up`,
`could_not_understand`, and for machines `machine_menu`, `machine_recording`, `machine_dead_end`,
`voicemail_full`, `voicemail_no_message`. Exactly one of them is a success, and `confirmed` is unreachable without a
read-back **and** their yes. The word you see is derived from whether that evidence exists, never from
how the transcript reads — "great, I'll get that sorted for you" is a warm, cooperative, completely
non-committal sentence, and a summary written from the feel of a call says the table is booked. Where a
confirmation rests only on somebody's word, you are told that too: "confirmed on the call only — no
reference and nothing in writing" is a different claim from a reference, and you can see which you have.

**Never twice.** Before any redial, `src/calls/redial.js` asks one question: did this already happen? A
number with something already agreed at it is not called back to agree again, one voicemail per number
ever, and the retry limit is `REASON_CALL_MAX_RETRIES` (**1** by default, so two attempts). The case it
exists for is the dangerous one: a call that dropped right after "you're booked" has an honest state of
*nobody knows*, so the next call is **not** the same call again — that is how somebody gets two tables
and two charges. It is a different goal, booking switched off: ring back and **ask whether it went
through**.

**Ringing back.** A call hands out `TWILIO_FROM_NUMBER` when a busy place offers to return the
call. When they do, Reason recognises the number as that errand continuing and gives them the
third-party context — the goal, the approved facts, the rules, the announcement — rather than the one
polite line a stranger gets. Never an owner call, whatever the caller id says.

#### One request, several calls

"Find me the cheapest place that can do it this week" is one request that happens to need six phone
calls. `call_errand_start` makes it one thing (`src/calls/errand.js`), and three properties follow that
no single call can have:

- **The same questions.** They live on the errand, so the sixth call cannot ask a thinner version than
  the first — the failure that turns a comparison into apples and oranges while every individual call
  looks fine. The standard six: full price including fees, anything extra, what is included, what is
  not, earliest availability, and **how long the quote holds**.
- **Firm or an estimate**, kept as a column. "About two hundred" and "two hundred" are different
  promises, and a place that would not pin it down is `unknown`, which is neither.
- **At most one commitment.** Several inquiry calls run at once
  (`REASON_CALL_MAX_PARALLEL`, **3**); bookings are serialised behind a single-row claim in SQL, and
  that is not a setting. Two places both being told yes is the failure the whole area exists to
  prevent, and "read the column, see it is empty, write it" has a window in it that is exactly this bug.

What comes back is already in the shape to send you: who was reached and who was not, each price,
firm versus estimate, and **the tradeoff named** — there is no field called "best", because "best deal"
silently meaning the lowest advertised number is the thing this is written to prevent. A place that
never quoted is reported as having no price, never sorted to the top as though it were free.

> I reached 4 of 6 places.
> - Clean Co: $180, Thursday — firm, good until Thursday · cheapest
> - Bright: $210, tomorrow — an estimate
> - Maids4U: they answered the questions, no price
> - Dustbusters: could not reach them
> - Shine: left a voicemail
>
> Cheapest isn't automatically best here: Bright could do tomorrow for $210.
>
> Want me to book one?

It ends on a question when there is a decision, because committing is yours.

**Not at half eleven at night.** `REASON_CALL_QUIET_HOURS` (**21:00–08:00** by default, on the clock of
the person being called) holds calls to other people; your own phone is never held by it, because a call
you asked for at midnight is a call you asked for. A call the window stops is **reported** to you, not
silently dropped: Reason says what time it is there and offers to place it at the first allowed time.
"Call now anyway" places that one call, and you can set your own hours (or none) by saying so.

Every number in this section is a **default I chose, not a finding** — max hold, how many calls at once,
retries, quiet hours, languages. They are all one line in `.env`, and
`src/config.js` has the reasoning beside each. Budget
(`REASON_CALL_MAX_ERRAND_CENTS`) is deliberately unset: the existing daily caps are the only ceiling,
and inventing a money number was not mine to do.

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

#### Reason itself on the phone

Bland has a voice of its own, handed a prompt once. The real provider does not: **GPT-Live over a
Twilio number** (`src/calls/gptlive.js`), where GPT-Live is only the voice — it listens, speaks and
hands every question and action to Reason (client delegation into `src/calls/voice.js`, in process),
so every word that matters is a Reason turn. Which means calls go **both ways**: people can ring the
number and talk to their own Reason, with their memory, their open jobs and their tools.

`REASON_CALL_PROVIDER=gptlive` plus `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER` and `REASON_PUBLIC_URL` is the whole of turning it on; the number's Twilio voice
webhook points at `/calls/gptlive/inbound`. Until they are there, `capabilities` reports calls not
connected, by name, because telling somebody they can call you when they cannot is the failure that
tool exists to prevent.

```
POST /calls/gptlive/inbound         the number's voice webhook: who is ringing, and the stream TwiML
POST /calls/gptlive/status/{tok}    one call's Twilio status (/amd/{tok}: its machine verdict)
WS   /calls/gptlive/stream/{tok}    Twilio Media Streams, relayed to the GPT-Live session
```

All Twilio-signed. Four things there are code rather than prompt:

- **Which call a turn belongs to is read off the database, and the kind of call off `is_owner`.** The
  request carries its own claim about which it is; that claim is read only to *disagree* with, and a
  disagreement is refused. The gap between the two readings is the gap between a restaurant hearing a
  goal and a restaurant hearing somebody's calendar.
- **The third-party context has no way to reach a thread.** Not a prompt saying "do not mention their
  messages": `thirdPartyContext` never loads a conversation, never loads memory, and returns an empty
  tool list. A call to a restaurant with `calendar_add` on it is one prompt injection away from a
  restaurant changing somebody's week. The test for it reads the context rather than a model's answer.
- **A URL is never spoken.** Any web address in what the model wrote is taken out of the words and
  queued as a text *during* the call, so "I'm texting you that now" is true at the moment it is said.
  "H t t p s colon slash slash" is not a link anybody can use.
- **A call joins the conversation that number already texts.** A conversation id has the channel in
  it, so admitting a caller under the call provider's name would hand them a second, empty Reason — no
  memory, no open jobs — and send the text ten minutes later somewhere else. A number with no account
  is a stranger: one line, the call ends, and the master is asked exactly as for a first text. The
  day's call and minute caps count a call that came IN, because a cap that only covers calls Reason
  places is a cap somebody can get round by dialling in.

Two more things follow from a phone being a phone. **Text streams at a sentence boundary** — which is
both what lets a whole web address be found (one split across two deltas could not be) and the unit a
speech engine wants, so the first sentence leaves before the last is written. And **a tool round gets
the `"... "` filler** rather than dead air, with far fewer rounds allowed than a text turn: nobody is
holding a handset during a text.

**The harm screen runs on a call too** (`src/harm.js`), because a phone is another way in and the
screen that reads every text lives in the runtime, which a voice turn does not go through. On an owner
call it reads what was just said; a refusal throws the reply away *unspoken*, says the refusal line,
ends the call, and counts the strike exactly as a text does — enough strikes pause that person and
queue the master the count and the kinds, never the words. A crisis says the help line, lets the reply
follow it, and ends nothing. It is **raced against generating the reply** rather than run before it:
both start at once and nothing is spoken until the screen has answered, so the first word costs the
longer of the two rather than their sum. On a text nobody is waiting; on a phone somebody is holding a
handset. A third-party call is not screened — no thread, no memory, no tools, and Reason is the one
asking.

Reason **switches language when the other person does**: the model answers with the line's
`language_detection` tool as a standard function call, so the switch and the reply happen together. The recorded-call announcement is spoken again in the new language the
first time it changes — the only language somebody has heard "this call is recorded" in must not be one
they do not speak — and exactly once, with a switch to the language already in use dropped in code.

After hangup the transcript is **written into the person's own thread as turns**, so a text ten minutes
later carries on from the call. Not for a third-party call — the restaurant is not in that conversation
— and not for a voicemail, because nobody was on it and filing one would tell the owner their message
was heard by a person. A call placed as a step of a job writes its outcome onto that job's log.

`REASON_CALL_BACKEND` is which backend answers a voice turn: empty means whatever the rest of Reason
uses, `api` pins the API path for calls alone. It exists because a phone turn cannot wait on a headless
CLI start while the rest of Reason may still be running on the subscription.

**A voice on the right number is not proof of who is holding the phone.** Caller ID says *whose*
Reason to be; it does not say who is calling, and a number can be spoofed. So ordinary conversation on
a known number is exactly as it was — no friction at all — and the **first** thing on a call that
spends money, books something, sends to somebody else or changes state takes one more step:
`REASON_CALL_PASSPHRASE` said out loud, or, with that unset, a yes to a text Reason sends to that same
number, which somebody not holding the phone cannot answer. Once per call, and in front of the
ordinary confirm gate rather than instead of it. What counts as consequential is the permission
system's own `GATED_ACTIONS` rather than a second list that could drift from it, plus
`confirm_record` — which is how a spoken yes *becomes* a granted confirmation, and so is exactly the
thing that must not be grantable by whoever happens to be on the line. A wrong passphrase gets "that's
not it" and no hint; two wrong ones and the call falls through to the text.

**He can ask it, mid-call, to go and ring somewhere else.** The errand is taken down while he is still
talking, read back before anything dials, and then the dial is a decision **code** makes from a
persisted row — who may ask, that the recipient is the one that was reviewed, that nothing changed
since the read-back (his yes is tied to a hash of it), that no request is already open to that number
and that nothing is already agreed there. It goes out through the ordinary `call_place` on a
confirmation row recording what the spoken yes was for, so every cap, quiet hour and never-twice check
stays on it. He is told which state it is in, in words — *preparing, dialing, on the call, paused for
your word, done* — and a queued request is never described as a finished call. A conference or a
bridge is never offered, because nothing has verified the platform can do one.

**And a call that cannot load its own context says so.** The database, the system prompt, the tool
registry, memory and open work are all things a context build reaches, and any of them failing used to
be a 500 — which on a live call is dead air from a line that has already said hello. Now his call gets
a turn with no thread, no memory and **no tools at all**, told to say plainly that it cannot reach his
things and to offer the two options that are true. The empty tool list is the enforcement: a turn that
cannot read what it is allowed to do cannot book, send, agree or invent a commitment. A third-party
call gets no degraded turn — its context *is* its brief, so with none loaded there is nothing safe to
say to a stranger, and it gets one honest line and hangs up.

Which **voice** a call ran under (`gpt-live-1/marin` by default) is written on the call row, so a
latency or naturalness figure measured later says what it was measured under.

Offline tests drive the provider with an injected `fetch` and the voice turn with a scripted generator. `npm run rehearse:calls` plays two
scripted calls — somebody ringing their own Reason, and a restaurant that answers in Spanish — through
the real voice turn with a real model, prints both transcripts, and writes Reason's half of each as a
voice note. The words there are real; the phone is a loop in a script. `docs/unverified.md` lists the
nine things only Friday can settle, in the order they are most likely to bite.

### Pages

Some answers are not texts. A gift shortlist with pictures and prices, three days in Lisbon, a
plan with sections — sending that as a wall of messages is worse than useless on a phone. So Reason
can make a **page**: a small web page you open from a link, keep, and come back to.

**How a page looks.** A page reads like a printed guide, not an app screen. One quiet column: a top line that scrolls away with the page ("Reason · Made for Omari · Oct 6" and a Private or Shared tag), a serif title at a regular weight, a one-line subtitle under it, then the blocks, then a grey closing line ("Written Oct 6, 2026. Start easy for the first two weeks.") and the footer. Headings get 48px of air above them and no decoration; tables, links and cards sit on hairlines rather than in shadowed boxes; nothing is uppercase except a table header. The same blocks are drawn the same way on every page: numbered steps one per row, plan rows (a bold name, a grey detail, a value on the right), callouts (a thin rule, a soft box, or a soft box with a red title for safety), a comparison table, picture cards with a price tag, tappable choices, and a source list. This came from putting a Reason page next to an Instinct "Files" page with the same gym plan on it (2026-10-06): theirs read calmer and had a block for everything, ours had a numbered list collapsing into one paragraph. It follows the phone's light or dark setting, and a quiet **Light · Dark · Auto** switch at the foot of every page overrides that for the browser it is tapped in (one word kept on the device, sent nowhere; Auto clears it and hands the decision back to the phone; the choice is applied in the head before the first paint so the next page never flashes the other way, and the phone's own chrome colour follows it). The dark colours are written once and serve both the phone's setting and the reader's choice, so the two cannot drift. The code gate and the not-found page stay on the phone's setting and carry no script. It uses only the fonts already on the device, and loads nothing from anywhere else, so opening a page tells no third party about it. The look lives in one place, `src/pages/render.js`; the model still supplies data only, never markup. Three things about it are now measured in Chromium at 390×844 rather than eyeballed on a laptop (`test/pages-phone.test.js`): the blank line the model wrote between two ideas is a gap a person sees, a three-column table fits the screen so no column hides behind a sideways swipe, and a long prompt in a copy block is capped so the page it sits on can still be scrolled past it. A four-column table of prose does **not** fit 390px and no wrapping makes it — that overflow goes into the table's own box and never drags the page sideways, and **the edge fades on whichever side there is more table**, so a hidden column says so instead of being a swipe nobody knows to make. The fade is four background layers rather than a script: two in the card colour that scroll with the table and cover two fixed shadows at the ends, so it appears only when something really is hidden, on the correct side, with nothing to keep in sync. A table that fits has no fade at all, and that is pinned by reading the pixels off a screenshot rather than a style rule. Still not seen on a real phone. The top line reads "Made for" and the person's first name, and says "for you" only when Reason has not been told a name. A person's name goes on their own account the moment they give it (the `my_name` tool), so pages, greetings and the master's list of accounts all use it.

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
- **Your link opens on your own browser.** The link Reason texts you carries its own key. On a
  browser that has opened one of your pages before, tapping it just shows the page. On a browser that
  has not — a private window, somebody else's phone — the key is not enough: the locked screen offers
  to text you a six-digit code, and typing it once signs that browser in to every page of yours
  for 90 days. Holding the link proves you were sent it; the code proves you hold the phone. A bare
  link is offered no code, so nobody can make your phone buzz by guessing addresses, and a held link
  can ask for at most three codes in fifteen minutes.
- **Private to everyone else.** The same address without your key does not open a page that has
  not been shared. The code path remains as a fallback for that case; wrong codes are rate limited
  — five in fifteen minutes and that page locks, counted in the database so a restart does not
  reset it. A page that does not exist and a page you may not see answer identically, so the link
  space cannot be probed.
- **The link can draw a preview card.** A page serves Open Graph tags — its title, its own opening
  sentences as the description, and Reason as the site — so a phone that chooses to make a card has
  something to make it from. **Only on a page the fetcher is already allowed to see.** The gate and
  the not-found page carry no tags at all, because a tag on either would turn a link preview into a
  way to ask "is this id real?" and read the title off the answer; a fetcher holding the owner's key
  already receives the whole page, so naming the title there gives away nothing new. There is no
  `og:url`, so a tap follows the link that was actually sent rather than a keyless one that would
  land on the gate, and no picture on the card yet. Reason is still told **never to promise a
  preview**: whether a card appears is the phone's business, and a page whose link is a tailnet
  address can only be fetched by a device on that tailnet anyway.
- **Shareable only when you ask.** Sharing gives a second link, without your key, that anyone can
  read. Unsharing takes effect on the very next request. Through the shared link the questions are
  read-only, so nobody can answer for you.
- **Your pages link to each other.** After a few of them there is a small body of work with no way
  through it: every page was a dead end, and the only route from one to another was scrolling a text
  thread for the older link. So the foot of a page carries a **Related** list — at most three of your
  other pages, the ones whose titles are really about the same thing, each a tap away. Two bars, both
  deliberate. **Only ever your own pages:** the list is scoped to your own conversation in SQL, and
  the links are owner links carrying each page's key, so the section is drawn on *your* view and on
  no other — a stranger reading a page you shared is shown no other page of yours and handed no key,
  and a printed PDF carries none either. **Only when there is really a match:** titles are compared
  word by word with the function words dropped and plurals folded together, and a word a title
  reaches for whatever it is about ("ideas", "plan", "guide") counts for half, so two pages that
  happen to both be lists are not linked. No match means no section at all, because a Related list
  built out of your three most recent pages is a Related list that lies.
- **You can tap an answer**, and it comes back to Reason as an event turn — exactly once, claimed
  before the turn runs, still waiting in the table if the process was down when you tapped.

Set `REASON_PUBLIC_URL` to the address the listener is reachable at. Without it pages still work,
but only on this machine — and `capabilities` and `page_list` both say so rather than handing you a
link that will not open on your phone.

### Documents

A page is a link. Some things are not: a CV somebody has to upload, a deck for Monday, a one-pager
to print and hand over, a plan a person wants sitting in their Files app a year from now. For those
Reason writes a **document** — a real file, written to this disk and attached to the message in the
thread: a Word document (`.docx`), a slide deck (`.pptx`) or a PDF.

**It is the same answer, not a second one.** `document_create` takes the **same blocks a page takes**
— a heading, text, numbered steps, plan rows, a comparison table, links, a callout, a piece of text
to copy — so an answer the model has already shaped can become a page *or* a file without being
written twice, and without a second vocabulary to keep true (`src/documents/content.js` is a short
list of differences on top of `src/pages/content.js`, not a rewrite). Still data and never markup:
there is no block that takes HTML, every string is escaped on the way out, and a block that is not
one of the fixed set is refused rather than rendered.

- **The PDF is the page, printed.** There is deliberately no third layout. A PDF is Chromium
  printing `src/pages/render.js` — the same layout that was argued over, measured at 390×844 and put
  next to Instinct's — so a PDF looks like Reason and keeps looking like Reason when the page look
  changes, instead of drifting into a house style nobody maintains. On a machine where Chromium was
  never downloaded nothing pretends: the tool refuses in words, like the page-picture renderer does.
- **Two things are refused by name, not quietly dropped.** A **tappable question** is a page block —
  the owner presses an answer and it comes back as a turn — and in a Word file it is a list that does
  nothing, so the model is told to make a page instead. A **picture** survives only the PDF: the
  `.docx` and `.pptx` writers embed no bytes and fetch no URLs, so an image in one would arrive
  missing. Both refusals name the block and the kind and say what to do instead, so the next turn can
  act on it. The real-picture rule is unchanged — an image address still has to have come back from a
  tool in this conversation.
- **The file is Reason's own, in one place.** Under the data directory
  (`REASON_DOCUMENT_ROOT`), named from the row that points at it, which is what makes three separate
  promises mean the same bytes: **"send me that again"** attaches the file off the row, **"export my
  data"** carries it inside the export base64 with its checksum (`--no-files` keeps the list without
  them), and **"delete everything"** unlinks the file as well as the row. The retention window takes
  old documents off the disk, file and row together. A document in a temp directory, or named
  whatever the model called it, breaks all three the first time two are called the same thing.
- **The filename is the title.** Lower-cased and hyphenated with the right suffix, so it is findable
  in a downloads folder — and anything a path could be smuggled through is *replaced* rather than
  refused, because the title is the model's and no title should decide where a file is written.
- **Nothing claims a send that did not happen.** The bytes are made before any row exists, so a
  renderer that falls over leaves no row and no file. If the upload then fails the document is still
  made and nothing says it was sent. On a channel that cannot carry an attachment the owner gets
  their own keyed link instead; in a terminal the path is what is handed over; with no channel
  connected at all the file is written and the refusal says so. `capabilities` reports `documents`
  as live **only where a file can actually be carried**, and tells the model not to offer a Word
  document into a thread that cannot take one.
- **Sending it to somebody else is a text to somebody else.** `document_send` back to the owner needs
  no yes and goes now, like a reply. To anybody else it needs an explicit yes with the number and the
  document said back, it waits out the undo window, that yes is not spendable on a different
  document, and the words that go with it are held to the same rules as any text. A person Reason may
  write to but never send to gets a draft, not a file. Asked for the same document twice in the same
  instant, it really goes twice.
- **The download link is the fallback, never the normal way.** `GET /f/{id}` is the owner's key or
  nothing — no code path, no cookie, no sharing — and 404s without it. A document is meant to arrive
  as an attachment; the link exists for the channel that cannot carry one.
- **`document_list` is what was really made**, newest first, with whether it went.
  `document_delete` takes the row and the file, and is honest that it cannot take the copy already
  on somebody's phone.

Proved offline by 32 tests (`test/documents.test.js`) that assert on real bytes — a real Word file
with the content in it, a deck with a slide per section and long lists continuing rather than running
off, the PDF coming out of the same renderer with no animation and no link tags, and all three kinds
landing on disk through the tool. `test/flow-documents.test.js` is the end-to-end one with nothing
faked: "send me that as a pdf", the model's own choice, through the live backend, asserting on what
landed on disk and in the thread rather than on wording. **Never opened on a real phone** — that a
`.docx` Reason wrote looks right in Word, and that a `.pptx` opens in Keynote, is unproven.

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
is unknown, says so in plain words, looks in your email itself for the shop's confirmation or
receipt and tells you what it found (or, with no email connected, says it can't see it and offers the
link), and asks. *Enforced in
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

### Buying things

Reason can buy from real shops — Amazon, Walmart, Target, Best Buy, Home Depot, DoorDash and more —
with a card the person stores once in [AgentCard](https://agentcard.sh)'s vault. Built from
AgentCard's current docs: an organization token for this machine, a vault session for the person,
and then that finished link exchanged — once — for **that person's own access and refresh tokens**,
because `/buy` always runs as one person and refuses an organization token. Every purchase goes out
on the tokens belonging to whoever asked, so two people's cards cannot be confused for one another.
With no `AGENTCARD_CLIENT_ID` it is **not connected** and says so rather than offering to shop.

Connecting survives a missing webhook. The exchange is what turns a stored card into somebody this
install can buy for, and it is triggered either by `vault.session_linked` or, on an install whose
hook is not registered, by the next tool that needs it reading the session and cashing it in. It is
single use and claimed before it is called, because the two vault events and a polling tool all race
for it. A person who says "done?" before anything has noticed gets connected by that question —
never a second link, which would otherwise overwrite the record of the link they just finished.

**Reason never sees a card number.** The person types it on AgentCard's own page and their device
encrypts it before it leaves; what comes back here is a user id and display fields — brand, last
four, expiry. There is no code path in `src/agentcard.js` that could receive a card number.

**They say yes twice, and the two are different questions.** Shopping is a turn-based loop that
cannot charge anything: Reason asks in plain words, gets back a cart with the real items, the real
fees and the real total, and says those figures rather than whatever prose the API wrote. Then the
ordinary gate asks "buy this for $23.06?" — and the yes is pinned to that exact cart, read back out
of the purchase row rather than retyped, so a price that moved between the ask and the confirm
cannot ride the old yes. AgentCard then asks their own phone for a passkey, which is a pause and not
a verdict: nothing has been charged, the same yes finishes the job once they approve.

A purchase is the one action nobody can pre-authorize. "Just buy it without asking" is refusable in
code (`NEVER_STANDING`), because a cart does not exist yet when a permission is granted — the shop
AgentCard picked, what it put in the basket instead of what was asked for, the fees and the real
total all arrive afterwards, so there would be nothing for the permission to be a bound on. Their
own card at a named merchant up to a limit **is** grantable; a cart is not.

Nothing is ever bought twice. A placed cart, a stale hash, and a confirm that went out and never
came back are all refused rather than resent — the last one is recorded as `outcome_unknown`, says
plainly that nobody knows whether the order exists, and will not retry without a fresh yes. Webhooks
are verified (HMAC-SHA256 over the raw body) before they are acted on and deduplicated on their
event id, so a redelivery cannot text somebody twice or move a row again. One person's vault and one
person's orders are never reachable from another person's conversation. **Nothing has been sent to
AgentCard** — all 26 tests run against a fake server built from their documented responses.

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
that is not one it asks for.

It **can read a file attached to an email** — a PDF resume, a lease, an offer letter, a ticket, or a plain
text one. Reading the email does not download what is clipped to it: the attachments are listed with their
names and sizes, the ones Reason can really read are marked as such, and the bytes only move when somebody
asks about that one file. A PDF's text is then **pulled out on the machine Reason runs on**, by the reader
macOS already has, and the document is not sent to a model or to any service to be read. It is the same
reader a PDF in their Drive goes through, so the two cannot disagree about what is in the same file. What
cannot be read says which thing was wrong — a scan with no text in it at all, a password, too big — rather
than a confident paragraph about a document nobody opened. A Word or Excel file, an image or a zip still
cannot be read at all, and it says so and names the kind.

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
`google_connect` result), which is one of the things that review looks for. The sentence is sent the
first time a person gives a kind of access (mail, calendar, Drive); once they hold that kind on any of
their accounts, a later link carries the privacy address alone. And an account that was already on
and gains a permission is told that ("drive's on for … now ✅"), not that it was "reconnected". While it was in
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

**Putting something on a calendar is four things, not one.** "A bare 'create event' action leaves me
managing the rest" — so a create and a time change each run the same short workflow, and the parts of
it that must not be left to good intentions are in code:

- **Check first.** Before anything is written, the proposed window is read against their primary
  calendar for that account. The overlap is Google's own definition rather than arithmetic done here:
  their `events.list` table says `timeMin` is the "Lower bound (exclusive) for an event's end time"
  and `timeMax` the "Upper bound (exclusive) for an event's start time", so asking with the proposed
  start and end returns exactly the events in the way — and back-to-back meetings correctly do not
  clash. `events.list` rather than `freebusy`, because a person cannot decide anything from "you are
  busy": the title, the time and the place are the sentence. What the calendar itself says is not a
  clash is not reported as one — an event marked "Show me as Available", a birthday, something they
  already declined. An all-day entry is not checked at all: a trip marks days rather than taking
  slots in them, and reporting every appointment inside a holiday as a clash would be noise.
- **The clash is a tradeoff they are shown, never a side Reason picks.** Nothing is created, the real
  events come back, and the model's job is to put it in their words — "that's over your 2pm with
  Sarah, move it or keep both?" — and wait. Going ahead takes their decision carried back explicitly
  on the next call. **A clear time is created in that same call**, with no extra question: a check
  that charges somebody a round trip for an empty diary is a nag rather than a check. A check that
  could not run refuses the write, rather than letting it through under a clear-diary claim nobody
  made.
- **A time has to be a real time.** "Tuesday at 3" is not settled until the date and the zone are.
  Anything that does not name a day is refused, and so is a wall-clock time when there is no zone to
  read it in — the zone comes from Google's setting on that calendar, or from what the person has told
  Reason theirs is, and never from the machine Reason runs on. The refusal names the question to put
  to them. Suggesting a correction is not the same as being allowed to make one.
- **Nothing is "added" until it has been read back.** Every create and every time change is fetched
  again by id, in the same account, and compared against what was asked for. The reply quotes what
  Google really stored. An event that landed at a different time, or under a different title, is
  reported as exactly that rather than reported as done.
- **A correction corrects.** "Make it 4 instead" is a change to the event id the create handed back,
  which travels in the result and so in the thread. A second create of the same title on the same
  day, within a few hours, is refused and handed that id — two dinners an hour apart is the kind of
  mistake nobody notices until they look at their own week.

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

What it does:

- **Find a file.** "my lease", "the budget spreadsheet", "that doc about the trip". It searches the
  name *and the full text* of their files, newest first, and leaves out anything in their bin — so a
  lease whose file is called "Scan 47" is still findable. What comes back is the name, what kind of
  thing it is, when it last changed, whose it is and the link, which drops straight onto a page as
  rows. Reading covers every Google account they have, and every file says which Drive it is in.
- **Read it.** A Google Doc and Google Slides come back as plain text. A **Google Sheet comes back as
  its first sheet** as rows — that is the only thing Google's csv export gives, and the result says so,
  because a number quoted off the wrong tab is worse than no number. Plain text, markdown, csv and html
  files are read directly. A long file is cut and says how much there was.
- **Read a PDF.** A resume, a lease, a statement, a ticket, an offer letter: nearly all of them are
  PDFs, which made this the biggest hole in Drive. The bytes come down the same `alt=media` route a text
  file takes and **the text is pulled out on the machine Reason runs on** — macOS PDFKit, through
  `osascript`, the same bargain `sips` is for a photo: already there, nothing installed, and **nothing
  about the document goes anywhere to be read**. A long one says how many of how many pages it read.
  A PDF with no text in it is a **scan**, and that is said as what it is, with the one offer that
  actually helps — screenshot the page and send it, because Reason can read a photo.
- **Hand it back as a file.** Built 2026-10-07, from Omari's own thread: *"I asked Reason to give me my
  most recent résumé on the Drive and give it to me, but it kept saying it can't get it to me as a
  PDF."* Everything around it worked — it could find the file, read the file, and write a brand new
  file out of its own words — and none of those is what was asked for. Now "send me my latest resume as
  a pdf" ends with **that file**, as a PDF, attached in the thread. A Google Doc, Sheet or Slides is
  exported by Drive; **a Word file is converted by Drive** — copied into a Doc, exported as a PDF, and
  the copy deleted, which runs on the failing path too and says so in words if the delete ever will not
  go; and something that is already a PDF is sent byte for byte, because a resume Reason typed out
  again is not their resume. A Google Doc comes back as a Word file the same way. It needs no
  permission: it is their own file going to them.
- **Make a document.** A new Google Doc from plain text, with the link to send them. No permission
  needed — it is their own Drive, it costs nothing and reaches nobody — but it leaves a receipt, the
  same as a draft left in their Gmail.
- **Organise it.** "I should also be able to organize." Built 2026-10-07, and it is **one more tap**
  again: moving, renaming and binning are a different Google permission from reading, so a Drive
  connected before this cannot do any of them — and Reason says exactly *that*, with the link, rather
  than failing at a 403 nobody can act on. What it does: list and search **folders**, make one,
  **rename** a file, **move** files into a folder, **upload** a file Reason itself wrote, hand back a
  **link**, **share** with one named person, and put a file in the **bin**.

  Four rules hold the shape of it, and all four are code rather than wording:

  - **A tidy-up is proposed before it happens.** One file moves on the asking. More than one is a
    plan first — what is going where, in counts and names, in one message — and moves only on a real
    yes, pinned to that exact set: a yes for two can never be spent on a third. Fifty in one go is the
    ceiling (`REASON_MAX_DRIVE_BATCH`), and over it is a **refusal**, never the first fifty moved
    quietly.
  - **A half-done tidy-up is reported as half-done.** If one move fails the run **stops** there, says
    how many had moved and why it stopped, and offers to carry on. Every file that really moved is its
    own ledger row, so "what did you do to my Drive" is answerable file by file.
  - **Binning and sharing-with-a-person always ask, and then wait.** Both go through the confirm gate
    with the file's real name in the sentence, and then sit in the undo window, so one word takes them
    back. **Nothing anywhere can delete a file of theirs for good.** The bin is Google's: it keeps a
    binned file for 30 days and the person restores it themselves, which is what Reason says instead
    of "gone". `files.delete` is called in exactly one place in `src/`, and it is never pointed at
    one of their files — it is the temporary copy the PDF hand-back makes and has to take back out
    again, a file Reason itself created seconds earlier. A test walks the source to keep it that
    way: one file may name the method, and in that file the call can only ever be handed the id that
    came back from `files.copy`, never a file id from a person, a search or a tool argument.
  - **Upload is fenced to Reason's own output.** `drive_upload` takes a path, which makes it the one
    tool a sentence in somebody's message could try to point at private files. Only paths under
    `REASON_DATA_DIR` are accepted, resolved through `realpath` first so a symlink cannot walk out.

  Sharing has one real limit, and it is said as a permission rather than as a failure: Reason can only
  give another person access to a file **it made itself**, because the scope it holds for that is
  per-file. Asked to share a document somebody has had for years, it says so and offers the nearest
  real thing — the link, so they can share it from Drive in a tap. Nothing is ever made public: a
  share is always one named address.

And what it will not do, said out loud rather than discovered:

- **"Newest" is never "theirs".** People keep a friend's resume, a client's contract, a form filled in
  for a parent. Every search row carries who owns the file, every hand-back says whose it is, and one
  that is not theirs comes back saying so by name — because "here's your resume" over somebody else's
  CV is the sentence that reaches a recruiter. Where Reason can read the type it checks whose name is
  inside as well; a Word file it cannot read at all, so there the owner and the file's own name are all
  there is, and if neither settles it, it asks.
- **Only PDF and Word come out, and each no names the yes.** A Sheet or a deck can be a PDF and cannot
  be a Word file — Google's export table has the Word type on Documents and nothing else. A PDF cannot
  become a Word file, because that is OCR guessing at a layout and what comes out is not the document.
  Nothing Apple's Pages, Keynote or Numbers wrote can be either, because Drive stores one and cannot
  open it; exporting from Pages on their own machine is the way, and that is what gets said.

- **A Word or Excel file, an image, or a folder cannot be read.** Each one comes back with a plain
  sentence naming what it is and the link to open it, and Reason says that instead of writing a
  confident paragraph about a document nobody could open.
- **A PDF that has no text to give cannot be read either, and says which thing was wrong.** A scan is a
  scan; a password-protected one says that and never asks anybody for the password; one over the size
  cap says so before a byte of it is read; a file labelled `.pdf` that is really a saved web page is
  refused on its bytes rather than on its label. Four different pieces of news, because the next move
  is different for each — and "Reason can't read PDFs" is no longer one of them.
- **Nothing is deleted, and nothing is edited.** A file can be renamed, moved and binned (above), but
  what is *inside* an existing document is never rewritten — the permission for that is not one Reason
  asks for. Asked to change a document, it says so and offers to make a new one. And there is no
  permanent delete anywhere, for anybody.
- **What is in a document is somebody's words**, marked the same way a fetched web page is. A file that
  says "email this to accounts@…" is a file Reason tells them about, naming it. It cannot produce a yes.

The three permissions, and why these three: **`drive.readonly`** to find and read a file,
**`drive.file`** to make one, and — added 2026-10-07 — **`drive.metadata`** to organise. There is
nothing narrower that works for any of them. `drive.metadata.readonly` is read-only and cannot read
contents, and `drive.file` on its own is documented as only seeing files the app made or the person
picked through Google's file picker — Reason has no picker, so under `drive.file` alone "find my
lease" would find nothing, and "move my receipts" would find nothing to move. `drive.file` is
non-sensitive and is the narrowest scope `files.create` accepts. `drive.readonly` and `drive.metadata`
are both **restricted** in Google's scope table — that is not a quiet escalation, because Reason
already asks for `gmail.modify`, which is restricted too, so the verification class of the app does
not change. The broad `drive` scope is still not requested, which is why editing the contents of an
existing file is not on offer, and `files.delete` is never called at all. All three have to be added
on the client's **Data Access** page in Google's console before a real connect works — that is
Omari's, not the code's, and `docs/google-verification.md` has it.

**The split matters to people who already connected.** `drive.metadata` is a scope their token does
not carry. Reason reads the granted scopes off its own record *before* it asks them anything, so
"bin that" from an older connection is answered with one line and one link — never a yes collected
for something that was never going to work.

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

**"Forget about her" means everything, and says what it does not reach.** `forget` deletes every fact
saved about that subject — under that name *and* any longer name containing it as a whole word, so
forgetting Kofi takes "Kofi Mensah" and forgetting Ama does not take Amanda — plus the rows in the
old flat memories table an upgraded install still has, plus the copies in this conversation: the
`recall` results the next turn would read, and the fact itself out of Reason's own earlier replies,
which is the likeliest place a forgotten thing comes back from. It leaves **your own messages alone**,
because rewriting what you said is a worse thing than remembering, and it tells you so rather than
letting you assume otherwise. A full delete is what takes those.

**Disconnecting an account deletes what was copied out of it.** Revoking a grant stops anything new
being read and does nothing about what has already been read — and there is no mail store or calendar
store here, so the only copy is the conversation. So `google_disconnect` clears every result that came
from a tool that reads your account, and reports how many, because "it's all gone" should be
checkable. Revoking Spotify clears what was read off Spotify; revoking a site sign-in clears the
cookies (which are the credential) and the pages Reason read on that site, found by the host on them
so the other sites are untouched. What stays is the receipts — the record of what Reason did with the
access it was given, which is the one thing a privacy feature must not quietly erase.

**It never writes down a card number, a security code, a password or a PIN.** `remember` is screened
before it writes, and so are the two other places a sentence of yours is kept verbatim forever: the
text behind a standing permission and the text behind a spending limit. This is the only place in
Reason that decides anything from a pattern in somebody's words, and it is allowed to be one because
it is not a judgment about what you meant — `4111 1111 1111 1111` is a card number whatever the
sentence around it was for, and a memory row is forever. Narrow on purpose: a 13-to-19 digit run that
passes Luhn, a CVC with its own word next to it, or a password or PIN written out as `word is value`.
"Lives at 441 graham ave" and "born 1992" save normally. Refused, Reason says it doesn't keep those,
does not read the number back, and does not offer to put it somewhere else.

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

**A test run never starts a builder.** The spawn and the session read are the only two places
`src/remote.js` reaches outside itself, and both refuse when the process is a test run (the test
runner's own mark, `--test` on the command line, or a file called `*.test.js`) — there is no switch
that turns the refusal off. A test passes its own `spawnImpl`/`execImpl`, through the tool's context
if it goes through `runTool`. This is there because it went wrong: three tests once called
`remote_start` through the tool with nothing injected, so every run of the offline suite handed a
made-up brief to a real session on the machine, which built it.

## Where this actually is

Three honest buckets. Nothing is in the first one unless a test passes on it.

<!-- usecases:start -->

### Working today

All of this is covered by the offline suite — **6,203 tests, 6,066 passing, 0 failing, 137 skipped**
(2026-11-10). The 137 skipped need a real model and have not been run against the API for want of
credit. The newest two are the flight check-in — a flight read out of one sentence, the offer raised
by the sweep in the airport's own zone, nothing pressed before a yes, the seat read back off the
page, and a payment wall handed back rather than paid — on the `claude-cli` backend (see below) on
2026-10-07. Before them, the standing commitment — "leg day tuesdays and fridays 7am" saved with the
zone on it, a 7:12 with nothing from him answered by the real thing, the real time, his last session
and "you hit 175 on squats last week. go 180.", "cant today" taken as the end of it, and a hurt knee
getting no session and no advice — on that backend on 2026-10-07. Before it, the standing check-in —
"check in with me every monday at 9 about the job search" read as one weekly series rather than one
Monday reminder, a first firing about the search, what he said back carried into the second Monday
in different words, and "stop checking in about that" ending it — on that backend on 2026-10-07.
Before it, the hard line — six sentences seeking help toward harm refused before any model turn,
seven innocent ones passed, two crisis messages read as crisis, one thread read for where it was
going, and the whole path from a test number, all on that backend on 2026-10-06 (see the first rule
under "The rules it keeps"). Before that, "where were we?" — a job mid-flight, asked for an update,
answered with what is done before what is left before the one thing it needs, which is the
difference between a status update and a demand. It passed twice on that backend on 2026-10-06. Next
to it are the subscription flows — a year of receipts sorted into subscriptions and
not-subscriptions, a `cancelling` row answered as not-yet rather than done, and a cancellation
walked to the last button and pressed only on a real yes — on that backend the same day. On the
machine this was last run on, `ffmpeg` is installed and `test/expressive.test.js` is green — the two
failures that line used to carry are gone.

Newest first. One line each; open the fold for what is actually proved and what is not.

- **[A file of theirs, handed back as a PDF](#their-drive)** — their own resume out of their Drive, as a real attachment · landed 2026-10-07
  <details><summary>A file of theirs, handed back as a PDF</summary>

  From Omari's own thread on 2026-10-07: *"I asked Reason to give me my most recent résumé on the
  Drive and give it to me, but it kept saying it can't get it to me as a PDF."* Everything around
  the ask already worked — it could find the file, read the file, and write a brand new file out of
  its own words — and not one of those is what he asked for. `drive_send` is the missing middle:
  **that file**, in the format asked for, attached in the thread. It needs no yes, because it is
  their own file going to them.

  Three routes, and the result says which one ran. A Google Doc, Sheet or Slides is **exported by
  Drive** (`files.export`). Something that is **already a PDF is sent byte for byte** — a resume
  Reason typed out again is not their resume. A Word file is **converted by Drive**: `files.copy`
  with a Doc mime type opens it as a Doc, that copy is exported as a PDF, and then the copy is
  deleted — which runs on the failing path too, with the delete's own outcome carried out to the
  ledger, so a copy that would not come back out is said in words with the name to look for rather
  than left in somebody's Drive to be found. The one route that writes in their Drive is the only
  one that checks for `drive.file`, against that file's own route, so a PDF that only had to be
  downloaded is never refused over a permission it never needed; a grant missing it gets the
  reconnect link the other Drive tools use.

  **Every no names the yes.** Only PDF and Word come out: a Sheet or a deck can be a PDF and cannot
  be a Word file, because Google's export table puts the Word type on Documents and nowhere else. A
  PDF cannot become a Word file — that is OCR guessing at a layout, and what comes out is not the
  document. Nothing Pages, Keynote or Numbers wrote can be either, because Drive stores one and
  cannot open it; exporting from Pages on their own machine is the way, and that is the sentence
  they get. A file Drive labels `application/pdf` that does not start like one is refused rather
  than attached, because the type on an upload is whatever the uploader said it was.

  And **"newest" is never "theirs"**: people keep a friend's resume, a client's contract, a form
  filled in for a parent. `owned_by_them` is the fact, the hand-back says whose it is, and one that
  is not theirs comes back refusing to let it be called theirs — "here's your resume" over somebody
  else's CV is the sentence that reaches a recruiter.

  **Proved:** 21 offline tests against the fake Google — all three routes on real bytes, the whole
  conversion matrix including each refusal, the copy taken back out after an export Google refused,
  a copy that cannot be deleted owned up to by name, the wrong-account answer, the scope refusal,
  and a receipt with no file contents in it. Plus one live end-to-end run on the `claude-cli`
  backend on 2026-10-07 walking his exact sentence: it reached for `drive_send` and never
  `document_create`, picked his `.docx` over the newer resume in that Drive belonging to Kofi Mensah
  and said why unprompted — "The newest resume in your Drive is actually Kofi's, so I skipped it" —
  took the convert route, and the fake's own file list showed the temporary copy gone. **Not
  proved:** nothing here has run against a real Drive, so Google's export and copy behaviour is as
  documented and not as observed. See `docs/unverified.md`.

  </details>

- **[A document, as a real file](#documents)** — the blocks that make a page make a `.docx`, a `.pptx` or a PDF · landed 2026-10-07
  <details><summary>A document, as a real file</summary>

  A page is a link, and some things are not: a CV to upload, a deck for Monday, a one-pager to
  print. `document_create` takes the **same fixed blocks `page_create` takes** — so an answer the
  model has already shaped becomes a page *or* a file without being written twice, and without a
  second vocabulary to keep true — and writes a real file to this disk, then attaches it to the
  message in the thread. The PDF is deliberately not a third layout: it is Chromium printing the
  page renderer, the one already measured at 390×844, so a PDF looks like Reason and keeps looking
  like it when the page look changes.

  Two things are refused by name rather than dropped, each saying what to do instead: a **tappable
  question**, which is a page block the owner presses and in a file is a list that does nothing, and
  a **picture in a `.docx` or `.pptx`**, because those writers embed no bytes and fetch no URLs, so
  it would arrive missing — the PDF is the one kind that carries an image, and the real-picture rule
  is unchanged. The file is Reason’s own, under the data directory and named from its row, which is
  what makes three promises mean the same bytes: a resend attaches it, an export carries it base64
  with its checksum, a delete unlinks it, and the retention window takes file and row together.

  Nothing claims a send that did not happen. The bytes are made before any row exists, so a renderer
  that falls over leaves nothing behind; a failed upload still made the document and says it did not
  go; a channel that cannot carry an attachment gives the owner a keyed `/f/{id}` link instead, a
  terminal gets the path, and `capabilities` reports `documents` as live **only where a file can
  actually be carried**. Sending one to anybody but the owner is held to the rules for texting that
  person: an explicit yes with the number and the document said back, the undo window, and that yes
  is not spendable on a different document.

  **Proved:** 32 offline tests on real bytes — a Word file with the content in it, a deck with a
  slide per section, the PDF out of the page renderer with no animation and no link tags, the
  refusals, the keyed download, the export, the delete and the retention sweep. Plus one live
  end-to-end run on the `claude-cli` backend on 2026-10-07: asked for a pour-over coffee guide and
  then "send me that as a pdf", it made exactly one document, a 151,656-byte PDF titled "Pour over
  coffee", carried as a single message with the file attached, and the words were read back out of
  the PDF itself. **Not proved:** nobody has opened a Reason `.docx` in Word or a `.pptx` in Keynote
  on a real device — the OOXML writers are hand-rolled and have only been read back by the tests
  that wrote them — and the live server has not been restarted onto this code. See
  `docs/unverified.md`.

  </details>

- **[Check-ins that keep coming back](#working-between-messages)** — every monday about the job search; it tracks what you said last time · landed 2026-10-07
  <details><summary>Check-ins that keep coming back</summary>

  Reason’s reminders were all one-offs. Now anything standing — "check in with me every monday about
  the job search", "remind me every day at 7 to work out", "every weekday morning ask me what’s on",
  "every two weeks ask if i’ve invoiced" — is **one arrangement that keeps going until you stop
  it**. It is one row, and **every firing is an ordinary reminder** pointing back at it, so the
  send-then-claim rule, the three tries, the "a reminder was missed" line and the list of what
  Reason has set and not yet sent all work on a check-in unchanged. **It tracks from what you say
  back.** The first thing you say after a check-in is kept as the report — by code, not by the
  model, because it has to still be true in six weeks — and the next one is handed it: "last monday
  you said two applications were out, any replies?" rather than the same line every week. Three
  things are code’s and not the model’s. **The maths**: occurrences are walked in local days, so
  "every monday at 9" is 9 o’clock on both sides of the November clock change (169 real hours apart,
  not 168), "every weekday" skips the weekend, and "every month on the 31st" skips February rather
  than inventing a date. **Quiet hours**: nothing fires between 23:00 and 08:00 where you are unless
  you named that time yourself. **No backlog**: three Mondays with the laptop shut produce one
  check-in, for the newest, and the older ones are gone. Stopping is a sentence: "stop checking in
  about that" ends it, "pause the workout reminders" holds it and resumes from the next one after
  that moment, and a bare "stop" with more than one running gets asked which rather than guessed at.
  Every one of them leaves a receipt with the schedule in the words you were told. Ten running per
  person (`REASON_MAX_SERIES`), counted in the database. All of it in `src/series.js`, pinned by
  `test/series.test.js`. **Against the real model** (`test/flow-series.test.js`, `claude-cli`,
  2026-10-07) the Monday ask became one weekly series rather than one reminder, and the second
  Monday opened "morning. last monday you had two applications out, has either one gotten back to
  you?". **What tests cannot prove**: nothing here has run on the live Reason or over real days on a
  real phone — "a series that survives several real fires" is exactly the claim a fake clock cannot
  make. See `docs/unverified.md`.

  </details>

- **[Nobody uses it to hurt anybody](#the-rules-it-keeps)** — every text screened before the model; harm gets no turn at all · landed 2026-10-06
  <details><summary>Nobody uses it to hurt anybody</summary>

  A separate narrow model call reads every message anybody sends, with the last few lines of the
  thread, before the model sees it. On **harm** — planning or carrying out violence, a weapon, a
  bomb, a poison, a nerve agent, drugging somebody, stalking, anything sexual involving a child,
  breaking into accounts; whatever the framing — there is no model turn: a refusal written in code
  goes back, the thread keeps it, and it is a ledger row and a strike. Three strikes in a day pause
  that person and tell the master the count and the kind, never the words. Borderline reads, a
  person in crisis, and a screen that could not run all get a turn with every outward tool refused;
  crisis gets a guaranteed crisis line and never a strike. No off switch.

  </details>

- **[Why, not just what](#working-between-messages)** — the reason you gave is kept and it reorders the options · landed 2026-10-06
  <details><summary>Why, not just what</summary>

  "I want to move" is one job; "to save money" and "for a shorter commute" are two different jobs
  out of the same five flats. A reason you state is its own row — the subject, the goal in your
  terms, and **your own sentence, verbatim** — kept apart from facts and from preferences, because a
  fact is what stays true about you and a reason is what you are trying to achieve. It outlives the
  task it was said on, arrives on the sheet of every later job on that subject, and the model is
  told to rank by it and to say so in one short clause. Two things are code's: a reason with no
  sentence behind it is refused, so an invented motive cannot start sorting your options; and a
  correction **supersedes** rather than overwrites, so the old one is kept as replaced and stays
  checkable. It is a goal and never a permission.

  </details>

- **Memory you can correct** — numbered sections for everything it holds; text back a correction and it sticks · landed 2026-10-06
  <details><summary>Memory you can correct</summary>

  "What do you remember about me" is one page with a number on every line: what you told it, what it
  is **guessing** (labelled as guesses, never said back as fact, and only ever promoted by you
  saying the thing), what you have turned down and why, **why you said you are doing things**, and
  what it may do without asking. Text back "#4's wrong, she's my cousin" and it changes that one
  line — and stops saying the old version anywhere, including in things it has already said.

  </details>

- **[Taste](#what-it-may-do-without-asking)** — a no is kept in your words and shapes every later pick · landed 2026-10-06
  <details><summary>Taste</summary>

  When you turn an option down it keeps your reason, in your words, with what kind of no it was, and
  every later pick is made knowing it. It is a preference and never a permission: nothing it learns
  this way lets it spend anything or send anything.

  </details>

- **[Noticing things first](#noticing-things-first)** — goes looking in mail and calendar, one catch a day · landed 2026-10-06
  <details><summary>Noticing things first</summary>

  It goes looking, every couple of hours, at a connected mailbox and calendar: a meeting that moved
  deep in a thread, a bill sitting unread, a reply somebody is waiting on. Anything they already
  handled is checked against the live mailbox and never raised. One unprompted catch a day, counted
  in the database, one nudge per thing, sent at the moment it is useful rather than in a batch,
  nothing in their night, and the three-question bar in front of all of it. How much initiative they
  want is theirs — the moment it matters, one batched line a day, or only ever when they ask — and
  none of it is permission to act for them. See **Noticing things first** above. The judgement side
  has only ever been exercised with a fake model: whether its sense of "worth interrupting somebody
  for" is any good is in `docs/unverified.md`.

  </details>

- **[Subscriptions](#subscriptions-find-them-cancel-them)** — a year of receipts, a monthly total, and a real cancellation · landed 2026-10-06
  <details><summary>Subscriptions</summary>

  Read a year of their receipts and come back with what is actually going out, keep the list, show
  it as a page with a monthly total, and cancel one — on the web with their own saved sign-in, or as
  a written request from their own address. Both behind their explicit yes, and nothing is ever
  called cancelled until something confirms it. See **Subscriptions** above.

  </details>

- **[Their Drive](#their-drive)** — find a file, read a Doc, Sheet, Slides or a real PDF · landed 2026-10-06
  <details><summary>Their Drive</summary>

  Against the same fake Google: find a file by its name or by what is inside it, read a Doc, a Sheet
  (first sheet, and it says so), Slides, a text or html file, **and a PDF — read on this machine,
  against real PDFs built in the tests**, including a real password-protected one that is refused
  and a real scan that is named as a scan — make a new Google Doc and send back the link. A Word
  file, an image and a folder each get a plain sentence saying Reason cannot read that one, with the
  link. Nothing is deleted, shared or edited, because the scopes for that are not asked for. And
  **an existing Google connection is not a Drive connection**: Drive is its own tap, and asking for
  it adds a permission without costing them the ones they have. Nothing has been sent to Google. See
  **Their Drive** and `docs/unverified.md`.

  </details>

- **[Gmail, per person and as many accounts as they have](#their-email)** — read, send, bin across every account, attached PDFs included · landed 2026-10-05
  <details><summary>Gmail, per person and as many accounts as they have</summary>

  Against a fake Google server built from their docs: a link each person taps, tokens stored and
  refreshed against their own conversation and their own address, reading across every account they
  connected with each result labelled, sending and binning gated on the real recipients, the whole
  body **and the sending account**, an email's own words treated as data and never as an
  instruction, and a dead connection reported as needing a reconnect rather than retried. **A PDF
  attached to an email is read** — against real PDFs built in the tests and really put through this
  machine's own reader — with the bytes fetched only for the one file asked about, a real scan named
  as a scan, a really encrypted one refused, and an instruction written inside the document flagged
  and unable to become a yes. Nothing has been sent to Google — the client id and secret are on the
  machine and have deliberately never been used. See `docs/unverified.md`.

  </details>

- **A message Reason starts reaches the phone** — reminders and task news go to the thread, not the log · landed 2026-10-05
  <details><summary>A message Reason starts reaches the phone</summary>

  A reminder, a task's news, a watcher or a picked-up thread goes to the thread that conversation
  lives in. Until 2026-10-05 these had no channel and were printed into the server's log instead —
  written, recorded as said, and never texted. `src/deliver.js`, pinned by `test/deliver.test.js`.

  </details>

- **[Research, with a real pick](#research-with-a-real-pick)** — many searches, sources read in full, then a recommendation · landed 2026-10-05
  <details><summary>Research, with a real pick</summary>

  Several different searches, the best sources read in full, a source log of what each one said and
  when, then a recommendation with what would change it. Capped so one question cannot run away, and
  it says when a cap cut it short. A big question runs as a durable task. The provider interface and
  the whole flow are offline-tested against a fake provider and fixture pages; the Tavily request
  shape is tested against its documented contract but **has never been sent to Tavily** — no key.
  **Reddit is never fetched** (its robots.txt forbids everyone); what threads say arrives as search
  snippets, labelled as snippets.

  </details>

- **[Finding out what is in a video](#videos)** — a link becomes timestamped lines, and says what produced them · landed 2026-10-05
  <details><summary>Finding out what is in a video</summary>

  A YouTube link (and many other video sites) → the title, channel, length, description, chapters
  and what is in it as timestamped lines. It reads the captions when there are any; a long one is
  cut and says which stretch is missing, and a follow-up reads that stretch. An age gate, a private
  video or a region block comes back as the reason. Every result says which of three things produced
  it, so "watched" is only ever said when something really watched. Proved against real YouTube
  videos as well as offline fixtures; see the manual checks in `docs/unverified.md`. The **video
  model** tiers — watching a YouTube link, and transcribing audio from anywhere else — are built and
  offline-tested but need `GEMINI_API_KEY`. The audio-only download and the delete-after are proved
  for real; nothing has ever been sent to Google.

  </details>

- **[Saved sign-ins, site playbooks, a daily spending limit and Spotify](#saved-sign-ins-and-real-sites)** — browsing free, the committing click gated, tokens never shared · landed 2026-10-05
  <details><summary>Saved sign-ins, site playbooks, a daily spending limit and Spotify</summary>

  Against local fixture pages and a fake Spotify server: browsing is free, the committing click is
  gated whatever the site calls it, a changed total asks again, and one person's sign-in or token is
  never usable from another's conversation. No real site has been signed in to and nothing has been
  sent to Spotify.

  </details>

- **[Telling somebody what's new, in passing](#whats-new-mentioned-in-passing)** — one live thing, one a day, never while a confirm is open · landed 2026-10-05
  <details><summary>Telling somebody what's new, in passing</summary>

  The gates are code's: nothing unverified is ever put in front of the model, nothing is mentioned
  that is not live for that person, one thing per reply and one per person per day, never while a
  confirmation is open, never on a message Reason started, and never to somebody who arrived after
  the feature did. Marked heard only once the reply really went out. What no test can prove is the
  part the model owns — whether it actually reads the moment right and writes one casual line rather
  than a pitch. See `docs/unverified.md`.

  </details>

- **[Messages arriving the way people actually send them](#texting)** — two texts are one turn; a photo arrives as a picture · landed 2026-10-05
  <details><summary>Messages arriving the way people actually send them</summary>

  Two texts seconds apart are one turn; the parts of one iMessage (a pasted link and its preview
  card) are one message rather than three; a photo or screenshot reaches the model as a picture to
  look at, and anything that cannot be read is explained once, by name, instead of being called
  "blank". Against the real failing shapes from a real phone.

  </details>

- **[Photos, voice notes and links](#what-they-send-photos-voice-notes-links)** — HEIC converted, voice transcribed, and a row for each · landed 2026-10-05
  <details><summary>Photos, voice notes and links</summary>

  An iPhone HEIC converted before anything looks at it, a voice note transcribed and answered as the
  words in it, a link sent as its own bubble, and a row for every one of them saying what was
  actually got out of it. See **What they send** above.

  </details>

- **[Tapbacks, screen effects and voice notes](#how-a-reply-arrives)** — Sendblue's own grammar and limits checked before any request · landed 2026-10-05
  <details><summary>Tapbacks, screen effects and voice notes</summary>

  As tools, with Sendblue's own grammar and limits checked before any request — including the
  awkward part, which is that "exactly one emoji" has to treat a skin tone, a family, a keycap and a
  flag as one.

  </details>

- **A voice, and ears** — says a voice note, listens to one, every failure named · landed 2026-10-05
  <details><summary>A voice, and ears</summary>

  Reason can say something as a real voice note and listen to one you send, with every failure a
  named reason. The whole path has run on this machine with the real speech model — spoken,
  converted, served back and transcribed word for word — but no voice note has been sent to or
  received from a real phone. See `docs/unverified.md`.

  </details>

- **[Inline replies](#how-a-reply-arrives)** — pinned under the message they answer, both directions · landed 2026-10-05
  <details><summary>Inline replies</summary>

  Both ways: a reply pinned under the message it answers, a refused pin that falls back to an
  ordinary message instead of losing it, and an inbound reply that arrives saying which message it
  was sent under. Never sent to a real phone — see `docs/unverified.md`.

  </details>

- **[The Bland adapter](#phone-calls-and-the-recording)** — exact request body and every status mapped; no call placed · landed 2026-10-05
  <details><summary>The Bland adapter</summary>

  Driven by an injected `fetch` that could not reach the network if it wanted to: the exact request
  body (`record: true`, the announcement as `first_sentence`, the standing rules ahead of the goal),
  every one of Bland's call statuses mapped onto Reason's, the audio fetched from Bland's own
  authenticated endpoint rather than from `recording_url`, and the signed call-finished webhook. No
  call has been placed.

  </details>

- **[A keep-by date on everything](#your-data)** — a real export copy and a delete that really deletes · landed 2026-10-05
  <details><summary>A keep-by date on everything</summary>

  A keep-by date on everything, with an export that is a real copy and a delete that is a real
  delete. See **Your data**.

  </details>

- **[An account per person](#everyone-who-texts-it-gets-their-own-reason)** — fully separate, master-approved by text, a daily limit each · landed 2026-10-04
  <details><summary>An account per person</summary>

  Fully separate, with the master approving each one by text — and a daily limit each, so nobody can
  run up the bill.

  </details>

- **Follow-ups** — a quiet plan with open questions is picked back up · landed 2026-10-04
  <details><summary>Follow-ups</summary>

  When a plan with open questions goes quiet for hours, Reason picks it back up on its own — at most
  once per plan per day, twice per conversation.

  </details>

- **[Pages](#pages)** — an answer at a link, reopened and updated at the same one · landed 2026-10-04
  <details><summary>Pages</summary>

  Made, updated at the same link, opened by the owner's own link on a browser they have proved once
  with a texted six-digit code (a new browser is asked; a known one is not), closed to the bare link
  until shared, shareable on request through a separate read-only link, with a tapped answer coming
  back as one event turn, and a **Related** list at the foot linking the few other pages of theirs
  it is really about — their own conversation only, by the owner link that just opens, and drawn on
  their own view alone because those links carry each page's key. Against the HTTP handler, no
  browser needed.

  </details>

- **[Phone calls](#phone-calls-and-the-recording)** — announcement, recording, caps — as far as no account goes · landed 2026-10-04
  <details><summary>Phone calls</summary>

  As far as they can go without an account: the provider interface, the recorded announcement, the
  recording store, the audio arriving with the summary in one message, the never-pay-by-phone guard,
  and the per-person daily caps on calls and on call minutes. Against a fake provider that dials
  nothing.

  </details>

- **`npm run serve`** — the long-running process with its sweep and webhook listener · landed 2026-10-04
  <details><summary>`npm run serve`</summary>

  The long-running process with its sweep and webhook listener.

  </details>

- **[The confirm gate, the action ledger and the accounts registry](#the-confirm-gate-in-detail)** — "what did you do today" is read off a table, never memory · landed 2026-09-30
  <details><summary>The confirm gate, the action ledger and the accounts registry</summary>

  The **confirm gate**, the **action ledger** ("what did you do today" is read off a table, never
  from memory), and the **connected-accounts registry**.

  </details>

- **[Export and delete](#your-data)** — call recordings and pages included, off disk too · landed 2026-09-30
  <details><summary>Export and delete</summary>

  Export and delete, call recordings and pages included.

  </details>

- **[A real browser](#saved-sign-ins-and-real-sites)** — it drives itself; the commit click always needs your yes · landed 2026-09-30
  <details><summary>A real browser</summary>

  A real browser it drives itself: open a page, read it, click, fill a form, screenshot. One profile
  per conversation so logins stick between turns. The final commit click always needs your explicit
  yes.

  </details>

- **Reading one web page** — answering from what the page actually says · landed 2026-09-30
  <details><summary>Reading one web page</summary>

  Reading one web page and answering from what it actually says.

  </details>

- **[Reminders and timers](#working-between-messages)** — real turns at real times, one-off or standing; fired once the message is out · landed before 2026-09-30
  <details><summary>Reminders and timers</summary>

  Reminders and timers that fire real turns at real times. **A timer counts as fired once its
  message is in the outbox, not before**: a turn that throws or times out leaves it due, it is tried
  again on the next sweep (three tries in all, `REASON_TIMER_MAX_ATTEMPTS`), the reply goes out
  under a key that belongs to that timer so retrying cannot text twice, and if it still cannot be
  got out they get one line saying a reminder was missed and what it was. Until 2026-10-06 the timer
  was marked fired first, and a turn killed after the Mac slept took the reminder with it — not
  sent, not retried, nobody told. `Runtime.tick`, pinned by `test/timer-claim.test.js`. A reminder
  can also be **standing** rather than one-off — every Monday, every weekday morning, every two
  weeks — in which case one series row keeps making them, one at a time, and each one is an ordinary
  timer with all of the above still true of it. See “Check-ins that keep coming back”.

  </details>

- **[Plans](#working-between-messages)** — make, change any detail, lock, cancel, mark done · landed before 2026-09-30
  <details><summary>Plans</summary>

  Make one, change any detail, lock it, cancel it, mark it done. It tracks what is still open and
  will not lock while something is.

  </details>

- **[Tasks that outlive a message](#working-between-messages)** — a row with a goal, a wake time and a progress log · landed before 2026-09-30
  <details><summary>Tasks that outlive a message</summary>

  Chasing someone, waiting on a reply, a multi-step errand. A row in the database with a goal, a
  next wake time and a progress log, so killing the process loses nothing. Reason only speaks about
  one when something actually changed.

  </details>

- **[Watchers](#working-between-messages)** — watch a page, come back when one thing changes · landed before 2026-09-30
  <details><summary>Watchers</summary>

  Watch a page, come back when a specific thing changes on it.

  </details>

- **Memory about people** — facts and preferences, read back whole, or forgotten · landed before 2026-09-30
  <details><summary>Memory about people</summary>

  Facts, preferences, who someone is; read it all back, or forget a person outright.

  </details>

### Built, but never run against the real thing

Written carefully, offline-tested, and **unproven**. Do not treat any of it as working.
`docs/unverified.md` is the full ledger, test by test. Newest first.

- **A restart does not cost you your message** — a turn killed mid-answer by a restart is put back, not apologised for · landed 2026-10-18
  <details><summary>A restart does not cost you your message</summary>

  Every `systemctl restart reason` used to throw away whatever turn was running and tell the person
  their message had broken. From the live journal on 2026-10-17: `Stopping reason.service`, then one
  second later `the CLI returned no JSON (exit 143)` and a `turn_failed`, and Omari got "ugh — that
  one broke on my end partway through" for a message that was not broken. The `requests` row for his
  text was left `dropped`, and the box was restarted seven times that day.

  A turn that dies while the process is stopping is now unfinished rather than failed, and the
  difference is proved rather than guessed: 143 is 128+15, so a child that exits 143 or dies of a
  signal outright resolves `interrupted`, and `Runtime.stopping` covers a backend with no exit code
  to read. Nothing is said to them — "that broke on my end" would be a lie and would also lose the
  reply, asking them to repeat a message still sitting on disk. What the turn took it puts back: the
  messages return under their original `arrived_at`, so a burst goes back whole and in order, and
  with `quietMs: 0`, because they already waited one quiet window and a restart must not charge them
  a second. The `requests` rows that turn opened are dropped, so nobody is asked the same thing
  twice. `shutdown` waits on `Router.idle()` after `Runtime.idle()`, so the putting-back lands
  before the process goes.

  `src/channels/router.js`, `src/backends/cli.js` and `src/serve.js`, pinned by nine tests in
  `test/restart-safe.test.js` — three of them spawning a real child and killing it for real, because
  the claim is about what a dying child reports and a mock would only prove the mock agreed. It is
  here rather than above because the end-to-end proof is missing: no real `systemctl restart` has
  been timed against a turn in flight with this code on the box, and a SIGKILL is still not covered
  — that needs the take to become a lease rather than a delete. `docs/unverified.md` says both.

  </details>

- **Checked in before you remember** — it watches the airline, offers, checks you in, hands back the pass · landed 2026-10-07
  <details><summary>Checked in before you remember</summary>

  The card on the site, verbatim: *"check-in for your 7:15am to atlanta just opened. want me to do
  it?"* — *"yes pls, aisle if u can"* — *"done. you kept 14C."* — and a link. **It watches the
  airline, not your inbox, and it asks before it touches anything.**

  **A flight gets in three ways and the model reads all three** — a sentence ("flying to atlanta
  friday at 7:15am on fixture air out of jfk, conf ABC123"), a confirmation email, a calendar event.
  No pattern-matching anywhere: what it read is stored, and **anything it worked out rather than was
  told is kept as a guess** and said as one. A card number sitting in the same booking email is
  refused outright, with nothing written down and nothing read back.

  **The clock is the flight's, never this machine's.** 7:15 in New York opens 24 hours before 7:15
  in New York, and the zone is stamped at save time off the departure airport — the suite runs the
  same flight through three zones in a process whose own clock is a fourth. A zone nobody knows and
  a time that is not a time are both refused rather than quietly read as UTC. The window is the
  airline's own where one is written down, 24h where it is not.

  **The offer comes through the proactive sweep, not a timer** — inside your waking hours, one nudge
  per flight, inside the same daily budget as everything else, and it carries the real flight rather
  than "you have a flight". **Nothing is pressed without a yes on what the last screen actually
  says.** The seat only appears on that screen, so a yes collected earlier would be a yes to
  something nobody had seen; the yes is pinned to the flight as well as the details, so one flight's
  yes cannot be spent on another, and `browser_click` refuses anything labelled "Check in" by
  itself. **"Just check me in, stop asking" cannot be granted** — it is on the list of things no
  standing permission covers.

  **"Done" is read off the page or it is not said.** Three things, separately, by code and not by
  the model: the checked-in words, a seat or a boarding position, and *their* name. Any one missing
  leaves the row at `checking_in` and the wording honest. A page confirming somebody else's booking
  is not a check-in; two travellers on one record stops and asks rather than saying you are both in;
  a screenshot of the screen the claim came off is kept with the flight. What you said in the same
  breath is carried — "aisle if u can" is kept on the flight *and* as a lasting preference, so the
  next flight starts out knowing it — and a middle seat after you asked for an aisle is said plainly
  rather than bought out of.

  **It never spends your money.** A page wanting paying for a seat or a bag stops the commit
  *before* the press, which also means the yes is still sitting there unspent, and what comes back
  is the furthest point it reached with the one tap left for you — never a request for a card and
  never an offer to pay it. An airline that refuses self check-in on your fare is reported in the
  page's own words, unpressed. An app-only airline, a desk-only airline and one nobody has written
  down each say their own honest thing rather than guessing at a URL.

  **The pass comes back as a Reason page** named off the row — "Boarding pass · ATL 7:15 AM", with
  the seat, the code and the airport's local time on it — and it says what it is not: Reason's own
  page, not the airline's scannable pass. All of it in `src/flights.js` and `src/airlines.js`,
  pinned by 56 tests in `test/flights.test.js` against a fake airline on 127.0.0.1.

  **Against the real model** (`test/flow-flights.test.js`, `claude-cli`, 2026-10-07) the whole card
  ran unaided. One sentence became a row with the right zone and the right 24-hour mark; the sweep
  raised *"check-in for your 7:15am to atlanta out of jfk is open. want me to do it?"*; "yes pls,
  aisle if u can" came back *"I've found your trip but haven't checked you in yet. It's Omari
  Nyarko, JFK to ATL, friday 7:15am, seat 14C, and the page shows no fee."* with **nothing
  pressed**; "yeah go for it" pressed it exactly once and said *"You're checked in. You've got 14C,
  and the airline's page says that's an aisle seat."* On the paying fixture it stopped: *"I won't
  put a card in for the $35 bag, and that page doesn't let you check in without it"*, then offered
  the airport counter.

  **What no test can prove: no real airline has ever been touched.** Every web step runs against
  `test/fixture-airline.js`, which is a fixture that cooperates. A real airline means a bot wall, a
  sign-in that expires, a seat map behind a modal and a page that changes next month, and none of
  that is settled here. Treat this as built, not working. `docs/unverified.md` has it test by test.

  </details>

- **[Organising their Drive](#their-drive)** — folders, moves, renames and the bin; a batch is proposed first · landed 2026-10-07
  <details><summary>Organising their Drive</summary>

  "I should also be able to organize." Reading a Drive and tidying one are two different Google
  permissions, and `drive.metadata` is the new one — so every connection made before today is
  answered with "reconnect and I can organise it", with the link, rather than a 403, and the check
  runs before the confirm gate so nobody is asked to approve something that was never going to work.
  Above that: one file moves on the asking; **more than one is proposed first** in counts and names
  and moves only on a yes pinned to that exact set; fifty is a refusal rather than a silent
  first-fifty; a failed move **stops** and says how many had moved; binning and
  sharing-with-a-person both ask and then wait out the undo window; and **no permanent delete
  exists** — a test walks every file in `src/` to keep it that way. Sharing reaches only files
  Reason made itself, which is said as a permission with the link offered, never as "Google refused
  it". `drive_upload` accepts only paths under `REASON_DATA_DIR`, resolved through `realpath`, which
  is what stops a sentence in somebody's message pointing it at private files. Walked live with the
  real model on 2026-10-07 against a fake Google: "make a folder in my drive called Taxes 2026" was
  just done, "ok now move my receipts into it" came back as “I only found 2 receipts in your drive,
  the dentist one and the plumber one. Want me to move both into Taxes 2026?” with nothing moved,
  and “yes” moved exactly those two and left the unrelated doc alone — no file id in any of the
  three replies. Never run against a real Google Drive, and the scope is not on Google's Data Access
  page yet; see `docs/unverified.md`.

  </details>

- **[It notices when you skip](#noticing-things-first)** — a standing commitment; the time goes past, one nudge, and the session handed over · landed 2026-10-07
  <details><summary>It notices when you skip</summary>

  A thing you say you *do* — **"leg day tuesdays and fridays 7am"** — is a commitment rather than a
  reminder, and the difference is that **nothing happening is the news**. So there is no timer
  behind one: the sweep reads the rows and the clock, and an occurrence with no log against it at
  ten past seven *is* the event. The zone is stamped on the row when you set it, so a 7am is 7am
  where you are, and stays 7am on both sides of the clock change. **The nudge is one text and then
  the session.** It goes out through `src/notice.js` like everything unprompted — inside your waking
  hours, one per occurrence and never a second, and silent the moment you have already said you
  went. It names the real thing and the real time ("leg day. you said 7 and it's 7:12 👀"), hands
  over **your last session** with every exercise's sets and reps, and then **the figure you really
  hit with a higher one to go for**. That last part is the whole point: a nudge on its own leaves
  you a decision, and removing the decision is the help. A schedule *you* set does not spend the
  day's one unprompted text — but it is still one nudge, and the hour you named carries its own
  permission and nothing wider, so a 5am commitment gets its 5:10 text and your night is otherwise
  still your night. **Every number comes off a row you logged, and there is no other source.** With
  nothing logged it says it has not got last time's numbers and asks for today's instead of naming a
  weight — a made-up 185 is Reason inventing your own body back at you. **No shame, written as
  refusals rather than manners**: no count, no streak, no days-since, no disappointment, no asking
  why. "cant today" is the end of it — one warm line, logged, no re-ask, and nothing more that
  morning however many sweeps run. Something hurting gets no plan, no numbers and no advice of any
  kind. **Three missed in a row is a wrong schedule and not a reason to push**: it asks once whether
  to move it or drop it, and either answer is a good one. All of it is read as meaning by the model
  — "omw", "already went", "cant today", "move it to 8", "my knee hurts" — and nothing anywhere in
  it matches a pattern. What you do on a schedule is **on the memory page with your numbers under
  it**, and correcting it really is one text: saying the new time keeps every session already logged
  against it. All of it in `src/commitment.js`, pinned by 43 tests in `test/commitment.test.js`.
  **Against the real model** (`test/flow-habit.test.js`, `claude-cli`, 2026-10-07) the card ran word
  for word: at 7:12 with nothing from him, *"leg day. you said 7 and it's 7:12 👀"*, then *"squats
  4x8, rdl 3x10 @ 135, lunges 3x12"*, then *"you hit 175 on squats last week. go 180."*; "omw" got
  the whole session back and *"squats were 175 last time, so 180 today."*; "squats 185x8" was logged
  and answered *"185 for 8, that's 5 more than i told you to go for 💪"*; and the next one, read off
  that log, opened *"you hit 185 on squats last week. go 190."* The same run proved a no is a no:
  "cant today" got no guilt and no second nudge, and "my knee hurts" got no session and no advice.
  **What tests cannot prove**: no real morning has happened. Every clock in every test is the fake
  one, so "it noticed a skip on a real Tuesday" is exactly the claim none of this makes. See
  `docs/unverified.md`.

  </details>

- **[The calendar check, and the event it confirms](#their-calendar)** — clashes shown as a tradeoff; nothing called "added" before it is read back · landed 2026-10-06
  <details><summary>The calendar check, and the event it confirms</summary>

  "A bare 'create event' action leaves me managing the rest." So putting something on a calendar is
  four things rather than one. **The diary is read first**: anything overlapping the proposed window
  comes back with its title, time and place, nothing is created, and the person is shown the
  tradeoff in their own words — "that's over your 2pm with Sarah, move it or keep both?" — and
  picks. Going ahead takes their decision carried back on the next call. A clear time is created in
  that same call with no extra question. **A time has to be a real time**: "Tuesday at 3" is refused
  rather than resolved against the server's clock, and so is a wall-clock time when neither Google
  nor the person has ever said which zone they are in — the tool names the question to ask instead
  of guessing. **Nothing is "added" on the strength of a 200**: every create and every time change
  is read back from Google by id and compared, and an event that landed an hour out is reported as
  exactly that. **A correction corrects**: "make it 4 instead" changes that same event id, and a
  second create of the same thing on the same day is refused and handed the id. What a conflict
  check cannot do is a judgement about which of two things matters more — that is always the
  person's. Walked live with the real model on 2026-10-06 against a fake Google: a clash over a
  coffee got “I haven't added it yet … want to move one of them, or keep both?”, “keep both” made
  exactly one event, and “actually make it 4pm” moved that same one. Never run against a real Google
  calendar; see `docs/unverified.md`.

  </details>

- **[Hand back the furthest point](#working-between-messages)** — a filled form and the one tap left, never a bare couldn't do it · landed 2026-10-06
  <details><summary>Hand back the furthest point</summary>

  A job's sheet carries a `furthest` record: what was reached, the shape it is in (a filled form, a
  ready draft, a partial result, a browser sitting on the right page), a link if there is one, what
  is already filled in, the ONE thing left for them to do, and why it stopped — from a fixed list.
  Append-only; the newest is what gets handed back. Three parts are code's: a job that got anywhere
  cannot be closed `failed` or set `blocked` with none of it handed over (one `task_update` clears
  it, and a job that produced nothing is refused nothing); a link on a hand-back is fetched first
  and a dead one refused; and when a browser walk stops — the commit click the gate will not press,
  a step the site refuses, or the ask for the yes itself — the address reached and the filled fields
  are read off the page and written down by code. Passwords are never recorded and a card-shaped
  value is recorded as filled with the digits withheld. The link is handed back as the page it is,
  never as the form it is not. The open-work page shows it on a stuck job, with the link as a link.
  The money guards on that last button stop the same way — a total the yes does not cover, a page
  past a standing permission, a missing limit, the install's daily ceiling — and each refusal
  carries where it got to with its own reason. What code cannot do is make the reply lead with it,
  so that was run: on 2026-10-06, against a fixture booking site on the claude-cli backend the live
  Reason runs on, the real model walked to the last button, was stopped, and said "the form is
  filled with your name, Omari, and 555-0100 … want me to hit confirm?" — with no apology in it at
  all.

  </details>

- **[Cancelling a subscription](#subscriptions-find-them-cancel-them)** — fifteen services' flows read off their help pages, none walked · landed 2026-10-06
  <details><summary>Cancelling a subscription</summary>

  The registry in `src/cancel-routes.js` was read off fifteen services' own help pages on 2026-10-06
  and **not one of those flows has been walked**. No account here has ever been cancelled and
  nothing in Reason has ever pressed one of those buttons: the web rail is proved end to end against
  a fixture service on 127.0.0.1 (a sign-in, a retention offer, a two-step cancellation, a
  confirmation number), and the mail rail against the fake Google. On 2026-10-06 that fixture rail
  was also walked by the **real model**, unaided: it read the retention offer and said so, clicked
  past it, stopped at "Finish Cancellation", said the $5 fee and the end date back, asked, and
  pressed only after a yes in his own words. What a fixture cannot settle is whether Netflix's page
  still says "Finish Cancellation", whether any of these sites will talk to an automated browser at
  all, and whether a retention wall sits somewhere the registry does not know about. Four of the
  entries do not document their last button and say so; one could not be read at all and is
  `unknown`.

  </details>

- **[The Bland call provider](#phone-calls-and-the-recording)** — written from their docs, field by field; no phone has rung · landed 2026-10-05
  <details><summary>The Bland call provider</summary>

  Written from Bland's own docs (`POST /v1/calls`, `GET /v1/calls/{id}`, `GET
  /v1/calls/{id}/recording`, their webhook-signing page), read 2026-10-05, with the page named next
  to every field in `src/calls/bland.js`. There is no `BLAND_API_KEY` on this machine, so **no phone
  has ever rung**: 38 tests drive it with an injected `fetch` and assert on the exact URL and body.
  What only a real call can settle — that the opening line is really spoken word for word, that it
  really declines when asked for a card, that a recording really comes back, that a webhook really
  arrives — is all listed in `docs/unverified.md`.

  </details>

- **[Handing work to the builders on this machine](#handing-work-to-the-builders-on-this-machine)** — one real one-step hand-over ran; everything harder has not · landed 2026-10-05
  <details><summary>Handing work to the builders on this machine</summary>

  **One real hand-over has run end to end**, and that is the whole of it. 59 offline tests cover the
  switch, the master-only gate, the brief, what is read back off disk, the states, the pages, the
  quiet window and the delete; none of them start a process. On 2026-10-05 one real job was handed
  to a real `openclaw` session against a scratch data dir: the detached runner started, the builder
  read the brief and appended `progress`, `detail` and `done` lines in the shapes it was asked for,
  the sentinel landed with exit 0, the reply parsed out of the real envelope, the state settled to
  `done` from what the builder wrote, and both pages built. So the path works once, for a one-step
  job.

  What has **not** been run: a job long enough to be swept while mid-turn, a builder asking a
  question and the answer getting back to it, a risky action going through the gate to a real
  builder, two jobs at once, a restart mid-build, and the text itself (no channel is connected on
  this machine). Every state and page for all of those is offline-tested and none of them is proven.

  </details>

- **[The video model](#videos)** — request shape pinned header for header; nothing sent to Google · landed 2026-10-05
  <details><summary>The video model</summary>

  `src/gemini.js`, written from Google's current docs (POST to `models/<model>:generateContent`, a
  YouTube URL as `file_data.file_uri`, a time range as `video_metadata.start_offset`/`end_offset`,
  and for audio the Files API's two-step resumable upload then `file_data` with a `mime_type`).
  There was no `GEMINI_API_KEY` in the environment when this was written, so **nothing has ever been
  sent to Google** — it has only answered an injected fetch. The tests pin the request shape header
  for header, which is all that can be checked without a key. The halves either side *are* proved
  for real: the audio-only download, the file on disk, the deletion afterwards, and the cache
  spending nothing on a second ask were all run against a real YouTube video. Also unverified: the
  optional OpenAI transcriber in `src/transcribe.js`, same reason.

  </details>

- **[Video sites other than YouTube](#videos)** — `yt-dlp` covers hundreds; only YouTube has been tried · landed 2026-10-05
  <details><summary>Video sites other than YouTube</summary>

  `yt-dlp` covers hundreds of them and the code treats them all the same, but only YouTube has been
  tried. Expect the metadata to be thinner elsewhere and captions to be missing more often.

  </details>

- **[The Linq channel](#texting)** — iMessage / RCS / SMS from their v3 docs; no key, no text · landed 2026-10-04
  <details><summary>The Linq channel</summary>

  Written from Linq's published Partner API v3 docs, signature checking per the webhook spec they
  document. No key has ever sent a real text.

  </details>

- **[Sending an attachment over Linq](#texting)** — their documented pre-upload flow, so a recording rides along · landed 2026-10-04
  <details><summary>Sending an attachment over Linq</summary>

  Their documented pre-upload flow, so a call recording can ride along with the summary. Same
  caveat: never run.

  </details>

- **[The API path](#testing-on-a-claude-subscription-owner-only-local)** — all 25 live tests pass — through claude-cli, not the API · landed 2026-10-04
  <details><summary>The API path</summary>

  All 25 live tests now pass — but through the `claude-cli` backend on a Claude subscription, not
  through the Anthropic API that Reason actually ships on (there is no credit on this machine). Same
  prompts, same tools, different backend: no prompt cache, and the CLI owns the tool loop. So the
  behaviour is proved with a real model; the path it will run on is not. In this repo "live tested"
  means *via claude-cli*, and `docs/unverified.md` says so test by test.

  </details>

- **[Whether a real call keeps its promises](#phone-calls-and-the-recording)** — the announcement and the card refusal need a real voice agent · landed 2026-10-04
  <details><summary>Whether a real call keeps its promises</summary>

  Code can prove a call request cannot carry payment details and cannot be placed without the
  recorded announcement. Whether a real voice agent says the announcement first and holds the line
  when a restaurant pushes for a card is a property of whichever provider gets bought — and it is
  the first thing to test on the first real call.

  </details>

### Not connected, and what you have to supply

Reason says all of this itself when asked: the `capabilities` tool and `account_list` report every
one of these as not connected, with what is missing. It starts up fine with none of them. Newest
first; the fold is what you must supply.

- **[Buying things](#buying-things)** — an AgentCard organization; the person stores a card once · landed 2026-10-11
  <details><summary>Buying things</summary>

  An organization from [app.agentcard.sh](https://app.agentcard.sh): put its client id and secret in
  `AGENTCARD_CLIENT_ID` and `AGENTCARD_CLIENT_SECRET`. Then each person taps the vault link Reason
  sends once and stores a card on AgentCard's own page, locked with their own passkey — Reason never
  sees the number. For the webhooks, register `{REASON_PUBLIC_URL}/agentcard/webhook` as an endpoint
  and put the secret it hands back in `AGENTCARD_WEBHOOK_SECRET`; **the route fails closed without
  it**, like every other inbound hook here. Everything still works without the webhook — a stored
  card is noticed by reading the vault session instead — but the person is then not told when their
  card lands or when an approval is declined. **Sandbox credentials stop at the confirm by design**:
  the loop and the cart are identical to production and the confirm comes back `declined` with
  `decline_code: sandbox_mode`, because a sandbox card cannot pay a real shop.

  </details>

- **[Google Drive](#their-drive)** — two scopes on the Data Access page, then one tap each · landed 2026-10-06
  <details><summary>Google Drive</summary>

  The same OAuth client, plus **two scopes added on its Data Access page** —
  `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/drive.file`
  — and the **Drive API enabled** on the project. Google rejects an app whose code requests a scope
  not declared there, so until those two are on the page a Drive connect fails at Google's own
  screen rather than here. Nothing goes in `.env`: the code side is built. Then **each person taps a
  Drive link of their own** — connecting Gmail does not connect Drive, so everybody already on needs
  one more tap, and nobody has to redo their mail. `drive.readonly` is a **restricted** scope, which
  is the same review class Gmail already put this app in, so it changes the verification work not at
  all; `drive.file` is non-sensitive. See **Their Drive**.

  </details>

- **[Handing work to the builders on this machine](#handing-work-to-the-builders-on-this-machine)** — an OpenClaw install plus a flag; off by default on purpose · landed 2026-10-05
  <details><summary>Handing work to the builders on this machine</summary>

  `REASON_REMOTE_BUILD=1` plus an [OpenClaw](https://github.com/openclaw/openclaw) install on the
  same machine (`REASON_OPENCLAW_BIN`, `REASON_OPENCLAW_AGENT`). Off by default on purpose and the
  master's alone even when on — see **Handing work to the builders on this machine** above. With it
  off there is no such tool and nobody is told one exists; Reason still writes code for anyone who
  asks, it just has nobody to hand the running of it to.

  </details>

- **[Phone calls](#phone-calls-and-the-recording)** — a Bland account at $0.14 a connected minute; caps hold it · landed 2026-10-05
  <details><summary>Phone calls</summary>

  A [Bland](https://app.bland.ai) account, then `REASON_CALL_PROVIDER=bland` and `BLAND_API_KEY`.
  Their published Start-plan rate is **$0.14 a connected minute**, free to sign up;
  `REASON_MAX_CALLS_PER_DAY` and `REASON_MAX_CALL_MINUTES_PER_DAY` are what stop one person running
  that up. Optional: `BLAND_FROM_NUMBER` (without it Bland dials from its own pool), and
  `BLAND_WEBHOOK_SECRET` from their dashboard so the call-finished webhook is verified by signature
  rather than only by the unguessable token in its URL. With no `REASON_PUBLIC_URL` there is no
  webhook at all and outcomes are polled, which Bland's own docs call the right answer rather than a
  workaround. `docs/call-providers.md` compares the alternatives.

  </details>

- **[Web search, and therefore research](#research-with-a-real-pick)** — a Tavily key; 1,000 free credits is ~200 questions a month · landed 2026-10-05
  <details><summary>Web search, and therefore research</summary>

  `TAVILY_API_KEY`, from [app.tavily.com](https://app.tavily.com). **1,000 API credits a month,
  free, no credit card** (their docs, read 2026-10-05). A basic search costs 1 credit, so that is
  about 1,000 searches a month, and one research run spends up to 5 of them — roughly 200 questions
  a month on the free tier. Past it: **$0.008 a credit** pay-as-you-go, or $30/mo for 4,000. Reading
  the pages afterwards is free (a plain fetch, not a Tavily extract). Without it, `capabilities`
  says search is not connected, `research` refuses rather than guessing, and Reason reads a page
  whose address it can name itself and says that is all it did. Brave Search is the alternative and
  is **not wired**: its free tier is $5 of monthly credit on a billing plan.

  </details>

- **[Watching a video, or reading one with no captions](#videos)** — a Gemini key; ~0.45 cents a minute to watch · landed 2026-10-05
  <details><summary>Watching a video, or reading one with no captions</summary>

  `GEMINI_API_KEY`, from aistudio.google.com. Per Google's docs (2026-10-05): a video is ~100 tokens
  per second at default media resolution, audio is 32 tokens per second, so on `gemini-3.8-flash` at
  $0.75 / M input that is roughly **0.45 cents a minute to watch** and **0.14 cents a minute to
  listen**, plus output. Free tier capped at 8 hours of YouTube a day. Public videos only. Capped at
  `REASON_VIDEO_MAX_MINUTES` (60) a video and cached per video and tier. No ffmpeg needed. Without
  it, a caption-less video comes back saying there is no way to know what is in it, and Reason says
  that.

  </details>

- **[Videos at all](#videos)** — just `yt-dlp` on the machine — no key, no account · landed 2026-10-05
  <details><summary>Videos at all</summary>

  Nothing but `yt-dlp` on the machine (`pipx install yt-dlp`, `brew install yt-dlp`, or the
  standalone binary), or `REASON_YTDLP_BIN` pointed at it. No key, no account. It is what fetches a
  video's details, its captions and its audio, so with it missing there is nothing Reason can find
  out about any video — and the tool and `capabilities` both say so.

  </details>

- **[Listening to a voice note](#what-they-send-photos-voice-notes-links)** — a Gemini key plus afconvert, or ffmpeg on Linux · landed 2026-10-05
  <details><summary>Listening to a voice note</summary>

  `GEMINI_API_KEY`, plus `/usr/bin/afconvert` (part of macOS) or `ffmpeg` on the PATH — on Linux
  that means installing ffmpeg.

  </details>

- **[An iPhone photo (HEIC)](#what-they-send-photos-voice-notes-links)** — nothing on a Mac; on Linux it is refused honestly instead · landed 2026-10-05
  <details><summary>An iPhone photo (HEIC)</summary>

  Nothing on a Mac — `/usr/bin/sips` is part of the OS. **On Linux there is nothing to supply:** the
  conversion is sips and has no fallback, so an iPhone photo is refused honestly rather than read.

  </details>

- **[Google verification (no "unverified app" screen)](#their-email)** — Google's own review; nothing in `.env` makes it go away · landed 2026-10-05
  <details><summary>Google verification (no "unverified app" screen)</summary>

  Nothing in `.env` makes this go away: it is Google's review of the project, done in the Cloud
  console by the project owner. The code side is ready — public home, privacy and terms pages, the
  Limited Use statement, the narrowest scopes, an in-product notice with every link, and
  `GOOGLE_SITE_VERIFICATION` for Search Console. What is left is a domain the owner controls (the
  Tailscale name counts as Tailscale's), Search Console, a demo video, the scope justifications, and
  for Gmail a paid annual security assessment. Step by step in `docs/google-verification.md`.

  </details>

- **[Spotify](#spotify)** — a developer app and a redirect URI; Premium to play · landed 2026-10-05
  <details><summary>Spotify</summary>

  A developer app from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard):
  put its id and secret in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and add
  `{REASON_PUBLIC_URL}/spotify/callback` to the app's Redirect URIs. Then each person taps the link
  Reason sends and approves on Spotify's own page. Playing, pausing, skipping and queueing need
  Spotify Premium.

  </details>

- **[OpenTable, Uber, DoorDash, Uber Eats, Amazon, Delta, United, Ticketmaster, Fandango](#saved-sign-ins-and-real-sites)** — you sign in once yourself; six of the ten refuse a browser · landed 2026-10-05
  <details><summary>OpenTable, Uber, DoorDash, Uber Eats, Amazon, Delta, United, Ticketmaster, Fandango</summary>

  You, signed in once yourself: `npm run signin -- <site>` opens a real window, you sign in, you
  close it. Reason never sees a password. **Six of the ten refuse an automated browser today** — see
  "Saved sign-ins and real sites" above for which.

  </details>

- **[Gmail and Calendar](#their-email)** — a Web application OAuth client; no refresh token in `.env` · landed 2026-10-04
  <details><summary>Gmail and Calendar</summary>

  A **Web application** OAuth client from the [Google Cloud
  console](https://console.cloud.google.com/auth/clients), with the Gmail and Calendar APIs enabled
  on the project: put its id and secret in `GOOGLE_OAUTH_CLIENT_ID` and
  `GOOGLE_OAUTH_CLIENT_SECRET`, and add `{REASON_PUBLIC_URL}/google/callback` to its Authorized
  redirect URIs, exactly — scheme, case and trailing slash all have to match. **No refresh token
  goes in `.env`**: that was the old shape, from before each person had their own Reason, and one
  refresh token there would mean everybody who texted reached the same inbox. Each person taps the
  link Reason sends and agrees on Google's own page, and their refresh token is stored against their
  conversation **and the address Google reported for it**, so one person can connect several Google
  accounts and each keeps its own grant. While the consent screen is in Testing, only listed test
  users can connect and Google expires each connection after 7 days. Published and unverified, the
  cap is 100 **Google accounts** over the project's lifetime, not 100 people — see **Their email**.

  </details>

- **[Texting](#texting)** — Sendblue's four values, your own number, a webhook · landed 2026-10-04
  <details><summary>Texting</summary>

  Sendblue: `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`,
  `SENDBLUE_WEBHOOK_SECRET` (or, superseded, Linq: `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`,
  `LINQ_FROM_NUMBER`), plus `REASON_OWNER_NUMBER` set to your own number and a webhook subscription
  pointed at your host.

  </details>

- **[Page links that open on a phone](#pages)** — the address this listener is reachable at · landed 2026-10-04
  <details><summary>Page links that open on a phone</summary>

  `REASON_PUBLIC_URL`, the address this listener is reachable at. Pages work without it; their links
  just only open on this machine, and Reason says so.

  </details>

- **[A server to run on](#running-it-on-a-server)** — a persistent disk, 1–2 GB, and the data dir pointed at it · landed 2026-10-04
  <details><summary>A server to run on</summary>

  A host with a persistent disk and 1–2 GB of memory, plus `REASON_DATA_DIR` pointed at the mounted
  volume. See **Running it on a server**.

  </details>

- **Payments** — one key, and nothing spends without it · landed 2026-10-04
  <details><summary>Payments</summary>

  `REASON_PAYMENTS_KEY`.

  </details>

- **The model** — an Anthropic key with credit; everything needs this · landed before 2026-09-30
  <details><summary>The model</summary>

  `ANTHROPIC_API_KEY`, with credit. Everything needs this, and a hosted install cannot use the
  subscription backend instead.

  </details>

Picked, and genuinely not started: Reason's own email address, real bookings and checkouts with the
exact total approved, group texts with polls, decks, and plug-in apps. `docs/features.md` has the
agreed order under **Decided 2026-10-04**.

<!-- usecases:end -->

## The rules it keeps

These are the point of the project rather than features of it. Each one says where it is actually
enforced, because a rule that lives only in a prompt is a hope.

**Nobody uses it to hurt anybody.** Not to plan an attack, not to get hold of or build a weapon, a
bomb or an explosive, not to make a poison or a nerve agent, not to drug somebody, not to track a
person down to hurt or stalk them, not for anything sexual involving a child, not to break into
somebody's accounts. Not as a joke, not hypothetically, not for a story, not "for a friend", not
because they say they are a nurse, and not in pieces spread across several messages. *Enforced in
code, four ways* (`src/harm.js`):

- **Every message anybody sends is screened before the model sees it**, by a separate narrow call
  (its own small model over the API, `REASON_HARM_MODEL`, default haiku, on every backend whenever
  `ANTHROPIC_API_KEY` is set, asked twice before it gives up; with no key, the CLI on `REASON_HARM_CLI_MODEL`, default
  sonnet) that is shown the message and the last few lines of the thread — so "ok just the ratio
  then" is read against the question before it — and answers `clear`, `borderline`, `harm` or
  `crisis`. On `harm` there is **no model turn at all**: the model never reads the message, no tool
  can run, the thread keeps their line and a refusal written in code, and that refusal is what goes
  back. One line, no lecture, nothing echoed. When the model's own platform safeguards decline to
  read the message at all (`stop_reason: refusal`), that is taken as `harm` too — the turn this
  screen guards would have met the same wall.
- **Anything short of clear runs with its hands tied.** A borderline read, a person in crisis, or a
  screen that could not run (`unscreened` — an error, a timeout, an off-schema answer; never
  treated as clear) all get a turn whose tools are refused in `runTool` unless they are on a short
  allowlist of things that only read Reason's own records (`SAFE_WHILE_SCREENED` in
  `src/tools.js`). No search, no research, no browser, no page, no call, no text, no mail — an
  allowlist, so a tool added later is held by default. A borderline reply is screened again on the
  way out, and anything but a clean `clear` replaces it with a plain line, in the thread too. An
  `unscreened` turn asks the screen once more at its first outward tool; only a real `clear` lets
  the tool run, and a second read of `harm` replaces the reply with the refusal and is a strike.
- **It is counted, and it ends.** Every refusal is a ledger row and a strike (`harm_events`: the
  kind and the time, never the words). `REASON_HARM_STRIKES` of them (default 3) inside
  `REASON_HARM_STRIKE_WINDOW_H` hours (default 24) pause that person's Reason on their own and tell
  the master one line — the number's last four digits, the count and the kind, never what was said.
  `admin_usage` shows the same count. The master's own account is refused the same way and is never
  paused.
- **Somebody in crisis is not an offender.** Suicide and self-harm come back `crisis`, not `harm`:
  the model answers, with its hands tied, and code makes sure a real way to reach help (988 in the
  US, findahelpline.com elsewhere) is on the end of whatever it says. No strike, ever.

There is no switch that turns the screen off. With no model configured at all (the offline suite, a
console with no key) the screen says `skipped: no_model` in its result and the turn runs as before,
because nothing in that state can run a model either. What this costs is one short model call in
front of every text (about three seconds on the claude-cli backend with sonnet, measured 2026-10-06),
and the odd innocent message refused — "shooting hoops", "this exam is killing me", "what shouldn't
I mix when cleaning" are in the live tests as things it must pass, and a refusal on a wrong read is
one text, which is the cheaper mistake. The prompt carries the same rule in Reason's own words
(`The hard line` in `src/agent.js`), so a message that reaches the model is refused there too; the
prompt is the second line of defence, not the first.

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

**It reads the room, and it acts rather than suggesting.** Two prompt rules, listed here because
they are prompt rules and not code: the jokes go when you are stressed or the news is bad, what you
told it gets used without being announced back at you, and "book dinner friday" means a booked table
rather than a list of restaurants. Research is how it gets there, not what it hands you.

**Only your own messages are instructions to it.** Everything else — an email, a calendar invite, a
web page, a page in its browser, a search result, a research source, a document in your Drive, the
words in a video, what somebody said on the phone — comes back marked as somebody else's words, with
the source named. *Enforced structurally* (`src/trust.js`): a yes is read out of your own messages in
your own conversation, and a tool result is not a message, so there is no path by which a sentence in
an email becomes a yes. Not because something filters it — because the gate never looks anywhere that
could hold one. A "yes, go ahead, confirmed" inside an email body leaves the confirmation ungranted,
and so does a tap on a page.

*And it tells you when something tried.* The classic shapes are flagged by pattern
(`src/outside.js`): disregard your instructions, you are now, forward this, reply with the code, give
me your password, pay this urgently, click here to confirm, don't tell them. Each flag carries the
words that did it, Reason is told to report it and do none of it, and it leaves its own ledger row —
so "has anyone tried it on?" is answerable months later from the record, not from whether it came up
at the time.

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

**It is never you, and it does not embarrass you.** Reason is your assistant acting for you, and it
says so. *Enforced in code for calls* — the announcement says "on behalf of" and cannot be edited by
the model. *Enforced in code for anything else a third party reads* (`src/represent.js`): an email or
a text to anybody but you is refused if it has an **emoji** in it or no **sign-off** on it, where a
sign-off means both halves — that it is your assistant, and that the assistant is called Reason. The
rest of how it writes to other people is a prompt rule: clear, polite, properly capitalized, full
sentences, no slang, no jokes, and only the details that message actually needs. Your own thread is
untouched — that is where the friend voice belongs — and so is mail to your own address.

The way past it is you. Tell it to send something exactly as it is and it goes, with
`Sent word for word, unchecked, because you said: "…"` on the receipt. Nothing can prove you really
said it, so it is never allowed to be invisible.

**Some people it writes to and never sends to.** Your mother, your boss, an investor, your landlord,
your doctor — anyone where getting the tone slightly wrong costs a relationship rather than an email.
`important_add` puts somebody on that list with your own reason for it; a send to them is refused and
the draft is handed over instead, in a copy block or straight into your Gmail drafts, for you to check
and send. A standing permission to text that person does not get past it. An entry with no number or
address saved cannot actually stop a message, and `important_list` says so for that entry rather than
letting you believe otherwise.

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
src/represent.js how Reason comes across to everybody who is not its person: the emoji and sign-off
                 checks on anything a third party reads, and the people it drafts for but never
                 sends to
src/outside.js   everything that is not the person's own words: the mark and the named source on
                 every reading tool's result, and the scan for the manipulation shapes
src/whatsnew.js  the announceable features and the two gates on them: a verified record somebody
                 filled in by hand, and the capability being live for the person being told
src/notice.js    noticing things first: what their calendar and mail say that slipped, the one-a-day
                 budget, their quiet hours, the moment a catch is worth sending, and the gate every
                 unprompted line goes through. Code decides when to look and how often to speak;
                 the model decides what is worth saying
src/series.js    standing check-ins: the rule, the next occurrence in the person's own local days,
                 quiet hours, the collapse of what was missed while the process was down, and what
                 they said back last time. Every firing is an ordinary timer row
src/db.js        SQLite (node:sqlite): conversations, plans, timers, series, tasks, people, calls,
                 threads, watches, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + the sweep: timers, standing check-ins, tasks,
                 watchers, dropped threads, what finishing something sets in motion, and the
                 watchful look at mail and calendar
src/serve.js     the long-running process; src/http.js is its listener and serves pages
src/channels/    Channel interface (send, send-with-an-attachment, typing, receive) + console,
                 fake and Linq adapters, and the router that decides whose conversation an
                 inbound message belongs to
src/pages/       what a page may contain (content.js), our HTML template (render.js), and who
                 gets to see one — codes, cookies, rate limit (access.js)
src/calls/       CallProvider interface, two adapters — Bland (bland.js) and GPT-Live over Twilio
                 with Reason itself as the brain (gptlive.js + voice.js, the in-process turn, plus
                 inbound.js for who is ringing and postcall.js for after) — a fake, which one this
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
$ LINQ_API_KEY=x REASON_BACKEND=claude-cli npm run serve
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

Every CLI child is sealed (`sealedCliHome` in `src/backends/cli.js`): it runs in an empty directory
outside the repository (`~/.reason-cli/cwd`), with CLAUDE.md / AGENTS.md loading off, and with
`~/.reason-cli/config` as its `CLAUDE_CONFIG_DIR`, so the CLI's login profile — the operator's
account email — and any workspace file on the machine never reach a person's turn. The child
signs in with `CLAUDE_CODE_OAUTH_TOKEN` (or a linked `~/.claude/.credentials.json`); a login that
lives only in the macOS keychain is not seen from the sealed config. `REASON_CLI_HOME` moves it.

The point of serving the tools in-process rather than as a CLI-spawned subprocess is that the
tools are then *the same code in the same process*: one SQLite writer, one Chromium that stays open
across turns, and every tool call landing in the same log the API backend writes. The gate, the
owner check and the ledger are exercised, not simulated.

Both backends also hand a tool the **same context**. Anything a turn is handed beyond the arguments
`runTurn` names is spread into every tool's context, and until 2026-10-06 this path dropped all of
it and built the context from four fields — so a fixture pointed at the cancel tools reached them on
the API path and silently did not here, which made the cancel rails unprovable on the only backend
there is a model for. `test/cli-ctx.test.js` pins the parity from both ends.

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
  --env-file .env \
  -e REASON_OWNER_NAME=Omari \
  -e REASON_OWNER_NUMBER=+12025551234 \
  -e REASON_PUBLIC_URL=https://reason.example.com \
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

**The three buckets are generated, not typed.** They live in `docs/usecases.json` — one entry per
use case with its name, its one-line hook, its bucket and the date it landed — and
`node scripts/usecases.mjs` rewrites the README between the `usecases:start` and `usecases:end`
markers from it, newest first with the detail folded. So a new use case is a new entry in that file
and a re-run, never a hand-edit between the markers; `test/usecases.test.js` fails if the two drift,
if a line points at a section heading that is not there, or if one of the honest "never" sentences
goes missing in a reflow. A date comes off the record — the `(added YYYY-MM-DD)` header in
`docs/features.md`, or `git log -S"<phrase>" -- README.md` for the first commit that mentioned the
thing — and when it genuinely cannot be pinned down the entry says `before 2026-09-30` rather than
guessing.
