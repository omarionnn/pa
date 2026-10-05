# Unverified: live tests that have not passed against the real model

> **2026-10-04: all 25 live tests now pass through the `claude-cli` backend** (model `opus`, on
> Omari's Claude subscription — **not** the API). See the last section for the run. They still have
> not run against the API, because there is no credit; a backend difference could in principle hide
> something, so this file keeps saying what has and has not been proved and how.

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

---

## Commit: Group 9 — a second backend, for the owner's local testing

`REASON_BACKEND=claude-cli` runs each turn through the official `claude` CLI against the Claude
subscription on this Mac, with Reason's tools served to it over MCP by the Reason process itself.
It exists so the live tests can be run with no API credit. The API backend is the default and is
untouched.

### What ran, and what that does and does not prove

On **2026-10-04** the whole suite was run this way:

```bash
REASON_BACKEND=claude-cli node --test --test-concurrency 1 test/*.test.js
```

**156 tests, 153 passed, 3 failed, 0 skipped — via the claude-cli backend on `opus`, not the API.**

This does **not** clear anything above. Every entry in this file is listed because it has not
passed *against the API path*, and it still has not: the CLI backend is a different model
invocation with a different tool loop and a text-only history. What the run does prove is that
the tools, the confirm gate, the owner check and the ledger behave correctly when a real model
drives them — which is most of what those tests were written to ask.

Live tests that passed under the claude-cli backend: all of `test/flow.test.js` (7),
`test/flow-trust.test.js` (5), `test/flow-proactive.test.js` (4), `test/flow-gate.test.js` (5 of
6), and 1 of 3 in `test/flow-errand.test.js`.

### The three that failed, and why

All three fail for one reason, and it is not the backend.

`test/fixture-booking.js` renders each time slot as a link to `/reserve?...`. That href contains
the word "reserve", so `browser_click`'s commit guard refuses to press it and sends the model
through the gate — correctly, by the guard's own rules. The model then presses it with
`browser_submit`, which **spends the owner's yes**. But `/reserve` is only the details form: the
booking does not exist until a second, real submit. So after one yes, Reason has navigated to a
form and has no authority left, which it says plainly ("tapping 9:00 didn't book it, it just
opened the reservation form. nothing's booked yet"). The tests expect a booking at that point.

| File | Test | Where it stops |
| --- | --- | --- |
| `test/flow-errand.test.js` | an explicit yes books it once, for real, with a receipt | `exactly one reservation on the site` — the yes was spent opening the form |
| `test/flow-errand.test.js` | 'did it actually go through' is answered from the ledger | downstream of the above; there is no booking to read back |
| `test/flow-gate.test.js` | a changed detail is re-asked and the booking lands on the new time | the 9:00 re-ask and the second yes both land correctly; the booking does not, for the same reason |

> **RESOLVED 2026-10-04 — Omari's call: only the action that actually commits needs a yes.** Picking
> a time slot or opening a form commits nothing, so it must not require or spend a confirmation.
> The fix is below under *Commit: only the click that really commits needs a yes*, and all three of
> these tests now pass. The paragraph that follows is kept as the record of what was wrong.

**This was an open question for Omari, not something to quietly fix.** `src/tools.js` says of the
commit guard that "a false positive costs one trip through the gate, which is the safe direction
to be wrong in". On this fixture it costs more than that: the yes is consumed by an action that
committed nothing. Either the guard should not spend a yes on a step that turns out to have only
navigated, or a two-step booking should legitimately need two confirmations and the tests should
say so. Changing a safety guard is not a call to make while writing tests, so it is written down
here instead.

### What *is* proven offline for this commit

`test/trust.test.js` gained two: that a confirmation recorded under its MCP tool name
(`mcp__reason__browser_submit`) is stored and matched as `browser_submit`, so a yes the owner
really gave still opens the gate — caught live on 2026-10-04, where it silently refused an
approved booking — and that the prefix does not let one action's yes cover a different action.

`confirm_pending` is new and backend-neutral: the open questions Reason has already put to the
owner. It exists because the CLI backend showed Reason asking twice for the same thing and the
owner's "yeah that's it" landing on a question that had never been put to them.

## Commit: calls come back with their audio, and the subscription backend is fenced in

Two additions, both offline-tested, neither one proven against anything real.

### Never run against a real phone

The whole call path is still fake-only. Nothing below has rung a phone or produced a real
recording:

- the announcement actually being **spoken** at the start of a call. Reason builds it, hands it to
  the provider as its own argument, and the provider refuses a call without one — all of which is
  provable offline. Whether a real provider says it *first*, verbatim, and before the person on the
  other end starts talking, is a property of the provider and cannot be known until one is wired
  up. The adapter for whichever provider wins has to be checked against this specifically.
- a real recording arriving: the fake provider returns a 4.8 KB WAV from
  `src/calls/fixture-recording.wav`. A real one is minutes of audio, from a URL that may need the
  provider's auth and may expire. The URL path through `storeRecording` is exercised with a stub
  `fetch`, never a real one.
- `cost_cents` and `duration_s` from a real provider.
- the 25 MB ceiling in `storeRecording` meeting an actual long call. Worth noting this now
  **fails the recording promise** rather than merely skipping audio: a long call whose recording
  is over the ceiling is marked `missing` and reported as a fault. If real recordings routinely
  come in over 25 MB, that ceiling is the wrong shape and should become a streamed copy.
- whether a real provider's final call state maps onto `SPOKE_TO_SOMETHING` the way Reason
  assumes. Reason treats `completed` and `voicemail` as calls that owed a recording, and
  `no_answer` / `busy` / `declined` / `failed` as calls that did not. A provider that reports a
  rung-out call as `completed` would produce a false "recording missing" fault.

### Never run against the real Linq API

`LinqChannel.sendMedia` follows Linq's documented three-step pre-upload — `POST /v3/attachments`
for a presigned URL, `PUT` the raw bytes with the `required_headers` exactly as returned, then one
message whose parts are `[text, {type: media, attachment_id}]`. Read from
`cdn.linqapp.com/openapi/linq-api-v3.yaml` on 2026-10-04 and asserted against a stub `fetch`.

Unproven, and all of it is the kind of thing only a real key settles:

- whether S3 accepts the `required_headers` passed through untouched;
- whether a WAV arrives as a playable attachment in iMessage. Linq's docs say audio in a media part
  appears as a **downloadable file**, and that an inline voice-memo bubble is a different endpoint
  (`POST /v3/chats/{chatId}/voicememo`). If Omari wants the voice-memo bubble, that is a second
  adapter method, not a flag.
- whether `attachment_id` is still valid by the time the message send runs (the docs warn about an
  ephemeral attachments tier removed within ~24–48h of upload).

### Proven offline for this commit

- 30 tests in `test/call-audio.test.js`: the announcement names the AI, the owner and the
  recording; the model cannot supply or change it; a provider with no announcement refuses to dial;
  the audio is saved as a file Reason owns; the owner gets **one** message carrying the summary and
  the audio; it goes out exactly once; a failed send stays queued and is never marked sent; a
  stranger's thread never picks it up. On the recording being mandatory: there is no off switch
  (asserted, including that `config` has no such key and that `REASON_CALL_RECORDING=off` does
  nothing); a provider that cannot record cannot place a call and `capabilities` stops offering
  calls; a missing recording on an answered call is marked `missing`, writes an **error** ledger
  row, and produces a loud warning; a call reaching voicemail still owes audio; a call nobody
  answered is `not_applicable` and raises no alarm, so the real fault stays visible.
- 7 attachment tests in `test/channels.test.js`: Linq's pre-upload shape, a rejected upload not
  going on to send a fileless message, refusals that never touch the network, the router
  passthrough, the console's "here is where the file is", and the base `Channel` not claiming
  support it has not got.
- 9 tests in `test/data.test.js` (new): the export carries the recording's bytes and they decode
  back to the file byte for byte; `--no-audio` keeps the list; a missing file is reported as
  `missing: true`; a scoped export or delete does not reach into another conversation; delete
  removes the audio **from disk**; a file already gone is counted, not failed.
- 7 tests in `test/guard.test.js`: `REASON_BACKEND=claude-cli` plus a channel other people could
  text refuses to start, names `ANTHROPIC_API_KEY` and credit, and leaves a way to keep testing;
  console and fake are fine; a half-configured channel still blocks; an unknown channel blocks by
  default.

The guard was also run for real: `REASON_BACKEND=claude-cli LINQ_API_KEY=x LINQ_WEBHOOK_SECRET=y
npm run serve` exits 1 with the message, and `REASON_BACKEND=claude-cli npm run serve` with only
the console starts normally. That is the one thing in this commit that is not just a unit test.

### One thing deliberately not done the way it was asked

The ask was for "the ledger entry for a call" to store the recording reference. The ledger is
append-only — it is in the README as a property — and the audio turns up after the `call_place`
row is written. So instead of rewriting that row, the recording gets **its own** row
(`call_recording`) carrying the same `call:<number>` target, and the reference is also written onto
the call's own row in the `calls` table. "What did you do today" and "where is that recording" both
have an answer; no ledger row was edited after the fact. Flagging it in case Omari wanted the
other reading.

### Correction applied 2026-10-04 (Omari): recording is mandatory

The commit above shipped a `REASON_CALL_RECORDING=off` switch. That was wrong and is now removed.
Every call is recorded; there is no configuration that changes it. What changed with it:

- `announcementFor()` has one form and it always discloses the recording. `requireAnnouncement()`
  refuses a line that does not, so a provider cannot place a call that fails to disclose it.
- A provider that cannot record cannot place a call: refused in `call_place` with
  `status: "cannot_record"`, and `capabilities` reports phone calls as not connected rather than
  offering a phone Reason should not use.
- A missing recording on an answered call is an **error state**: row marked `missing`, an error row
  on the action ledger, and a warning telling Reason to say plainly that the recording is missing.
- `recording_requested` is gone from the `calls` table — with no switch it carried no information.
  An older database keeps the column (harmless, defaulted); nothing reads it.
- `docs/call-providers.md` now opens with recording as a disqualifier rather than a column. All
  five candidates pass, which is itself worth knowing: price and architecture are the only live
  questions. Vapi's per-assistant recording setting is listed as a *risk* rather than a feature,
  since it is a way to end up with an unrecorded call while the announcement still promises one.

### Added 2026-10-04: never pay by phone

Enforced in code, offline-tested (12 tests in `test/call-payments.test.js`), and unproven in the
only way that matters until a real provider exists:

- the call request scan is provable offline and is proven: a card number, CVV, expiry, routing
  number, sort code, IBAN, bank account number or PIN in the goal or the facts refuses the call
  before anything is dialled, no call row is written, and the refusal never echoes the number back.
- **whether the voice on the call actually obeys the rules is not provable here.** `callRulesFor()`
  is handed to the provider as its own argument and a provider without the payment rule refuses to
  dial, which is as far as code can go. Whether a hosted voice agent holds the line when a
  restaurant pushes — "we really do need a card to hold it" — is a property of that provider's
  model, and it is the single most important thing to test on the first real call. Test it
  deliberately: ring somewhere that will ask for a card and listen to the recording.
- the detector errs towards refusing, which means false positives are possible. "account number"
  will fire on a loyalty account number. The error tells Reason to reword, so the cost is one turn;
  the asymmetry is deliberate. If it turns out to fire on something ordinary and common, that is
  worth fixing — but towards a narrower pattern, never towards letting payment details through.

### Added 2026-10-04: the apps Omari chose

All of them are in the connected-accounts registry and **none of them is built**. The registry says
so in those words (`why: "nothing is built for <name> yet"`), `account_connect` refuses them with
`status: "not_built"` even with a granted yes, and `account_list` reports every one. Four tests in
`test/trust.test.js` pin that.

Nothing about any of their APIs has been assumed. Where the credentials are not known — Spotify —
the registry says the credentials are not decided yet rather than naming an environment variable
nobody has verified. The nine browser ones need no credentials at all: they need Omari signed in
once in Reason's own browser, which needs saved logins, which is also not built.

The thing to watch when these do get built: `built: false` is what keeps them honest today, and it
has to be flipped **in the same commit** as the code that makes one work, or the registry starts
lying in the other direction.

### Added 2026-10-04: pages

Offline-tested end to end against the HTTP handler — 35 tests in `test/pages.test.js` covering the
link surviving an update, a private page refusing the link alone and opening with the code, the
cookie keeping a browser in, a code working once, a new code killing the old one, expiry, the rate
limit (and that it is counted in a table so a restart does not reset it), a shared page opening for
anyone, unsharing taking effect on the next request, HTML and script in every block coming out as
inert text, a `javascript:` url being refused, an invented image address being refused, a real one
being allowed, a tap becoming exactly one event turn, a shared page's questions being unanswerable,
and export/delete covering pages and everything hanging off them.

**Never seen in a real browser.** Every assertion above is about the HTML string and the handler's
response, not about what a phone does with them. Specifically unproven:

- how it actually looks. The template is mobile-first and renders cleanly as a string, but no
  phone has displayed it. Expect to adjust spacing and the card grid on first sight.
- the choice button's `fetch` has never run in a browser. The route it posts to is tested
  directly; the five lines of script that call it are not.
- the cookie round trip through a real browser: `SameSite=Lax` is the right choice for arriving by
  tapping a link in a text, and `Secure` is set only when `REASON_PUBLIC_URL` is https, but no
  browser has been asked to keep one.
- nothing has been served over a real network. There is no reverse proxy, no TLS, and
  `REASON_PUBLIC_URL` has never pointed anywhere real, so a page link has never opened off this
  machine.
- a code has never been *sent*. Reason is told to hand the owner the code when they tap the link,
  which depends on a live channel — and there is no live channel. On this machine the code can only
  be read out of the database or the console.

**The image rule is the part to watch.** `web_lookup` now returns the real image addresses on a
page it reads, and only those can go on a page. That makes pictures possible rather than invented,
but it means a picture is only ever as good as a page Reason actually read: there is no image
search, so "find me pictures of X" cannot be answered. The browser's snapshot does not surface
image addresses yet either, so in practice pictures come from `web_lookup` alone.

## Commit: only the click that really commits needs a yes

### What was wrong

`browser_click`'s commit guard tested the model's own `expect` text as well as the element's
label. So a model that wrote `expect: "reserve the 8pm slot"` had its own wording gate its own
click. On the fixture that meant the time-slot link — a plain `<a href="/reserve?…">8:00 PM</a>` —
was treated as a booking: the gate fired, the owner's yes was spent *navigating to the form*, and
there was none left for the button that actually books. Three live tests failed on it.

### The fix

The decision now comes from what the element is, never from what anyone says about it
(`clickCommits()` in `src/tools.js`, fed by `describeRef()` in `src/browser.js`):

- **an anchor with an href navigates**, and a GET to another page books, buys and sends nothing —
  so it is not a commit, whatever its label says. This is what lets Reason pick a time and open a
  booking form without spending anything.
- **anything else is judged by the page's own label for it.** The page saying "Confirm
  reservation" is the page telling us what that button does, which is a different kind of claim
  from the model saying so.
- **an unreadable label is a commit.** If we cannot tell what it does, we do not press it. An
  element that cannot be inspected at all is a commit too.
- **money is the exception to the navigation rule.** A link labelled pay / buy / checkout / order /
  charge / subscribe still goes through the gate, because a one-tap charge cannot be undone and
  "it was only a GET" is no comfort afterwards.

`expect` is still recorded on the ledger receipt. It just no longer gets a vote.

A second half, because a yes has to cover the details and not just the verb: `browser_submit` now
carries its `what` into the gate as the confirmation's target, the same mechanism that stops a yes
for texting one person texting someone else. A yes for the 8:00 booking will not submit the 9:00
one — it comes back `wrong_target`, unspent, and Reason has to say what changed and ask again.

### Proved offline

Four tests added to `test/browser.test.js` (they drive real Chromium against the local fixture, so
they need no key):

- picking a time slot spends no yes **even when the model describes it as "reserve and book the
  8:00 PM table"** — the exact wording that used to gate it. No confirmation row is created at all.
- the submit is still gated, **even described as "just have a look at the next page"** — the page's
  label is what decides.
- a yes for the 8:00 booking cannot submit the 9:00 one: refused `wrong_target`, nothing booked,
  the yes not spent, and the agreed details still go through on it afterwards.
- `clickCommits` itself, over the cases: links labelled "8:00 PM" / "Reserve" / "Book this table"
  are free, links labelled "Pay now" / "Checkout" are gated, buttons labelled "Confirm
  reservation" / "Place order" are gated, "Search" / "Next" are not, and an unlabelled button or an
  uninspectable element is a commit.

### The live run, via claude-cli — not the API

Run on 2026-10-04 with `REASON_BACKEND=claude-cli` (model `opus`) on Omari's Claude subscription.
**All 25 live tests pass**, including the three this bug was blocking:

| File | Result |
| --- | --- |
| `test/flow-errand.test.js` | **3/3** — including "an explicit yes books it once, for real, with a receipt" and "'did it actually go through' is answered from the ledger", both of which failed before |
| `test/flow-gate.test.js` | **6/6** — including "a changed detail is re-asked and the booking lands on the new time", which failed before |
| `test/flow.test.js` | 7/7 |
| `test/flow-trust.test.js` | 5/5 |
| `test/flow-proactive.test.js` | 4/4 |

What that does and does not establish. It establishes that the behaviour is right with a real
model reading real sentences and driving a real browser: a booking really lands, once, after a
real yes, with a receipt, and a changed detail really is re-asked. It does **not** establish the
API path, which is what Reason actually ships on — same prompts and same tools, but a different
backend, no prompt cache, and the CLI owning the tool loop. Until there is API credit, "live
tested" in this repo means *via claude-cli*, and that is how it is labelled here and in the README.

## Commit: runs without the operator's Mac

### Never built

**There is no Docker on the machine this was written on, so the image has never been built or
run.** The Dockerfile is reviewed, not proven. What is checked by a test that does run: the base
image tag matches the `playwright` version in `package.json` (a mismatch fails at runtime, not at
build time, which is the worst place to find it), `REASON_DATA_DIR` is `/data` with a `VOLUME` on
it, it binds `0.0.0.0`, `node` is PID 1 rather than npm so `SIGTERM` reaches it, it runs as
`pwuser` rather than root, there is a `HEALTHCHECK`, and `.dockerignore` keeps `data` and `.env`
out of the image.

Everything else about it is unproven: whether `npm ci --omit=dev` succeeds in that image, whether
the NodeSource step installs cleanly on top of it, whether Chromium actually launches under
`pwuser` in a container, and what it weighs. Expect to fix something on the first build.

Also untried, and only establishable on a real host: that `/data` survives a restart on a
particular provider's volume, that a provider's health check is satisfied by `/health`, that a
container with 1 GB survives a browser errand, and that a provider's TLS front end delivers the
Linq webhook intact.

### Proved offline

13 tests in `test/deploy.test.js`, none of which need a container:

- `REASON_DATA_DIR` puts the database, recordings, browser profiles and screenshots under one
  directory, and each can still be pointed elsewhere individually. Checked in a child process,
  because config is read once at import.
- `REASON_PUBLIC_URL` is what page links are built from — the public name, not the bind address —
  with no doubled slash.
- `src/config.js` reads no file at all, asserted against its source, so a hosted install cannot be
  missing a config file nobody mentioned.
- A task that was mid-step when the process stopped is **not lost**: `shutdown()` gives it a wake
  time back, and a hard kill with no shutdown at all is rescued on the next start, which logs that
  the last stop was not clean. A finished task is not resurrected, and a task that already had a
  wake time is not brought forward.
- `shutdown()` drains the turn that is running before it rescues, asserted by ordering.
- `/health` reports open tasks off the table, says whether it is really sweeping, and contains
  nothing from anybody's conversation. It answers over a real socket; an unknown path 404s.
- `src/serve.js` handles SIGTERM and SIGINT and calls `runtime.shutdown()`.

### A real bug this found

`markTaskWoken` clears `next_wake_at` before the turn runs, which is what stops a task firing
twice. The cost, until now, was that a process killed mid-turn left the task open with no wake time
— asleep for good, silently, which is the worst way to lose work. `rescueOrphanedTasks` runs on
every start and on every graceful stop. This was a live bug on the laptop too, not only a
deployment concern.

## Commit: the master lets people in by text

Replaces the invite list. Anyone may text the number; the master approves each person in their own
words, read by the same judge the confirm gate uses.

### Proved offline

29 tests in `test/access.test.js`, judge stated rather than real:

- an unknown number reaches the master **once**, with their first message quoted exactly, and
  **spends no model turn**; a channel-supplied name is passed on.
- while waiting, further texts cost nothing and get at most one "still waiting" line.
- `yes` creates the account, welcomes them, and their next text gets a real turn; `no` declines
  politely and the cool-off holds for 7 days and then lets them ask again.
- somebody **other than the master** saying "yes let kofi in" grants nothing; nobody can approve
  themselves; **one yes cannot approve two requests** (the second is refused against that spent
  confirmation); an **expired** request cannot be approved; `unclear` and `change` grant nothing
  and leave it pending.
- the master's ordinary messages are not read as answers, and their turn runs normally.
- blocked numbers get nothing at all and are never announced; blocking somebody who is waiting
  closes their request.
- removed and paused accounts stop answering with **no model turn** and keep all their data;
  resume puts it back; delete is gated and really removes everything.
- the master sees the first message and usage counts and **nothing else** — asserted against their
  own `plan_list`, `recall`, `page_list` and `ledger_list` as well as `admin_usage`.
- on the subscription backend the approval flow still runs but an approved person still gets no
  turn, because it is not their plan to spend.
- `REASON_OWNER_NUMBER` still works and `REASON_MASTER_NUMBER` wins when both are set, checked in
  a child process.

### Two real bugs this found

1. **The master silently stopped receiving access questions.** `upsertAccount`'s ON CONFLICT
   updated the name and last-seen but **not the channel**, so the operator row seeded as `linq` on
   a machine with no Linq kept a channel nothing could send on — and the question to the master was
   dropped with only a log line. The upsert now updates the channel and address, and `tellMaster`
   falls back to a channel that is actually live rather than trusting the row. Found by driving
   the flow by hand, not by a test; the test came after.
2. **The master was answered twice about one decision** — once by code and once by the model turn
   that ran afterwards. A decided answer now ends the turn.

### Not proved

- **No real model has read a real master's reply in this flow.** The judge is stated in every test
  here. `test/flow-gate.test.js` does prove a real model reads real sentences ("no problem, book
  it" is a yes; "ok but make it 9 instead" is not) through the same `recordConfirmation`, so the
  machinery is live-tested — but not with an access request as the subject. Worth one live run
  when there is credit: the summary the judge sees is "give +1… their own Reason", which is a
  different shape of sentence from a booking.
- Nothing has run over a real channel, so no real person has ever texted and been let in.
- The hourly ceiling is tested only indirectly: because one request is in front of the master at a
  time, four strangers produce one question, so the cap itself has not been reached in a test.

## Sendblue channel (added 2026-10-04, reviewed against the docs 2026-10-05)

`src/channels/sendblue.js` is proven offline, against payloads shaped like the examples in
Sendblue's docs (`test/sendblue.test.js`). There are no Sendblue credentials on this machine, so
the tests inject `fetch` and a passing test proves the **shape** is right, not that Sendblue
accepts it.

### What one real night of use did prove

Not tests — observed on the live install, which is the only real Sendblue traffic this adapter has
ever seen:

| Check | What happened |
| --- | --- |
| Inbound `receive` webhooks | Arrive, and the shared-secret header check passes on the default `sb-signing-secret` |
| A send where `number` equals `from_number` | HTTP 400, `"Cannot send messages to self"`, with no `error_key` on it |

Everything else below is read off the docs and has never had a real reply from Sendblue.

### Mismatches found in the 2026-10-05 doc review, and fixed

- **The length limit was off by one.** "must be less than 18996 characters" — the check allowed
  exactly 18,996. Now `>=`.
- **Only one of the two attachment ceilings was enforced.** iMessage is 100 MB, SMS is 5 MB, and a
  send to a non-iPhone falls back to SMS where Sendblue "will attempt to compress the file ... If
  compression fails, the message will fail to send". A file over 5 MB now carries that on the
  delivery record instead of looking like a clean success.
- **The typing bubble's expiry was invisible.** `max_duration_ms` "Defaults to 60000 (60 seconds)",
  and the adapter was not sending it, so a turn over a minute long silently lost the bubble. The
  duration is always sent now and the expiry comes back as `expires_at`.
- **The documented recovery for a 503 on typing was not taken.** The docs pair "Worker firmware ...
  does not yet support typing-v2" with "Legacy start requests with no duration are unaffected and
  always succeed". A 503 on a start is now retried once as a bare legacy start, reported as
  `degraded`.
- **"Cannot send messages to self" had no name.** It carries no `error_key`, so it read as an
  unclassified 400. Now `cannot_send_to_self`, permanent.
- **A dropped socket looked like a refusal.** It is now `transport`, and retryable, because never
  reaching Sendblue is not an answer from Sendblue.
- **An iMessage from an Apple ID was dropped as a malformed payload.** Sendblue "can receive from
  iCloud email addresses" and Reason is keyed by phone number, so this still cannot become a turn —
  but it is refused with its own reason now, not silence that looks like a bug.
- **Inbound `service` was discarded.** It is the documented field that says whether a conversation
  is iMessage, which is exactly what decides whether a typing bubble, read receipt or tapback can
  work at all.

### What the docs do not settle

- **Which header carries the webhook secret.** The webhooks page says a configured secret is
  "included in the webhook request headers" and never names it. `sb-signing-secret` comes from
  Sendblue's own Chat SDK adapter page and is what the live install verified on — evidence for this
  account, not a spec. There is also no signature over the body and no timestamp, so there is no
  replay window to check; that is weaker than the Standard Webhooks scheme the Linq adapter
  verifies, and it is Sendblue's design rather than a shortcut here.
- **The response when the free shared line refuses an unverified contact on a send.** The rule is
  documented and read-receipts documents a `403` "Contact Not Verified" for it, but
  send-message's error table never lists the case. A 403 on a send is read as the same thing and
  labelled `unverified_contact_inferred` so the inference is visible.
- **Whether a text from a number that is not a verified contact reaches the account at all** on the
  free shared line, which decides whether the master-approval flow can be tried there.
- **No inbound tapback exists in any payload.** None of the nine webhook types is a reaction,
  `message_type` is documented as exactly "message or group", and neither the `receive` nor the
  `outbound` payload has a reaction field. Sendblue can send a tapback and documents no way to hear
  about one. `send_style` *is* on the inbound payload, so an effect somebody sent Reason is visible.
- **Nothing inbound flags a voice note.** A voice memo arrives as a `media_url` like any other file,
  so the `.caf` extension is the only signal, and it is read as one.
- **`line_blocked`, `line_assigned` and `contact_created` have no published payload.** They are
  dropped by having neither a `message_handle` nor a sender rather than by a guess at their shape.
- **`10001 "Message failed to send"` and `10002 "Failed to resolve message status"` are not
  described as transient or permanent.** Both are treated as retryable under a bounded attempt
  budget, which is the direction that can waste attempts rather than lose a message.
- **`pre_reply_override: true` is documented and deliberately never sent.** It would push one
  otherwise-blocked message per contact per day past the pre-reply rules. Spending somebody's one
  override without being asked is a decision for whoever owns the line, not for a retry loop.
- **File upload then send as one message, and delivery of a call recording,** have never run.

## The outbox (added 2026-10-05)

`test/outbox.test.js` is 24 offline tests and the whole state machine is driven through them: a
successful send, a retryable failure, a refusal, the attempt budget running out, exponential
backoff, two overlapping sweeps racing for one row, the same idempotency key asked for three times,
a restart with a queued row, a restart with a row stuck mid-send, and each of the three answers a
channel can give to "did that one go out?". The clock is the fake one, so backoff is asserted rather
than waited for.

What that does **not** prove:

- **No message has ever actually been retried against Sendblue.** The retry classifier is read off
  their error table (`canRetry` in the adapter) and exercised against their documented error bodies,
  not against a real 429 or a real 5xx. The first real rate-limit is the test of whether a 429 on a
  send really does carry what the docs say it carries.
- **`GET /api/v2/messages` has never been called.** The crash-recovery path depends on it, and on
  content matching being enough to identify a message. Two things could be wrong in practice: the
  `created_at_gte`/`created_at_lte` window might filter on a timestamp that is not the one the
  message was accepted at, and an identical reply sent twice to the same person inside the same
  window would be indistinguishable. The second is a real and accepted limitation — it resolves to
  "it went", which is the safe direction.
- **The free shared line's behaviour under retry is unknown.** The pre-reply count limit counts only
  messages with status SENT or DELIVERED, so a retry after a failure should not burn one of the six
  — but that is read off the docs, not observed.
- **Nobody has seen the owner notification arrive.** The chain where the line to the owner is itself
  down (the notice becomes its own row, retries, and degrades to the next turn's `[delivery failure]`)
  is tested offline and has never happened for real.

## The typing bubble (added 2026-10-05)

`test/typing.test.js` is 13 offline tests with injected timers, so a five-minute turn is exercised
in a millisecond: the order (up before the turn, down after the reply), renewal before the chunk
lapses, the ceiling, the three ways a channel can refuse, and the proof that a typing call which
throws cannot break or delay a reply.

What that does **not** prove:

- **No bubble has ever appeared on a phone.** Whether `max_duration_ms` is really honoured, whether
  renewing a live bubble extends it or restarts it, and whether a `stop` is visible immediately are
  all unobserved. The renew-at-80% interval assumes extending works; if it turns out that renewing
  makes the bubble flicker, the chunk should be lengthened rather than the renewal removed.
- **The 503 legacy fallback has never fired.** A line old enough to reject `typing-v2` would take
  the bare-start path, which means no explicit duration and no early stop — so the bubble would run
  Sendblue's full 60 seconds after a short turn. That is accepted and reported as `degraded`, but
  nobody has seen it.
- **Whether the reply itself clears the bubble** is assumed from how iMessage behaves, not measured.
  The explicit `stop` after the send is there because of that assumption, and the docs call a stop
  with nothing showing a safe no-op.
- **Sendblue has an account-level `auto_typing_indicator` setting** that would show a bubble on every
  inbound 1:1 iMessage without any of this code. It is deliberately not used: it fires on arrival
  rather than for as long as the turn runs, so it cannot say "still working" through a twenty-second
  turn, and the two together would fight. Worth revisiting only if the per-turn bubble proves
  unreliable in practice.

## Video understanding (added 2026-10-05)

`test/video.test.js` is 50 offline tests. `src/video.js` takes its `run` as an argument and
`videoUnderstand` takes its `model`, so the real metadata parsing, track picking, caption parsing,
trimming, caching, audio handling and error wording all run against fixture files in
`test/fixtures/video/` — caption tracks that came off YouTube once, and an 844-byte WAV. No network,
no key, and **nothing in the suite ever reaches Google.**

### Proved against real YouTube, by hand (2026-10-05)

Not tests — manual checks, run with a scratch database and no key, through the real code path:

| Check | What came back |
| --- | --- |
| `youtube.com/watch?v=aircAruvnKk` (3Blue1Brown, "But what is a neural network?") | `tier: captions`, title and channel right, length 18:40, upload date 2017-10-05, **12 chapters**, **creator** captions in `en`, 288 lines, 0:04–18:25, laid out as `[0:04] This is a 3.` …; trimmed at 20k chars with `17:52–18:25` reported missing |
| the same video, `from: "14:00", to: "16:00"` | `asked_for 14:00–16:00`, covers 14:02–15:59, nothing before or after the window — the trimmed→follow-up loop works on real data |
| `youtube.com/watch?v=dQw4w9WgXcQ` | `tier: captions`, **creator** captions, 86 lines, 0:01–3:27, whole thing, nothing trimmed |
| `youtube.com/watch?v=jNQXAC9IVRw` ("Me at the zoo", 19 seconds) | `tier: captions`, creator captions, 9 lines — a very short video is not a special case |
| a video id that does not exist | `ok: false`, `cannot: "gone"`, "is not there any more — it has been removed or was never public" |
| **the audio half of the model tier**, on "Me at the zoo", with a stub standing in for the model | `yt-dlp` really downloaded format 140 as a single **302 KB `.m4a`** for a 19-second video (≈1 MB a minute), handed it over as a real file on disk, and the file and its scratch directory were **gone afterwards**. A second ask came back `cached: true` and called neither yt-dlp nor the model. **No ffmpeg on this machine, and none needed.** |

### Not proved

- **Nothing has ever been sent to Google.** There was no `GEMINI_API_KEY` in the environment when this
  was written — it may be in `.env`, which this work was told not to read — so **no real manual check
  of tier 2 was possible and none was attempted.** `src/gemini.js` is written from their docs, read
  2026-10-05, and has only ever answered an injected fetch:
  - `ai.google.dev/gemini-api/docs/generate-content/video-understanding` — POST to
    `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, key in an
    `x-goog-api-key` header, a YouTube URL as `{"file_data": {"file_uri": "…"}}`, a time range as
    `video_metadata.start_offset` / `end_offset` in seconds-with-an-`s`. Their text: "Gemini 3.8 Flash,
    3.7 Flash, 3.6 Flash, and 3.5 Flash Lite models support YouTube URLs"; "You can only upload public
    videos (not private or unlisted videos)"; max 10 videos a request on 2.5+; free tier "you can't
    upload more than 8 hours of YouTube video per day"; "approximately 100 tokens per second of video
    at default (low) media resolution, or approximately 300 tokens per second" at high.
  - `ai.google.dev/gemini-api/docs/generate-content/audio` — an uploaded file as
    `{"file_data": {"mime_type": "audio/m4a", "file_uri": "…"}}`; "The maximum supported length of
    audio data in a single prompt is 9.5 hours"; "Gemini represents each second of audio as 32 tokens;
    … one minute of audio is represented as 1,920 tokens". Their own worked example of asking for
    times is "Provide a transcript of the speech from 02:30 to 03:29", which is why the prompts ask
    for M:SS.
  - `ai.google.dev/gemini-api/docs/files` — the two-step resumable upload, the `x-goog-upload-url`
    response header, `X-Goog-Upload-Command: "upload, finalize"`, 2 GB a file, kept 48 hours, and a
    `state` that has to reach ACTIVE.
  The tests pin every one of those request shapes header for header, which is all that can be checked
  without a key. **What they cannot check** is whether Google still answers that way: the model ids, a
  `v1beta` path that may have moved (their docs also show a newer `/v1beta/interactions` surface on
  some pages, which this does **not** use), and whether an uploaded `audio/wav` or `audio/m4a` is
  accepted in practice. The first real call should check all of that before anything is trusted.
- **The optional OpenAI transcriber has also never run.** Same reason, no key. It stays in
  `src/transcribe.js`, offline-tested, and only runs if `REASON_TRANSCRIBER` names it.
- **The local Whisper is documented, not installed.** `LOCAL_NOTE` in `src/transcribe.js`. It would
  work on this Mac (Apple M4, so `mlx-whisper` in its own virtualenv the way yt-dlp went in), but it
  wants a model download of roughly 1.5 GB and it wants **ffmpeg** to turn the downloaded `.m4a` into
  PCM. Neither is installed and neither should be installed quietly. `pip install imageio-ffmpeg`
  ships a prebuilt ffmpeg and needs no Homebrew, which is the route if it is ever wanted.
- **Only YouTube has been tried at all.** `yt-dlp` supports hundreds of sites and the code treats them
  identically, but no Vimeo, TikTok, Twitter or news-site video has been read — so the whole
  non-YouTube branch, which is the one that downloads and uploads audio, has only been exercised
  against fixtures.
- **ffmpeg is not on this machine, and the normal path does not want it.** Where it would be needed:
  converting an audio stream Gemini does not accept (reported rather than attempted), and
  `--download-sections`, which is why there is no time-range *listening* — a range on a non-YouTube
  video still fetches the whole audio.
- **Auto-generated captions get rate-limited, and that is live behaviour, not a bug here.** Reading
  `youtube.com/watch?v=kCc8FmEb1nY` (Karpathy, 1:56:20) came back `tier: metadata` twice in a row:
  `HTTP Error 429: Too Many Requests` on the auto-caption fetch, after a handful of requests from this
  machine in a few minutes. That is the honest-failure path working — the result says it did **not**
  read the video and quotes the 429 — and it is exactly the case the model tier exists for. Creator
  caption tracks kept working throughout.
- **yt-dlp warns that YouTube extraction without a JavaScript runtime is deprecated.** Every real run
  printed: *"No supported JavaScript runtime could be found… YouTube extraction without a JS runtime
  has been deprecated, and some formats may be missing."* Captions and audio both still came back, and
  the only fix is installing a runtime (`deno` is what yt-dlp enables by default) — a new runtime on
  the machine, so it is Omari's call rather than something to add quietly. If caption or audio fetches
  start failing across the board, this is the first thing to look at.
- **The private / age-gated / members-only / region-blocked wording is tested against yt-dlp's error
  strings, not against those videos.** The strings are the ones yt-dlp emits, but no real gated video
  has been pointed at this.
- **No live model has used the tool.** `test/video.test.js` drives `runTool` directly. Whether the
  model actually matches its wording to the tier, reaches for `from`/`to` when it sees `trimmed`, and
  leaves `watch` alone when the captions answer the question, are prompt properties and need one live
  test when there is credit.

## Research with a real pick (added 2026-10-05)

`test/research.test.js` — **24 tests, all passing offline, no key needed.** They drive `runTool`
directly against a fake `SearchProvider` and a fixture HTTP server. What they prove is the part code
owns: an answer cites only sources that were really fetched, each cap holds *and is reported*, a
source that fails to load is skipped and named, a site that forbids being read is never requested, no
key is an honest fallback rather than a guess, a deep run survives a brand new `Runtime` and reports
once, and the ledger receipt names the sites.

**What has NOT run, and must not be described as working:**

- **No request has ever been sent to Tavily. There is no key on this machine.** The provider is
  written off their published docs (read 2026-10-05: `POST https://api.tavily.com/search`,
  `Authorization: Bearer tvly-…`, body `{query, search_depth, max_results, include_published_date,
  include_domains, time_range}`, response `{results:[{title,url,content,score,published_date}]}`), and
  the test asserts the request matches that contract — but a contract test is not a live call. The
  first real search could fail on anything a doc does not say.
- **Whether Tavily returns usable Reddit snippets is unproven, and it matters most.** The design
  leans on it: Reddit cannot be fetched, so the provider's snippet is the *only* way an owner opinion
  reaches an answer. `include_domains: ["reddit.com"]` is documented and the snippet field is
  documented; that those two combine into quotable thread text has not been seen once. **First thing
  to check when a key exists.** If it comes back thin, "what do people say" has no real source and
  Reason should say so rather than leaning on a one-line snippet.
- **The free allowance is as their docs state it, not as observed.** 1,000 credits/month, no credit
  card, 1 credit a basic search, $0.008/credit after. Nothing has been billed, so nothing is confirmed.
- **The 1,000-free-credits figure has not been watched against real usage.** A research run spends up
  to `REASON_RESEARCH_MAX_SEARCHES` (5) credits, so ~200 questions a month — arithmetic, not
  measurement. There is no usage counter and no warning as the allowance runs down; a 429 is handled
  and says "the allowance is used up", which is the only signal.
- **No live model has used either tool.** Whether the model plans genuinely *different* queries (the
  instruction says so; nothing enforces it), puts "reddit" in one when opinions matter, leads with a
  pick instead of a survey, reaches for `deep: true` on a big question, and refuses to call one source
  research, are all prompt properties. They need one live test each when there is credit. The caps and
  the source log do not depend on any of it.
- **The time cap is only tested with an injected clock.** Real latency has never pushed a run past 90
  seconds, so whether 90s is the right number for 5 searches and 8 page reads is a guess.
- **`robots.txt` parsing is tested against a fixture file and Reddit's real one, not broadly.** Groups,
  longest-match, Allow-beats-Disallow and an empty `Disallow:` are covered. Crawl-delay, sitemaps and
  the stranger real-world files are not; a weird file could in principle read as a refusal and
  silently cost a source. The failure direction is safe (skip and say so), not unsafe.
- **The robots guard covers research reads only.** `web_lookup` and the browser are unchanged — the
  model can still fetch a Reddit URL directly and will get six characters of nothing. Whether to
  extend the guard across `web_lookup` is flagged in `docs/features.md` as Omari's call, because it
  changes behaviour that existing errand flows rely on.
- **Reddit's own policy was read on 2026-10-05 and could change either way.** `Disallow: /` for all
  agents, `.json` → 403, `oauth.reddit.com` → 403 without a token. If they reopen a route, the
  snippets-only path should be revisited rather than left as the permanent answer.
