# PA

A general-purpose agent that lives in your texts. It plans things with you and your friends, runs errands in the chat, and talks like a person.

Private. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

## Run it

```bash
npm install
cp .env.example .env     # put your ANTHROPIC_API_KEY in it
npm run chat             # talk to PA in the terminal; add --log to see tool calls
npm test                 # flow test against the real model (skipped without a key)
```

Console commands: `/skip 2h` moves PA's clock forward and fires any timers that come due, `/plans`, `/timers`, `/reset`, `/log`.

## Layout

```
src/agent.js     the brain: system prompt + tool loop (Claude via the Anthropic SDK)
src/tools.js     tool schemas, input validation, guards; the only way state changes
src/db.js        SQLite (node:sqlite): conversations, plans, timers, memories
src/runtime.js   per-conversation turn queue + timer loop → event turns
src/chat.js      terminal console
test/            flow test (asserts DB state, never wording) + date guard unit test
docs/design.md   what PA can do, what stays in code, milestones
```

## Status

Milestone 1 (DM only) in progress. Live: plans (create/change/lock/cancel/done), timers that fire real event turns, memory, capability manifest. Not connected yet: venue search, payments, messaging other people, any phone channel.
