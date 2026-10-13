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
  (A fifth, `spent`, comes back when the yes was already used — `src/trust.js:107`. It is a refusal,
  not a go.)
- **The model cannot grant it for them.** It calls `confirm_record`; the guard decides.
- **The guard reads the reply with a model of its own.** `recordConfirmation` calls `judgeReply`
  (`src/judge.js:55`) — the `claude-cli` backend or the Anthropic API. A flat no is honoured in code
  before the judge is ever asked (`isBareRefusal`, `src/trust.js:121`), so a dead judge cannot turn
  a no into a yes, and when the judge errors or cannot read the reply the state is
  **`waiting_for_yes`**, never `granted` (`src/trust.js:142`). Fail-closed is the design: a
  `waiting_for_yes` after a judge error is the gate working.
- **It reads meaning, not keywords.** `"no problem, book it"` is a yes. `"don't wait, do it now"` is
  a yes. `"ok but make it 9 instead"` contains "ok" and is **not** a yes — a word list booked the
  8:00 he had just rejected, which is the exact failure this exists to prevent.
- **Their words go on the record.** `granted_quote` is the owner's sentence verbatim.
- **A yes is pinned.** `target` is checked, so a yes for one phone number cannot be spent on
  another, and a yes for an 8:00 booking cannot be carried to a 9:00 one.
- **A yes is spent once.** `consumed_at`.
- **Open asks are findable.** `confirm_pending`, so Reason records against the id it already has
  instead of asking twice and landing their yes on nothing.
- **Standing permissions.** `permission_grant` saves "you can reorder groceries without asking" with
  the owner's sentence verbatim and a narrow `scope` the gate actually checks. Money needs
  `max_amount`; a permission with no amount cannot authorise a charge.
- **Caps.** Per-purchase and monthly, counted in the `usage` table so a restart does not reset them.
- **A receipt for everything.** A row in `action_ledger` with the outcome, linked to its
  `confirmation_id`.

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
  (`src/tools.js:6844`). Use `dm:owner` — it is `config.ownerConversation`, which the guard exempts
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
(`src/tools.js:9103` passes it straight through to `recordConfirmation`), and it is the right tool
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

A real-sentence pass with the real model, which is what `flow-gate` is for:

```bash
cd ~/Desktop/pa && node --test test/flow-gate.test.js      # skips without a model
```

## Gotchas

- **A wrong `ctx` fails like a product bug.** No `messages`, or the reply not last, and the guard
  reads the wrong sentence. Shape content as `"[<stamp>] <OwnerName>: <text>"`. A `conversationId`
  with no account behind it is the same trap one step earlier: the answer is `blocked: "no_account"`,
  which is the guard working and says nothing about the gate.
- **There is no `amount` column on `confirmations`.** The figure is read back out of `summary`
  (`amountsIn` in `src/trust.js`), so the summary *is* the number of record — a summary that does
  not name the amount counts as no amount and the cap cannot see it. Assert on `summary`.
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
