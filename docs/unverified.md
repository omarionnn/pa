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
  *during the turn* loses that turn (deliberate, the same bargain `claimInbound` and
  `markTimerFired` make — losing it beats answering twice). Nothing recovers it.
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
- **Whether the model uses any of them well is untested.** A tapback instead of a filler "ok", an
  effect only for a real moment, never both at once, never offering a voice note — all four are
  prompt rules, asserted to be present and never exercised against a live model. One live test each
  when there is credit.

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
- "exactly two permissions", "cannot delete your mail permanently", "Attachments are never
  downloaded", "No access token or refresh token ever leaves the machine" — `SCOPE_LIST` in
  `src/google.js`, the absence of any delete tool, `bodyOf()` listing parts without fetching them,
  and `SECRET_COLUMNS` in `src/data.js`. Each has its own test.
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
  model wrote them in; each link keeps its own words and never another link's.
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
