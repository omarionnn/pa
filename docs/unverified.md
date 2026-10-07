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
- a code has never been *sent*, and as of 2026-10-05 nothing asks for one: the link Reason texts
  the owner carries a key and opens on a tap (`ownerUrl` in `src/pages/access.js`, tested against
  the handler). What that leaves unproven is the real thing: the keyed link has not been tapped on
  a phone, and an iMessage link preview has not been watched fetching it.

### Added 2026-10-05: a choice is answered on a page

`research` takes `kind` ('choice' or 'fact') from the model, and for a choice its result carries
`next_step`: make the page first, then a short text with the pick and the link. Tested offline:
the result says so, a fact is left alone, and a page made from that step opens from its link.
**Not enforced in code:** nothing stops the model ignoring `next_step` and texting the whole
comparison anyway, and nothing checks the length of what it sends. Whether the real model follows
it is only known from trying it.

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

## Read receipts (added 2026-10-05)

`test/receipts.test.js` is 15 offline tests: sent only on a message that was really taken, not on a
re-delivery, never for a number nobody approved, off when the switch is off, and each of the six
documented error codes read as the thing Sendblue says it is. The scope tests are the ones that
matter most — a per-contact `403` must not switch the feature off for the whole line, and a per-line
`422` must switch it off for everybody.

What that does **not** prove:

- **No read receipt has ever been sent.** Whether "Read" actually appears on the sender's phone,
  and how quickly, is unobserved. The docs say there is "no callback or webhook, and no confirmation
  that the receipt was applied", so a 200 is all this will ever know — which means a receipt that is
  silently not applied would look exactly like one that worked.
- **The 403 is expected never to fire, which is itself suspicious.** A contact is verified "the
  first time they text your line", and this is only ever called about somebody who just texted. So
  a 403 here would mean the free-plan verification is narrower than the docs suggest. It is handled
  and remembered per-contact, but if it ever appears in the log it is worth reading as a sign that
  something else is wrong rather than as a routine refusal.
- **Whether a contact's refusal can clear is unknown**, and the code assumes it cannot: a remembered
  per-contact 403 is never retried, so if Sendblue would start allowing it later nothing here would
  notice. Clearing the row by hand is the fix (`DELETE FROM channel_limits WHERE ...`).
- **Sendblue has an account-level `auto_mark_read` setting** that would do this for every inbound
  1:1 iMessage with no code at all. It is deliberately not used: it fires on arrival, including for
  messages from numbers nobody approved and ones Reason will never answer, and "marked read then
  ignored" is the one outcome worth avoiding.

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

## Parts of one message are one message (added 2026-10-05)

`src/parts.js` + `splitHandle`/`attachmentOf` in `src/channels/sendblue.js`, proven offline by
`test/parts.test.js` (13 tests). Every fixture is the shape of one real failure on Omari's own
phone at 1:35 AM on 2026-10-05: he sent a line of text, then pasted a drmartens.com link, and the
one bubble arrived as three `receive` webhooks ten seconds apart — `E32ECEF5-…`, `E32ECEF5-…_1`,
`E32ECEF5-…_2`, the last two with empty `content` and a `media_url` each. Reason answered all
three, telling him twice that files had "come through blank".

### Read off real traffic, not the docs

- **Nothing documents one iMessage arriving as several `receive` webhooks.** The receive and
  webhooks pages describe one payload per message and say to dedupe on `message_handle`. The
  three-webhook delivery is observed, once.
- **Nothing documents the `_N` suffix.** `api-v2/reactions` does confirm the surrounding model: a
  message with attachments has one "primary `message_handle`" plus parts selected by `part_index`,
  and "an attachment-specific handle returns 422" — so the two kinds of handle exist and are
  different strings. What an attachment-specific handle *looks like* is never stated. `splitHandle`
  reads `stem_N` as part N of `stem`, which fits both the docs' model and the observed handles, and
  is still a reading rather than a spec.
- **The ten-second gap is one observation.** Nothing says parts arrive in order, or how far apart,
  or that a message's parts all arrive at all. The code assumes none of those: parts are rows, each
  is judged on its own, and a part whose message is not on record is treated as a real attachment.

### The deliberate trade, and how it could bite

**Sendblue's inbound payload has no content type** — `media_url` is "A CDN link to any media
attached to the message" and that is all. So there is no field that tells a link card's preview
thumbnail apart from a photo somebody chose to send. The rule is therefore: a part with no words,
carrying only picture(s), whose message's own text contains a URL, is a preview.

That also drops **a photo attached to a message whose text happens to contain a link**. That is the
known false positive and it is accepted on purpose: a pasted link is an everyday thing and used to
cost three replies, two of them wrong; a caption-with-a-link-*and*-a-photo is rare. Both directions
are visible rather than silent — every drop is logged with its reason (`dropped_part`), and the
webhook result carries it. If the real traffic shows the false positive happening, the fix is to
narrow on something observed (a preview filename pattern, the gap in arrival times), not to guess
at a field.

**Not dropped, ever:** part 0; a part that carries words; a part holding anything that is not a
picture; a picture whose message had no link; a part with no record of its message. A part with
neither words nor a file is dropped as nothing at all.

### What has NOT been proven

- **The fix has never run against the real thing.** The three-webhook shape is reproduced from the
  description of what the database held, not replayed from the stored payloads — the live install's
  data directory was deliberately not touched. The actual `media_url` values those two previews
  carried were never seen, so whether they even end in an image extension is **unverified**: if
  they have no extension, `attachmentOf` calls them `file`, the preview rule does not fire, and the
  bug survives in a quieter form (two "cannot open that file" replies instead of three). **First
  thing to check on the next real pasted link.**
- **Whether a photo and a caption arrive as parts of one message at all** is unobserved. The
  "photo with a caption" tests assert the rule does not eat it; they do not prove that is the shape
  a real captioned photo takes.
- **Multi-part on SMS/MMS or RCS** has never been seen. All of this is read off one iMessage.

## Burst intake: an arriving message waits for the rest of the thought (added 2026-10-05)

`db.holdInbound` / `Router.drain` / `Router.drainDue`, proven offline by `test/burst.test.js` (15
tests). The failure it exists for is the other half of the 1:35 AM one: Reason answered "Can you
find me a good deal on this type of doc martens:" before the link arrived a second later, with
"which ones? looks like the rest of your message got cut off… if it was a pic, i can't open those".

The tests own the router's timers and move the clock when they fire, so a twelve-second burst costs
no wall-clock. One test deliberately uses real time, because its whole claim is about real time: a
lone message with a 40ms window is answered in well under a second, by itself, with no sweep.

### What has NOT been proven

- **No real burst has gone through this.** 2.5 seconds and 8 seconds are read off the shape of one
  incident — roughly how long it took him to paste a link after typing a line about it — not
  measured against real traffic. If 2.5s turns out to be too short, people will still get two
  answers; too long and every single text feels sluggish by that much. **Worth watching on the next
  real multi-text message**, and both are one env var.
- **A turn still runs inside the webhook request.** That was already true, and the quiet window
  adds up to 8 seconds to it. Sendblue's webhook timeout is 45 seconds and they retry on 5xx only,
  so a slow turn can still make the delivery look unanswered to them; `claimInbound` means a retry
  costs nothing, which is why this was left alone rather than made fully asynchronous. Untested
  against a real slow turn.
- **The mid-turn crash case is unchanged and is not covered.** Held messages are deleted the moment
  they are taken for a turn, so a crash *during* the window loses nothing (proven) and a crash
  *during the turn* loses that turn (deliberate, the same bargain `claimInbound` makes — losing it
  beats answering twice). Nothing recovers it. (A timer no longer makes that bargain: see the
  timer commit of 2026-10-06 below.)
- **A capped conversation still gets one "that's me done for today" line per text**, because the
  cap is checked before a message is held. A burst from somebody who is already capped is therefore
  as noisy as it was before. Pre-existing, not made worse by this, and not fixed.
- **Two processes on one database would both sweep.** `takePendingInbound` reads and deletes with no
  `await` between them, which is atomic for *this* process because the driver is synchronous — it is
  not a cross-process lock. Reason runs as one process today; a second one would need a real claim.
  This is the same assumption the outbox already makes.

## Pictures reach the model as pictures (added 2026-10-05)

`src/media.js` + the image path in `src/agent.js`, proven offline by `test/media.test.js` (20
tests). `fetch` is injected everywhere, so what a passing test proves is the format rules, both
size checks, the retry shape, every refusal sentence, and the two shapes one message takes — not
that a real CDN link answers.

### Read off Anthropic's docs (build-with-claude/vision, read 2026-10-05)

- Readable formats are JPEG, PNG, GIF, WebP (`image/jpeg`, `image/png`, `image/gif`,
  `image/webp`). Anything else is refused in words before any request is made.
- "The maximum size per image is 10 MB (base64-encoded) when using the Claude API directly."
  Base64 is four bytes per three, so the byte ceiling is 7 MB — under it with room for the request.
- "Claude works best when images come before text", so the blocks go ahead of the text.

### What has NOT been proven

- **No real photo has ever been fetched.** Not one inbound `media_url` has been requested from this
  repo, because there are no Sendblue credentials here and no real inbound traffic reaches this
  worktree. Whether the link is public, what host it is really on, what content type it serves and
  whether the extension on the path is reliable are all **unverified**. **First thing to check on
  the next real photo.**
- **Whether the link needs credentials is unknown, and deliberately not probed.** `fetchImage`
  takes an `auth` argument and retries exactly once on a 401/403 — and **nothing passes it**. The
  media_url host in Sendblue's own examples is `storage.googleapis.com`, somebody else's CDN, and
  putting `sb-api-secret-key` on a request to a third party to find out whether it was needed would
  hand over a credential. If a real photo comes back 403, check the host, then wire it.
- **The extension is the only clue there is.** There is no content type on an inbound Sendblue
  message. A `.jpg` that is really a HEIC would be sent to Anthropic and rejected by them; the
  refusal would reach Reason as a thrown API error rather than as the honest one-liner. Untested.
- **No live model has seen an image through this.** That the model answers from what is in a
  screenshot, and that it says "that came through as a heic, can u screenshot it?" rather than
  "blank", are prompt properties with no live test yet — the two new prompt rules are asserted to
  be *present*, which is not the same thing. One live test each when there is credit.
- **The claude-cli backend takes a picture now, and has done so exactly once for real.** This
  entry used to say it "genuinely cannot", and that was wrong: the CLI's streaming JSON input takes
  an image block, with the `Read` tool still denied (`cliInvocation`, src/backends/cli.js; checked
  against CLI 2.1.283 on 2026-10-05). One real turn on the subscription looked at a real photo from
  the owner's phone. NOT proved: the same thing arriving through Sendblue on the running server and
  being answered on the phone; several photos on one message; a photo near the 7 MB ceiling going
  down stdin; a HEIC from an iPhone camera (the one real photo so far arrived as a JPEG; the
  conversion has only been run on a HEIC this Mac made itself).
- **Forgetting the picture after the turn is a real limit.** Ask "what was in that photo?" two
  messages later and Reason has only what it already said about it; the history line says so, so it
  should admit that rather than invent. Not live-tested, and a `look_again` tool over a stored
  media_url would fix it properly — not built.

## Tapbacks, effects and voice notes (added 2026-10-05)

`src/expressive.js`, `react()`/`send(sendStyle)` on the Sendblue adapter, and the `react` /
`message_send(style)` / `voice_note_send` tools. Proven offline by `test/expressive.test.js` (31
tests). `fetch` is injected, there are no Sendblue credentials here, and there is no ffmpeg — so
every refusal path is real and every success path is a shape.

### What the docs settle, and is implemented from them

- **Reactions** (api-v2/reactions): `POST /api/send-reaction` with `from_number`, the inbound
  `message_handle` and `reaction`; six case-sensitive classic names or exactly one emoji, `-` to
  remove; `part_index` for a part of a multi-part message; the primary handle only, never an
  attachment-specific one; iMessage only; inbound messages only; "reactions can be sent to messages
  received within the last few days".
- **Effects** (guides/expressive-messages): the 13 styles, `send_style` on `/api/send-message`,
  iMessage only.
- **Voice notes** (sending-messages, guides/voice-notes): ".caf files are rendered as voice memos",
  and the conversion command is theirs verbatim — `ffmpeg -i input -acodec opus -b:a 24k out.caf`.
- **An inbound effect**: `send_style` is on the documented receive payload, so one somebody used is
  readable and is described to Reason.

### What has NOT been proven

- **No tapback, effect or voice note has ever been sent.** Not one request has left this repo. Every
  one of these is a shape test against a documented contract.
- **Whether this line supports reactions at all is unknown.** "Not every Sendblue phone number
  supports reactions"; an unsupported `from_number` returns 422. On the free shared line this may
  simply never work, and nobody has found out. The 422 is handled and remembered against the line,
  so the failure mode is "quietly absent and visible in `/health`", not a loop. **First thing to
  check on a real thread.**
- **"Within the last few days" has no number in it.** A 404 is read as the message being too old
  and says so; where the real boundary is, is unknown, so nothing pre-filters on age.
- **ffmpeg has never run.** The conversion path is exercised with an injected runner on a machine
  with no ffmpeg, so what is proven is the refusal and the command's shape — not that Sendblue
  accepts the `.caf` ffmpeg produces, and not that an iPhone renders it as a voice memo.
  **Installing ffmpeg is Omari's call and was deliberately not done.**
- **Inbound tapbacks cannot be heard, and that is Sendblue's design.** No webhook type is a
  reaction; `message_type` is documented as "message or group"; neither the `receive` nor the
  `outbound` payload has a reaction field. So somebody hearting a message of Reason's is invisible
  to it. Nothing here works around that, and Reason is not told a reaction happened, because
  nothing tells it.
- **Whether the model uses the voice note well is untested.** Never offering one that cannot be sent
  is a prompt rule, asserted to be present and never exercised against a live model. The tapback and
  effect rules have since been run against a real model — see the next section.

## Tapback and effect guards (added 2026-10-05)

The three things code owns in this feature: the question guard on a tapback-only turn, one effect
per conversation per hour, and a receipt for both. `src/tapbacks.js`, `mark_moment` and
`they_asked` on `react`, `holdReaction`/`takeHeldReaction`/`lastEffectAt`/`setPendingStyle` in
`src/db.js`, and the hold/effect handling in `src/runtime.js`.

Proven offline by `test/tapbacks.test.js` (25 tests, fake channel) and — unusually for this file —
**against a real model** by `test/flow-tapbacks.test.js` (4 tests, `REASON_BACKEND=claude-cli`, all
passing): "thanks 🙏" got a tapback and no text, a question was answered in words, good news got an
effect on a reply that reads on its own, and an ordinary back-and-forth got no effect at all.

### What the docs settle, and is implemented from them

- Nothing new. Every field used is the same documented set as the section above: `send-reaction`
  with `from_number` / `message_handle` / `reaction`, and `send_style` on `send-message`.
  Re-read at docs.sendblue.com/llms.txt and the linked reactions and expressive-messages pages
  while building this; the 13 styles and the reaction grammar are unchanged.
- Sendblue documents **7 webhook types** — receive, outbound, typing_indicator, call_log,
  line_blocked, line_assigned, contact_created. None is a reaction, which is the documentary basis
  for "Reason cannot hear a tapback somebody puts on its message". Capabilities now says that in
  those words, so the model cannot claim to have seen one.
- **A reaction goes on the PRIMARY handle**, and "an attachment-specific handle returns 422"
  (api-v2/reactions). Reading that back caught a real bug: the router was storing each part's own
  handle as the thread's tapback target, so after a pasted link — which arrives as `H`, `H_1`,
  `H_2` (see the parts section) — every tapback would have been aimed at `H_2` and 422'd. It now
  stores the base handle. Pinned by "the tapback target is the message, not the last part of it to
  land" in `test/parts.test.js`, which fails on the old line.

### What the docs are SILENT on, and what was decided here instead

- **There is no documented limit on `send_style`.** Nothing in Sendblue's docs says how often an
  effect may be sent, whether a line can be rate-limited for them, or whether a recipient's device
  suppresses repeats. **One per conversation per hour is this repo's own rule**, not a provider
  constraint, and it exists because rare is the whole of what makes an effect mean anything. If
  Sendblue has its own limit, nobody here knows what it is.
- **Nothing documents whether an effect can be combined with `reply_to` on the same send.** Both
  fields are documented individually and no page shows them together. Code allows it (the pin goes
  on the first part of a split reply, the effect on the last) and **this has never been sent**.
- **Nothing documents what a recipient sees when an effect arrives on a message they never open.**
  "Effects play on open" is Apple behaviour taken from Sendblue's framing and Omari's own note, not
  from a stated contract, and it has not been watched on a device from this code.
- **Nothing documents whether a reaction can be sent to a message in a GROUP thread.** The reactions
  page says iMessage and inbound only and does not mention groups. Reason has no group threads yet,
  so nothing here depends on the answer.

### What has NOT been proven

- **Still no tapback and no effect has ever left this repo.** Everything above — including the four
  live-model tests — ran against the fake channel. What the model decides is now proved; what
  Sendblue does with the request is not. The 422-on-this-line question in the section above is
  unchanged and is still the first thing to check on a real thread.
- **The hour limit has never been crossed on a real conversation.** It is proved by moving the test
  clock, including across a fresh `Runtime` to show it is read from the database rather than held in
  memory. A real hour has not passed over a real thread.
- **The held tapback has never been watched landing on a phone.** Offline it is proved to reach the
  channel after the words and to be dropped when a turn says nothing. Whether a tapback arriving
  just after a reply looks right on the device — rather than like a stray reaction — is a judgement
  only Omari can make with a phone in hand.
- **`mark_moment` on a reply that splits around a link is shape-only.** The effect is put on the
  last part (the words) by `sendSequence`, asserted on the outbox rows, and never sent.
- **The live flow tests assert what went out, never wording.** A model can pass all four and still
  pick a tapback that reads oddly in context. Four examples is not a measurement of taste.

## Inline replies (added 2026-10-05)

`src/replies.js`, `send({replyTo})` and `receive()` on the Sendblue adapter, `reply_to` on the
outbox row, and the `reply_to` tool. Proven offline by `test/replies.test.js` (28 tests). `fetch`
is injected and there are no Sendblue credentials in the tests, so every request is a shape and no
reply has ever been pinned under a message on a real phone.

`test/flow-replies.test.js` (2 tests) runs the tool with a real model on a fake iMessage thread:
an ordinary back-and-forth is not pinned, and asked to answer under an earlier message it quotes
that message and the reply goes out under it. Both passed on 2026-10-05 via the `claude-cli`
backend, not the API.

### What the docs settle, and is implemented from them

- **Sending** (guides/inline-replies): `reply_to: { message_handle }` on `POST /api/send-message`,
  using "the exact public message_handle returned by a Sendblue API response or webhook". For an
  attachment with its own inbound webhook, that webhook's handle is the one to use, so the full
  handle is stored and sent, never the stem. `part_index` and `thread_originator` are response
  fields and are not sent.
- **A rejected reply sends nothing**: "A rejected reply is not sent as a standalone message and is
  not downgraded to SMS. Handle the returned 400 response as a validation failure." That sentence
  is what makes the fallback safe — after a 400 the same message is sent once more without the pin.
- **Receiving**: "Reply relationships are returned on message responses, status callbacks, and
  inbound/outbound message webhooks", as nested `reply_to.message_handle`. That is read off the
  inbound webhook and resolved against the one conversation it arrived in.
- **V2 iMessage lines only**, and never SMS.

### What the docs do not settle

- **Whether this line is a V2 line that supports inline replies.** Never tried. If it is not, every
  pinned send costs one refused request and then goes as an ordinary message. Nothing remembers
  that refusal, because the 400 carries no documented error key and so cannot be told apart from
  "this one message cannot be replied under" — remembering it would turn one stale handle into
  never pinning again. If the first real threads show every pin being dropped (`reply_dropped` in
  the log), that is the thing to add.
- **What the 400 body looks like.** No error key or message is documented, so nothing branches on
  it: any 400 on a send that carried `reply_to` is retried once without it, and if the pin was not
  the problem the second answer is the real refusal. The cost of being wrong is one extra request.
- **Whether a handle comes back in the same case it was given.** The docs' own example shows an
  upper-case handle for the parent and a lower-case one for the new message, so handles are matched
  ignoring case.
- **How old a message can be and still be replied under.** "Not in a replyable sent or received
  state" is the only wording. Reactions document a few-days limit; replies document none.
- **Whether the handle on a send response is the one a later inbound `reply_to` carries.** It is
  assumed so — it is the only public handle there is — and an inbound reply whose parent is not on
  record is said to be exactly that rather than guessed at.
- **Group threads and carousels** take `reply_to` too. Reason has neither, so neither is sent.

### What is a choice rather than a fact

- **The model names a message by quoting it**, and the most recent message carrying those words
  wins. Two messages with the same words can only be told apart by quoting more of one; the tool
  result says which message it found so a wrong pick is visible before anything is sent.
- **A reply under the newest message in the thread is refused.** Inline and ordinary say the same
  thing there, and pinning every message is the thing that makes an assistant look like a bot.
- **Messages from before this change cannot be quoted**, because what an inbound message said was
  not kept with its handle until now. Reason's own sent messages can, since the outbox always had
  both.
- **Only text is pinned.** A call summary arriving with its recording is never sent as a reply.
- **A reply is pinned by code when the thread has moved on** (added later on 2026-10-05, after two
  texts ten seconds apart got two plain replies nobody could tell apart). "Moved on" means a
  message this turn did not send sits after the text being answered. Two messages recorded in the
  same millisecond are ordered by row id across two tables, which is a guess; real texts do not
  tie.
- **A burst is announced to the model as N separate texts**, and whether they are one thought is
  left to it. Run twice through the `claude-cli` backend: two different questions got two pinned
  answers, a correction got one plain reply. Not run against the API.
- **A text that arrives while a turn is running waits for the sweep** (up to 15 s) before its own
  turn starts. That was already so; it is why the second answer came 19 s after the first.
- **Still true: no pinned message has been seen on a real phone** at the time of writing.

## The Bland call provider (added 2026-10-05)

`src/calls/bland.js`, `src/calls/choose.js`, the `POST /calls/{provider}/webhook/{token}` route in
`src/http.js`, and the per-person daily call caps in `src/accounts.js`. Proven offline by
`test/bland.test.js` (38 tests).

**No phone has ever rung.** There is no `BLAND_API_KEY` on this machine and none was looked for.
Every test drives the adapter with an injected `fetch`, so what is proven is the shape of a request
against a documented contract and nothing about what Bland does with it.

Everything below was read from Bland's own docs on **2026-10-05**, with the page named.

### What the docs settle, and is implemented from them

