# Unverified: live tests that have not passed against the real model

Reason's guards are tested two ways. Most logic is deterministic and runs with no API key at all —
that is the suite that gates every commit:

```bash
npm run test:offline      # must be fully green: zero failures, live tests skipped
```

The rest needs the real model, because what it proves is that the model reads a real message
correctly. Those tests skip themselves when `ANTHROPIC_API_KEY` is absent. They are listed below
because they have **not been run successfully against the current code**, so nothing here should be
described as working.

When credit is back, this is the first job:

```bash
npm test                  # the whole suite, live tests included
```

Then fix whatever it shows and delete the lines that pass.

---

## Commit: Group 3 — body v0 (browser, web lookup, errand flow)

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-errand.test.js` | drives the booking site to the confirm step and stops there | The model works a booking site unaided — search, pick a slot, fill the form — and stops at the commit click with a pending confirmation naming the real place and time. Nothing booked. |
| `test/flow-errand.test.js` | an explicit yes books it once, for real, with a receipt | After a yes, the gated submit goes through exactly once on the fixture, with the right party size, name and phone, and a ledger row naming the confirmation that authorized it. |
| `test/flow-errand.test.js` | 'did it actually go through' is answered from the ledger | "Did that actually go through" is answered from the record, quoting the confirmation code the fixture really returned, and asking does not book a second table. |

These three did each pass live on 2026-09-30 at some point, but never together in one run and never
after the gate's spend fix landed, so they are listed until a clean `npm test` says otherwise.

### Also behind the gate, so re-listed

These passed live on 2026-09-30 under the gate as it was. They are not re-proven against the
current code.

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow.test.js` | dinner with a named place, time and person → one plan, nothing re-asked | Details already given are used, not asked for again. |
| `test/flow.test.js` | change one detail from the DM → same plan updated, no new plan | A changed detail updates the existing plan. |
| `test/flow.test.js` | owner's own question answered with a bare 'no' is not dropped | A bare "no" lands on the question it answers. |
| `test/flow.test.js` | 'never mind' is acknowledged and does not cancel | "Never mind" is acknowledged in words and cancels nothing. |
| `test/flow.test.js` | lock, then a day-of reminder timer exists and fires as a message | Locking sets a real day-of timer that fires as a message. |
| `test/flow.test.js` | clear cancel → cancelled, and its timers are gone | A clear cancel cancels, and takes its timers with it. |
| `test/flow.test.js` | asks for something Reason can't do → honest, no fake link, no fake venue | A capability it does not have is admitted, with no invented venue or link. |
| `test/flow-trust.test.js` | asked to get into gmail → honest not_connected, nothing connected | A provider with no credentials is reported as not connected, plainly. |
| `test/flow-trust.test.js` | 'what have you done' reads the ledger, not memory | "What have you done" is answered from the ledger. |
| `test/flow-trust.test.js` | connecting an account stops at the gate: asked, nothing connected yet | Connecting an account stops at the gate with nothing connected. |
| `test/flow-trust.test.js` | an explicit yes opens the gate exactly once and leaves a receipt | One yes opens the gate once and leaves a receipt. |
| `test/flow-trust.test.js` | revoke cuts it off with no second confirmation | Revoking needs no second confirmation. |

### What *is* proven offline for this commit

`test/browser.test.js` drives the whole fixture booking site through the real tools with no model:
the snapshot/ref loop, `web_lookup`, that `browser_click` refuses a commit button, that
`browser_submit` without a yes is refused, that one yes books exactly once and cannot book twice,
that a submit which pressed nothing does not burn the yes, and that every step leaves a ledger row.

---

## Commit: the confirm gate reads meaning with the model

