# Reason

A general-purpose agent that lives in your texts. It plans things with you and your friends, runs errands in the chat, and talks like a person.

MIT licensed. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

## Run it

```bash
npm install
cp .env.example .env     # put your ANTHROPIC_API_KEY in it
npm run chat             # talk to Reason in the terminal; add --log to see tool calls
npm test                 # flow test against the real model (skipped without a key)
```

Console commands: `/skip 2h` moves Reason's clock forward and fires any timers that come due, `/plans`, `/timers`, `/ledger`, `/accounts`, `/reset`, `/log`.

Your data:

```bash
npm run data:export > reason-export.json   # everything, as JSON
npm run data:export -- dm:owner            # one conversation
npm run data:delete -- --yes               # wipe it; refuses without --yes
```

## Layout

```
src/agent.js     the brain: system prompt + tool loop (Claude via the Anthropic SDK)
src/tools.js     tool schemas, input validation, guards; the only way state changes
src/trust.js     the confirm gate, the action ledger, the connected-accounts registry
src/db.js        SQLite (node:sqlite): conversations, plans, timers, memories, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + timer loop → event turns
src/chat.js      terminal console
src/data.js      export / delete your data
test/            flow tests (assert DB state, never wording) + guard unit tests
docs/design.md   what Reason can do, what stays in code, milestones
docs/features.md the agreed feature list
```

## The trust model

- **Confirm before commit.** Anything that spends money or acts on a third party stops until the owner says go. The guard is in the tool, not in routing: the model cannot assert consent on their behalf, cannot grant a confirmation in the same turn it asked, cannot spend one yes twice or after it goes stale, and cannot carry a yes over to details the owner never saw.
- **The gate reads meaning, not words.** What a reply means is decided by a separate narrow model call that sees only the action as described and the owner's answer, verbatim — no history, no tools, a forced `yes`/`no`/`change`/`unclear` verdict. Word lists cannot do this job: "no problem, book it" is a go-ahead, and "ok but make it 9 instead" is not, though it reads as a yes to any substring match and would book the 8:00 that was just rejected. A reply that approves but moves any detail comes back `change`, which authorizes nothing and sends Reason back to ask again with the corrected summary. Anything the judge cannot read — an error, a timeout, an off-schema answer — is `unclear`, and `unclear` never grants. Code still owns every fact a model cannot be trusted with: that a real new message arrived after the ask, single use, expiry, one action per yes, and the owner's exact words on the record.
- **A receipt for everything.** Every action that touched the outside world writes an append-only ledger row: what was attempted, what came back, when, and which yes authorized it. "What did you do today?" is answered from that table.
- **Nothing is faked.** A provider with no credentials on this machine reports `not_connected` and names the exact variables that are missing. `/accounts` shows what Reason can reach; `account_revoke` cuts it off with no second confirmation.

## Status

Milestone 1 (DM only) in progress. Live: plans (create/change/lock/cancel/done), timers that fire real event turns, memory, capability manifest, the confirm gate, the action ledger, the connected-accounts registry, export/delete. Not connected yet: email, calendar, phone calls out, payments, venue search, messaging other people, any phone channel.