- **Placing one** (api-v1/post/calls): `POST https://api.bland.ai/v1/calls` with
  `authorization: Bearer <key>`. Body: `phone_number` (E.164, required), `task` (the prompt,
  required, "keep the prompt under 2,000 characters where possible"), `first_sentence` ("makes your
  agent say a specific phrase or sentence for it's first response"), `record` (**"default false"**),
  `max_duration` (minutes, default 30), `webhook` ("when the call ends, call information is sent to
  this webhook URL"), `from` (optional — "by default, calls are initiated from a separate pool of
  numbers owned by Bland"), `voicemail` (`{action}`, default `hangup`), `ivr_mode` (default false).
  The answer is `{status, call_id}`, and "it does not wait for the call to finish".
- **Checking one** (api-v1/get/calls-id): `GET /v1/calls/{call_id}`, with `status`, `queue_status`,
  `completed`, `answered_by`, `error_message`, `summary`, `transcripts[]`,
  `concatenated_transcript`, `corrected_duration` (seconds, as a string), `call_length` (minutes),
  `price` (USD), `record` and `recording_url`.
- **The audio** (api-v1/get/calls-id-recording): `GET /v1/calls/{call_id}/recording` takes the API
  key and returns an audio stream, "in the requested or default format (WAV)".
- **Webhook signing** (tutorials/webhook-signing): HMAC-SHA256 over the body, hex, in the
  `X-Webhook-Signature` header, against a secret created by hand in the dashboard.
- **Voicemail is not a status** (platform/agent-quickstart): "A completed call that reached
  voicemail is still `status: completed`." So voicemail is read from `answered_by`, which is what
  keeps an answering machine from being filed as a conversation that happened.

### Decisions taken here, and why

- **`record: true` on every request.** Their default is `false`, and Reason's announcement tells
  the other person they are being recorded. There is no setting that removes it.
- **The audio is fetched from `GET /v1/calls/{id}/recording`, not from `recording_url`.** In
  Bland's own examples that URL is sometimes `api.twilio.com`; sending this account's API key to
  whatever host is in that field would hand the key to a third party, and nothing in the docs says
  that URL needs authentication anyway. `recording_url` is read only as the yes/no of whether a
  recording exists.
- **A prompt that will not fit under 2,000 characters is refused, not trimmed.** Everything that
  could be cut — the standing rules, the goal, the approved facts — is something the call needs.
- **`voicemail: {action: "hangup"}` and `ivr_mode: false` are sent explicitly** even though both
  are Bland's documented defaults, so a change to their defaults cannot start leaving voicemails in
  somebody's name or silently suppress voicemail handling.

### What the docs leave open, and is NOT guessed at

- **`canceled` has no Reason state.** Bland's `canceled` ("call was canceled before completion")
  maps to `failed`, with the word "cancelled" in the outcome text so the row still says what
  happened. There is no better state to put it in and none was invented.
- **`declined` is a Reason state Bland never produces.** Their status list has no "the other end
  rejected it"; a rejected call presumably surfaces as `busy` or `no-answer` at the carrier, but
  the docs do not say so, so nothing here produces `declined`.
- **`status: "unknown"` is called `failed`.** Their docs say only "status could not be determined".
  It is deliberately NOT treated as a conversation that happened, because Reason must not report an
  outcome it does not have — which also means a recording missing from such a call raises no alarm.
  Whether that is the right call is unknown until one happens.
- **`answered_by: null` and `"unknown"` are both treated as a conversation.** Their docs say
  `unknown` "is most likely a human" and `null` means "not enabled, or still processing". Calling
  both `completed` errs towards reporting a missing recording rather than quietly not having one.
  The cost of being wrong is a false "recording missing" on a call nobody answered.
- **Post-call fields settle late.** "Webhooks may take up to a minute to fire after the call ends
  while the call audio is processed", and a transcript "may still be filling in". Nothing here
  re-checks a call once it has been written down as finished, so a call settled the instant it
  ended could keep a thinner transcript than Bland eventually has. Not yet a problem anybody has
  seen, because nobody has seen one.
- **Whether their signature is over the raw bytes or the re-serialised body.** Their own
  verification example hashes `JSON.stringify(req.body)`, which is not byte-for-byte what arrived.
  Both are accepted — either one matching still proves the sender knew the secret — but which one
  Bland actually signs is unknown until a real delivery lands.
- **What a voicemail hangup leaves behind.** Reason tells Bland to hang up rather than leave a
  message, and a voicemail still counts as having spoken to something, so the missing-recording
  alarm applies to it. Whether Bland produces a `recording_url` for a call that hung up on a
  voicemail beep is not documented. If it does not, the first voicemail will report a missing
  recording that is arguably not a fault. **Worth watching on the first one.**

### What has NOT been proven, and only a real call can prove

- **That the announcement is really spoken, word for word, before anything else.** This is the
  whole consent story — several states Reason will call into are all-party-consent for recording.
  `first_sentence` is the right field by the docs and the prompt separately forbids rewording it,
  but nobody has heard it. **The first thing to check on the first real call.**
- **That it really declines when asked for a card.** The rule is in the prompt ahead of the goal,
  and the request itself cannot carry payment details (`src/calls/payments.js` refuses before the
  dial). Whether the voice on the phone actually holds the line when a restaurant says "we just
  need a card to hold the table" has never happened. **Test it deliberately, before it happens by
  accident.**
- ~~That a recording comes back at all, and that it plays.~~ **Checked on the first real call,
  2026-10-05, and it was wrong.** `/v1/calls/{id}/recording` answered 200 with 111 bytes of JSON
  (`{"code":200,"status":"success","url":"https://api.bland.ai/v1/recordings/<id>"}`), which was
  filed as `call-1.wav` and marked stored. The audio is at that second address; it answers 401
  without the key and `audio/x-wav` (16 kHz, 16-bit, stereo) with it. Fixed: the pointer is
  followed when it is on Bland's host, the bytes are checked before anything is called stored, and
  the file is named for what the bytes are. Sending `Accept: audio/wav` to the first endpoint
  returned the audio directly but as MP3 (`audio/mpeg`), so no Accept header is sent.
- **Still open: how late the price and the summary can be.** On that call both were absent when the
  call was settled and present about three seconds later. `call_status` re-reads a finished call
  that has neither for up to a week, but **nothing re-reads on its own**: a call settled by webhook
  that nobody asks about stays without them until somebody does.
- **That the webhook arrives, and that the signature verifies.** Neither the route nor the
  signature check has seen a real delivery. **With no `BLAND_WEBHOOK_SECRET` set, a delivery is
  accepted on the unguessable per-call token in its URL and nothing else** — which is weaker than a
  signature, and is the reason that is said here rather than left to be discovered.
- **That `price` is populated when the call ends.** `cost_cents` is written from it. If it settles
  later than the rest of the call object, a webhook-settled call could keep a null cost.
- **Which statuses really turn up.** All of the mapping above is read off a documented list. Which
  of them a real restaurant at eight on a Saturday actually produces is unknown.
- **The daily call caps have never been hit by a real call.** The counting is proven offline; that
  10 calls and 30 minutes are the right numbers for a person is a guess, and Omari's to change.

## Reason's voice, and listening to voice notes (added 2026-10-05)

`src/voice.js`, the afconvert path in `src/expressive.js`, the `voice_note_say` tool, and the
listening step in the router's drain. Proven offline by `test/voice.test.js` (25 tests, one of
which runs the real `afconvert` on a machine that has it) and by `test/flow-voice.test.js` (2 tests
with a real model and a stand-in speech server).

### What has actually run, on this machine, on 2026-10-05

- **afconvert writes the voice-memo format.** `afconvert -f caff -d opus@24000 -c 1` produced a file
  `afinfo` reports as `1 ch, 24000 Hz, opus` in a CAF container, and `-f WAVE -d LEI16@16000 -c 1`
  read it back. This replaces the earlier note that the conversion "has never executed": there is
  no ffmpeg here and none was installed — there is no Homebrew on this Mac either.
- **The whole loop with the real models.** `speak()` → Gemini `gemini-3.8-flash-tts` (voice Puck) →
  `.caf` → served over local HTTP → `hear()` → transcribed. The words came back right; "Omari" came
  back as "Amari" once, which is why the line a turn reads warns that a transcript can mishear a
  name or a number.
- **A direction in the prompt is spoken.** "Say this the way a friend would in a quick voice note,
  relaxed and natural: ..." came back with that sentence in the audio, and so did the shorter "Say
  in a relaxed, natural voice: ...". The bare text came back word for word twice. A system
  instruction is refused with a 400 ("Developer instruction is not enabled for this model"). So the
  model gets only the words and there is no tone control.
- **With a real model deciding:** asked for a voice note it called `voice_note_say` once and did not
  text the same words; an ordinary question got text and no voice note. Via the `claude-cli`
  backend, not the API.

### What has not

- **No voice note has reached a real phone, and none from a real phone has been listened to.**
  Whether Sendblue delivers this `.caf` as a voice-memo bubble, and whether a memo recorded in
  Messages converts with the same afconvert arguments, are both first-real-thread questions. Apple's
  own recordings are Opus in CAF, which is the format tested, but that file came from afconvert and
  not from a phone.
- **`.amr`** is read as a voice note by its extension and has never been put through afconvert.
- **The ffmpeg paths** (`VOICE_FFMPEG_ARGS`, `WAV_FFMPEG_ARGS`) have never executed anywhere. Linux
  and the Docker image depend on them.
- **The inbound `media_url` is fetched with no credentials**, as pictures are. If Sendblue ever
  wants auth on it, listening fails with "could not be downloaded" and says so.

### Limits that are facts about the account, not the code

- **The Gemini key is on the free tier: 3 spoken requests a minute** for `gemini-3.8-flash-tts`
  (`GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, read off a real 429). A daily cap
  probably exists too and was not reached. Over the limit, `voice_note_say` says the voice is over
  its limit for the moment and Reason texts instead.
- **`gemini-3.8-flash` answered 503 "experiencing high demand" three times in ten minutes** while
  transcribing. It is tried twice, then `gemini-3.5-flash-lite` listens instead (same words back on
  the test clip, and faster). Only for a 503; any other refusal is reported as it is.

### What is a choice rather than a fact

- **Only to the person whose thread it is.** `voice_note_say` has no `to`: speaking in Reason's
  voice to a third party is a different decision from texting one, and nobody has made it.
- **A voice note is never pinned as an inline reply, and never carries a caption.**
- **The sound is not kept.** The spoken file is deleted once it has gone and a heard one once it is
  transcribed; what was said is in the conversation as text either way.
- **Listening happens at the turn, not at the webhook**, with the typing bubble already up — a few
  seconds on top of the reply, and a failure never costs the turn.

## Saved sign-ins, real sites, the spending limit and Spotify (added 2026-10-05)

`src/signin.js`, `src/signin-cli.js`, `src/sites.js`, `src/spotify.js`, the spending cap in
`src/trust.js`, and their tools. Proven offline by `test/signin.test.js`, `test/sites.test.js` and
`test/spotify.test.js` (77 tests) against local fixture pages and a fake Spotify server.

### What has actually run

- **The site probe**, once, on 2026-10-05 at 06:16 UTC: headless Chromium, scratch profile, signed
  out, no stealth plugins. Four of ten sites loaded (Uber, Lyft's front page, Amazon, Fandango) and
  six refused (OpenTable, DoorDash, Uber Eats, Delta, United, Ticketmaster). The raw results are
  `docs/site-probe-2026-10-05.json`. It is one run from one home connection on one night; a site
  that refused may not tomorrow, and one that loaded may start refusing.

### What has not

- **Nobody has signed in to anything.** `npm run signin` has never opened a window on a real
  sign-in page with a person in front of it, so whether each site lets a person sign in inside this
  Chromium at all is unknown. Sites that refuse the headless browser may refuse this window too.
- **No "am I signed in" probe has ever seen a signed-in page.** Each one is written from what the
  signed-out page does (the account page redirecting to sign-in) and from fixtures. The first real
  sign-in per site is the test of its probe.
- **No errand has been walked on a real site**, signed in or out, beyond loading the entry page. The
  commit labels per site are the labels those sites are known to use, not labels read off a live
  checkout.
- **Whether a saved session survives.** How long each site keeps a session alive in this profile,
  and whether it asks for a second factor again from a headless browser, is unknown.
- **Nothing has been sent to Spotify.** There is no developer app. The authorize URL, the token
  exchange, the refresh and every endpoint are shapes from their docs against a fake server. Their
  playback errors (no Premium, no active device) are documented only as a status and a message, so
  the wording that names the likely cause is an inference and says so.
- **The Uber link** follows Uber's published deep-link format and has never been tapped on a phone.

### What is a choice rather than a fact

- **The spending limit counts what was approved, not what was charged.** The amount is the largest
  dollar figure in the line the person said yes to. A hold or a deposit named in that line counts as
  spend, which over-counts in the safe direction; an approval naming no amount counts as nothing,
  which is why a priced page cannot be committed on one.
- **Dollars only.** A bare number or another currency is not read as an amount.
- **Sign-in is for the person at the machine.** Everybody else is told there is no safe way yet.
- **The browser launches with `--disable-blink-features=AutomationControlled`**, as it has since
  the first browser tool. It is the only launch flag of that kind, there are no stealth plugins and
  nothing spoofs a fingerprint — but it is worth a deliberate yes or no from the owner now that the
  rule for real sites is "a block is a finding, not a problem to defeat".

## The sign-in window, opened from a text (added 2026-10-05)

`src/signin-window.js` and the `signin_open` tool. Proven offline by `test/signin-window.test.js`
(11 tests) with a stand-in process for the window.

- **Has run:** on this Mac, against a scratch data folder, the real window opened on Amazon's
  sign-in page from a background process, was closed by the time limit about three seconds after
  the limit passed, and left nothing running.
- **Has not:** nobody has signed in through a window opened this way, so the whole loop — asked by
  text, window opens, person signs in, window closes, Reason texts what the site said — has never
  completed with a real account. The model has not been run against `signin_open` either.
- **A choice:** the window is on the machine's screen. There is no link to tap and no sign-in page
  of Reason's own, because the session has to be made in the browser Reason will use. Doing it from
  a phone needs the hosted, streamed browser described under saved sign-ins, in which the person's
  keystrokes would pass through Reason on their way to the site — which is a decision for the owner
  and has not been made.

## Signing in from a phone (added 2026-10-05)

`src/signin-remote.js`, the `/s/{token}` routes and the `signin_link` tool. Proven offline by
`test/signin-remote.test.js` (22 tests) with a stand-in browser.

### What has actually run

- **The whole path against Amazon's real sign-in page, on scratch data, signed out.** A link was
  made, Start launched the browser, the picture came back as a phone-sized JPEG of Amazon's form, a
  tap focused the email box, typed text appeared in it, and Done reported `signed_out`. Nothing was
  submitted to Amazon. Then the same again through the page itself, in a phone-sized touch browser:
  tap on the picture, type in the box, Send, Done.
- **That run found a bad address.** The saved Amazon sign-in URL (`/ap/signin`) answers 200 with a
  dead "Looking for Something?" page. It now starts from the order-history page, which redirects to
  a working form. The same bad address was what the window on the Mac would have opened.

### What has not

- **Nobody has signed in through it.** Not with a real account, not from a real phone, not over the
  public address. So: whether a site finishes a sign-in in this browser, whether the saved session
  then survives into Reason's own browser, and how iOS Safari's keyboard behaves with the page are
  all first-real-use questions.
- **Sites that refuse the headless browser** (six of ten, see the probe) will very likely refuse
  here too; the tool warns before the link is sent.
- **Second factors.** A code by text or email should work, since it is typed. An "approve on your
  phone" push should work. Face ID, passkeys and security keys cannot.
- **The other nine sites' sign-in addresses** have not been opened and looked at the way Amazon's
  was. Amazon's was wrong and was marked verified.
- **The model has not been run against `signin_link`.**

### What is a choice rather than a fact

- **What is typed passes through Reason.** Decided by the owner on 2026-10-05 with that stated. It
  is relayed to the page and kept nowhere; the claim is "not kept and not seen by the model", never
  "does not pass through".
- **Possession of the link, then of the first device.** There is no code to enter. The link goes to
  the person's own thread, is good for ten minutes unopened, and binds to the first browser that
  taps Start. Somebody who gets the link first, before the owner taps Start, gets the session.
- **Sessions are in memory.** A restart ends every one, which is the safe way to fail and means a
  deploy mid-sign-in costs that person a fresh link.
- **A picture a few times a second, not a video stream.** Simple, works through any proxy, and is
  slow on a bad connection.

## The phone sign-in page, rebuilt (added 2026-10-05)

The owner opened the first version on his iPhone at 11:39 on 2026-10-05 and got a blank white
rectangle under a toolbar: "terrible and not intuitive at all". `src/signin-remote.js` was rebuilt
around that. `/shot` became `/view`; the toolbar, the "Type here, then Send" box and the key row
are gone.

### What went wrong, and how that is known

**The white rectangle was one request that never came back.** The old page set a `busy` flag before
each `fetch`, cleared it after, and had no deadline, no retry and no message. One stalled request
left `busy` true for good: no further request was ever made and nothing was said. Reproduced
exactly — a proxy in front of a scratch server that holds the first `/shot` open and never answers
it leaves WebKit on an iPhone profile with `img.src === ""` for ever, which is the owner's
screenshot. The same proxy against the rebuilt page gives up at nine seconds, retries, and the
picture is up by about twelve.

Everything else that was suspected was ruled out by running it: Amazon's real sign-in page loads
in the headless browser in about 600 ms and screenshots as a readable form (no bot check, no blank
page); the `Path`-scoped `SameSite=Strict` cookie is sent on the fetches after the redirect; blob
URLs swap fine in iOS WebKit; and the whole page works over real HTTPS/HTTP-2 through Tailscale on
the same host name. **So the exact trigger on the owner's phone is not proven** — only that this is
the one failure mode that produces precisely that picture, and that it is now impossible to sit in
silently.

### What has actually run

- **The whole flow against Amazon's real sign-in page**, scratch data, signed out, in Playwright
  WebKit on an iPhone 15 Pro profile, over `https://reason.tail3753c7.ts.net:8443` (a second,
  temporary port mount alongside the live one; removed afterwards). Tapped the email box — the
  native input took focus inside the tap with `autocomplete="username"` and `inputmode="email"` —
  typed a made-up address, watched it appear inside Amazon's own box character by character, and
  tapped Amazon's own Continue on the picture. Amazon advanced to its next step. Nothing was
  submitted beyond that one Continue with an obviously fake address, and no account was created.
- **Password and verification-code boxes** against a local stand-in login page, because a made-up
  address never reaches a real site's password step and poking one repeatedly would be probing. A
  tap on the password box focused a `type="password" autocomplete="current-password"` input; a tap
  on a `maxlength=6` numeric box focused an `autocomplete="one-time-code" inputmode="numeric"`
  input. Both relayed into the site's own boxes.
- **Nothing typed reached anything that keeps.** Grepped every scratch log and the scratch database
  for each made-up value after each run: not one hit.
- **A transient `/view` failure during a navigation** happened by itself in the Amazon run and the
  page recovered on the next poll without the person seeing anything but the picture pausing.
- **Auto-finishing fired** on the stand-in site: two consecutive signed-in readings ended the
  session, and the real `checkAndRecord` then ran.

### What has not

- **No real iPhone, and no real account.** Everything above is Playwright WebKit with an iPhone
  profile, which is the same engine but not the same thing as the phone in somebody's hand.
  Specifically unproven: that iOS puts the **Passwords** key on the keyboard bar for these inputs,
  that picking an entry from it fills both boxes, that a code from Messages is offered over the
  `one-time-code` input, and that focusing inside a `pointerup` handler opens the keyboard on real
  iOS. The last of these is the one the whole design rests on; it holds in WebKit.
- **Nobody has completed a sign-in through it.** So the green ending — the site agreeing somebody
  is signed in and the session surviving into Reason's own browser — is still a first-real-use
  question. The auto-finish run above ended "could not tell", correctly, because the stand-in site
  is not in the site registry the real check reads.
- **A saved password could be offered to the wrong address.** The four native inputs live in a form
  on Reason's host, so iOS could in principle offer to save an Amazon password under Reason's
  address. The form never submits and never navigates, which is normally what suppresses that
  prompt, but it has not been seen on a real device.
- **Tapping a box that is already placed goes to the native input, not to the picture**, so the
  site's own field is focused on the first keystroke rather than on the tap. A site that does
  something visible on focus alone will do it a moment late.

### What is a choice rather than a fact

- **Entering a box clears it.** When a native input is focused over one of the site's boxes, that
  box is cleared and retyped from empty. The alternative was sending each field's contents back to
  the phone so the two could be kept in step, and nothing in a field is worth sending back.
- **The form is read with every picture, not asked for after each tap.** iOS only opens the
  keyboard for a focus that happens inside the gesture, so there is no room for a round trip
  between the finger landing and the input focusing. The cost is a page-wide `evaluate` per frame.
- **Two readings before finishing, and never in the first eight seconds or while a name, password
  or code box is on screen.** Picked to make ending somebody's sign-in out from under them hard. A
  false positive is survivable either way: the claim still comes from asking the site.


## Telling people what's new (added 2026-10-05)

`test/whatsnew.test.js` is 23 offline tests and every gate in it is code's rather than the model's,
so they are all provable without a key: an unverified entry never reaching the model, a verified one
whose capability is not live here never being offered, offered once and then never again, a skipped
offer staying unheard, an open confirmation holding it, an event turn never getting one, one a day,
an account younger than the feature not hearing it, a failed send and a silent turn both leaving it
unheard, a stale claim not being committed by the next reply, one entry per reply, the `whats_new`
answer being verified-and-live only, and the export and delete covering the rows.

What that does **not** prove, and none of it can be proved offline:

- **No real model has ever been offered one of these notes.** Everything above drives the gates
  directly or through an injected turn. Whether the model actually reads the moment right — leaves
  the line out of a reply about a cancelled flight, puts it on the end of an idle one, writes "oh
  btw u can connect ur gmail now" rather than a sentence that reads like marketing — is the whole
  point of the feature and is unknown until a real turn has one. There is nothing verified to offer
  yet, so this cannot be tried today even with credit.
- **The claim is the model's word that the line is in its reply.** Code checks the id is really
  that person's to hear and that the reply went out; it cannot check the words. So a model that
  calls `whats_new_said` without saying anything records a thing nobody heard, and one that says it
  without calling the tool will say it again another day. The second is the direction this is built
  to fail in, and it is why the tool's description says to call it only when the line is in what is
  being sent. A structured marker in the reply text would tie the record to the words, at the cost
  of a marker that could leak into somebody's message; that trade is written down here rather than
  settled quietly.
- **The claude-cli path is asserted against its source, not run.** `src/backends/claude-cli.js`
  builds its own prompt and cannot be driven without the CLI, so the test checks that it asks
  `whatsnew.noteFor` for the note and puts it in front of the model. That it lands usefully in that
  prompt, and that the CLI then calls `mcp__reason__whats_new_said` rather than something else, has
  not been seen. This is the backend the live Reason runs on, so it is the first thing to watch.
- **A queued message counts as sent.** If the reply carrying the line goes into the outbox rather
  than out of the door, the entry is marked heard. That matches what `ok` means in
  `src/deliver.js` — it will arrive or be reported as lost — but a message that dies in the outbox
  means somebody was never told and never will be. Silence was chosen over the alternative, which
  is telling them twice.
- **Nothing is verified yet, so no announcement has ever been eligible.** The Gmail entry is
  deliberately unverified. The first real test of the whole thing is the first feature somebody
  marks verified by hand.
## Gmail, per person (added 2026-10-05)

`src/google.js`, the `google_connect` / `google_disconnect` / `gmail_*` tools in `src/tools.js`, the
per-person `gmail` and `google_calendar` entries in `src/trust.js`, the `/google/callback` route in
`src/http.js`, and the state expiry and reconnect state in `src/db.js`. Proven offline by
`test/google.test.js` (56 tests) against a fake Google server (`test/fixture-google.js`) standing in
for accounts.google.com, oauth2.googleapis.com, gmail.googleapis.com and www.googleapis.com.

Everything below was written from Google's docs read on 2026-10-05: OAuth 2.0 for web server
applications, the Gmail API reference for messages, threads, drafts and labels, and the Google API
Services User Data Policy. The endpoints, parameters and error shapes are theirs; nothing was written
from memory.

### What has actually run

- **Nothing against Google.** Not one request. Every test answers the fake server. The real
  `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are on the machine and have deliberately
  never been used — the first real sign-in is Omari's to do, with somebody watching.

### What has not, test by test

Each line is a test that passes against the fake and has never been checked against Google.

- **The authorize URL** is `accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`,
  `response_type=code`, a space-delimited `scope`, `state`, `access_type=offline` and
  `prompt=consent`. Whether Google's consent screen shows the two scopes the way the tool describes
  them, and whether `prompt=consent` really returns a new refresh token every time, is unconfirmed.
- **The token exchange** posts `code`, `client_id`, `client_secret`, `redirect_uri` and
  `grant_type=authorization_code` form-encoded to `oauth2.googleapis.com/token`. The response is read
  for `access_token`, `refresh_token`, `expires_in` and `scope`. Never sent.
- **The redirect URI** is built by `callbackUrl()` and must match
  `https://reason.tail3753c7.ts.net/google/callback` exactly. That it matches what is registered has
  been read off the console by Omari and never confirmed by Google accepting it.
- **The refresh** posts `grant_type=refresh_token`. That a real refresh response carries no new
  refresh token — which is what the store's "do not overwrite with empty" depends on — is their
  documented shape and has not been seen.
- **`invalid_grant` means reconnect.** Tested by making the fake answer it. That a grant Google has
  ended really presents as `invalid_grant` on the refresh, rather than as something else, is from
  their error documentation and has not been watched happen.
- **The consent screen was published on 2026-10-05; that the weekly expiry has stopped is not
  proven.** Google's console shows "In production", External, unverified, 1 of a 100-person cap. The
  first real connection was made earlier that day while it was still in Testing. Their documentation
  says the seven-day expiry applies to Testing only; nobody has yet held a connection made after
  publishing for more than a week, so that is their word and not something seen.
- **The revoke** posts to `oauth2.googleapis.com/revoke?token=…` with
  `Content-Type: application/x-www-form-urlencoded`, which is the form their own curl example uses.
  Whether Google accepts the token in the query string rather than the body has not been checked.
- **`users.getProfile`** is how the connected address is learned. That `gmail.modify` alone is enough
  for it is stated in their reference and unproven.
- **Search** calls `users.messages.list` with `q`, `maxResults` and `includeSpamTrash`, then
  `users.messages.get` with `format=metadata` per id. The fake honours a toy subset of Gmail's query
  language — `is:unread`, `from:` and plain words — so **nothing here tests Gmail's real search
  syntax**. A query that Gmail parses differently will behave differently and no test will know.
- **Reading** uses `format=full` and walks `payload.parts` for `text/plain`, falling back to
  `text/html` through the same `readableText` a web page goes through. Real Gmail HTML is far messier
  than the fixture's; how readable a real marketing email comes out is unknown.
- **Attachments** are listed from parts that carry a `filename`, using `body.size` for the size.
  Never seen on a real message, and `kb` is `size / 1024` rounded, which is Google's estimate of the
  encoded part rather than the file as saved.
- **Reading one attachment** is `users.messages.attachments.get`, which their reference says answers a
  `MessagePartBody` with `data` as a base64url string — so the bytes arrive inside JSON and the decode
  is ours. Proved offline, against the fake, with **real** PDFs out of `test/fixture-pdf.js` really put
  through the `osascript`/PDFKit reader: a text PDF attached to an email comes back with its words, one
  page of one, marked `untrusted_content` with the file named in `untrusted_source`; a real scan comes
  back `no_text` with a real page count and the only screenshot offer in the feature; a really
  encrypted one comes back `locked` and quotes nothing; a `.docx` is refused on its type **before any
  download** (the fake's `attachmentReads` is empty); an instruction written inside an attached PDF is
  flagged with its shapes and cannot become a yes; an attachment id from a different message is refused
  and names what really is attached; and with `REASON_PDF_READER=none` the refusal blames the machine.
  **What this cannot settle:** no real attachment has ever been fetched from real Gmail. Whether the
  read scope really covers `attachments.get` on a live consent screen, whether a real message's
  `attachmentId` survives a round trip the way the fixture's does, and whether Gmail's `size` matches
  what comes back are all unproven. Nothing here has been near Google.
- **Threading.** A reply sets the same `threadId`, `In-Reply-To`, `References` and a matching
  `Subject`, which are Google's three stated conditions. The fake checks all three and records the
  result; whether a real Gmail thread accepts it is the single most likely thing here to be subtly
  wrong, because the consequence (a reply that starts a new conversation) is invisible to the sender.
- **Sending and drafting** post a base64url RFC 2822 document in `raw`. The body goes out base64 with
  `charset="UTF-8"`; a non-ASCII subject is RFC 2047 encoded. No real client has rendered one.
- **Archive, mark read/unread and label** are `users.messages.modify` with `addLabelIds` /
  `removeLabelIds` — `INBOX` off for archive, `UNREAD` off for read. **Bin** is
  `users.messages.trash`. That the system label ids are spelled exactly that way is from their labels
  guide and has not been read off a real mailbox.
- **No permanent delete exists.** `users.messages.delete` requires `https://mail.google.com/` and
  nothing else, which Reason never asks for. Not a choice that can be reversed by a flag: the scope
  is not on the consent screen.
- **Rate limits and quotas.** Never hit one. The 429 and `RESOURCE_EXHAUSTED` branch is written from
  their error shape and has never fired. A search of a large mailbox makes one `messages.get` per
  result, which on fifty results is fifty-one requests, and whether that trips a per-user limit is
  unknown.
- **A large mailbox.** The fake has four messages. Nothing has been run against a real inbox, so how
  slow a search feels, and whether `maxResults` of 50 is a sensible ceiling, is a guess.

### What is a choice rather than a fact

- **`prompt=consent`, every time.** Their docs say the refresh token comes back only on the first
  authorization. Google can end a grant at any time — and did so every seven days while this app's
  consent screen was in Testing — and a reconnect that came back without a refresh token would be
  dead within the hour. Forcing the consent screen every time is the price of that always working.
  It means somebody reconnecting sees the full permission screen again rather than a quick redirect.
- **One grant, both capabilities.** Gmail and Calendar are one consent, one refresh token and one
  `oauth_tokens` row under the provider `google`, with a `connected_accounts` row per capability. So
  `email` and `calendar` connect together and die together, and a consent with one box unticked
  leaves the other honestly not connected.
- **Sending is gated even when the mail goes to themselves.** What the gate protects is not only who
  it reaches but that the words going out are words they saw.
- **More than one message at a time is gated; one is not.** Drawn there because nobody reads a list
  of forty, and "archive everything from that sender" on a misread query is how a year of mail
  leaves an inbox. One message is small, visible and reversible by hand.
- **A draft is a ledger row.** Nothing leaves the account, but Reason's words appear in their Gmail,
  and "where did this draft come from" deserves a receipt. Reads are not on the ledger.
- **The yes is pinned to a computed target, not to the model's summary.** `sendTarget()` folds the
  recipients, the subject, the thread and the body's length and checksum into one string, which the
  tool recomputes from what it is really about to send. Changing a word produces a different target
  and the gate refuses it. The blocked result hands the model that exact string so it cannot fail the
  check by retyping it slightly differently.
- **A connect link expires after 15 minutes** (`GOOGLE_STATE_TTL_MS`). Spotify's never expires; this
  is deliberately tighter, because a link sitting unopened in somebody's messages a week later should
  not still attach a mailbox.
- **An email's contents are marked untrusted in the tool result**, and the system prompt carries the
  rule. There was no such convention in the repo before this — fetched web pages are not marked —
  so this introduces one, and `web_lookup` still does not use it.
- **Body text is capped at 4,000 characters per message** (`REASON_GMAIL_BODY_CHARS`) and says when
  it cut one short.

### One pre-existing bug this found

- **`normalizeTarget()` in `src/trust.js` treated any target with seven or more digits anywhere as a
  phone number**, stripping every non-digit. A booking target of
  `Carbone, Fri Sep 26 2026, 8pm, party of 4, $240` became `+262026800 4240`, and an email target
  became its own punctuation removed. Both sides of the comparison were mangled the same way, so
  `browser_submit` still refused changed details in practice — but two genuinely different actions
  could normalise to the same string, and a yes for one would then authorize the other. It now asks
  whether the whole string is phone-shaped. Phone targets behave exactly as before.

## Their calendar (added 2026-10-05)

The `calendar_*` tools in `src/tools.js` and the calendar half of `src/google.js`, on the same
per-person Google connection as Gmail. Proven offline by the calendar section of
`test/google.test.js` (21 of its 77 tests) against the same fake Google server.

Written from the Google Calendar API v3 reference read 2026-10-05: events.list, events.get,
events.insert, events.patch, events.delete, and calendars.get.

### What has actually run

- **Nothing against Google.** Same as Gmail: not one request. The first real use is Omari's.

### What has not, test by test

- **events.list** is called on `/calendar/v3/calendars/primary/events` with `timeMin`, `timeMax`,
  `singleEvents=true`, `orderBy=startTime`, `maxResults`, `q` and `timeZone`. Their docs say
  `orderBy=startTime` is only available with `singleEvents`, which is why the two go together. The
  fake filters by a crude string comparison on the dates, so **nothing here tests how Google really
  applies the bounds** — in particular that `timeMin` is a lower bound on an event's *end* and
  `timeMax` an upper bound on its *start*, which means an event straddling the range is included.
  Nothing depends on that being wrong, but no test would notice if it were.
- **The time zone** comes from calendars.get on `primary` and is re-fetched on every calendar call.
  That the field is `timeZone` on the Calendars resource is from their reference and has never been
  read off a real calendar.
- **RFC3339 bounds.** `rfc3339()` turns a bare date or a bare wall-clock time into a timestamp with
  the zone's real offset, resolved in two passes because the offset depends on the instant and the
  instant depends on the offset. Tested against `Intl` for New York in January and July and for
  Tokyo. **A time inside a skipped daylight-saving hour is not a real wall-clock time in that zone
  and what comes out of it is undefined** — no test covers that, and Google has never been asked.
- **events.insert** posts to the collection with `sendUpdates=all` when there are attendees and
  `none` when there are not. **That `sendUpdates=all` really emails the attendees, and that `none`
  really emails nobody, is the single most consequential untested thing in this commit** — their docs
  warn that "some emails might still be sent even if you set the value to false" about the deprecated
  `sendNotifications`, and whether anything leaks out under `none` has not been observed.
- **events.patch** sends only the changed fields. Their docs note a patch costs three quota units and
  suggest a get-then-update instead; this does a get (for the attendees) and then a patch, so the
  quota cost is theirs plus one. No quota has ever been measured.
- **Array fields on a patch overwrite.** Their docs say so explicitly, which is why `attendees` on
  `calendar_change` replaces the guest list rather than adding to it, and why the tool description
  says so. Never seen happen.
- **events.delete** answers an empty body; the client treats 204 as success. Unproven.
- **`attendee.self`** is how the person's own row in the attendee list is told apart from everybody
  else's, with the address checked as well in case `self` is absent. Read from their reference.
- **Recurring events.** Only `singleEvents=true` is ever used, so nothing here has created, changed
  or deleted a recurring event or one occurrence of one. `recurrence` is passed through to
  `eventView` for reading and there is no tool that writes it.
- **Only the primary calendar.** `calendarId` is hard-coded to `primary` everywhere. Somebody with a
  second calendar cannot reach it, and no tool exposes `calendarList.list`.

### What is a choice rather than a fact

- **Attendees are the whole test for whether a yes is needed.** An event with nobody else on it is a
  private note and is written with no confirmation; one with anybody else on it emails them, so it
  goes through the gate. "Dentist at 3" should just happen.
- **For a change or a delete, that gate lives inside the handler**, not in `needsConfirmation`, and
  this is the only place in the repo that does it. Who is on an existing event is a fact only Google
  has, so the event is fetched first, the gate is applied to what came back, and the yes is spent by
  hand after the write. `needsConfirmation` stays honest for `calendar_create`, which knows its
  attendees from the request.
- **Adding people to an event that had none is gated**, because that reaches them for the first time.
- **`sendUpdates` is always stated, never left to default.** The default is documented as not sending,
  but a decision about whether other people get an email should be in the request rather than implied.
- **A calendar invite's text is untrusted input**, same as an email's — a description is a place a
  stranger can write, and there is a test that an invite telling Reason to email a password produces
  no send without the person's own yes.

## A home page and a privacy policy (added 2026-10-05)

`src/pages/site.js`, the `GET /` and `GET /privacy` routes in `src/http.js`, and the `indexable`
option on the page shell. Proven offline by `test/site.test.js` (13 tests) over a real socket.

Google will not publish a consent screen without both links, so these exist for that — and because a
privacy policy is the one document where being approximately right is being wrong, every claim on it
was checked against the code rather than written from intention.

### What has actually run

- **Both pages, over a socket**, answering 200 to a request with no link, no code and no cookie, and
  every route that existed before still answering exactly as it did. The pages were also rendered and
  read as text by the person who wrote them.

### What has not

- **No reviewer at Google has seen either page**, and the consent screen has not been submitted for
  publishing. Whether these satisfy their review is unknown.
- **Nobody has read the privacy page who did not write it.** Omari has to, before it is used: it makes
  statements on his behalf about what happens to other people's mail.
- **The pages have never been fetched over the public address.** They answer on 127.0.0.1 in tests;
  that `https://reason.tail3753c7.ts.net/privacy` resolves and serves them has not been checked.

### Every claim on the privacy page, and what it was checked against

- "One database file … no other copy, no analytics service and no third-party storage" — the table
  list in `src/data.js` and the schema in `src/db.js`; `grep` for analytics, telemetry, Sentry,
  PostHog, Mixpanel and Datadog across `src/` finds nothing.
- "keyed to your conversation, and no query … can read one person's rows from another person's" —
  every read takes a `conversation_id`. Pinned by the two-conversation tests in `test/google.test.js`,
  `test/accounts.test.js` and `test/channels.test.js`.
- "the most recent 60 messages" — `MAX_HISTORY = 60` in `src/agent.js`. `test/site.test.js` asserts
  the constant is still 60, so changing it fails the test that guards the sentence.
- "the text of that email or event is in the transcript" — `saveConversation(conversationId,
  trimHistory(messages))` in `src/agent.js` saves tool results with the rest of the turn.
- "sends your conversation to Anthropic's API … there is no model on the machine" — `src/backends/`.
- Plans, reminders, timers, tasks, remembered facts, pages, page answers, the action ledger,
  confirmations, connected accounts, OAuth tokens, calls, call recordings as files, daily usage and
  committed spend — all present in `TABLES` in `src/data.js` and in the schema.
- "exactly two permissions", "cannot delete your mail permanently", "No access token or refresh token
  ever leaves the machine" — `SCOPE_LIST` in `src/google.js`, the absence of any delete tool, and
  `SECRET_COLUMNS` in `src/data.js`. Each has its own test.
- The PDF paragraph that replaced "Attachments are never downloaded or opened", sentence by sentence,
  against the code it describes. "Reading an email does not download what is attached to it" is
  `bodyOf()` listing parts without fetching them, and the fake records every
  `messages.attachments.get`, so the test asserts **one** download of **one** named attachment from
  the server's side rather than ours. "Pulled out on the machine Reason runs on" is `pdfText` through
  `/usr/bin/osascript`; there is no network call in `src/pdf.js` or on either caller's PDF path.
  "Not kept … deleted straight afterwards" is the `finally` in `pdfText`, asserted by reading the temp
  directory back on the passing path **and** on a real timeout. "A disconnect clears it" is
  `gmail_attachment` in `READ_TOOLS`, asserted on the text of a read PDF and not only on the tool
  list. The one sentence that is a claim about Google rather than about this code is that
  `messages.attachments.get` is covered by the read scope already granted: that is from their
  reference page, and no real consent screen has confirmed it.
- "it asks Google to let go of your connection on the way through — and reports honestly if Google
  would not" — `revokeGoogleGrants()` in `src/data.js`, with tests for both outcomes.
- "It removes … the saved browser logins" — `deleteProfiles()` in `src/data.js`.
- "Reason has no backups" — true of this code, which writes one database and one recordings directory
  and copies neither. **It is not a promise about the host.** A hosted install on a provider that
  snapshots its volumes has backups Reason knows nothing about, and this sentence would then be
  wrong. Flagged for Omari.

### What could not be confirmed from the code, and is flagged rather than asserted

- **"Anthropic's own terms govern what they do with it."** True as a statement about whose terms
  apply, and the page deliberately does not characterise what those terms say — that is not Reason's
  claim to make. Worth Omari checking that the API terms in force for this key do what he expects
  regarding training, because the page tells people to rely on them.
- **"no human reads it except …"** is a commitment about how this install is operated, not something
  code can enforce. Whoever runs the machine can read the database. The sentence is Google's Limited
  Use wording applied honestly, and it is a promise Omari is making rather than a fact tested here.
- **"not directed at children" and the under-13 line** are statements of intent about who the product
  is for. Nothing in the code checks an age.
- **"run by the person who gave you the number"** assumes the install is one person's. True today.
- **The Limited Use sentence is a paraphrase in the sense that Google's policy page enumerates the
  requirements rather than giving one sentence to copy.** The sentence used names the policy and the
  Limited Use requirements explicitly, which is the form their policy asks developers to affirm, and
  the four plain-words commitments under it are taken from the enumerated list on the policy page read
  2026-10-05. If their review wants exact prescribed wording, this is the line to change.

### What is a choice rather than a fact

- **These two are the only pages in Reason that may be indexed.** Everything made for one person
  carries `noindex,nofollow,noarchive`; a privacy policy that asked not to be read would be absurd, so
  the shell takes an `indexable` flag and only these two set it.
- **They are cached for five minutes and nothing else here is.** They are identical for everybody and
  have nothing of anybody's on them, and Google's reviewer will fetch them.
- **Exact paths, not prefixes.** `/privacy/` with a trailing slash is a 404, not the policy, so these
  two routes cannot swallow anything. `test/site.test.js` checks `/p/`, `/s/`, `/channels/`, `/health`
  and six near-misses still answer as they did.

## Commit: a link goes out as its own message

### What Sendblue's docs settle, and what they do not

Read 2026-10-05.

- **Settled: there is no link-preview parameter.** The full parameter table for
  `POST /api/send-message` (getting-started/sending-messages) is `number`, `from_number`, `content`,
  `media_url`, `app_card`, `send_style`, `status_callback`, `seat_id`, `reply_to` and
  `pre_reply_override`. No rich-link option of any kind is documented anywhere on the endpoint.
- **Settled: App Cards are not that path.** api-v2/app-cards requires `extensionBundleId`, a
  ten-character Apple `teamId` and a Messages extension the recipient has installed. Reason has no
  iOS app and no Apple Team ID, so this is closed rather than merely unused. Checked rather than
  assumed, because `app_card` sits in the same parameter table and looks like a card.
- **The only sentence about link previews in the whole of their documentation** is in
  guides/contact-card, about getting the recipient to save the sender as a contact: "it allows any
  links you send to expand on the end users phone".

### Never proved, and only a real iPhone can

- **Whether a bare URL from Reason's line draws a preview card at all.** On the reading above it is
  Apple's doing, on the recipient's device, and the one documented condition is the recipient having
  the sender saved as a contact — which nothing in Reason controls. `src/links.js` therefore sends
  the URL bare and claims nothing, and the system prompt forbids the model from promising a card,
  a title or a picture of the page. See `docs/iphone-checklist.md`.
- **Whether two sends a fraction of a second apart arrive in that order on the device.** The order
  they are SENT in is guaranteed here — one row per part, chained on `after_id`, the next not even
  due until the one in front of it is `sent` (`db.dueOutbound`), proved in `test/links.test.js`
  across a 429 and a permanent failure. What iMessage then does with two messages to the same
  thread in the same second is not something this repo can test.
- **Whether a link bubble and then a summary bubble is nicer than one bubble**, which is the actual
  point of the change. That is Omari's eye on a real thread.

### Proved offline for this commit

- A reply with no link in it is one message, byte for byte as it was written, and one outbox row.
- A reply with a link leaves as the bare URL and then the words, in that order, whatever order the
  model wrote them in; each link keeps its own words and never another link's. Except words ending on
  a colon, which leave first with their link under them (2026-10-06).
- A sentence's full stop is not sent as part of the address.
- The inline-reply pin goes on the link and not on both halves.
- A link that cannot go yet does not let its summary go first: the summary is not due until the
  link is sent, and the sweep finishes the chain in order.
- A link that is never going marks its summary failed too, with a reason saying why, and both land
  at the top of the next turn as replies that never arrived.

## Commit: a number left on the website asks the master too

`POST /access/web`, `handleWebRequest` in `src/access.js`, `Router.webAccess` and
`Router.askNextWaiting`, and the sweep's `accessQueue`.

### Never proved

- **A real person being let in from the website and then texting.** The first text a web applicant
  ever gets is the one after the master's yes, sent to a number that has never texted Reason's
  line. Whether the line will deliver that depends on the provider and the plan: Sendblue's free
  plan was read (2026-10-04) as requiring a contact to text the number first. If it does not go,
  the outbox tells the master it never arrived — that path is tested — but the person is left with
  a website that said they were on the list. Nobody has tried it.
- **The master's yes to a website request, read by a real model.** The judge is stated in
  `test/web-access.test.js`. The same `recordConfirmation` path is live-tested on a booking
  sentence (`test/flow-gate.test.js`), not on this one.
- **The form's server** is not in this repo. It was rehearsed once by hand against this code over a
  real socket with made-up numbers (signing, duplicates, the daily ceiling, a wrong secret, Reason
  unreachable) and is not covered by any test here.

### Known and left alone

- **One unanswered question holds the queue.** Only one request is in front of the master at a
  time, and one they never answer stays there for `REASON_ACCESS_WINDOW_MIN` (a week by default) —
  and is only marked expired when the master next texts anything. Everybody behind it waits. That
  was already true for people who text; the website makes it easier to reach.
- **An unsigned request costs one HMAC.** There is no limit on how often the route can be hit with
  a bad signature. It does no database work and sends nothing, so it is left to whatever is in
  front of the listener.
- **`REASON_MAX_REQUESTS_PER_DAY` applies to people who text as well**, not only the website. It is
  one ceiling on how often the master's phone is troubled, on purpose, and it is new for them.

### Proved offline for this commit

13 tests in `test/web-access.test.js`, judge stated: one question to the master and nothing to the
applicant; a yes sends their first text and their own texts then get turns; a no is silent and the
form cannot make the master be asked again inside the cool-off; no "you're in" on the subscription
backend; the same number, the master's own, a test-list number, an existing account and a blocked
number all get the same answer and no question; somebody already waiting by text is not asked about
again; one at a time, and the next is asked after the answer; the daily ceilings on both sides, and
the sweep asking about the held ones the next day; only a plain number gets through; unsigned,
wrong secret, other body, stale, future-dated and no timestamp are all 401 before the number is
read, and a replay changes nothing; no secret, no route; no line to text on, 503 and nothing
stored; and the route over a real socket.

## Commit: a record of what they sent, and what was got out of it

### Proved offline for this commit

- Every photo, voice note, file and link is one row carrying the message it came on, which one it
  was on that message, the coverage got out of it and the reason for a failure.
- The coverage words are the ones the model reads: looked, transcribed, no speech, read, watched,
  heard, metadata, failed, dropped. A transcribed note, a silent one and one that broke are three
  different rows.
- A link card's preview thumbnail is recorded as **dropped with its reason** rather than vanishing.
- A page Reason went and found itself is nobody's item, so nothing is marked.
- One person's record is not another's, in the table or in the tool.
- The record is in an export, scoped, and a delete takes it.

### Never proved, and what would settle it

- **Whether the model uses it.** "This one", "the second photo", "that link you read" resolving to
  the right item is the entire point, and it is the model reading `media_reviewed` and choosing.
  The prompt says the record is the truth and its own memory is not evidence. A live run is the
  only thing that shows whether it reaches for the tool instead of guessing — and the failure to
  watch for is the opposite one: calling `media_reviewed` on every mention of a photo.
- **Whether the drop rule is the right trade.** A photo on a message with a link in it is dropped,
  because Sendblue's payload cannot tell a link-card thumbnail from a photo. Every drop is a row
  with a reason, so the argument for changing it is countable rather than a guess. Nobody has
  counted yet, because no real traffic has run through it.

## Commit: a photo is read against the conversation it arrived in

### What is proved offline

Only this: that each rule is in the system prompt, on **both** backends, since `systemFor` is what
the CLI backend hands the CLI too (`test/photos-in-context.test.js`). Plus the one piece of it that
is code's — `remember` refuses a fact whose source is a picture or a deduction, and writes nothing.

### Never proved, and only the real model can

Each of these is its own line because each can fail on its own.

- **A car photo after "i'm thinking about buying a car" gets a question, not "congrats".** The named
  failure, in the spec's own words. Nothing offline can test a model's judgement about tone.
- **A photo with nothing around it gets one short question** rather than a story built out of it.
- **A question sent with a picture is answered first**, and anything else after.
- **A thin connection is called a guess or asked about**, rather than forced to fit.
- **A correction is accepted in one line and not argued with**, and nothing afterwards implies the
  old reading.
- **The model names its source honestly when it calls `remember`.** The refusal is only as good as
  that: a model that says `they_said` about something it inferred gets the row written. There is no
  code path from looking at a picture to a memory row, so this is the one seam, and it is a seam in
  honesty rather than in plumbing.
- **Whether "you can look at pictures" ever produces a claim about a picture that is not there.**
  The prompt forbids saying it cannot open pictures when one is in front of it; the opposite
  mistake — describing one that failed to convert — is the one to watch for on a real phone.

## Commit: a voice note is their words, and the gaps in it are asked about

### Proved offline

- All five states, distinct, and the record moving through `waiting` → `processing` → the outcome.
  A row left in `processing` is a crash rather than a shrug.
- The same note delivered twice is one turn and one item. A note arriving as a later part of a
  message already answered is still one answer, tied to the message its text came on.
- No speech and could-not-listen are different states and different lines.
- `[inaudible]` stretches are counted off the marker the transcriber was asked for; the count and
  the never-fill-it-in instruction reach the turn; nothing is said about gaps when there are none.
- A note's length comes off the bytes of the WAV. Over thirty seconds the transcriber is asked for
  timestamps and the markers are reported as real; under it they are not asked for.
- Their words are readable later by id and only by id, and not from another conversation's thread.
- A silent note stores no transcript, because there were no words, and its length is still a fact.

### Never proved, and what would settle it

- **The ordinary case has been seen on a phone and nothing else has.** The owner sent voice notes
  to the live Reason from his iPhone on 2026-10-05 and reported they "work perfectly", which
  settles a spoken note being heard and answered. Which cases he tried was not said, so everything
  below is still proved by fixtures and stubs only. `.amr` has never been through afconvert at all.
- **Whether Gemini ever writes `[inaudible]`.** The whole unclear-speech path hangs on the
  transcriber marking a gap instead of guessing a plausible word, which is exactly what a language
  model is inclined to do. The instruction asks for the marker by name and the counting is a
  literal string match, so the code is honest either way — but if the marker never appears, the
  feature does nothing and nobody would see a failure. **Send a note with something genuinely
  inaudible in it and look for `unclear: 1` in the log.**
- **Whether the timestamps are real.** The transcriber is asked to take them from where a sentence
  really falls in the audio. Nothing here can check that against the audio, so a quoted time is as
  good as Gemini's word for it. The threshold means this only ever applies to a long note.
- **Whether the model asks about the right bit.** "Couldn't catch what came after the address" is
  the behaviour; a model that re-asks for the whole note, or that answers around something it
  needed, are both failures only a real run shows.
- **Whether "what did i say in that voice note" reaches for the record.** Same seam as the photo
  record: the words are there to be read by id and the prompt says to read them.

## Commit: everything Reason holds now has a date it goes

### Proved offline

- Both windows, separately: content dropped at one, the record of it at the other, and `0` meaning
  keep forever on either.
- The sweep is idempotent — a second run finds nothing — and every statement is bounded by a
  timestamp, so a database with nothing old in it does no work.
- A note whose words were dropped says so with the date, and says never to reconstruct it.
- The dedupe keys survive the content window, so a redelivery cannot become a second answer.
- A failed message nobody has been told about is never swept, however old.
- A conversation nobody has touched stops carrying its history; a live one is untouched.
- A call's transcript and its audio off disk both go, and the call reports the deletion as a
  setting working rather than as the provider losing a recording.
- Nine tables that were in neither an export nor a delete are in both, children before parents, and
  one conversation's delete leaves another's media alone.
- `--log` cuts every long string to a length and a count, including a field invented tomorrow.
- A fetched page comes back marked `untrusted_content`; a page that could not be read does not.

### Never proved, and what would settle it

- **No sweep has ever deleted anything on the live server.** Every test moves a timestamp
  backwards; nothing has run for thirty real days. The first real drop is the one to watch, and the
  thing to check is that it is a content drop and not a row.
- **Whether the two windows are the right lengths.** 30 and 365 are a judgement, not a finding.
  The argument for changing either is somebody asking what they said in a note that is now gone.
- **Whether Reason explains retention correctly when asked.** The numbers are in `capabilities` and
  it reads them; what it says about them is the model's. Ask it "how long do you keep my voice
  notes" on a real thread.
- **Whether `untrusted_content` changes behaviour.** The structural guard is the gate, which is
  tested and cannot be fed. The marking exists so the model reports an instruction in a page
  instead of trying it. Whether it does is a live run with a hostile page — and nobody has written
  one yet.
- **The retention sweep runs inside the same pass as everything else proactive.** On a database
  with a lot of old content, the first sweep after an upgrade does all of that work at once. It has
  only been run against test databases of a few dozen rows.

## Commit: several Google accounts for one person (added 2026-10-05)

`src/google.js` (`resolveAccount`, `accountsFor`, `allAccessTokens`, `connectedAddresses`,
`addressOf`, and the per-account `authorizeUrl` / `disconnect` / `accessTokenFor`), the `account`
parameter on every `gmail_*` and `calendar_*` tool plus the new `google_accounts` tool in
`src/tools.js`, the per-account key and the `oauth_tokens` migration in `src/db.js`, the account list
in `src/trust.js`, and the full-delete fan-out in `src/data.js`.

Proven offline by 30 new tests in `test/google-accounts.test.js`, with the 77 in
`test/google.test.js` still passing, all against the fake Google in `test/fixture-google.js` — now
multi-account, so it keeps a separate mailbox, label set and calendar per address and answers 404 for
an id belonging to another one.

Everything below was written from Google's docs read on 2026-10-05: OAuth 2.0 for web server
applications (the authorization parameter table and `#tokenrevoke`), the unverified-app and
production-readiness pages, and the Calendar API reference for `calendars.get`. Nothing from memory.

### What has actually run

- **Nothing against Google. Still not one request.** Every test answers the fake. Omari has one real
  Google account connected to the live Reason; a second real account has never been connected by
  anybody, so the central claim of this commit — that two work at once — has never been seen.

### What has not, test by test

- **`prompt=select_account consent` shows the chooser AND still returns a refresh token.** This is
  the whole mechanism for adding a second account and it is the least proven thing here. Google's
  parameter table lists `none`, `consent` and `select_account` as the values of a "space-delimited,
  case-sensitive list" and documents only `none` as mutually exclusive with the others, so the pair
  is legal by their own wording. That `select_account` actually interrupts a signed-in browser with
  the account picker, and that pairing it with `consent` does not cost the refresh token
  `access_type=offline` + `consent` is there to guarantee, is inference from that table. **If it is
  wrong, the failure is somebody tapping the "add your work email" link and silently re-granting the
  account they already had** — which the code then correctly reports as a refresh rather than an
  addition, so it would look like nothing happened. The fake accepts any `prompt` value and records
  it; the test asserts what was sent, not what Google would do with it.
- **`login_hint` offers the named account.** Sent only when reconnecting a named address. Their table
  says the server "uses the hint to simplify the login flow either by prefilling the email field…
  or by selecting the appropriate multi-login session". Whether a dead-grant reconnect really lands
  on that account rather than on whoever the browser is signed in as is unproven.
- **Revoking one account's token leaves the other account's grant alive.** `#tokenrevoke` is
  documented per token — "The token can be an access token or a refresh token" — and each account has
  its own refresh token, which is why one revoke is scoped to one grant. **"Therefore the other
  account survives" is read off that wording and is not a sentence Google writes.** If it turns out
  the revoke is scoped to the app-and-user pair more broadly, "disconnect my work email" would take
  the personal one with it. The test proves the code sends one revoke per account and deletes one
  row; it cannot prove what Google does on the far side.
- **The calendar-only address fallback.** A grant with calendar scope but no Gmail scope has no
  profile endpoint to ask, so `addressOf` falls back to the primary calendar's own `id` and uses it
  only if it contains an `@`. Google documents that field as "Identifier of the calendar" without
  promising it is an email address. Never checked against a real calendar-only grant.
- **That `users.getProfile` returns the address of the account that granted, not of some other
  signed-in session.** Everything here keys on that address being the right one. It is the documented
  behaviour and has not been watched on a second account.
- **A real Gmail 404 for an id from another account.** The "that message is in your other mailbox"
  answer depends on Gmail returning a 404 — not a 400 or a 403 — for a well-formed id that belongs to
  a different account. The fake is written to return 404. If real Gmail answers differently, the
  refusal degrades to the ordinary error it used to be: still safe, still nothing changed, just less
  helpful.
- **The migration has never run on the live database.** It is proven against copies built in the old
  shape (old `UNIQUE(conversation_id, provider)`, a row carrying a refresh token), including being run
  twice and then having a second account added. Omari's real `data/reason.db` has not been migrated by
  anybody at the time of writing.

### The 100-user cap: what it counts

Asked because it decides whether this feature is cheap or expensive for Omari.

**It counts Google accounts, not people.** The production-readiness overview describes an unverified
published app as one where "Any Google user can access… a hard cap of 100 total users applies", and
the verification FAQ calls it "a 100 new-user cap restriction" that "applies over the entire lifetime
of the project, and it cannot be reset or changed". The unit in every one of those sentences is a
Google user, which is a Google Account; Google has no way of knowing two Gmail addresses belong to
one human, and nowhere on those pages is a person distinguished from an account.

**So one person connecting three accounts spends three of the hundred.** That exact sentence is not
one Google writes, so it is an inference from the unit they use rather than a quoted fact — but it is
the only reading the wording supports, and the cautious assumption is also the correct one to plan
against. Two consequences worth Omari's attention:

- A hundred *accounts* is far fewer than a hundred *testers* once people connect a personal and a
  work address each — roughly fifty people, not a hundred.
- The cap is lifetime and cannot be reset, so a disconnect does not give the slot back.

The real number used is readable only in the Cloud console under the OAuth user cap. Nothing in the
code can see it, so **Reason cannot warn anybody when it is running out** — that is Omari's to watch.

### What is a choice rather than a fact

- **Reads fan out, acts ask.** A search with no account named hits every account; a send with no
  account named and several connected refuses and asks. That asymmetry is a judgement about which
  mistake is worse to make silently, not something Google or the docs decide.
- **The limit on a search is per account, not shared out.** "The last ten" with two accounts connected
  returns up to ten from each, because splitting ten across two mailboxes would quietly hide the older
  half of one. It does mean a two-account search costs twice the requests.
- **Acting pre-checks every id.** `gmail_archive` / `mark` / `label` / `trash` read each id once before
  touching anything, so a list half from the wrong mailbox is refused whole rather than half applied.
  That is one extra request per id, chosen because "it partly worked" is the wrong thing to discover
  afterwards about mail somebody asked to be binned.
- **The default account is per person and set only by asking.** `google_accounts` with `set_default`
  is the only way one gets set; nothing infers it from use. With several connected and none set, every
  act asks. Somebody who dislikes being asked has to say so once.
- **A single account behaves exactly as before.** One connected account is treated as "nothing to
  choose": no account is asked for, and the results carry no account grouping. That is deliberate, so
  this change is invisible to anybody who never connects a second one.
- **An account Google will not name is refused as a second account but accepted as a first.** With
  nothing connected, a grant whose address could not be read is still stored — a working connection is
  worth more than a label. With one already connected it is refused, because two accounts that cannot
  be told apart cannot be sent from. Nothing is saved and nothing existing is touched.
- **The address is matched case-insensitively.** `KOFI@gmail.com` and `kofi@gmail.com` are one
  account. Gmail's own local parts are case-insensitive; this is applied to every provider's labels
  rather than only Google's.

---

## Commit: replies arrive as a phone can draw them

The layout layer (`src/plain.js`), the delivery wiring (`src/deliver.js`), the prompt's layout
rules and three phone-width fixes to the page renderer. What is proved offline is wide — 33 tests
across `test/plain.test.js` (14, the rules on strings), `test/deliver-plain.test.js` (13, the same
rules through the real delivery path) and `test/pages-phone.test.js` (6, in real Chromium at
390×844). What cannot be proved anywhere but on a real iPhone is
below, and it is the premise the whole commit rests on.

### Only a real iPhone can settle these

- **Messages renders no markdown.** This is the reason the markers come off at all. It is not a
  claim Sendblue makes either way: the documented payload for `POST /api/send-message` is `number`,
  `from_number`, `content`, `media_url`, `app_card`, `send_style`, `status_callback`, `seat_id`,
  `reply_to` and `pre_reply_override` (getting-started/sending-messages, read 2026-10-05), `content`
  is plain text, and markdown is not mentioned anywhere in their documentation. Absence from a
  payload table is strong evidence and is why `rendersMarkdown` answers false, but it is not the
  same as having watched `**bold**` arrive as four asterisks in a real thread. If Messages turned
  out to render *anything*, the right change is one line on the adapter, not a change to this layer.

  **SETTLED 2026-10-05 (evening), on Omari's real thread.** Screenshots of two replies that had been
  through this layer: a numbered jollof recipe and a page link with a paragraph about it. Both
  arrived as clean plain text — no stray asterisks, no hashes, no backticks — and the page link
  arrived in a bubble of its own with the words as a separate message below it. So the premise holds
  and the bubble split works on the device. What those screenshots do **not** settle is the inverse:
  nothing in them contained markdown that Messages might have *rendered*, because the layer had
  already taken it off. The claim "Messages renders none of it" is still an inference; what is now
  proved is the thing that actually matters, that what Reason sends arrives looking right.
- **Press-and-hold copies exactly one bubble.** The second guarantee — a pasteable block alone in
  its own message — is worth having only if the iOS copy gesture takes a single message and not a
  selection or a run of them. That is the behaviour the design assumes, from using iMessage, and it
  has not been checked on the device against a three-bubble reply. If the gesture turns out to grab
  more, splitting the block out still helps but stops being the whole answer, and a page with a
  copy button becomes the better home for anything pasteable.
- **Whether a bare link draws a preview card.** A link goes out in its own bubble partly so the
  phone *may* draw a card for it. Reason is told never to promise a card, a picture or a title, and
  that instruction stands whatever the answer turns out to be.

  **Half answered, 2026-10-05.** Omari's screenshot shows Messages drawing a placeholder that says
  "Click to Load Preview" under `reason.tail3753c7.ts.net` — so his client is willing to make a card
  and was waiting to be asked. At that point the page served **no Open Graph tags at all**, so a
  click would have produced a bare card with a domain and nothing else. Omari asked for previews, so
  the tags are now served (`previewTags` in `src/pages/render.js`): title, description and site name,
  on the allowed render only.

  **Three things still unproved, all of them needing his phone.** Whether tapping that placeholder
  now produces a card with the title on it. Whether the fetch reaches the page at all — the host is
  a Tailscale tailnet name, so only a device on the tailnet can resolve it, which is fine for him
  and means *nobody else's* phone will ever draw one of these cards. And whether Messages fetches
  with the `?k=` key intact; if it drops the query string it gets the gate, which deliberately
  carries no tags, and the card stays bare. None of these is a reason to promise a preview in words,
  which is why that prompt rule did not change.
- **That four bubbles is the right cap.** Four is reasoned, not measured: a link needs a bubble, so
  does anything pasteable, so three pieces plus a line about them is the most an answer legitimately
  comes to. Whether a four-bubble reply reads as one answer or as a burst of notifications on a real
  lock screen is a judgement about a thing nobody has watched arrive. `REASON_MAX_BUBBLES` exists so
  the answer can be changed without touching code.
- **The page at phone width, on a phone.** `test/pages-phone.test.js` measures Chromium at 390×844
  with `isMobile` and a 3× scale factor, which is not Safari on a real device: it does not prove
  the dynamic type setting, the home-bar inset, momentum scrolling inside the table box, or how the
  copy block's own scroller feels under a thumb. The numbers it asserts (a ~16px paragraph gap, a
  three-column table inside 351px, a copy block under 62% of the screen) are real measurements of
  the right CSS, on the wrong browser.

### A real limit, and the cue that now admits to it

A **four-column table of prose does not fit a 390px screen** — 351px of usable table against about
373px of minimum content. Letting the header wrap bought the three-column case and that is the one
the renderer should produce; the fourth column is a sideways scroll inside the table's own box. Two
facts about that are pinned by test: the page itself never scrolls sideways, and the hidden column
is still reachable.

What was missing was any *visual cue* that the box scrolls — on iOS there is no scrollbar, so a
reader could be unaware a column existed. **Omari chose the edge fade and it is built** (2026-10-05).
It is four background layers on `.scroll` and no script: two in the card colour attached `local`,
which scroll with the table, over two fixed shadow layers at the same two edges. At rest each cover
sits on its own end of the content and hides the shadow beneath it, so the fade appears on a side
only while there is more table that way. A table that fits has no fade at any scroll position,
which matters more than the fade itself: an edge that appears on a table with nothing hidden invites
a swipe that does nothing, and would be noise rather than information.

Two things were given up for it, both deliberate and both visible in the screenshots:

- **The header's tint goes transparent below 30rem.** The fade is painted on the scroller's own
  background, so anything opaque in the content covers it; `th` had `background: var(--soft)`, which
  would have stopped the fade dead at the header band. The header still reads as a header on the
  uppercase, letterspaced, dim lettering and the rule under it. Above 30rem nothing changes.
- **The cue is scoped to phone width,** because that is where there is no scrollbar and where the
  overflow was measured. A narrow desktop window that overflows still has no fade.

### What a real iPhone still has to settle about the fade

**`background-attachment: local` on iOS Safari, inside a `-webkit-overflow-scrolling: touch` box.**
This is the one genuinely risky thing in the commit. The technique is long-established and correct
per spec, and it is proved pixel-by-pixel in Chromium — but iOS has a history of quirks precisely at
the intersection of momentum scrolling and backgrounds that scroll with content, and `.scroll` sets
both. The plausible failure is not ugliness but a *lie*: a fade that sticks in place during a flick,
or one painted on a table that fits. If that happens the fallback is small and known — drop
`-webkit-overflow-scrolling: touch` (modern iOS scrolls smoothly without it) or move the cue to a
sticky overlay element. **Worth one deliberate look on the device: swipe the four-column table both
ways, and check the three-column table above it never fades.**

Also unsettled, and milder: whether the fade is *strong enough to notice* on a real screen at real
brightness, especially in dark mode where it is a light edge at 17% rather than a dark one at 19%.
Chromium says it is clearly measurable (a card at 254.8 against a faded edge at 199.6 in light
mode); whether a person's eye catches it mid-read is a different question.

### What *is* proven offline for this commit

- `plainText` leaves text that only looks like markdown exactly as it was: `report_final_v2.txt`,
  `2 * 3 = 6`, `3*4*5 cm`, `a*b`, `snake_case_name`, `$5*2`, `C#`, `#1`, `#teamwork`, emoji.
- A URL is never altered: underscores, asterisks and query strings in an address survive, and the
  link split still finds it afterwards.
- A fenced block comes out whole and alone, its info string treated as fence rather than content;
  an empty fence or an unclosed one does not split a sentence into two bubbles.
- A markdown table becomes readable lines with no pipes left, and the prose around it keeps its
  spacing.
- The cap merges neighbouring prose, never drops a part, never merges a link or a pasteable block,
  and logs the case it cannot fix. Nothing is lost at any cap value, including nonsensical ones.
- Through the real `deliver` over a channel that records what it was handed: markers off, bubbles
  in order, one outbox row per bubble, the call-summary path stripped without being split, the
  fallback line when audio fails stripped too, and a message that was nothing but markers still
  sending something rather than an empty text.
- The stripping is asked of the adapter: a fake channel claiming `rendersMarkdown: true` keeps its
  markers, which is the only way that claim can be made.
- In real Chromium at 390×844: the paragraph gap, the three-column table fitting *because* of the
  header wrap (the test forces `nowrap` back on and checks it then overflows), a short prompt not in
  a scroller at all, a long one capped with the buttons and the next section still reachable, and no
  horizontal page scroll from a 120-character unbroken string or a 90-character table cell.
- A blank line between numbered steps, and nowhere else: not before the first step's lead-in twice,
  not inside a fenced block, not between bullets, and not on "1999." or "2026." starting a sentence.
- The words around a link keep their paragraphs. This was a real bug, found by reading the samples
  rather than by a test: the rejoin collapsed newlines along with spaces, so every message sent with
  a page link arrived as one slab. Pinned now from both sides — a link on its own line keeps the
  blocks apart, a link mid-sentence is still closed up with a space, and a list under a link keeps
  its dashes.
- A page serves preview tags only where it is already allowed to be read: the gate and the not-found
  page carry none, titles and descriptions are escaped inside the attribute, a long description is
  cut on a word, and there is no og:url.
- The edge fade, read off real screenshots rather than a style rule, because computed style says the
  same thing whether the cue is showing or not: the overflowing table is clean on the left and dark
  on the right at rest, and the other way round scrolled to the end; the table that fits is clean on
  both sides, and stays clean when something tries to scroll it.

---

## Commit: the narrow calendar scopes, terms, and the verification hooks (added 2026-10-06)

`src/google.js` (`CALENDAR_SCOPES`, `LEGACY_CALENDAR_SCOPE`, `covers()`, `privacyUrl()`, the
`say_with_link` and `privacy_url` fields on `authorizeUrl`), `src/pages/site.js` (`termsPage`, the
Search Console tag, the three-permission wording), `src/http.js` (`/terms`), `src/config.js`
(`googleSiteVerification`), and the `google_connect` description in `src/tools.js`.

Proven offline: 4 new tests in `test/google.test.js` and 3 in `test/site.test.js`, plus the 77 and
10 that were already there, all green against the fake Google — which now checks calendar methods
against per-method scope lists copied from Google's reference (calendars.get accepts
`calendar.calendars.readonly`; events.* accept `calendar.events`; both also accept the broad
`calendar`).