Every `confirm_record` now goes through a separate model call (`src/judge.js`) that reads what the
owner's reply meant, replacing the keyword lists. That call is on the path of **every live test
above**, so none of their earlier passes carry over.

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-gate.test.js` | "no problem, book it" is a go-ahead | The judge reads a go-ahead that contains the word "no". The old keyword list refused this. |
| `test/flow-gate.test.js` | "don't wait, do it now" is a go-ahead | The judge reads a go-ahead that contains "don't". The old keyword list refused this. |
| `test/flow-gate.test.js` | "perfect, lock it in" is a go-ahead | The judge reads a go-ahead built from none of the old list's words, which used to mean asking again. |
| `test/flow-gate.test.js` | "ok but make it 9 instead" authorizes nothing | **The dangerous one.** Approving while moving the time authorizes nothing: the 8:00 on record is neither granted nor refused and nothing is booked. The old keyword list read this as a yes and would have booked the 8:00. |
| `test/flow-gate.test.js` | a changed detail is re-asked and the booking lands on the new time | End to end: the 8:00 is never booked, Reason re-asks with 9:00, and after a fresh yes there is exactly one booking at 9:00 PM, authorized by the second confirmation. |

`test/flow-gate.test.js` → `a bare "no" is refused` is **not** listed: it needs no model call and
passes offline. It only shows as skipped because its file is skipped wholesale without a key.

### What *is* proven offline for this commit (the gate)

`test/trust.test.js`, using a stated verdict in place of a real one: that a `change` verdict grants
and refuses nothing and leaves the old confirmation dead to its own action; that a broken,
timed-out or off-schema judge always lands on `unclear` and never grants; that the real `judgeReply`
returns `unclear` rather than throwing when the call cannot succeed; that the judge is handed only
the recorded summary and the reply verbatim, with no conversation history; that a flat no never
reaches the judge at all; and that single use, expiry, one-action-per-yes and the stored quote all
still hold.

---

## Commit: Group 4 — proactive (watchers, dropped threads, reminders)

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-proactive.test.js` | asked to keep an eye on a page, it sets a real watcher | "Keep an eye on this" produces an actual row in the watches table with a specific condition written down, not a promise in prose. |
| `test/flow-proactive.test.js` | a watcher fires only once the page really changes | On an unchanged page the model does not claim a hit; once the page really says a table is free it fires exactly once and then stops. This is the honesty test for watchers. |
| `test/flow-proactive.test.js` | a dropped thread is picked back up with one message about something open | Given a plan idle for hours with open questions, it either sends exactly one message or chooses silence — and either way does not raise the same thread again inside the gap. |
| `test/flow-proactive.test.js` | a day-of reminder and a morning-after check-in both arrive | Asked for both, it sets two real timers at the right times and each one produces a message when it fires. |

### What *is* proven offline for this commit (proactive)

`test/proactive.test.js`, 24 tests, with the turn runner, the page fetch and the watch check all
injected — so the schedule and the bookkeeping are proved without a model:

- a day-of timer fires once as an event turn carrying the note and the plan's current state, and a
  fired timer never fires again; a cancelled timer never fires; a morning-after timer is independent
  of the day-of one
- choosing silence on an event turn sends nothing
- a dropped thread is a plan with open questions where both the plan and the conversation have been
  idle past the threshold; warm threads, question-free plans, and locked/cancelled/done plans are
  never chased, whatever their questions say
- the rate limit: the same plan is not raised twice inside the gap, the daily cap holds across
  different plans, the cap survives a new `Runtime` because it is counted in the `nudges` table, it
  rolls off after 24h, a capped conversation costs no model call at all, and silence does not spend
  the cap
- watchers: an interval floor, a non-URL and a non-http scheme both refused, re-checks happen on
  schedule rather than every pass, the previous page text is carried into the next check, an
  unreadable page is never handed to the checker and is never a hit, a lookup that throws is
  survived, an unsure checker never fires, a met watch fires once and is never checked again, a
  cancelled watch is not checked, a watch gives up at the ceiling and says so, and `watch_list`
  reports only what is really running
- one `sweep()` runs timers, watchers and dropped threads together, as three separate event turns

---

## Commit: Group 5 — memory is about people

No new live tests. `remember` and `recall` keep the same shape the model already sees, so every
live test that touched them is unaffected; what changed is behind them.

### What *is* proven offline for this commit (memory)

`test/memory.test.js`, 11 tests, no model: that "Kofi", "  kofi " and "KOFI." are one subject and
the first spelling stays as the display name; that the same fact twice is one fact and the tool
says so; that `remember` hands back everything known about them, not just the new line; that
`recall` with no name is everyone most-recently-touched first; that a partial name finds them with
the exact subject ranked first; that knowing nothing says so plainly and tells the model not to
pretend; that one conversation's memory is not another's, for both `recall` and `forget`; that
`forget` drops the subject with its facts and leaves no orphans, and fails honestly on someone
there is nothing on; and that an install from before this change keeps what it knew, with the move
running exactly once and never duplicating.

