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