### What has actually run

Nothing against the real Google. Specifically unproven:

- **That `calendar.events` + `calendar.calendars.readonly` is enough for everything the calendar
  tools do.** Read from the per-method "Authorization" tables on developers.google.com for
  calendars.get and events.list/get/insert/patch/delete on 2026-10-06. If Google's real answer to one
  of those calls under the narrow pair is a 403, the tool reports it as `scope_missing` and offers a
  fresh link — the failure is visible, not silent — but the scopes would then need widening, and
  Google's Data Access page re-declaring.
- **That an existing grant made under the broad `calendar` scope keeps working.** `covers()` treats it
  as a superset, which is what Google's scope table says it is, and the tests prove the code path with
  a fake grant carrying that scope. A real token with that scope has not been exercised since the
  change.
- **The consent screen now lists three permissions, and a person can untick any one.** Unticking
  `calendar.calendars.readonly` alone leaves calendar not connected (events without the time zone
  would write times in the wrong zone, so the pair is treated as one). That is a product decision
  recorded here rather than tested against a real consent screen.
- **The Search Console meta tag has not been checked by Google.** It is the documented tag with the
  documented attribute names; whether a URL-prefix property on the live address verifies is a thing
  only the real checker can say.

### Not provable from code at all

Everything in `docs/google-verification.md` that happens in Google's console — brand verification,
scope review, the security assessment — is the project owner's to do and Google's to judge. The
"unverified app" screen stays until Google says otherwise, whatever this code does.

