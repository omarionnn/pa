# The confirm gate — money, and acting on somebody else

Before Reason spends money or does something to another person, it says exactly what it is about to
do and waits. The owner's own sentence is what authorises it, the gate reads that sentence itself,
and a receipt is kept. This is the feature the whole trust story rests on: *"Reason confirms before
it spends or sends on someone's behalf, keeps a receipt for every action, and lets you revoke a
connected account in one tap."*

Source: `src/trust.js` (the guard, the caps, `amountsIn`), `src/tools.js` (`confirm_request`,
`confirm_record`, `confirm_pending`, `permission_grant`), `src/receipts.js`, `src/db.js`
(`confirmations`, `action_ledger`, `permissions`).
Tests: `test/trust.test.js` (the gate offline, no model), `test/trustline.test.js`,
`test/permission-readback.test.js`,
`test/trustline-loop.test.js`, `test/receipts.test.js`, `test/undo-window.test.js`,
`test/flow-gate.test.js` and `test/flow-trust.test.js` (real model reading real sentences).

## Sub-features

- **The ask is checked in code before it reaches the owner.** `action` must be a tool the gate
  really stops — asking somebody to approve something that needs no approval is how they learn to
  say yes without reading, so it is refused. Anything reaching a person or committing on a site must
  carry `target`. If `stakes` says money, `amount` is required.
- **Four states, and only one of them is go.** `confirm_record` reads the owner's actual last
  message: `granted`, `refused`, `waiting_for_yes`, or `changed` — they want it but with a detail
  different from what was recorded, so **nothing is authorised**: fix the details, ask again.
  (A fifth, `spent`, comes back when the yes was already used — the `consumed_at` check at the top of
  `recordConfirmation` in `src/trust.js`. It is a refusal, not a go.)
- **The model cannot grant it for them.** It calls `confirm_record`; the guard decides.
- **Only the owner's own line is a reply; an event turn never is.** `ownerTexts` (`src/trust.js`)
  tells them apart by the line's opening: `[event …]` is a timer/sweep, `[<stamp>] <Name>:` is them.
  So `userMessageFor` (`src/agent.js`) always puts that prefix first and a `[delivery failure]`
  notice on its own lines right after (lead 29, 2026-11-07). Before, the API path put the notice in
  front, so a timer turn that also reported a failed text counted as a new owner message and the
  notice/timer text went to the judge as their yes (and on owner turns the failed body read as their
  words). Pinned in `test/trust-event-notice.test.js` (4; 3 fail on the old code). Drive, no model,
  cage env: enqueue a `toOwner` outbox row, `markOutboundFailed(row.id, …)`, claim it with
  `undeliveredFor` + `markUndeliveredTold`, build the turn with `userMessageFor({ notice:
  undeliveredNotice(rows), prefix: "[event …]", text })`, push `forModel`, `confirm_record` with
  `ctx.judge` stubbed yes. End state: `waiting_for_yes`, `granted_at` null; the same with an owner
  prefix and "yes send it" → `granted`, `quote` first line `yes send it`. On the old code the event
  turn came back `granted`.
- **The guard reads the reply with a model of its own.** `recordConfirmation` calls `judgeReply`
  (`src/judge.js`) — the `claude-cli` backend or the Anthropic API. A flat no is honoured in code
  before the judge is ever asked (`isBareRefusal`, defined near the top of `src/trust.js` and
  called in `recordConfirmation` before `judge(...)`), so a dead judge cannot turn a no into a
  yes, and when the judge errors or cannot read the reply the state is **`waiting_for_yes`**,
  never `granted` (the `verdict !== "yes"` branch of `recordConfirmation`). Fail-closed is the design: a
  `waiting_for_yes` after a judge error is the gate working.
- **It reads meaning, not keywords.** `"no problem, book it"` is a yes. `"don't wait, do it now"` is
  a yes. `"ok but make it 9 instead"` contains "ok" and is **not** a yes — a word list booked the
  8:00 he had just rejected, which is the exact failure this exists to prevent.
