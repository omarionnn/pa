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