## Commit: the page kit — steps, rows, callouts, subtitle, closing line, calmer chrome (2026-10-06)

### What has actually run

The offline suite, with twelve new tests in `test/pagekit.test.js`: each new block checked and
refused with a fixable message, each drawn as described, every string in them escaped, the two
page fields bounded at 160 characters and clearable, an old page row without them rendering, and
the chrome assertions (no `h2::before`, no `backdrop-filter`, headings at weight 400, hairline
sources). The existing `test/pages-phone.test.js` still passes under the new stylesheet, including
the pixel-read edge fade on an overflowing table.

A page with every new block on it was rendered through `renderPage` and screenshotted at iPhone
14 size in headless Chromium (`~/.openclaw/workspace/tmp/instinct/reason-after-*.png`) and looked
at: no sideways overflow, steps on their own rows, values right-aligned, the three callout tones
distinct, the closing line after the date.

### Not seen on a real phone

- How New York at weight 400 renders on an actual iPhone, and whether 28px / 21px headings feel
  right in the hand. Chromium's serif is not Safari's.
- Whether the right-hand value in a `rows` item ever collides with a long name on a narrow phone;
  it is capped at 40% of the row and wraps the name, which Chromium honours.
- The dark-mode colours for the warning title and the soft callout box.
- Whether the live model, given the new tool description, actually reaches for `steps` and `rows`
  instead of a text block with numbers typed into it. The instruction is in the prompt and the
  tool description, and there is a test that it is there; obeying it needs a live run.