- **Their words go on the record.** `granted_quote` is the owner's sentence verbatim.
- **"owner" is the person in this conversation, never the operator's phone.** `addressedToOwner`
  treats `owner`/`me`/`self`/`myself`/`user` as this conversation's person, and `ownAddress` in
  `src/tools.js` is the only place that turns it into a number: the operator's thread reads config
  first (as before), anybody else's reads their account then their thread, and with neither nothing
  is sent. Covers `message_send`, `voice_note_send`, `send_picture` and every document handover;
  `call_place` already used `me.address`. Before 10-28 all four read `config.ownerNumbers[0]` first,
  so testers' "on it" texts and Yaw's flight link went to Omari (outbox 443, 1850, 1901). Drive:
  `node --test test/owner-means-this-thread.test.js`, then the claude-cli lane
  `test/flow-owner-thread.test.js`. The cage cannot prove a send (blanked channels), so the fake
  channel's `sent[].to` is the proof.
- **A yes is pinned.** `target` is checked, so a yes for one phone number cannot be spent on
  another, and a yes for an 8:00 booking cannot be carried to a 9:00 one.
- **A yes is spent once.** `consumed_at`.
- **Open asks are findable.** `confirm_pending`, so Reason records against the id it already has
  instead of asking twice and landing their yes on nothing.
- **Standing permissions.** `permission_grant` saves "you can reorder groceries without asking" with
  the owner's sentence verbatim and a narrow `scope` the gate actually checks. Money needs
  `max_amount`; a permission with no amount cannot authorise a charge. Since #349 the sentence has to
  be found in one of the owner's own recent typed messages (code, not the model's `said`) and a judge
  must read it as meaning the grant, else `blocked: "not_their_words"` / `"not_what_they_said"`;
  `caps_set` needs both numbers in one message of theirs (`not_their_words`). An unverified caller's
  speech on a call is never the owner's text (`src/trust.js`, `src/calls/postcall.js`).