---

## Commit: Group 6 — durable tasks (work that outlives a message)

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-tasks.test.js` | "chase the handyman" becomes a task, not a promise | Asked for something that cannot finish in one message, Reason starts a real task row with a goal and a wake time rather than saying it will get on it. |
| `test/flow-tasks.test.js` | "what are you working on" is answered from task_list | The answer names the real open tasks and their last progress line, and invents nothing. |
| `test/flow-tasks.test.js` | a task wake with no news stays quiet | Woken on a task where nothing moved, Reason takes the step, writes it down and says nothing. |
| `test/flow-tasks.test.js` | a task that finishes reports once, in Reason's voice | The finish is a single message naming what actually came of it, from the task's outcome. |

### What *is* proven offline for this commit (tasks)

`test/tasks.test.js`, 15 tests, with the turn runner injected:

- `task_start` writes a real row with a wake time and explicitly claims nothing has happened yet;
  `task_list` is the truth of what is running, and tells the model to say so when nothing is
- a task survives the process: a brand-new `Runtime` with nothing in memory picks it up off the
  row alone, at the right time, and is told its own goal and progress log
- a due task fires exactly once, not on every pass, because the wake is cleared before the turn
- **the reporting rule**: the task's signature (state, outcome, newest log line) is taken before
  the turn and again after, and a step that changed none of them sends nothing *whatever the
  model wrote* — a change reports exactly once
- a task left open with no wake time is re-scheduled at the default rather than lost
- **the retry rule**: a crashing step is counted and backed off a step each time, says nothing
  while it still has budget, and at the budget is marked failed with the real error in its
  outcome, told to the owner exactly once in plain words, and never woken again
- real progress resets the crash budget, so a long task is not treated as a failing one
- a task that keeps waking without finishing gives up at the ceiling and says so
- a closed task cannot be updated or finished twice; one conversation's tasks are not another's;
  `task_update` refuses to close a task behind `task_finish`'s back
- one `sweep()` runs timers, tasks, watches and dropped threads together

---

## Commit: Group 7 — serve, channels, and the Linq adapter

Two different kinds of unverified here. The first is the usual: live tests needing the model.
The second is new and more important — **no request in `src/channels/linq.js` has ever been made
against Linq's real API.** It was written from Linq's public Partner API v3 docs
(docs.linqapp.com, read 2026-10-04) and its offline tests prove it builds the documented request
and verifies the documented signature. They cannot prove Linq agrees. Nothing about the Linq
adapter should be described as working until a real key sends a real text.

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-tasks.test.js` | "chase the handyman" becomes a task, not a promise | (listed above) |
| `test/flow-channel.test.js` | asked to text someone, Reason stops at the gate with the real number | The number and the words it is about to send are said back before anything goes out. |
| `test/flow-channel.test.js` | a yes sends exactly one text to the third party | After a real yes, one message goes out with the words that were confirmed, and a second attempt on the same yes is refused. |
| `test/flow-channel.test.js` | asked to text someone with no channel connected, it says so | With no credentials, Reason says texting is not available and offers the nearest real thing, rather than claiming to have sent anything. |

### What *is* proven offline for this commit

`test/channels.test.js`, 28 tests, no model and no network:

**The owner boundary.** The owner's number lands in the owner's conversation; any other number
gets its own thread and is labelled to the model as a stranger. A stranger's thread cannot run
`confirm_request`, `confirm_record`, `account_connect`, `browser_submit` or `message_send` at
all — each is refused with `not_the_owners_thread` and no confirmation row is ever created, so
there is nothing for a stranger's "yeah go on" to grant. A stranger can still be *talked to*:
planning tools work there, scoped to their own conversation. Owner identity comes only from
config, and formatting (`+1 (202) 555-1234`) is not a different person.

**Dedupe.** The same event id delivered three times costs exactly one turn; two different ids in
the same second cost two.