## Commit: their Drive — find a file, read it, make a document (2026-10-06)

### What has actually run

The offline suite, with 38 new tests in `test/drive.test.js` and Drive routes added to the shared fake
(`test/fixture-google.js`): every route from Google's v3 reference, with the scope lists their reference
gives per method, the two download routes kept separate the way Google separates them (a Doc refuses
`alt=media`; a blob refuses `/export`), and `fields` honoured so a client that forgot it reads
undefined rather than being quietly indulged.

Proved offline, against that fake:

- A mail-and-calendar grant reads as **Drive not connected**, through `covers()` and nothing else; the
  capability line says it is a separate permission; asking anyway is a named `scope_missing` with the
  scope in words and the list to pass to `google_connect`, and **nothing is asked of Drive**.
- The link that fixes it asks for **both** Drive scopes, carries `include_granted_scopes=true`,
  `access_type=offline` and `prompt=consent`, and — with one account connected — `login_hint` for that
  address and no account chooser. With two accounts it does show the chooser and says which to pick.
  A link for a grant that already covers everything asked for is a *second account* and gets the chooser.
- The `q` Google receives, exactly: `trashed = false and ((name contains 'lease' and name contains
  'ocean') or fullText contains 'lease ocean')`. An apostrophe is escaped, and the escaped query still
  matches, so the escaping is right rather than merely present. `fields`, `orderBy=modifiedTime desc`
  and `pageSize` are all asserted from the server's side.
- Each export: a Doc and Slides as `text/plain`, a Sheet as `text/csv` **with the second tab absent**
  and the first-sheet note present, a text file and an html file through `alt=media` with the markup and
  the stylesheet gone.
- A folder comes back `cannot_read`, naming the kind, with the link, and with "do not guess at what is
  in it" in the result.
- **A PDF is read, and the reader is not faked.** `test/fixture-pdf.js` builds real PDFs — a correct
  xref table, real content streams, and for the locked one the actual RC4 standard security handler from
  ISO 32000-1 §7.6.3 — and the tests put them through the real `osascript`/PDFKit reader. So these are
  measurements on this machine rather than assertions about a stub: a text PDF's words come back and the
  download is `alt=media`; a 6-page one with the budget at 3 returns pages 1–3, says "the FIRST 3 of its
  6 pages", and does **not** contain the word on page 4; a real scan (a drawn rectangle, no text layer)
  comes back `why: "no_text"` with a real page count; a really encrypted PDF comes back `why: "locked"`
  and nothing inside it is quoted; the size cap refuses before anything is read; a file labelled
  `application/pdf` whose bytes are HTML comes back `why: "not_a_pdf"`; and with `REASON_PDF_READER=none`
  the refusal says it is the machine and not the file. An instruction written **inside** a PDF reaches
  the same injection scan as one in an email, is flagged with its shapes, and cannot become a yes.
  **What this still cannot settle:** nobody has read a real PDF out of real Drive or real Gmail. Google
  has never been called. A PDF produced by Word, Pages, Google Docs or a phone scanner app — CID fonts,
  subset encodings, ligatures, a column layout whose reading order is not its drawing order — has never
  been through this path from Drive. A one-page probe printed through `cupsfilter` on this machine on
  2026-10-06 did read back correctly, which is evidence about PDFKit and not about anybody's resume.
- **The reader has been run on real PDFs nobody here wrote.** 2026-10-06, from a one-off script outside
  the suite, against three documents macOS already ships — authored by Apple's own tools, not by
  `test/fixture-pdf.js`, and not downloaded from anywhere:

  | file | bytes | took | result |
  | --- | --- | --- | --- |
  | `Automator/Apply Quartz Filter…/Sample.pdf` | 68,521 | 73 ms | 1/1 pages, 48 chars — a chart's axis labels and "Lorem ipsum…" |
  | `PDFKit.framework/…/Sample.pdf` | 13,177 | 71 ms | 8/8 pages, 38 chars — "PDFKit Sample PDF 2 3 4 5 6 7 8" |
  | `FinanceKit.framework/…/tileFallback.pdf` | 3,527 | 71 ms | `no_text`, 1 page — vector art with no text layer, refused as a scan |

  So the `osascript` path really runs on this machine, on documents with real font dictionaries, at
  about 70 ms a document; a multi-page real PDF really walks page by page; and a real text-free PDF
  really takes the scan branch rather than coming back as empty success. The temp directory was empty
  afterwards. **This is still evidence about PDFKit and not about anybody's resume**, and it says nothing
  at all about Drive or Gmail — no Google route has been called by anything in this feature.
- The cut message, the not-found message with Google's own words, multi-account fan-out with every file
  labelled, a file id used against the wrong account refused with the right one named, `drive_create`
  with two accounts and no choice refusing and uploading nothing, and an address that is not theirs
  never reaching a Drive.
- `drive_create` sends a correct `multipart/related` body: two parts, the metadata as
  `application/json` carrying the Docs MIME type, the content as `text/plain`, trailing newline intact.
  A boundary that appears inside the text does not split the document. It needs no yes, leaves one
  ledger row, and the row holds the text's length rather than the text.
- A document whose contents are instructions to the assistant comes back marked untrusted, is reported
  in full, and produces no send and no draft.
- `invalid_grant` is one reconnect and **one** token call — no loop — and a mail grant dying does not
  report Drive as having stopped working.
- Drive adds **no table**: the export carries no file contents and no document text, the receipt is
  there, and a delete clears it.
- A flow test takes "find my lease" through the real `runTool` dispatch twice over — search, then read
  with the `file_id` and `account` the search named — and writes an answer whose figure comes out of the
  text that came back.

### Never sent to the real Google

Not one request. Every route above has only ever been answered by the fixture. Specifically unproven:

- **That `include_granted_scopes=true` behaves as Google documents it.** The parameter is on the link
  and the fake returns the union of scopes, which is what the parameter table says happens — but a fake
  returning what the docs promise is not evidence that Google does. This is the one thing in this commit
  whose failure would be quiet and costly: if a real Drive-only grant came back carrying only the Drive
  scopes, the stored scope string would be overwritten and that person's mail would stop working until
  they reconnected. **Worth watching on the first real Drive connect**, which is Omari's to do: connect
  Drive on an account that already has Gmail, then ask Reason to search that mailbox.
- **That `drive.readonly` and `drive.file` on one consent screen read as expected to a person**, and
  that Google accepts them on the Data Access page without re-opening review. Reason already requests a
  restricted scope (`gmail.modify`), so the review class is unchanged — that is read off Google's own
  sensitivity table rather than stated by Google about this app.
- **How a real document reads once exported.** A 40-page lease as `text/plain`, a spreadsheet with
  merged cells as csv, a deck whose text is inside images: all three are shapes a fixture cannot
  produce. The 20,000-character cut (8,000 until 2026-10-06, when a two-page resume did not fit) and the first-sheet note are the honest hedges, not solutions.
- **Whether `fullText contains` finds what a person means.** Google's index does stemming and phrase
  handling the fake does not; "find my lease" against a real Drive may rank differently or miss a file
  whose wording differs. The result already says what it searched for and offers to try another word.
- **Google's 10 MB export cap** and the `pageSize` maximum of 1000: both are in their docs, neither has
  been met.
- **That a real Doc created from `text/plain` arrives looking like a document** rather than one long
  paragraph. The conversion is documented; what it does to line breaks and lists is not something the
  fake can show.

### Simpler than Google, knowingly

- The fake's `q` matcher understands only the three terms Reason sends (`trashed = false`,
  `name contains`, `fullText contains`) and not Drive's grammar, and `fullText` searches the text the
  fixture holds rather than an index.
- The fake's `drive.file` visibility rule is per-file in the right direction (a token with only
  `drive.file` sees files this app created) but does not model Google's file picker, which Reason does
  not use.
- Shared drives are not modelled and not asked for: `corpora`, `driveId` and `supportsAllDrives` are
  never sent, so what Reason sees is the person's own My Drive and what has been shared with them, which
  is what `files.list` answers by default.

### Added the same day: what `google_accounts` says about Drive

`can` on each account is read off the scopes that grant really carries, so an account with mail and no
Drive reports `["mail","calendar"]` and the note names it. Proved offline with two accounts, one of
each, including that the status and the behaviour agree: a Drive search on the account without it is
refused by name and one on the account with it works. What is unproven is the same thing as everywhere
else here — whether the live model, handed that result, says "your work one, not your personal one"
rather than "your Google is connected".

## Commit: standing permissions — things they said not to ask about (2026-10-06)

Everything below is covered offline: `test/trustline.test.js` (17), five flow tests on the fixture
shop in `test/sites.test.js`, and one through the real tool loop with a scripted model in
`test/trustline-loop.test.js`. **No live model call has been made against any of it** — there is no
API credit on this machine. What a fake cannot settle:

- **Whether the model saves their sentence verbatim.** The whole design rests on `text` being what
  they actually said. Code cannot check it: there is no copy of their message for the tool to compare
  against, and a model that paraphrases "you can reorder groceries without asking" into "allowed to
  buy groceries" produces a permission that still works and a receipt that misquotes them. The prompt
  says word for word, never tidied, and the tool description says it twice. Unverified against a live
  model.
- **Whether the model's reading of a sentence is narrow enough.** `scope` is the model's judgment.
  "You can reply to scheduling emails yourself" could be read as `{action: email, target: scheduling}`
  or as `{action: email}` with no target at all, and the second one is a permission to send any email
  to anybody. Code refuses to let a saved scope grow; it cannot refuse a scope that was too wide when
  it was written. The two guards that do exist in code — money needs an amount, and the two
  never-standing actions — cover the worst cases and not this one.
- **Whether a refusal that quotes the near miss actually changes what the model says.** The refusal
  hands back the sentence and the reason ("it covers 'groceries', and this is 'a desk chair'") and
  tells it not to stretch. Whether the reply to the person then says that, rather than asking blankly,
  is a live-model question.
- **Whether a person understands what they granted.** The tool result tells the model to say the
  permission back once, naming what it does *not* cover. Nobody has read one of those messages.
- **Target matching against real wording.** `groceries` matching "the usual groceries from Amazon
  Fresh" is substring matching on the details the tool was given, and those details are written by
  the model. A model that writes `what` as "weekly shop" rather than naming the groceries gets an
  honest refusal for a reason that has nothing to do with safety. Proved against strings a test
  chose; not against what a model writes unprompted.

## Commit: the limits they set, and never retrying an unknown payment (2026-10-06)

Covered offline: eight flow tests on the real fixture shop in `test/sites.test.js` (including a shop
taken away mid-press, which is how the browser-error-page case was found), four unit tests in
`test/trustline.test.js`, and the first-ever-purchase sequence through the real tool loop in
`test/trustline-loop.test.js`. **No live model call.** What a fake cannot settle:

- **Whether the caps question gets asked as one line.** The result hands over the exact sentence and
  says not to ask twice and not to suggest numbers. Whether the live model asks both halves together,
  rather than "how much per thing?" and then "and per month?", is a live-model question — and two
  questions here is the difference between a 10-second setup and an interrogation.
- **Whether a person's answer is read into the right two numbers.** "$200 a thing, keep it under 1500
  a month" has to become `per_purchase: 200, monthly: 1500`. Reversing them is caught (the guard
  refuses per-purchase above monthly); "$200 a month" misread as per-purchase is not, because both
  orderings are valid numbers.
- **Whether the over-cap refusal reads as "your own limit" rather than as Reason refusing.** The
  wording is in the result; the reply is not.
- **The unknown-outcome message, which is the one that matters most.** A person has to come away
  knowing that they must go and check, and that Reason is not going to try again on its own. The
  result says all of it; nobody has read the text a model writes from it.
- **Whether `chrome-error://` is the only shape a dropped commit takes.** It is what Chromium does on
  a refused connection, proved against a server that was shut down between the fill and the press. A
  shop that returns a 500 with a styled error page, or one that times out server-side, lands on a
  page with words on it and is NOT caught by this — it reads as a committed submit whose `page_text`
  is an error, and the only thing standing there is the model reading that page honestly. That is a
  real gap and it is listed rather than claimed.
- **The over-count.** An unknown outcome counts the money against the day and the month with
  `(OUTCOME UNKNOWN)` on the line. If the charge never happened, their limit is tight by that much
  until the month turns, and nothing automatically corrects it. The alternative — not counting a
  charge that may be real — was judged worse. There is no tool to undo a spend line.
## Commit: the outcome sheet — a task carries the whole outcome (2026-10-06)

### What has actually run

The offline suite, with 14 new tests in `test/sheet.test.js`. Proved with no model anywhere in the
path, which is the point: these are the facts that have to hold on the model's worst day.

- A sheet written at `task_start` survives a fresh read off the row, with each constraint's source
  and their quoted words intact.
- A task from before the column — `sheet` empty or at its default — reads as an empty sheet and goes
  on updating exactly as it did.
- A rejected option is **out of `options` by id** in the view the model gets, is in
  `rejected_options` with their words ("too expensive") and the reading (`price`), and cannot be put
  back to `open`: that is refused `needs_them` and nothing is written.
- A rejection with no words, or with a reading that is not one of the five, is refused.
- `source: "found"` and `source: "assumed"` are both refused against a `them` value, with the
  constraint name, their value, and a refusal that names `waiting_on_you` and the tradeoff.
- A `them` value moves only when the new thing they said is quoted; the unquoted version is refused.
- An assumption lands in `assumptions` with the "say it once, do not ask" note, and nothing they
  stated appears there.
- The open-work note really carries the budget and "including fees" into a later ordinary turn, and
  is empty once nothing is open.
- A bad patch sent alongside a progress line writes neither.

### What only a live run proves

The merge rules are code's and are settled. What a fake model cannot settle:

- **That the model actually writes the sheet, and writes `source` honestly.** Nothing forces a model
  to put "under $2k" on the sheet as `them` rather than as `found`. The guard is narrow on purpose:
  it stops Reason *overwriting* what they said, not a model mislabelling it in the first place. The
  live flow test (`test/flow-finish.test.js`) is what checks a real model does it, and it is the one
  thing here worth re-reading after a prompt change.
- **That a sheet in every turn's context does not crowd out the conversation.** A person with four
  open jobs carries four sheets into every message. The cap is four tasks; whether that reads well at
  the length a real sheet reaches is a thing to watch on a real thread.

## Commit: states, loose ends, and "where were we?" (2026-10-06)

### What has actually run

The offline suite, with 12 new tests in `test/loose-ends.test.js`.

- Each of the three new states is refused without the thing that makes it actionable, and the state
  does not move on a refusal: `waiting_on_you` without `needs`, `needs` without a tradeoff,
  `waiting_on_other` without a next check, `blocked` without what would unblock it.
- `done`, `cancelled` and two plausible-looking near-misses are all refused as open states.
- An old `waiting` row still updates and still wakes.
- A `waiting_on_you` task makes **no model call at all** on its wake, nothing is sent inside the gap,
  exactly one reminder goes out past it carrying the question and the tradeoff, and five more passes
  over ten days send nothing. A new `needs` later gets its own single reminder.
- The reminder honours the daily proactive cap like every other interruption.
- `claimNeedsReminder` is idempotent: the second call in the same sweep gets nothing.
- `task_list` carries done / left / the one ask, says so when nothing is on them, and names
  `activity_page` once there are more than two open jobs.

### What only a live run proves

- **That a real model picks the right state.** Nothing makes a model call `waiting_on_other` rather
  than leaving a task `running` while it quietly waits. The guards make each state honest once
  chosen; choosing it is the prompt's job, and `test/flow-finish.test.js` is the only check on it.
- **That the reminder reads like a friend and not a dunning letter.** It is one line written by code
  — `still need one thing on "…" whenever u get a sec — <question> (<tradeoff>)`. Nobody has received
  one on a phone.
- **That 24 hours is the right gap.** A guess, and the one number here most likely to want changing
  after a week of real use.

## Commit: representing them well, and the people Reason does not send to (2026-10-06)

Covered offline: 13 tests in `test/trustline.test.js` and 6 in `test/google.test.js`. **No live model
call.** What a fake cannot settle:

- **Whether the writing is actually good.** Code checks two characters-in-a-string facts — no emoji,
  and a sign-off with both halves in it. Everything that makes a message read well to a stranger is
  the prompt: full sentences, no slang, the right amount of detail. A message can pass both checks and
  still be a bad email, and nothing here can tell.
- **Whether it shares only what the message needs.** "A time and a name, not where they work, not
  what else is on their calendar" is judgment, and it is the part of this with the highest cost if the
  model gets it wrong. There is no code check for it and there is no obvious one to write.
- **Whether the sign-off reads naturally in a text.** "Omari's assistant, Reason" in an email is
  normal; in a 12-word text to a friend who is in the middle of planning something it may read as
  stiff, and the rule applies to both. Worth watching on the live Reason — it is the most likely thing
  here to need softening, and softening it means deciding what code still checks.
- **Whether `exactly_as_asked` is ever used dishonestly.** It is the one override and nothing can
  verify it: the model passes a sentence claiming the person said to send it as it is. The receipt
  records it, which makes it auditable after the fact and not preventable.
- **Whether a person is offered the draft-only list at the right moment.** The prompt says to offer it
  the first time they mention family, a boss, an investor, a landlord or a doctor. Nobody has seen
  that offer made.
- **Whether a number gets saved with the entry.** An entry with no contact cannot stop anything, and
  the tool says so and tells the model to ask. Whether it asks, and whether the person answers, is the
  difference between a guard and a note.
- **Recipient shapes beyond the two that are handled.** A plain address and `Mum <mum@example.com>`
  are both unwrapped and matched, and that is tested. A group alias that expands elsewhere, a mailing
  list the person is on, or a name with no address Reason has ever seen are all ways to reach somebody
  on the list without the list being able to tell — which is the same limit as the missing-contact one
  above, in a different shape.
## Noticing things first (added 2026-10-06)

The watchful sweep, the budget and the three-question test are offline-tested end to end
(`test/notice.test.js`, 37), and so is the half that is about them rather than about the mechanism —
already handled, the three modes, snooze and stop, what already went out, the ceiling nobody can
raise, the opt-in question, one nudge per thing and the brief
(`test/notice-initiative.test.js`, 38). Both against the fake Google and a fake model. What a fake
model cannot settle is the only thing that really matters about this feature, so it goes first:

- **Whether the model's judgement of "worth interrupting somebody for" is any good.** Code decides
  when to look and how many times to speak, and every one of those rules is proved. What is NOT
  proved is the part the frame asks for: of five things in front of it, does the model pick the one
  a person would actually want, and — much harder — does it say NO_REPLY on the days when none of
  them clears the bar? A fake model answers whatever the test told it to. **The way to find out is
  to leave it running for a week on a real connected inbox and read what it sent**, which is
  Omari's, and until then the honest description of this feature is "built and reasoned about, never
  judged".