- **Saving a standing permission is itself asked about (#356, 2026-11-07).** `permission_grant` is in
  `CONDITIONALLY_GATED`, and its handler asks the gate *last*, after every refusal of its own (not
  their words, never standing, no amount). The first call saves nothing: it answers
  `blocked: "needs_confirmation"` with `use_target`, built by `permissionYesTarget` from the scope,
  e.g. `standing permission: texts for +14155559876 (Kofi)` (action, who it is on record as, amount,
  end date, caps). Reason reads that back as one plain question naming the person, never the number,
  then `confirm_request` with `action: "permission_grant"` and `target` = `use_target` exactly (a
  target is required for this action), `confirm_record` on their reply, and `permission_grant` again
  with the same text/scope/caps plus `confirmation_id`. Only then is the row saved, and the yes is
  spent: a second save on it is `already_spent`; a different person or "anyone" on it is
  `wrong_target`; a no saves nothing. Undo class `easy` (`permission_revoke`). Other tests grant
  through `test/fixture-grant.js` (`grantWithYes`).
- **Caps.** Per-purchase and monthly (`checkCaps` in `src/trust.js`), with what is already
  committed summed from the `spend` table (`db.spentThisMonth`) so a restart does not reset them.
  With no caps set at all, anything that would spend answers `blocked: "needs_caps"` and asks once
  for both numbers (saved with `caps_set`) before doing anything that costs money.
- **A receipt for everything.** A row in `action_ledger` with the outcome, linked to its
  `confirmation_id`. **Receipts and the confirm flow never name the operator** (PR #335, 11-07):
  `receiptFor` (`src/trust.js:985`) and the `requestConfirmation` / `recordConfirmation` /
  `authorizeConfirmation` / `retryBlocked` lines say "them"/"they" — "Sent them the recording of
  call #73", "Told them, unprompted: …", "they already have a Visa stored with AgentCard", access
  grants "In their words: …" (`src/trust.js:156,245,293,948,1188,1260,1264,1302`). Before, every
  line read `config.ownerName`, so "Sent Omari the recording of call #73" landed in another person's
  own ledger. Pinned in `test/receipts-no-owner-name-1107.test.js` (3); driven by
  `bin/recall-figures-drive.mjs` step "receipts never name the operator" (command in
  [recall.md](recall.md)).

## How to get to it (user POV)

Ask for something that costs money or touches another person — "book me a table at Carbone", "text
Kofi that I'm running late", "order the usual". Reason replies with what it is about to do, the
amount, and how hard it is to undo, and waits. Reply in your own words.

## Driving it with the harness

The caps, the pinning and the receipts are code and are tested with no model and no key. **Start
here:**

```bash
cd ~/Desktop/pa
node --test test/trust.test.js test/trustline.test.js test/receipts.test.js
```

Two calls drive the whole gate by hand. Two things have to be right or you are reading a refusal
instead of a verdict:

- **The conversation has to belong to somebody.** `confirm_request` refuses outright with
  `{ ok: false, blocked: "no_account" }` on any conversation with no account row
  (the `no_account` guard at the top of `runTool` in `src/tools.js` — re-grep `blocked: "no_account"`).
  Use `dm:owner` — it is `config.ownerConversation`, which the guard exempts
  — or call `db.upsertAccount({ conversationId, channel: "sendblue", address, name, isOperator: true })`
  first for a throwaway id. A made-up `dm:whatever` never reaches the gate at all.
- **`ctx.messages` matters more than anywhere else in Reason.** The guard reads the owner's **last
  message out of it**, so the reply you are testing has to be the final entry.

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"

node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const db = await import("./src/db.js");
  const owner = (t) => ({ role: "user", content: `[Sat, Oct 10, 2026, 3:00 PM] Omari: ${t}` });

  for (const reply of ["perfect, lock it in", "nah leave it", "ok but make it 9 instead"]) {
    const conversationId = "dm:owner";            // the owner conversation: no account row needed
    const messages = [owner("book me a table at carbone")];
    const ctx = { conversationId, messages };     // add judge: async () => ({ verdict: "yes" }) to pin it
    const req = await runTool("confirm_request", {
      action: "browser_submit", stakes: "both", amount: 100,
      target: "Carbone, Fri Oct 9 2026 8:00 PM, party of 4",
      summary: "Book Carbone, party of 4, Fri Oct 9 2026 at 8:00 PM, under Omari. $25 per person cancellation hold.",
    }, ctx);
    if (!req.ok) { console.log("REQUEST REFUSED:", JSON.stringify(req)); continue; }
    messages.push(owner(reply));
    const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, ctx);
    const row = db.getConfirmation(conversationId, req.confirmation_id);
    console.log(JSON.stringify({ reply, state: rec.state, granted_at: row.granted_at,
      refused_at: row.refused_at, granted_quote: row.granted_quote }));
  }
'

cd ~/Desktop/pa/.agents/skills/verify-reason
bin/peek.sh confirms
bin/peek.sh ledger
bin/caged.sh stop
```

That drive is the **real** judge, so it needs a model backend and the three replies cost three judge
calls. `ctx.judge` is the seam production ships for stating what a reply means
(`case "confirm_record"` in `src/tools.js` passes it straight through to `recordConfirmation` —
re-grep `judge: ctx.judge`), and it is the right tool
when you are testing the *guard* rather than the reading:

```js
const ctx = { conversationId, messages, judge: async () => ({ verdict: "change" }) };
```

The `!req.ok` guard in the loop is not decoration: without it a `no_account` refusal carries no
`confirmation_id`, and the next line dies inside `db.getConfirmation` with
`Provided value cannot be bound to SQLite parameter 1` — which reads like a database fault and is
not one.

**End state that proves it.** `"perfect, lock it in"` → `granted`, `granted_at` set,
`granted_quote` is that exact sentence, `refused_at` null. `"nah leave it"` → `refused`,
`refused_at` set, `granted_at` null. `"ok but make it 9 instead"` → `changed`, **both**
`granted_at` and `refused_at` null — the 8:00 he just rejected is not authorised, and he did not
say no either. Every state visible in `bin/peek.sh confirms`, not just in the tool result.

**Saving a standing permission, no model.** Same cage env, `dm:owner`. `ctx.judge` here reads both
their original sentence (inside `permission_grant`) and their yes, so one stub answering `yes` covers
both:

```bash
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const db = await import("./src/db.js");
  const C = "dm:owner", KOFI = "+14155559876";
  db.addImportantPerson(C, { who: "Kofi", contact: KOFI });
  const owner = (t) => ({ role: "user", content: `[Sat, Nov 7, 2026, 3:00 PM] Omari: ${t}` });
  const messages = [owner("you can text kofi without asking me")];
  const ctx = { conversationId: C, messages, judge: async () => ({ verdict: "yes" }) };
  const G = { text: "you can text kofi without asking me", scope: { action: "texts", target: KOFI } };
  const first = await runTool("permission_grant", G, ctx);          // blocked: needs_confirmation, nothing saved
  const req = await runTool("confirm_request", { action: "permission_grant", stakes: "both",
    summary: "save that: I can text Kofi without asking?", target: first.use_target }, ctx);
  messages.push(owner("yes, save that"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, ctx);
  const out = await runTool("permission_grant", { ...G, confirmation_id: req.confirmation_id }, ctx);
  const again = await runTool("permission_grant", { ...G, confirmation_id: req.confirmation_id }, ctx);
  console.log(first.blocked, first.use_target, rec.state, out.ok, db.listPermissions(C).length, again.blocked);
  process.exit(0);
'
```

**End state (2026-11-07, cage on #356 `3a72671`):** `needs_confirmation`,
`standing permission: texts for +14155559876 (Kofi)`, 0 rows; `granted`; `true`, 1 row with `said`
verbatim, `action: texts`, `target: +14155559876`; reuse `already_spent`, still 1 row.
`bin/peek.sh confirms` shows the `permission_grant` row with `granted_quote` and `consumed_at` set.

A real-sentence pass with the real model, which is what `flow-gate` is for:

```bash
cd ~/Desktop/pa && node --test test/flow-gate.test.js      # skips without a model
```

## Asks run out (2026-10-30)

An ask is closed as a no (`expired_at`), never a yes, once it is older than its window: 12h for calls,
texts, voice notes and DMs to someone else (`REASON_ASK_TTL_REACH_H`), 24h for money
(`REASON_ASK_TTL_MONEY_H`) and everything else (`REASON_ASK_TTL_DEFAULT_H`). A granted yes unused past
`REASON_CONFIRM_WINDOW_MIN` is closed the same way. Closed lazily on every pending read
(`db.expireStaleAsks`); `confirm_record` on one returns `state: "expired"` and grants nothing, and the
gate answers `blocked: "expired"`. The next turn they start shows each one to the model once
(`trust.expiredAsksNote`, stamps `expiry_told_at`); nothing is ever sent because of expiry.

Drive: `node --import ./test/paid-key-guard.js --test test/stale-asks.test.js` (9). Deploy sweep, from
the repo on the server: `node --env-file-if-exists=.env scripts/expire-stale-asks.js --dry-run`, then
without `--dry-run`. It logs one JSON line per closed ask (id, action, summary, age_h) and a count;
asks older than 7 days close quietly (expiry_told_at set). Proof: `peek.sh confirms` shows
`expired_at` on every row past its window and no `granted_at` written by it.

## Gotchas

- **A test that grants then waits more than the window now sees `expired`, not `granted`.** That is
  the fix: an old yes is dead. Use `clock.skip` inside the window when a test needs a live yes.
- **A wrong `ctx` fails like a product bug.** No `messages`, or the reply not last, and the guard
  reads the wrong sentence. Shape content as `"[<stamp>] <OwnerName>: <text>"`. A `conversationId`
  with no account behind it is the same trap one step earlier: the answer is `blocked: "no_account"`,
  which is the guard working and says nothing about the gate.
- **There is no `amount` column on `confirmations`.** The figure is read back out of `summary`
  (`amountsIn` in `src/trust.js`), so the summary *is* the number of record — a summary that does
  not name the amount counts as no amount and the cap cannot see it. Assert on `summary`.
- **The caps live in `spend`, not `usage`.** `usage` counts turns and calls. The caps are checked
  where money is actually committed (`purchase_confirm` and the other spending paths call
  `trust.checkCaps`), not at `confirm_request`, so the drive above never sees them; a spending drive
  on a fresh cage hits `needs_caps` first, which is the gate asking for limits, not a broken gate.
- **`changed` is the state to care about.** Agents and word lists both get this wrong, and getting
  it wrong means booking the thing the owner just rejected. Any change to the gate must re-drive
  `"ok but make it 9 instead"`.
- `action` must name a tool the gate actually stops, or `confirm_request` refuses the ask itself —
  a refusal at step 1 is the gate working, not a bug.
- Granting and spending are separate. `granted_at` plus a `consumed_at` that never arrives means the
  action was authorised and then never happened; that is a real failure and it is silent.
- `test/flow-gate.test.js` runs a real model against a real fixture site and is **non-deterministic
  in wording**. It asserts on the `confirmations` table and the fixture's booking list. Do the same.
- Never drive the gate against the live instance: a `granted` row there can let a real tool spend
  real money.