**Sending.** `message_send` to the owner needs no yes and goes back into the thread it came from;
to anyone else it is refused without a confirmation, with the refusal written to the ledger
naming the number. One real yes sends exactly one text and is then spent. A channel that is not
connected fails with the missing env var named and sends nothing; with no channel at all the tool
says so rather than pretending.

**Capabilities.** With nothing connected, `message_people` is `not connected` and names the
missing credentials; with a channel live it says so and names the gate. The console is live but
is never counted as the ability to text other people.

**Linq.** Not connected with no key, and says which env vars are missing rather than throwing.
A correctly signed `message.received` parses in both documented payload versions (2026-02-03 and
2025-01-01). A bad signature, a body tampered with after signing, a timestamp outside the 5-minute
window, and missing headers are each refused with 401 and produce no turn; with no signing secret
nothing is accepted at all. A `message.delivered` event is acknowledged with 200 and ignored, so
a receipt never costs a model call. Sends hit the documented URLs with the documented bodies
(`POST /v3/messages` with `to` + `message.parts`, `POST /v3/chats/{id}/messages` for a known
chat, `POST`/`DELETE /v3/chats/{id}/typing`), with `idempotency_key` inside `message`, and an
HTTP error comes back as a readable error instead of being swallowed.

**The listener.** `/health` reports real counts read from the database; a webhook POST runs one
turn and a retry of it runs none while still returning 2xx; an unregistered channel and an
unknown path are 404s; a malformed body is a 400 with no turn; and `health()` is readable with no
channels at all, which is how a bare install starts.

**Started with nothing configured** (checked by hand, 2026-10-04): `npm run serve` with no
`.env` at all comes up, binds, prints `linq: not_connected (needs LINQ_API_KEY,
LINQ_WEBHOOK_SECRET)`, and warns that with no `REASON_OWNER_NUMBER` every inbound text is a
stranger's.

---

## Commit: Group 8 — phone calls (set up, not provisioned)

**No paid telephony provider is wired up.** The only provider that exists is `FakeCallProvider`,
which dials nothing. Nothing in this commit has ever rung a phone, and `capabilities` says
`phone_calls: not connected` until one is configured. The comparison of real providers is in the
build report, not in code.

| File | Test | What it proves |
| --- | --- | --- |
| `test/flow-calls.test.js` | asked to ring a restaurant, it stops at the gate with the number and the goal | The exact number and what the call is for are said back before anything is dialled. |
| `test/flow-calls.test.js` | a placed call is reported as ringing, not as an answer | Between placing and the result, Reason says it is ringing them and claims no outcome. |
| `test/flow-calls.test.js` | the result is read from call_status and quoted, not embellished | What Reason says happened on the phone matches the call record. |

### What *is* proven offline for this commit (calls)

`test/calls.test.js`, 19 tests, with a provider that dials nothing:

- with no provider, and with a provider switched off, `call_place` fails honestly and names the
  missing credential; `capabilities` repeats it and tells the model not to offer calls
- calling a third party with no yes is refused, nothing is dialled, no call row is invented, and
  the refusal is on the ledger naming the number it would have rung
- **the yes is per person, not per tool.** A confirmation carries the exact number it was taken
  for. Pointing that yes at a different number is `wrong_target` and dials nothing, while the
  number it really was for still works; a confirmation with no target recorded cannot reach
  anyone at all (`no_target_on_record`); and `+1 (212) 555-9999` is not a different number from
  `+12125559999`
- a real yes rings exactly once, carries only the facts that were listed, honours the time cap,
  writes a receipt naming the number and what was shared, and is then spent
- calling the owner needs no yes; with no `REASON_OWNER_NUMBER` it says there is nobody to ring
- a placed call is explicitly not a finished one: while it is ringing there is no outcome, no
  summary and no transcript to read, and the tool says so
- a settled call is read off its record and never re-dialled or even re-queried
- no answer is a real outcome reported as itself; a call that cannot be placed says nobody's
  phone rang and is recorded as failed; a provider that throws is survived, not crashed through
- a number that is not a number is refused before anything is recorded
- a stranger's thread cannot place a call at all
- `call_status` with no id lists only this conversation's calls

The per-person gate also applies to texting; `test/channels.test.js` covers the same three cases
for `message_send`.