- **Whether one a day is the right number.** It is a default chosen from the brief ("one great catch
  a day beats five generic ones"), not a measured one. The budget, the ceiling and the cadence are
  all one environment variable each precisely because nobody knows yet.
- **Whether the three-question test keeps out what it is meant to.** The flags are the model's own
  answers about its own line. Code refuses on a false one, which is the half that is checkable; the
  half that is not is whether a model ever answers them honestly against its own instinct to be
  useful. A line that fails all three and gets `true, true` is a failure no test here can see.
- **Whether a catch arrives as one short line or as a summary.** The frame says one line, pointed at
  the real thing, never a list. Nothing enforces it — the words are the model's and `src/plain.js`
  will happily send a paragraph.
- **Whether "it was buried in the thread" is ever true.** That phrasing is in the brief and in the
  frame as the shape to aim at. Reason knows the meeting moved; it does not know the move was
  buried, and a line claiming that when the change arrived as a plain invitation update would be the
  model dressing a fact up. Worth looking for specifically in the first week.
- **Whether the moment is right.** Two hours before the thing is a guess. What a real day looks like
  — whether a 9am meeting moving is useful at 7am or at 11pm the night before — has not been
  watched.
- **Whether a real calendar's event ids and start times behave like the snapshot assumes.** A
  recurring event expanded by `singleEvents` has a different id per occurrence, which is what makes
  the key stable here; a series being edited as a series, a timed event becoming all-day, and a
  cancellation arriving as a dropped item rather than a `cancelled` status are all handled, and none
  has been seen against Google.
- **Whether "a known contact" is the right test for a reply somebody is owed.** It is "on one of
  their events, or somebody they have written to", which a real mailbox will stretch in both
  directions: a mailing list that once got a reply reads as known, and a new client who has only
  ever emailed in reads as a stranger. The probe is also capped per sweep, so on a busy day some
  unread mail is simply not looked at.
- **Whether Gmail's own operators select the right mail.** `subject:(invoice OR bill OR …)` is
  Gmail's syntax and has never been sent to Gmail. It will have false positives ("payment received")
  and misses (a bill whose subject is a reference number), and the honest guard is that the frame
  tells the model to read the thread before saying a date or an amount.
- **Whether the model reads the right mode out of a real sentence.** `notice_mode` takes the mode
  from the model and the sentence verbatim, with no pattern matching anywhere, which is the right
  split and also the unproved one. "Text me less" is `notice_settings` (fewer a day) and "only when
  I ask" is `notice_mode` (`off`), and a model that confuses the two either goes quiet when somebody
  asked for less, or keeps texting somebody who asked it to stop. The second is much the worse
  failure and nothing in code can tell them apart. The tool description names the cases and says to
  ask rather than guess when it genuinely cannot tell; whether that is enough has not been seen.
- **Whether `off` means what a particular person means by "stop".** Code reads it as the strongest
  thing it could mean: no texting, no looking, not even urgent. Somebody who meant "stop the chatty
  ones, obviously still tell me if my flight is cancelled" gets silence, which is a real cost of
  erring this way and the one worth asking about after a week.
- **Whether "they have opened it" is a fair test for a bill being handled.** It is the strongest
  honest signal a mailbox gives — paid is not visible to Gmail at all — and it will be wrong in both
  directions: somebody who opens a bill and forgets it gets no reminder, and the wording in the
  resolved row is careful to claim only that they have seen it.
- **Whether "the newest message in the thread is theirs" is a fair test for a reply being sent.**
  A reply sent from their phone outside the connected account, or in a thread that has since had
  another inbound after their answer, both read as not-replied. The second is deliberate — a reply
  under somebody's later mail is not the thing that was noticed — but no real thread has been seen.
- **Whether the digest hour is ever the right hour.** 18:00 is a default and theirs overrides it,
  but the brief's own argument is against digests ("beats a morning summary that mentions it on line
  nine"), so `digest` is knowingly the second-best mode and only ever what somebody asked for.
- **Whether one nudge per thing is too few.** What lifts the wait is them saying anything at all,
  which is generous in one direction (a text about something else re-opens every subject) and
  stingy in the other (somebody who never replies is never reminded again). Both are visible only
  in real use.
- **Whether a brief written from their own threads is any good.** The sources are real and the
  headings and the source-reference rule are enforced in words, not in code: nothing stops a model
  writing a line with no thread behind it, and nothing stops it looking somebody up publicly and
  putting a fact about their private life in. The rule is stated in the tool and in the frame, which
  is the strongest available guard and is not a proof.
- **Whether the opt-in question ever gets answered.** It goes out once, is allowed to need more than
  a word, and costs one of that day's texts. If it is ignored the default simply runs for ever,
  which is the intended failure — but it also means `notice_window` may never be called in real use
  and that path would then only ever have been exercised by these tests.
- **Nothing in here has touched Google.** Every calendar read, every mail search and every scope
  check in these tests answers `test/fixture-google.js`. That now includes the recheck reads — the
  single-event GET and the thread GET — so "they already replied" and "it moved again" are proved
  against the fixture's shapes and not against Google's.

### Simpler than Google, knowingly

- The fixture ignores `showDeleted`, so a cancelled event is tested through a `cancelled` status and
  through an event dropping out of the list — not through Google's own deleted-event behaviour.
- The fixture's calendar window is a string comparison on the start date rather than real instant
  arithmetic, so a 48-hour horizon is tested as "about two days" and not to the minute.
- The fixture's Gmail `q` now understands `in:sent`, `to:` and one `subject:(a OR b)` group, added
  for this feature. It is still not Gmail's query language: no stemming, no phrase ranking, and
  `newer_than`/`after:` are ignored, so the window a sweep asks for is enforced in Reason's own code
  here and would be enforced by Gmail in production.

## Commit: cheap steering, and corrections that stick (2026-10-06)

### What has actually run

The offline suite, with 9 new tests in `test/steering.test.js`. The judge is injected, so what these
prove is what the guards do with a reading — not whether the reading is right.

- "Including fees" recorded as a steer with their words, applied to the option in the same call, and
  still in front of the model two days and a fresh row-read later, on both the wake path and the
  ordinary-turn path.
- A steer missing their words, or missing what it changed, is refused.
- The `change` verdict: nothing granted, nothing refused, the ask still open, the refusal naming
  "change the details first" and "ask once more", the stale ask unable to commit, and the amended yes
  refusing the original detail by target.
- "Wrong person", both directions: the old yes cannot reach a new number, and the new yes cannot
  reach the old one. The fake channel recorded **zero** sends across both refusals, and exactly one
  after the right yes. The ledger has one successful `message_send`, to the right number.
- `cancelled` hands back the real ledger receipts from the window the task was open, names the
  window, says it cannot be taken back, and leaves the other open task running and the channel
  untouched. With nothing behind it, "nothing to undo".
- A steer carrying an illegal constraint write lands neither half.

### What only a live run proves

- **That the model reads two words as a steer at all.** Everything above starts after the model has
  decided "including fees" is a correction to the apartment search. That decision is the model's, the
  turn note is what gives it the referent, and only a live run shows whether it takes it. This is the
  single most important unproven thing in this commit.
- **That it does not re-explain.** "Apply it and carry on, never make them explain it again" is a
  prompt rule with no code behind it. A model that answers a two-word steer with a paragraph passes
  every test here and fails Omari's actual test.
- **That "leave that alone" is heard as cancel and not as never-mind.** The existing rule is that
  "never mind" leaves the plan alone and only a clear cancel cancels. Which side of that line each
  phrase falls on is the model's reading, and it is the kind of thing worth watching on a real thread.
## Commit: subscriptions — find them, cancel them (added 2026-10-06)

### What has actually run

The offline suite, with 44 new tests in `test/subscriptions.test.js`, against the existing fake
Google and a new fixture service on 127.0.0.1 (`test/fixture-service.js`).

- **The scan.** Google not connected comes back honest and asks for nothing of their mail. Connected,
  it sends exactly one request per documented search (eight), every query bounded to the `after:`
  date for the window asked for, read off the clock. Results group by sending domain — two Netflix
  receipts are one group — with the amount parsed to cents and a currency, the renewal date
  identified from the words around it, and the billing period read off "per month" / "annually". A
  one-off order receipt comes back as a candidate, which is the point: the scan decides nothing and
  the list stays empty until something is recorded. Both connected accounts are covered and every
  message names the mailbox it came from. A ledger row names the window and that the scan recorded
  nothing itself.
- **The record.** Create once, update by merchant after, however the merchant was spelled; a field
  left out keeps what was there. A yearly price is shown as what it costs a month without losing the
  receipt's own number. A non-dollar receipt keeps its currency. A price nobody can read ("about
  twenty quid") is refused rather than stored as something else. A service name not in the registry
  is refused, and a merchant nothing matches is recorded with the route `unknown` and says so.
- **The list and the page.** The monthly total normalises a yearly price and names what it could not
  count, by name and by reason. The page comes back as a `rows` block with the amount on the right,
  the total as a `callout`, and a "forgotten" guess as a second callout that says it is a guess —
  and those blocks go through `page_create`'s own checker unchanged and produce a real page.
- **The one rule.** `subscription_update` refuses `cancelled` with no confirmation and the row does
  not move. A `cancelling` row reads as not-cancelled in the list, in the row's own `says`, and on
  the page.
- **The registry, as data.** Every entry has a source URL, the date 2026-10-06, and how it was read;
  every route is a real kind; every web route has a page address; and every entry that could not be
  read is `unknown` with no invented address. The four entries with no documented last button say so
  rather than carrying a guess. The fees and notice rules that have to be said before a yes (Adobe's
  early-termination charge, Planet Fitness's eight days and $58 buyout, ChatGPT's 24 hours,
  Spotify's immediate drop inside a trial, Audible's lost credits) are all asserted present.
- **The click guard.** Every label in the registry is matched by the pattern AND refused by
  `clickCommits` as a button. The four generic one-word labels ("Continue", "Next", "Cancel", "OK")
  still click, and the two services whose real last press is one of those carry the note saying the
  press is gated by the tool instead. A link labelled "Cancel membership" is still a link.
- **The web rail, end to end against the fixture.** Signed out: Reason stops, the site's own answer
  is written down, nothing reads as connected, and the result carries the sign-in link and the
  refuse-a-password text. Signed in: the cancel page opens, the retention offer is in front of the
  model, nothing is pressed. Step one ("Continue") is an ordinary click; the last button
  ("Finish Cancellation") is refused by `browser_click` with a ledger row, and refused by
  `subscription_cancel_commit` with no yes. With a yes: a yes whose details have moved is refused, a
  yes for another merchant is refused, the real press goes through exactly once, the service's own
  cancellation number lands on the record with `cancelled_at`, the ledger row names the yes that
  authorized it, and the yes cannot be spent twice. A press that pressed nothing (a stale ref) does
  not burn the yes. A cancel page that will not load is reported as the site refusing.
- **The `cancelling` half.** With the fixture's confirmation turned off, the press really goes
  through — the fixture records it — and the row stays `cancelling`, the result says "NOT cancelled
  … waiting on confirmation", and the ledger receipt says the page gave no confirmation.
- **The written rail.** No address: it asks for one, drafts nothing into their Gmail, sends nothing,
  and carries the notice rule and the fee. With an address: the draft says "on behalf of Omari" and
  signs "Omari's assistant", asks for a reference number, and carries the line about treating it as
  still active. A draft needs no yes and reaches nobody; the send is refused without one and goes
  through with one; the row then moves to `cancelling`. The club's reply is found by a search of its
  own sending domain, the strongest proof on it wins (a reference number over a date), nothing moves
  on its own, and the model's `subscription_update` is what flips it to `cancelled`.
- **The rails that do not work.** Phone is `cant_do` with the offer for when calling exists and
  nothing changes on the record. An App Store subscription says the four taps. A service nobody has
  read says it does not know and offers to look together. Something not on the list cannot be
  cancelled at all, because there is nowhere to put the proof.
- **Standing permissions.** A permission naming one merchant lets that merchant's cancellation
  through with no yes at all, and refuses another merchant's with the near-miss line. A permission
  covering every subscription is refused on a service whose registry entry documents a fee, before
  the browser is touched, and the refusal names the fee — while the same permission still reaches a
  merchant with no fee on record.
- **Their data, and other people's.** An export carries the subscriptions including their notes and
  the confirmation numbers; a delete takes them. One person's subscriptions are not in another
  person's list or export, and another person cannot start a cancellation on them.
- **The capability and the prompt.** The capability is "not connected" before Google and "live"
  after, says the phone rail is not built and that Reason cannot tap a phone, and counts the ones
  mid-cancel. The prompt carries the rules the tools enforce.
- **Two flow tests through the real tool loop** with a scripted model in the controller's seat —
  every tool really runs, with the real zod check, the real gate, the real ledger and the real
  database. "What am I paying for every month": list first (empty), scan, four records out of five
  candidates, the list, a page, and the total it says out loud is the one the table computes.
  "Cancel it": route, start, an ordinary click past the offer, the gate, the press, a cancelled row
  with the service's own number on it, and both rails of the errand in the ledger.

#### With the real model, 2026-10-06 — `test/flow-subscriptions.test.js`

Three tests, `REASON_BACKEND=claude-cli` (opus, Omari's own Claude subscription — **not** the API,
which still has no credit). These are the three things this commit's risk list used to say only a
live run could settle, and they are the three worth the tokens: the rest of this feature is
deterministic and the offline suite has it.

| Test | What it proves |
| --- | --- |
| a scan's candidates get sorted | Asked what he pays for every month, it scans a year of a fake mailbox and writes down the recurring ones — while the shop's one-off desk-lamp receipt, which the scan hands back looking exactly like the others, is left off the list. Asserted on the table, not on the words. |
| "did it go through" on a `cancelling` row | A started, unconfirmed row is answered as not-yet and what it is waiting on — never "it's cancelled", "all set" or "you're all good". **The only wording assertions in the suite**, because here the wording *is* the feature: code already refuses to *store* `cancelled` with no confirmation, and nothing in code stops a model *saying* it. |
| the web rail, unaided, to the last button | It opens the cancel page, reads the retention offer and says so instead of clicking blindly through it, clicks past it, stops at "Finish Cancellation", says the $5.00 fee and the November 6 end date back, asks, and presses only after a yes in his own words. Ground truth is the fixture's own `cancellations` array: empty on every turn before the yes, exactly one entry after, with the service's cancellation number on the record. |

**Two real faults came out of that run, both invisible to 44 green offline tests.**

1. **The two backends handed tools different contexts.** Everything a turn is handed beyond the
   arguments `runTurn` names is spread into every tool's context on the API path; the `claude-cli`
   path built the MCP server's context from four fields and dropped the rest. So `ctx.cancelRoutes`
   — the documented hook that points the cancel tools at a fixture instead of fifteen real services
   — never arrived, the model was told Streamly does not exist, and it said so. That reads exactly
   like a model that cannot be bothered, which is the expensive part: the finding was nearly written
   up as "the model does not reach for the rail". Fixed by threading the extras through
   `runTurnViaCli` → `startMcpHttp` → `mcpDispatch`; `test/cli-ctx.test.js` pins it from both ends.
   Production sets nothing there beyond `channels` and `calls`, so nothing live changes.
2. **`subscription_cancel_commit`'s own description sent the model into a dead end.** The gate pins
   the yes to `"<merchant>: <what>"`, so a yes to ending Hulu cannot be spent on Netflix — but the
   description told the model to set the target to "the same one-line `what` you pass here", a
   string it cannot know. On the last screen, with a granted yes in hand, it got `wrong_target`
   twice, asked him a second time for a yes he had already given, and apologised for a glitch that
   was Reason's. The offline flow test never caught it because the test hand-builds
   `` `Streamly: ${what}` `` — it encoded knowledge the model does not have. Now the description and
   the web rail's `next` step both say to take the exact `use_target` the tool hands back when it is
   called with no confirmation (it presses nothing), and two tests pin that the instruction cannot
   drift back. The general lesson: **a gated tool whose target is computed from more than one of its
   arguments has to hand the model that string, and a test driving it must get the string the same
   way the model would.**

Also changed, and run: `test/fixture-google.js`'s query matcher. The old one stripped every
`word:word` token and substring-matched the punctuation left over, so a scan's real queries —
`(subject:(receipt OR invoice OR "payment received")) after:2025/10/06`, `from:(netflix.com OR
spotify.com)` — matched nothing and the scan could not be asserted against this server at all. It
now handles implicit AND, `OR`, quoted phrases, one level of parentheses, `field:(a OR b)` for
`from`/`to`/`subject`, and `is:unread`; `after:` and `before:` are recognised and ignored, because
filtering a fixed array of six messages by date would mean reproducing Gmail's date parsing to no
purpose and "the scan asked for the right window" is provable from the query string instead. The
existing Google suites use `is:unread`, `from:kofi` and an empty query and all still pass.

And `test/signin.test.js`: the test for a bad site name used "netflix" as the name nothing knows.
It is a real name now — a subscription's web rail signs in exactly the way an errand site does, so
`signin.entryFor` resolves both registries — so that test uses "blockbuster" and a new one asserts
that `signin_status` with no site still returns exactly the ten errand sites.

### Never run for real, and that is the whole of the risk here

**No real subscription has been cancelled. Nothing in Reason has ever pressed one of these
buttons.** Everything below is unproven and none of it should be read as working.

- **Every page address and every button label in `src/cancel-routes.js`.** They were read off each
  service's own help page on 2026-10-06 and not one of them has been loaded by Reason. A help page
  moves; a cancel flow is redesigned by the quarter precisely because the people who own it do not
  want it walked. `commits` is the field most likely to be stale and the most expensive to be wrong
  about.
- **Whether these sites will talk to an automated browser at all.** Unknown for every one of them.
  `npm run probe:sites` covers the ten errand sites and nothing here. Most consumer sites refuse an
  automated browser, and several of the errand sites in `src/sites.js` do; there is no reason to
  think Netflix, Amazon or Adobe are friendlier. A site that blocks automation is a finding to
  report and not a problem to defeat, and nothing here tries to get around one.
- **The sign-in.** Signing in to one of these services has never been done. The probe's signed-out
  signals (`signed_out_says`, `signed_out_url`) were written from what these sites are known to put
  on a signed-out page and **have not been checked against a loaded page**, which is a weaker claim
  than `src/sites.js` makes about its ten. `when_in` is empty on every entry on purpose: nobody has
  loaded a signed-in page on any of them, so there is nothing positive to test for and signed-in is
  inferred from the absence of every signed-out signal.
- **Fifteen common cancel phrasings in the click guard are not off any one service's page.** They
  are a widening of a guard, not a claim about a route, and they are the one place in this commit
  where a string was written from general knowledge rather than from a source. The reasoning:
  four entries can end on a button nobody has written down, and an unrecognised cancel button that
  `browser_click` presses unasked is the failure that costs somebody their subscription. Failing
  closed costs one extra question. It may also mean a button that commits nothing gets gated.
- **A retention wall.** A "chat with us to cancel" page, a phone-only escape hatch bolted onto a web
  flow, a dark-patterned offer that looks like the cancel button — the tools report and stop, and
  nobody has met a real one through Reason. The fixture's own pause-instead offer *was* met by the
  real model on 2026-10-06 and it stopped, said the offer back and asked — once, on one offer that
  announces itself. A wall built to be hard is a different thing and is still unproven.
- **The amounts.** Every price in the system comes from a receipt that a real Gmail returned, and the
  parser has only ever seen six fixture receipts. Real receipts carry subtotals, taxes, proration,
  credits and currency symbols in orders this has not met. The first amount in a message is returned
  first and the model is told the order carries meaning; nothing checks that it does.
- **Whether a confirmation email really arrives, and really matches the search.**
  `confirmationQuery` is built from the merchant's own sending domain, and no real service has ever
  replied to anything here. A service that confirms from a different domain, or does not confirm at
  all, leaves a row at `cancelling` forever until somebody asks again — which is the safe direction
  and still a thing nobody has watched happen.
- **The App Store web route.** Apple documents cancelling at account.apple.com. It is recorded as a
  `device` route anyway, because that page needs two-factor on a trusted device and Reason cannot
  complete one. That judgement has not been tested against the real page.
- **Whether a standing permission to cancel is a thing anybody wants.** It is allowed because the
  reasoning holds, not because anybody asked for it. Nobody has granted one in a real conversation,
  and the fee carve-out keys on what fifteen help pages happened to document — a service that charges
  to leave and does not say so on its help page would slip through a standing permission.
- ~~**Whether the live model reaches for any of this.**~~ **Answered on 2026-10-06** by
  `test/flow-subscriptions.test.js` above, on the `claude-cli` backend: the candidates get sorted,
  `cancelling` is said as not-yet rather than rounded up to done, and the rail is walked to the last
  button and no further without a yes. Two faults were found doing it (the backends' tool context,
  and the commit tool's own description) and both are fixed in this commit. What a live run on a
  fixture still cannot say is anything about a real service's pages.
- **Live model tests run via `claude-cli` only: no API credit.** The three flows above have never run
  against the Anthropic API, which is the path a hosted Reason would use.


## Commit: graceful recovery, without changing the ask (2026-10-06)

### What has actually run

The offline suite, with 6 new tests in `test/recovery.test.js`.

- A failed route lands on the sheet AND in the progress log, in one line written from the sheet, and
  the tool result tells the model to take the next safe route to the same goal rather than stopping.
- Two dead ends are both still on the sheet two days later, and the result names the count.
- All four `them` constraints — budget, move-in date, place, who — refused from both `found` and
  `assumed`, with `status: "needs_them"`, the constraint named, and "keep looking within what they
  asked for" plus `waiting_on_you` and the tradeoff in the refusal. Nothing written on a refusal,
  including the progress line that came with it.
- The route the refusal points at works: `waiting_on_you` with a question naming both options and
  the real tradeoff, and the constraint still exactly what they said.
- A `found` fact about the world goes straight on.
- A bare `blocked` is refused with "take another safe route first"; a `blocked` after three dead ends
  carries what stopped it, what would unblock it, and the three routes.

### What only a live run proves

- **That the model takes the second route instead of reporting the first obstacle.** Nothing in code
  can make it try again; the refusal and the tool note are both prompts. This is the part of the
  whole commit most likely to come apart in practice, and `test/flow-finish.test.js` is the only
  check on it.
- **That a refused goal change becomes a good question.** The guard produces `needs_them`. Whether
  the model turns that into *"stretch to about $2,200 all in, or go a couple stops further from the
  L?"* rather than *"what would you like me to do?"* is the whole difference between bringing back a
  decision and handing back the problem, and only a live run shows it.
- **That `routes` gets written at all.** A model that hits a 403 and simply tries another site
  without recording the first one loses the "do not try it twice" guarantee. The record is the
  model's to make.

## Commit: respecting their data (2026-10-06)

Covered offline: 11 tests in `test/trustline.test.js`, 3 in `test/google.test.js`, 1 in
`test/spotify.test.js`. **No live model call.** What is genuinely not covered, and the limits that are
real rather than untested:

- **`forget` does not delete their own messages, and that is a decision rather than a gap.** A fact
  they typed themselves — "kofi's allergic to shellfish" — is still in the thread after a forget, and
  the model can read it there. Rewriting somebody's own conversation was judged worse than the leak,
  and content is swept after `REASON_KEEP_CONTENT_DAYS` anyway. The tool, the prompt and the README
  all say so, and point at `npm run data:delete`. **Whether the model actually says it when asked is
  unverified.**
- **A forgotten fact can be paraphrased.** Reason's own replies are redacted by matching the fact's
  exact text. A reply that said "he can't do shellfish" rather than "allergic to shellfish" is not
  matched and stays. There is no fix for that short of a model call per forget, and that is not built.
- **A disconnect clears tool results by tool name.** A fact out of somebody's email that the model
  then repeated in its own reply is not cleared — only the mail itself is. The same shape of hole as
  the paraphrase one above, and the same reason.
- **Whether `looksLikeACredential` has the right false-positive rate on real messages.** Proved
  against eleven strings chosen by hand. A long order number that happens to pass Luhn would be
  refused as a card; a 13-to-19 digit number is 1-in-10 likely to pass Luhn by chance, so this will
  eventually refuse a memory somebody wanted. The refusal says what it thinks it saw, which is the
  mitigation, not a fix.
- **What it does not catch.** An account number, a sort code, a routing number, an API key, a
  passphrase written without the word "password" next to it, a card number spelled out in words. Each
  of those is a pattern that cannot be checksummed and would have to be guessed at by shape, and
  guessing is how a feature like this starts refusing ordinary facts. The model is told not to keep
  credentials; only these three shapes are enforced.
- **Whether the live model volunteers the honest half.** "It cannot reach the account any more AND
  what it already read is deleted" is two clauses in a tool result. A reply that says only the first
  is the failure this was built to prevent, and nobody has read one.

## Commit: outside content is data, heavily (2026-10-06)

Covered offline: 10 tests in `test/trustline.test.js`, 1 in `test/google.test.js`, and the Drive
injection test extended. **No live model call.** The real holes, which are holes rather than untested
claims:

- **There is no OCR anywhere in Reason, so "a screenshot's OCR" has no entry point to mark.** A photo
  or a screenshot the person sends reaches the model as an image content block, ahead of the text
  (`imagesFor` in src/media.js). An image cannot be wrapped in a sibling key, and whatever is written
  on it is read by the model directly, with nothing between. **So a screenshot of a page that says
  "ignore your previous instructions" is the one entry point in Reason with no mark and no scan on
  it.** The gate still cannot be fed from there — a yes is read from their own typed messages, and an
  image is not one — so the structural protection holds. What is missing is the mark and the flag.
  Fixing it means either putting the owner's own picture through a scan (it is usually THEIR photo,
  which is the opposite of untrusted) or a text-in-image pass that does not exist. Listed, not fixed.
- **Whether the model reports a flag rather than reading past it.** Every flagged result carries the
  shapes, the quotes and an instruction to say what was asked for and that nothing was done. Whether
  a reply actually says it — and says it in a way a person understands — is the whole point and is
  unverified.
- **The scan's false-positive rate on real mail.** Eight patterns against about twenty strings chosen
  by hand. A legitimate "reply with the code" from a bank's own 2FA email flags, which is arguably
  right and will still read as noise the third time. A flag costs a mention, which is the budget this
  was designed against, but nobody has watched a week of real mail go through it.
- **What the scan misses.** Anything paraphrased, anything in another language, anything split across
  lines mid-phrase, anything encoded, and any shape not on the list. It is a tripwire for the obvious
  cases, and the honest claim is that it catches the eight shapes it names.
- **Whether `untrusted_source` is specific enough to be useful.** "An email in me@example.com from
  billing@totally-real.example" is checkable; "pages on rtings.com, reddit.com and 4 more" is less so
  for a research run that read nine sources. Not wrong, possibly not enough.

## Commit: be a person, and act rather than suggest (2026-10-06)

Two prompt lines. **Nothing about either can be verified offline, and the test says so in its own
comment:** it checks that both are present, that each sits next to the rule it qualifies, that each is
said exactly once, and that nothing contradicts them. That is the whole of what a test can do here.

What a live run would have to settle:

- **Whether "read the room" changes anything.** The model already has the conversation and its mood in
  front of it. This line tells it what to DO about that, and whether one sentence moves a model that
  was going to make a joke about a cancelled flight is exactly the kind of thing only a real
  conversation shows.
- **Whether using memory without announcing it reads as warm or as presumptuous.** "The usual place?"
  is the good version. "Booked Carbone" when they never said Carbone for this one is the bad version,
  and the line does not distinguish them — the existing rules about never claiming something a tool
  did not do are what stand between those two.
- **Whether acting rather than suggesting goes too far.** This is the line most likely to cause a
  problem: a model told not to offer a menu will sometimes pick when it should have asked. The gate is
  what makes that safe for anything that spends money or reaches a person — those still stop — but a
  plan changed on a wrong guess costs nothing to the gate and something to the person. The hedge is in
  the line itself ("ask only when the answer genuinely changes what you do"), and whether the balance
  is right is a judgment nobody has made against real messages yet.

## Commit: a timer is fired once its message is in the outbox (2026-10-06)

Covered offline: 17 tests in `test/timer-claim.test.js`, on the server's real wiring (Runtime, router,
outbox, `deliver`) with the model replaced by a function that throws. **No live model call, and no
machine was put to sleep.** What that leaves:

- **The sleep itself is reasoned, not reproduced.** That the CLI's timeout fires on waking is read off
  one log: the turn started at 10:36:10, the Mac slept from 10:37:43 to 10:48:16, and the timeout
  line is stamped 10:48:21. A clock that did not count sleep would have put it near 10:51. The test
  pins what follows from a turn that throws that error; nothing pins that a real sleep produces it.
- **A machine that keeps dozing can burn all three tries.** That morning's wake lasted ninety
  seconds and the turn did not finish inside it. If every wake is that short, each try dies the same
  way and the third ends in the "missed a reminder" line rather than the reminder. That line carries
  the note, so they still learn what it was — late, and in code's words. Not judging a turn by time
  asleep would not obviously do better (it depends on a CLI process recovering a connection that
  slept), and nobody has measured either.
- **Only the reply is idempotent.** A retried turn runs the model again from the top. Anything the
  first try did through a tool before it died — a plan changed, a task started — is done, and the
  second try may do it again. The gate still stands in front of anything that spends money or texts
  somebody else. The first try's event line also stays in the conversation, which is why the retry's
  frame says "one reminder, late — not a second one"; whether a live model reads that as intended is
  unverified.
- **The wording of the missed line.** Written by code, never read on a phone. It quotes the note
  Reason left itself, which is written for a model ("daily challenge: remind Omari to work out
  today") and reads that way.
- **If the line saying it was missed cannot be sent either**, the timer is still finished and the
  failure is logged. On a real channel the outbox row then reports it at their next turn; on a
  channel that is not connected at all there is no row, and the log is the only trace.
- **One process.** The set that keeps overlapping sweeps off a running timer is in memory. Two
  processes on one database could both run the turn; the outbox key would still stop the second
  text. Same limit the rest of the sweep has.
- **A person over their daily proactive cap still loses the timer silently.** Unchanged, and
  deliberate when it was written ("the moment it was for has passed"), but it is the same shape as
  the bug this fixes and is worth a decision.
- **Watchers and page answers still claim before the turn.** `markWatchMet` and
  `markPageChoiceDelivered` are both written before the event turn runs, so a turn that times out
  loses "the thing you were watching for happened" and "they tapped an answer" exactly the way the
  reminder was lost. Not touched here.
- **The reminder that was lost is still lost.** Timer #2 in the live database stays fired; nothing
  replays it.

## Commit: initiative controls — what already went out, and the ceiling nobody can raise (2026-10-06)

Both halves are offline-tested against real rows: a text already sent is named in `already_went_out`
and counted in their own local day; `per_day: 10` saves ten and the fourth text of a day is still
refused `hard_cap`, urgent or not. What a fake model cannot settle:

- **Whether the model actually says the "already went out" line.** Code supplies the list and the
  instruction. Whether a model that has just been told to stop then also says "two already went out
  today, sorry" — rather than a bare "ok, stopping" — is a wording decision made on a live turn.
  Nothing offline can prove a sentence a real model has to write.
- **Whether the honest ceiling lands as honest or as pedantic.** Somebody who asks for ten a day is
  told the real number is three. That is the truthful answer and it may read as Reason arguing with
  them. Whether the one line is the right amount of saying so is a judgement on real messages.
- **Whether "less often" reliably goes to `notice_settings` rather than to `notice_mode`.** The split
  — how MANY is one question, how much initiative is another — is in both tool descriptions and it is
  the model's read. A fake model is told which tool to call, so the suite proves what each tool does
  and never that the right one gets picked.

## Commit: the connect exchange, read off a real thread (2026-10-06)

Three things from Omari's own phone, adding Drive to his second Google account: "Privacy policy:"
ending a bubble with its link above it, "is reconnected ✅ … all good again" for an account that had
just gained Drive, and the full notice twice in four minutes.

**Proven offline.** Words ending on a colon go out before their link, and the exchange as written
comes out in the order a person reads it. `completeConnect` returns `gained` and the line says what
was added; a trip that adds nothing still says reconnected. The notice is whole the first time a kind
of access is given, whole again for a link nobody finished, and the address alone afterwards.

**Not proven.**

- **How the two orders read on a phone.** Link-then-words was chosen for a preview card with a
  caption under it; words-then-link for a label. Nobody has looked at both in one thread on an iPhone.
- **That the model sends the short line and stops.** The tool description forbids adding the sentence
  back and the result says it was already shown. A fake model does what it is told; only a real one
  shows whether it re-explains anyway.
- **Google's reviewer.** See `docs/google-verification.md`: the notice on first grant only is a
  reading of "where the grant is asked for", not something Google has confirmed.
- **A model that writes a colon mid-thought** ("two things: <link> and <link>") gets words-then-link
  for the first pair. That is the intended reading, and nothing has checked how often it happens.

## Commit: taste — a rejection outlives the task it happened on (2026-10-06)

Offline-tested end to end in `test/taste.test.js` (14): a rejected option becomes a preference with
its category and their verbatim words, the same rejection twice is one row, it reaches a different
task's pick three weeks later, a stored preference cannot open a gated action, a real permission
still can, and the export and the delete both cover the table. No model anywhere in it. What a fake
cannot settle:

- **Whether the model's category is the right one.** price / vibe / timing / location / other is the
  model's one-word reading of a sentence, and the whole value of the list is that "too dear", "bit
  much" and "over budget" land in the same bucket. A fake model is told which category to pass. On
  real messages some nos are two categories at once ("$90 for a tuesday in bushwick") and which one
  it picks decides what the next pick is told.
- **Whether a taste read back from weeks ago still holds.** "Too expensive for a tuesday" was true
  about a tuesday in October. There is no expiry on a preference row and no notion of a taste going
  stale, so the risk is Reason being quietly governed by a sentence somebody has moved on from. The
  hedge is that every row is correctable and shows on the memory page with its date — not that
  anything notices on its own.
- **Whether "offer it and say so" actually happens.** The instruction says a taste is not a rule: an
  option that breaks one should be offered with the break named in the same line. A model that
  instead silently filters it out would look identical from the outside and would be the worse
  failure — the person never learns the best option existed. Nothing offline can see the difference.
- **Whether a rejection is read as a no to the thing or a no to the idea.** `taste_note`'s description
  draws that line in words ("a no about THAT THING rather than a no to the whole idea"). A person who
  says "forget dinner" is not telling Reason anything about restaurants, and a row written from that
  would be a false preference carried forward indefinitely.
## Commit: Reason checks its own work, and "done" has to be earned (2026-10-06)

### What has actually run

The offline suite, with 25 new tests in `test/verify.test.js`.

- A dead link is refused with the real status and "do NOT send it"; a live one passes; a 200 that is
  not readable text (a PDF) counts as opening, because the question is whether the link works and
  not whether Reason can read it; a non-URL and a `file://` are refused with no fetch at all; a
  lookup that throws is a dead link rather than a crash.
- With `fees_included` on the sheet, a total with no fee line in it is refused and one that shows
  base + fee + all-in passes. No constraint, an explicit "no, quote me the base rent", and a line
  with no money in it are all left alone.
- A number that is not on the job is refused with the sheet's own people named back; the same number
  written differently is the same person; a job that names nobody may reach nobody; the owner is
  never checked against the sheet; somebody on `waiting` is somebody the job may reach.
- A page that renders passes; an empty one is refused with the words to use instead; a page whose
  blocks the renderer cannot handle is deleted again, so no row is left with a link on it.
- `done` is refused while an ask is open, and the refusal quotes the ask. The same job closes
  `failed` with that ask still open. A **refused** ask does not hold it. An ask with **no task** on
  it does hold it (forgetting to name one is not an escape); an ask from **before** the task does
  not. `done` is refused on a dead link in the outcome and goes through on a live one; refused on a
  total missing the fees and through on one that shows them. In every refusal the task is still
  `running` — nothing is written.
- `checkFinish` puts the open ask first: a job with one is never told about its dead link instead,
  and the link is not even fetched.
- The fee and recipient checks inside `confirm_request` record nothing when they refuse; an action
  that reaches nobody (a browser click) is not checked against the people on the sheet; an ask
  pinned to another conversation's task is refused; and the task a turn was **woken for** is found
  without the model naming it.

### What only a live run proves

- **That the model closes `failed` rather than arguing with the refusal.** Every refusal names the
  honest alternative, but taking it is the model's to do. A model that answers a blocked `done` by
  rewording the outcome until it passes would satisfy the code and defeat the point.
- **That the fee refusal produces a real all-in number** rather than the word "fees" added to the
  same price. Code can only see whether the line mentions a fee; whether the arithmetic is true is
  beyond it, and `verifyFeesShown` says so by name.
- **That `task_id` gets named on an ask.** Code covers the forgetful case by treating an unpinned
  ask as in scope, which can over-report: an unrelated open ask will hold a task back. That is the
  safe direction, and the refusal names which ask it is, but a model that never pins an ask will
  produce the occasional confusing hold.
- **The recipient check depends on the model having put people on the sheet.** `peopleOn` reads
  constraints whose *name* suggests a person and everything in `waiting`. A job that keeps the
  agent's number under a constraint called `contact_v2` will fail closed — refusing a send that was
  fine — which is the right direction but is still friction only a live run will show.


## Commit: everything open, on one page (2026-10-06)

### What has actually run

The offline suite, with 11 new tests in `test/activity.test.js`.

- Every open job is on the page under what it is really doing, with the progress log as finished
  steps and `sheet.left` as the steps that are not.
- What is waiting on them is above the first job, with the tradeoff and how long it has been there.
- The same link, one revision later, every time — and no second page.
- Rejected options are folded into a `details` block with their own words for why.
- A job finished an hour ago is on it; the same job three days later is not.
- Nothing open says exactly that, and the note tells the model not to invent a question.
- A `blocked` job shows what stopped it and what would unblock it; a `waiting_on_other` job names
  who is owed what and says Reason is checking without being asked, and does not count as waiting
  on them.
- A job with nothing on it yet is still a readable block, and the whole thing renders.
- Deleting the page is allowed and the next one is a new link.

### What only a live run proves

- **That the model reaches for it at all.** Nothing in code makes a page happen: `task_list` says
  to past two open jobs and the prompt says it, and both are prompts. A model that answers four
  open jobs with four bubbles is the failure this does not prevent.
- **That the message it sends alongside the link is a headline and not the page again.** The note
  says the headline goes in the text and nothing from the page is repeated. Only a live run shows
  whether that holds.
- **What it looks like on a phone.** The blocks are the ones the page kit already renders, but no
  activity page has been opened on a real device. A long progress log on a narrow screen is the
  thing to look at first.

## Commit: memory I can correct — four sections, every row theirs (2026-10-06)

Offline-tested in `test/memory-page.test.js` (16): the four sections render from rows and an empty one
is not a section; a correction changes exactly one row and the old wording is gone from the page, the
answer's data and the saved thread; four readings of the same thing off two sources leave it a guess
and one sentence from them makes it a fact; a permission cannot be corrected or dropped from here; the
export and the delete cover both new tables. No model anywhere in it. What a fake cannot settle:

- **Whether the model says a guess as a guess.** Everything code can do is done: the guesses are a
  separate list, the page carries a box saying nobody told Reason any of it, and the instruction says
  "i think" / "i've got you down as" and never as fact. Whether a real model, reading four lists in one
  tool result, keeps the line between the first two is the single thing this whole feature turns on, and
  it is a sentence a model writes. The hedge is that a wrong one is now visible and one text away from
  being fixed, which is better than the old behaviour of the reading existing only in the thread.
- **Whether the numbers survive the trip.** A person corrects a line by texting its number back. That
  needs the model to put the numbers into its reply, and then to read "#4" as that row rather than as a
  count or a price. Both are in the prompt and in the tool's description; neither is enforceable, and
  the failure — changing the wrong line — is the worst one here. `memory_fix` refuses a number that does
  not exist and names `memory_page`, which catches a made-up id and not a plausible wrong one.
- **Whether "that's my friend's car" reaches `memory_fix` at all.** The model has to notice that a
  correction in conversation is also a correction to a row. A person who puts Reason right and sees it
  agree in the chat, while the row stays wrong, is in exactly the position this feature was built to
  end — and nothing offline can tell whether the tool gets called.
- **Whether a guess should ever have been kept.** This is the one design decision worth a second look
  rather than a test. Writing a refused reading down makes it visible and correctable; it also means
  Reason holds a row about somebody that they never said, for as long as they never look at the page.
  The alternative — not keeping it — is what was there before, and its failure mode was worse but
  quieter. Omari's call if he disagrees.
- **Whether the page is the right length.** It renders every fact, guess, preference and permission
  (capped at 60 facts and 40 of the rest). Nobody has read one with two hundred rows on it on a phone.

## Commit: notice conflicts before acting (2026-10-06)

### What has actually run

The offline suite, with 15 new tests in `test/conflicts.test.js`.

- Cheapest against never-basic-economy: written down, the job held, and the standing rule's own
  words handed back so the question can quote them.
- A conflict against a constraint that is not on the sheet is refused and nothing is held, with the
  refusal naming the real fix. A made-up kind of `against` is refused with the three real ones
  named. `remembered:` is refused unless the fact is really saved. `rejected:` carries the taste
  reason — "felt grim", read as vibe.
- A `confirm_request` on a held job is refused with nothing recorded, and two open collisions hold
  it until both are answered.
- A second check on the same collision returns the one already open rather than asking twice.
- The resolution lands as a `source: "them"` constraint with their words; the hold lifts; the thing
  they said before is untouched when the answer was "just this once"; and the next search raising
  the same collision gets the resolution back with "do not ask again".
- A resolution with no words of theirs is refused and the job stays held; `keep: "both"` is
  refused; settling the same conflict twice is refused.
- The model's view of the sheet carries `open_conflicts` with the tradeoff and the instruction not
  to decide, and `settled` with their words after.
- Both the collision and the answer are in the progress log.

### What only a live run proves

- **That the model notices at all.** This is the whole feature and code cannot do it: nothing
  forces a `conflict_check`, and a model that simply books the cheap fare has broken nothing that
  any test can see. The hold only works on a collision that was spotted. This is the single
  biggest live risk in this commit.
- **That the one-line question is actually one line with a real tradeoff in it.** Code requires a
  `tradeoff` string and nothing more; "which would you prefer?" would satisfy it and defeat it.
- **That the model does not over-fire.** The refusals push back on invented conflicts against
  things that are not written down, but a model that raises a genuine-looking collision on every
  ask would turn the hold into a stall. Nothing has been watched doing this on real asks yet.
- **Whether `settled_<n>` constraints read well on a long job.** They accumulate on the sheet and
  are shown to the model under `settled`; a job with six of them has not been looked at.


## Commit: change my mind cheaply (2026-10-06)

### What has actually run

The offline suite, with 12 new tests in `test/letgo.test.js`.

- A job with a reminder, a watcher and a question out: all four stop, each on its own line, and
  the task is cancelled. The never-mind leaves one ledger receipt with their words on it.
- What really went out is listed, **not** touched — the only new ledger row after a `let_go` is
  the `let_go` receipt itself — and carries the cancellation terms the job wrote down.
- A `failed` ledger row is not a commitment and is not listed as one.
- With no terms written down, the answer is the string "not written down on this job" and the note
  says to find out rather than guess.
- The partial: "forget the hotel, keep the flight" cancels one, leaves the other and its own timer
  running, and returns the flight under `still_running` with the note naming it.
- A reminder belonging to no job is never swept up.
- Nothing attached → `nothing_was_running`, with "all clear" and "do not imply you undid anything"
  in the note. A job that already finished is refused with its outcome quoted. A task id that is
  not this conversation's stops nothing at all, including the valid ids in the same call.
- A held heads-up scheduled on the job's own timer is dropped with it, is marked `dropped_at`
  rather than deleted, and does not come back through `heldNotices` or `pendingNotice`.

### What only a live run proves

- **That the model names the right jobs.** `task_ids` is the model's reading of what "the trip"
  covers, and that reading is the whole feature. Code refuses ids that are not theirs or not open;
  it cannot know that "forget the trip" meant the hotel job too. A model that names one of three
  leaves two running and says it stopped everything.
- **That the acknowledgement is one line.** The note says so; nothing enforces it. The failure to
  watch for is Reason reading the whole stopped list back, which is exactly the negotiation this
  commit exists to remove.
- **That the committed ask is one line with the cost in it** and not a paragraph of options.
- **Anything made before this commit has no task id**, so a never-mind on a job that was started
  earlier will find its own row and nothing hanging off it. It will under-report rather than
  over-report, which is the safe direction, but it is worth knowing on the first live never-mind
  after deploying.
- **A held notice is only found through a timer.** A notice about the same topic with no timer on
  it is not swept up, by design — there is no tie, so there is no claim. Whether that reads as a
  gap in practice is a live question.

## Commit: whose file it is, and a voice note asked for twice (2026-10-06)

**Proven offline.** A Drive search asks for `ownedByMe` and every row says who owns the file; the
note and the tool description both say newest is not theirs; both prompt rules are present once, for
the operator and for anybody else. A listening request that hangs is asked again, then goes to the
fallback, and stops after four; the per-attempt wait follows the note's length.

**Measured once, on real audio, 2026-10-06.** Three of Omari's own voice notes were downloaded and
re-sent to both listening models. `gemini-3.8-flash` answered 503 every time. The fallback
transcribed two in about a second and took 52 seconds over the third. That one slow answer is the
whole evidence that the shorter wait plus a retry is right; three notes is not a distribution.

**Not proven.**

- **That the model obeys the rule.** "Open it and check whose name is in it" is a prompt line and a
  tool note. A fake model does what its script says. Whether the real one reads the file before it
  writes a bio from it is only visible on a real ask.
- **A resume that names nobody at the top**, or names them differently ("O. Nyarko"). The model has
  to decide whether that is the same person, and nothing here helps it.
- **Whether a shorter wait cuts off a slow-but-coming answer more often than it saves a minute.** The
  52-second answer above would have been abandoned at 22 and asked for again.
- **Clipped openings.** The measurement says the phone; nobody has checked a second phone or the
  Sendblue file against the original on the handset.
## Commit: how much care a job is worth (2026-10-06)

### What has actually run

The offline suite, with 18 new tests in `test/stakes.test.js`.

- The mark is one of three words; `high` is refused with the three named rather than guessed at.
- An unmarked sheet reads as `money` in `stakesOf` while staying `null` on the sheet itself, and the
  view tells the model it is unmarked rather than telling it the job is `money`.
- `low` closes on a bare total that `money` refuses; `low` still cannot close over an unanswered ask
  or a dead link.
- `binding` is refused with no `document`, refused on a number with no `prices` row, and closes with
  both — naming the document it read.
- A partial read (`document.could_not`) closes and lands in `could_not`, with the note that says not
  to claim it.
- `failed` and `cancelled` go through at all three levels, through the real tool, on a job with a
  fees constraint, a dead link and no document.
- The depth reaches `task_finish` itself, not just `checkFinish`: a binding job is refused by the
  tool and the row stays open.

### What a fake model cannot settle

- **Whether the model marks a job correctly, or at all.** This is the whole feature and nothing in
  code can check it. A model that marks a flight booking `low` has turned the fee check off for a
  thing that spends; a model that marks everything `binding` has made Reason unable to finish
  anything without a document. The default is the mitigation — silence gets `money`, which is the
  old behaviour — but a *wrong* mark is worse than no mark and nothing here catches one. The one
  structural comfort is that `low` is the only mark that loosens anything, and it loosens exactly
  one check.
- **Whether `document.says` is really off the document.** Code checks that `where` parses as a URL
  and that `says` is non-empty. It does not fetch the document, does not check the text came from
  it, and could not tell a real cancellation clause from a plausible sentence about one. A model
  that writes what it expects a lease to say would pass this check and the refusal it was built to
  stop would not fire. Fetching and quoting-checking the document is the obvious next step and is
  **not built**.
- **Whether a price row is a price Reason really saw.** Same hole, same shape: `where` has to be a
  link, and nothing fetches it. A fabricated listing URL passes.
- **"Two different sites" is reported, not enforced.** One source closes the job. Nothing refuses a
  number seen once, at any level — `could_not` just says it was one site, and whether the model then
  says that out loud to the person is unverified. Enforcing two was considered and rejected: a lease
  rent exists on one listing, and a check that refuses the honest case teaches the model to work
  around it.
- **Whether the model reads `could_not` back to them.** The result supplies the list and the
  instruction. Nobody has seen a live reply that says "the link works, I couldn't re-check the fee
  schedule" — and that sentence is the feature, on the person's side of it.
- **The `HAS_MONEY` test decides whether a binding job needs a price source.** It reads the line
  Reason itself composed, not anything the person wrote, so the no-regex rule holds. But a binding
  close worded without a numeral — "signed at the rent we agreed" — does not trip it and closes with
  no price source at all. Over-reporting would be the safe direction here and this does not
  over-report.

## Commit: an approval that says what is being approved (2026-10-06)

### What has actually run

The offline suite, with 5 new tests in `test/verify.test.js` and two rewritten in
`test/channels.test.js` and `test/calls.test.js`.

- `action: "proceed"` and `action: "task_list"` are both refused `not_a_gated_action`, with nothing
  written to the confirmations table.
- `message_send` with no target and `browser_submit` with no target are refused `ask_says_nothing`
  with `target` named in `missing`; the same ask with a target goes through.
- `browser_submit` + `stakes: "both"` + no figure is refused; the same ask with "$240" in the
  details, or with `amount: 240`, goes through.
- `message_send` + `stakes: "both"` is NOT asked for an amount, because a text cannot spend.
- `undo` comes back `no` / `hard` / `easy` for a text, a booking and an account connect.

### What a fake model cannot settle

- **Whether the model says the undo line.** Code supplies `undo` and the sentence to use. Whether a
  live reply actually tells somebody "this can't be unsent" before they answer is the whole point on
  their side of it, and nobody has read one.
- **Whether a model routes around the refusal rather than fixing the ask.** The refusal names what
  is missing, which is the design — but "name a target" can be satisfied with a vague one, and
  `stakes` can be downgraded to `third_party` to make the amount check go away. Code cannot tell a
  careful declaration from a convenient one. The honest summary is that this stops an ask that says
  *nothing*, not an ask that says *too little*.
- **The amount check only ever looks at `browser_submit`.** That is the only tool in `SPENDS_MONEY`.
  A future action that spends has to be added to that set or it inherits no amount check at all, and
  nothing fails loudly if it is forgotten.
- **`UNDO` is a hand-written table and its default is `hard`.** An action missing from it is treated
  as reversible-at-a-cost, which is the middle rather than the safe end. A new irreversible tool
  that nobody adds to the table would be described to somebody as undoable. `test/trustline.test.js`
  already asserts `GATED_ACTIONS` cannot drift from the gate; `UNDO` has no such test and should.
- **Whether refusing a yes for an ungated action costs anything real.** The reasoning is that being
  asked about things that need no approval teaches somebody to skim. It is a judgement about people,
  not a tested claim, and a model that genuinely wants to check a plan is now told to use a normal
  message instead — which is right, but unverified as behaviour.

## Commit: a lower number binds the texts that already went out (2026-10-06)

The close-out pass over "memory I can correct + taste + initiative controls" found the building done
and one line of it unpinned: "less often" lowering the number and code then holding the LOWER number.
What the suite had was the raising case and the hard cap. It now has the lowering case against real
budget rows — three a day, two used, then `per_day: 1`, and the next unprompted text is refused
`budget_spent` with "(2 of 1)" on it while urgent keeps its room under the ceiling of three. No code
changed; the behaviour already held and nothing proved it.

### What a fake model cannot settle

- **Whether "less often" is read as fewer-a-day at all.** Already written down above for the raising
  case and it is the same gap here: a fake model is told which tool to call, so the suite proves what
  `notice_settings` does with a lower number and never that a real model reaches for it.
- **Whether being told "that's your day" straight after asking for less reads as obedient or as
  sulking.** Somebody who asks for fewer texts and is then told nothing else is coming today has been
  obeyed exactly. Whether that lands as Reason respecting them or as Reason making a point is a
  judgement on a real exchange, and the line is the model's to write.

## Commit: the text answer's instruction is held to its four sections (2026-10-06)

The page was already pinned block for block. The answer somebody actually gets in a text was pinned
only as data — the four arrays are in the `memory_page` result — and the instruction that turns those
arrays into four sections in one order was not, nor was the standing rule in `SYSTEM` that governs the
reply on the turn after. Both are now asserted. No behaviour changed.

### What a fake model cannot settle

- **Whether a real model answers with all four.** This is the honest limit of the whole thing: code
  hands over four lists and an instruction naming them in order, and a model short of room, or one
  with its own sense of what is interesting, can still answer with two. Nothing offline can prove a
  paragraph a real model writes. What the test buys is that the ask cannot quietly disappear from the
  prompt — not that it is obeyed.
- **Whether "i think" and "i've got you down as" actually come out of it.** A guess said as a fact is
  the one failure the separate list exists to stop, and the hedge is wording on a live turn.

## Commit: knowing when to stop digging (2026-10-06)

### What has actually run

The offline suite, with 4 new tests in `test/research.test.js` (32 in that file, all passing).

- `enough: true` with a `research_id` comes back `ok` with the source log, and `enough_at` is on the
  row afterwards with `queries` emptied — so it survives a restart and a trimmed context.
- Carrying that run on afterwards is refused `blocked: "already_enough"`, the source log comes back
  with it, the `enough_why` line is in the error, and the fake provider's search counter is still
  zero. The `searches` count on the row is unchanged.
- The same question asked again as a **new** run is not blocked: it gets a different
  `research_id`, the search counter really goes up, and its `enough_at` is null.
- A run a cap cut short has `cut_short: "searches"` and `enough_at: null`, and carrying it on with a
  bigger cap is still allowed.

### What a fake model cannot settle

- **Whether the real model ever passes `enough`.** This is the whole feature on the owner's side and
  it is entirely the model's call: code cannot tell an answered question from an unanswered one, so
  there is no offline test that can make this fire. Every test here calls `enough` by hand. If the
  live model never reaches for it, nothing breaks and nothing improves — the caps stay the only stop,
  which is what the current behaviour already is.
- **Whether it stops at the right moment rather than too early.** The field description says it is
  not a way to hide a thin answer, and the prompt says to say what could not be found out. A model
  under pressure to look efficient has an obvious cheap move here: call it enough after two pages and
  answer confidently off both. The honest summary is that this removes a reason to over-search and
  adds a reason to under-search, and only a live transcript can say which way a real run leans.
- **Whether `enough_why` is written for a later self or written to satisfy the field.** It is free
  text and nothing validates it. "enough info" would pass.
- **A new run on a settled question is deliberately unblocked, and that is a real cost.** A model
  that forgets it has a settled run and starts the identical question again will search again, and
  nothing stops it. That is the chosen trade: refusing on wording would break the common honest case
  (the same question asked a month later, when the answer has changed) to catch an uncommon one. The
  mitigation is a prompt line, not a guard, and prompt lines are not guarantees.
- **The deep-wake path is covered only through the tool.** A woken deep run reaches this refusal
  because the model calls `research` with the id it was handed; `researchForTask` exists in `src/db.js`
  but nothing calls it, so there is no code path that re-enters a settled run without going through
  the tool. If one is ever added it will need its own check — `src/research.js` `step()` refuses a
  non-open run, which catches it today, but with the generic "already done" message rather than this one.

## Commit: one nudge per open question, and at least that one (2026-10-06)

### What has actually run

The offline suite, with 3 new tests in `test/loose-ends.test.js` (15 in that file, all passing).

- One nudge per open question: the same question is nudged once and never again however long it
  waits; a *different* question written to the sheet afterwards gets its own single nudge, and the
  reminder that comes back is the new question.
- Re-writing the **same** question does not reset the stamp, so a model restating what it is waiting
  on — which happens on every wake — cannot switch the ceiling off by repeating itself.
- A nudge the proactive cap stopped is **not** spent: `reminded_at` is still null after the capped
  pass, the reminder really goes out on the next pass with the question in it, and the pass after
  that sends nothing. This test fails against the previous order (claim, then check the cap), which
  is how the bug was confirmed rather than argued.

### What a fake model cannot settle

- **Whether one nudge is the right number.** It is Omari's call written into a row, and the row is
  the point: the alternative is the model's sense of tact, which drifts over two hundred wakes. But
  whether a person wants exactly one chase on a thing they forgot is a judgement about people, not a
  tested claim.
- **Whether the model writes a genuinely different question or just a reworded one.** The sheet keys
  "same question" on the exact text the model wrote, which is the honest key available — it is the
  model's own structured field, not anybody's prose being pattern-matched. A model that rephrases the
  same need on a later wake will be given a second nudge, and code cannot tell that from a job whose
  question really moved on. The idempotence test covers the common case (the same string written
  again); near-misses are not covered and cannot be without reading meaning out of a string.
- **Whether the nudge line reads as caring rather than nagging.** The sentence is written by code,
  which is deliberate, but nobody has read one land on a real phone after a real 24-hour silence.
- **The deferred-nudge window is unbounded.** If the proactive cap were spent every single day, the
  nudge would be deferred every day and never sent, which is the old bug with extra steps. Nothing
  tests or bounds that, because the cap resetting daily makes it not happen in practice; it is an
  assumption about the cap, not a guarantee of this code.

## Commit: closing clearly — "done" is not "started", and "where were we?" in order (2026-10-06)

### What has actually run

**A live test, and it passed.** `test/flow-loose-ends.test.js` runs through the `claude-cli` backend
(model `opus`, on Omari's Claude subscription — **not** the API, no credit spent). One turn: a job
mid-flight with real progress, a real `left` list and a real open question on its sheet, asked "hey
where were we". It passed **twice**, 2026-10-06, ~10s a run.

It asserts the thing that is actually promised to somebody who put their phone down for a day: what
has happened lands before what is left, and the one thing on them lands **last**. A model that opens
with its question has turned a status update into a demand, and every offline test would still be
green. The three tokens checked (`441`/`1,850`, `super`, `tuesday`/`wednesday`) exist only on that
sheet, so an answer containing them was read off the sheet rather than improvised, and they are
deliberately distinct strings so their positions mean something. Nothing is asserted about wording.

Also offline, 2 new tests in `test/loose-ends.test.js` (17 in that file, all passing):

- The gated half of "done is not started" is confirmed **in code**: a `confirm_request` that was
  asked and never carried out makes `task_finish` state `done` come back `asked_but_never_done` with
  `"Done" cannot mean "started"` in the error, and the task is still `running` — nothing written. The
  same job closes `failed` straight away, so it can always be ended truthfully.
- The prompt carries the rule for the ungated half, including both ways out of it.

### What a fake model cannot settle

- **An unanswered `sheet.needs` does not block a `done` close, and this was measured, not assumed.**
  A probe closed a `waiting_on_you` job carrying "tuesday or wednesday?" as `done` and it went
  straight through, no refusal. So the gated kind of unfinished step is guarded and the plain kind is
  not. **This is a decision for Omari**: making it a refusal would be consistent with
  `asked_but_never_done`, and the honest way out already exists in the sheet (`sheet.needs: null`).
  The cost is false refusals — a model that acted on an answer given in chat but never cleared the
  sheet would be told no and need one extra turn, exactly as the gate refusal already does. It was
  left as a prompt line because the brief for this run scoped the remedy to one, and because adding
  a refusal path to the close gate minutes before a live restart is not a thing to do unasked.
- **Two passes is not stability.** The order rule held twice. Two samples of one model on one
  backend is evidence, not a guarantee, and nothing here pins the *tone* — only the order.
- **The order is only pinned for a job that has all three parts.** A job with no progress yet, or
  nothing left, or nothing on them, is not covered live. The offline tests cover the
  nothing-on-them case at the tool (`task_list` says so rather than offering a question); whether the
  model obeys that with a real empty list has not been read.
- **The live test cannot run against the API.** No credit. A backend difference could in principle
  hide something, and `claude-cli` is the owner's machine only, so this proves the model reasons
  correctly — not that a deployed API-backed Reason does.

## Commit: the watch judges mail by meaning (2026-10-06)

**Proven offline.** Selection: a person's mail six hours old is a candidate; a list (by
`List-Unsubscribe`) and a no-reply address are not; a stranger is, marked as one; the known-contact
probe's answer travels as a fact and is absent when the probe budget was spent. The opt-in question
leaves the day's budget untouched. The frame names the bar and what urgent means.

**Not proven.**

- **Whether the model, shown fifteen ordinary emails and one invite, picks the invite** and marks it
  urgent when the day is spent. The judgement side of this feature has never run against a real model
  (no API credit). The whole change is a bet that a reader beats a word list; the fake proves only
  that the reader is now shown the mail.
- **More to read per sweep.** Up to 15 unread per account every two hours, each a metadata read, plus
  up to 6 sent-mail probes. Real cost on a busy inbox is unmeasured.
- **Header coverage.** Some bulk senders set none of the four headers; some humans' mail (a shared
  mailbox, a CRM) sets `Precedence: bulk`. Both edges exist and neither has been seen here.
- **The 2026-10-06 invite itself.** It was already opened by the time this landed, so the first sweep
  on the new build cannot re-raise it; the next real test is the next real email.

## Commit: what it has kept for you is part of the moment (2026-10-06)

**Proven offline** (`test/kept.test.js`, 12 tests). The note lists the pages made for this person
(title, page id, owner link; newest first; ceiling holds) and the reminders not yet sent (fired and
cancelled ones absent; soonest first); nothing kept means no note. It reaches the model on both
backends on a turn they start, never on an event turn, and never lands in the saved thread. `keep`
on a turn is what the thread records in place of the frame, on both backends and through the
runtime; the sweep and the digest pass one. The short lines say how much was in front of the model.

**Proven live, once, via the `claude-cli` backend (opus, not the API)** — `test/flow-kept.test.js`:
with a back guide on a page and Reason's own 7pm nudge as the last line of the thread, "About
leaving" got *"nice, have a good one 💪 if today's a back day, here's your back guide: <link>"*.
No "for what?", and the guide offered with its link.

**Not proven.**

- **The API path with a real model.** Same note, same rules, no credit.
- **That the thread stays readable with the short sweep lines in it** over a real week — the model
  now sees "you looked; 3 things were in front of you" where it used to see the mail itself, so a
  later "what did you see in my inbox earlier" has to go back to the mailbox rather than the thread.
  That is the intended direction; whether it ever asks for the bundle is unobserved.
- **Reminders in the note changing behaviour.** The replay proved pages; no live turn has yet shown
  a reminder in the note being picked up ("i'm doing it now, cancel the 7pm one").

## Commit: the contact card, and the picture on a page link (2026-10-06)

Omari: "all of Reason's pages never have the preview." Three stacked causes, all confirmed on
2026-10-06: iMessage previews are built by the SENDING device and Sendblue's send API has no field
for one; Apple will not expand a link from a number not in the recipient's Contacts (Sendblue FAQ
and guides/contact-card); and a page's HTML had no `og:image`. Three answers, one commit.

**Proven offline** (`test/contact.test.js`, 17 tests; `test/pages.test.js` updated). The card is a
vCard 3.0 with the live line's number, the icon as its photo and the site as its URL, folded to 75
octets, served at `/reason.vcf` only while a texting channel is live. It goes out after the master's
"yes", on a pre-approved number's first text, and once at startup to every existing account — once
per account, remembered on the row, retried no sooner than six hours after a failure. A page link
leaves with the page's own picture on it (title, subtitle, "Made for …", date; 1200×630, the page's
palette); other links and the words go bare; a picture that cannot be drawn costs the link nothing.
`og:image` names `/p/{id}/card.png`, keyed for a private page and bare for a shared one; the gate
and the not-found page build no card and carry identical icon links. Two real Chromium renders were
looked at by eye (`/tmp/reason-card-try-*.png`), 380 ms for both.

**Not proven.**

- **Any of it on a real phone.** Whether iOS saves the card from a Sendblue `media_url`, whether
  a saved contact then makes the bare link bubble expand, and — the one to watch — whether the link
  bubble carrying the picture AND a phone-drawn preview shows the picture twice. If it does,
  `REASON_LINK_CARDS=off` sends links bare again without a deploy.
- **Sendblue accepting `media_url` with `content` alongside** for a .vcf. The docs allow both on one
  message; the fixture answers QUEUED. The first startup send to Omari's own number is the real test.
- **`og:image` being fetched at all.** Apple's fetcher has never been watched hitting
  `/p/{id}/card.png`; the route is tested against the handler, not a fetcher.

### Same evening: the picture on the link is gone (2026-10-06, 10:10 PM)

Omari's phone settled two of the three unknowns above in one screenshot. The card from the startup
send saved, and the bare link bubble then drew its own preview — title, domain, and the og:image
picture. It also showed the third: the picture attached to the link bubble was the same picture a
second time, one bubble above the phone's card. "I don't like that extra picture card on top. I just
wanted the link preview and it works fine." So the attachment path is REMOVED, not switched off:
`withPageCards`, `pageForLink` and `REASON_LINK_CARDS` no longer exist, and `sendParts` /
`sendSequence` take strings again. The picture stays where the phone fetches it from
(`/p/{id}/card.png`, named by og:image). Still unobserved: a phone with the card NOT saved, which
should get bare blue text as before; and whether Apple's fetcher caches the picture across a page
revision (the `?v=` on the address is there for that).

## Commit: the read is not the reply (2026-10-06, 10:20 PM)

Omari texted "You're so smart" and the first line of the answer was "A compliment, so I'll just
talk back. Short." — the prompt's compliment rule, recited to him, then the real reply. Found in his
screenshot; one occurrence across every thread in the live database.

**Proven offline** (`test/plain.test.js`, 2 new tests): `withoutSelfNote` takes off a first
paragraph that is one short line, ends in a full stop, carries no colon, is not addressed to them,
and is in the first person about Reason's own move or a read of the message followed by "so"; the
reply after it is what is kept and sent. Seven lines to THEM are kept whole, including "I'll keep it
short: lisbon wins" and a one-paragraph reply whatever it says. Applied on both backends before the
reply is saved, so the thread does not teach itself the habit. The prompt now says the read stays in
your head and the first line IS the reply.

**Not proven.** That the prompt line stops the model doing it; the floor is narrow on purpose and
a differently worded leak ("Vent. Keeping it light.") would get through. Watch `self_note_dropped`
in the log: if it fires more than rarely the prompt is the thing to fix, not the regex.

## Commit: Reason itself on the phone, via ElevenLabs (2026-10-06, built ahead of Friday 10-09)

Six new files, 80 new offline tests, and **nothing that has touched the real platform**. There are no
ElevenLabs or Twilio keys on this machine until 2026-10-09, so every request is shape-tested with an
injected fetch and every spoken turn with an injected generator, exactly as Bland's adapter was. The
provider is dormant: it needs `REASON_CALL_PROVIDER=elevenlabs` *and* each key, and `status()` reports
not connected by name until both.

**Proven offline.** `test/elevenlabs.test.js` (18), `test/call-voice.test.js` (26),
`test/call-inbound.test.js` (15), `test/call-postcall.test.js` (21). The documented outbound request
with the announcement verbatim in `first_message` and the pinned voice; refusal with no announcement,
no rules, no payment rule, a non-E.164 number or a missing key, in every case before anything is sent;
voicemail read off the termination fields rather than the status; cost returned null rather than a
credit count written into a cents column; the HMAC scheme over `${t}.${rawBody}` including a replay
outside the window; the SSE framing and `[DONE]` on every path including a model that throws; the
bearer check and that no secret means no answer; a third-party context that carries no thread, no
memory and no tools, proved by planting strings in the owner's thread and searching the whole context
for them; the language switch leaving as a function call, the disclosure asked for once per language,
and a switch to the language already in use dropped; a web address never spoken and really queued; an
inbound stranger getting one line with the master asked on the texting channel; the day's call and
minute caps counting a call that came IN; the transcript written into the thread as turns and NOT
written for a third-party call or a voicemail; audio saved as bytes, refused when it is JSON, and
refused when it is too small to be a call of that length.

**Rehearsed, with real words.** `npm run rehearse:calls` plays both scenarios through the real
endpoint on the subscription backend. Two things were wrong on the first run and are fixed: the model
called `language_detection` on every turn once the restaurant answered in Spanish (now dropped in code
when the language has not changed, and asked against in the prompt), and it said "thank you, goodbye"
on the second turn of a five-turn call without hanging up (the prompt now says never one without the
other). This is a rehearsal, not a call: the phone is a loop in a script.

**Not proven, in the order it is most likely to bite.**

1. **That ElevenLabs accepts this SSE.** The framing is what "Integrate your own model" describes, but
   a platform wanting something slightly different shows up as a call that connects and says nothing.
2. **That an inbound turn can find its call.** An outbound call carries Reason's own ids in
   `custom_llm_extra_body` and gets them back as `elevenlabs_extra_body`; an inbound one has nothing of
   Reason's in it, so it is matched on ElevenLabs' own conversation id read from `conversation_id`,
   `conversationId`, `elevenlabs_conversation_id` or `user_id` — four names tried because their docs
   do not pin down which the custom-LLM request really carries. If inbound calls answer with "I can't
   pick this one up", this is why, and the fix is one field name.
3. **Which field says "voicemail".** `metadata.termination_reason`, `termination_reason`,
   `metadata.call_status` and `call_successful` are all matched for the word, because their docs name
   no single one. Erring is one-directional on purpose: a human call mistaken for voicemail loses a
   summary, while a voicemail mistaken for a conversation tells the owner their message was heard by a
   person. Worth confirming first on Friday.
4. **First-word latency.** Text streams at a sentence boundary — held back that far on purpose, since a
   web address split across two deltas cannot be found in either — so the first word costs one
   sentence of generation, not a whole reply. Whether that lands near the one second Omari is judging
   against is unmeasured. If it is bad, a smaller model for voice turns is the first thing to try.
5. **`conversation_config_override`'s exact shape.** `agent.first_message`, `agent.prompt.prompt`,
   `agent.prompt.tools`, `tts.voice_id` and `conversation.max_duration_seconds` are sent as their docs
   name them. A field they reject may be a whole override silently ignored, which for the stranger path
   means a stranger reaching a full Reason — so **the stranger path is the second thing to test on
   Friday**, by ringing from a number that is not on the list and checking it says one line and hangs
   up.
6. **That the model obeys the re-announcement.** Code guarantees the instruction is given exactly once
   per language change; whether the words come out is unverifiable from here. The Spanish test call is
   what proves it.
7. **Spoofed caller ID.** Caller ID is identity: a spoofed one reaches that person's Reason, with their
   memory and their tools. Written down as a known limit when the plan was made and still true. A
   spoken passphrase for anything that spends money is the obvious next step if it matters; nothing is
   built for it.
8. **Twilio's per-minute rate.** Their pricing page is script-rendered and was never read. The minute
   cap is counted in both directions, so the exposure is bounded, but the number it is bounded to is
   unknown until the console says.
9. **Reason's own tools on a real call.** They run on the API backend only; the subscription backend has
   no tool loop, so the rehearsal can say what it would do and cannot do it. "It did one real thing
   mid-call with my spoken yes" is untested end to end and is on Friday's list.
