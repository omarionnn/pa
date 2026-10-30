# To-do list (src/todo.js) — REASON_TODO off | owner | on

Somebody texts a photo of their to-do list, or types it. Reason answers with ONE plan in three groups
("i'll handle these" / "i need one thing from you" / "only you can do these"), naming every business it
would call and flagging money; waits for ONE yes to the whole plan; works the items through tasks,
calls, research and timers; keeps a checklist page that ticks itself off; and sends ONE wrap-up text
("2 of 3 done; joe's plumbing: a call back thursday, i'll chase it; gym is yours" + the link).

## How a person reaches it
Text the list (or a photo of it) to Reason. `owner` = the operator's conversation only (`accounts.is_operator`).
Off (the default): the four tools are hidden and refused before the gate, the grant covers nothing,
no page is drawn, the sweep sends nothing.

## What is enforced in code
- **The plan text is code's** (`planText`): the model's reading (`todo_plan` items, groups, `money`,
  `businesses`) is stored, and the message is composed from the rows, so no business or money flag
  can be left out of what they approve.
- **The yes is a normal confirm-gate yes**: `todo_approve` is in `ALWAYS_NEEDS_CONFIRMATION`, its target
  is `to-do list #<id> [<plan fingerprint>]` read off the row (`approvalTarget`). A plan revised after
  the ask → `wrong_target`. `todo_approve` is in `NEVER_STANDING`.
- **The grant** (`grantCovering`, consulted in `runToolInner` after standing permissions, and by
  `confirm_request` for `call_place`): covers `call_place` only, only to a number in the list's
  `grant_json` (copied at approval: businesses on non-"theirs" items, minus anyone the lookups say
  they know), not once the item is dropped, not after `GRANT_TTL_MS` (14 days), not for a closed list.
  Never: a number in `important_people`, `accounts`, or a `people`/`person_facts` row
  (`db.knownPersonByNumber`, re-checked at call time); a call with `max_price_cents`/`approved_terms`;
  `may_book` on an item flagged money. A miss adds `todo_list_does_not_cover` to the usual refusal.
  A number found AFTER the yes joins the grant only for a business the plan named, and only if it is
  in this turn's tool sources (`offers.turnState`) — never typed from memory.
- **The checklist** is an ordinary page row (same `/p/<id>?k=` link and code gate as every page),
  redrawn by `db.taskBus` (`updateTask`, `finishTask`, `logTask(kind 'call')`) for any task linked to an item.
- **The wrap-up** (`wrapUps`, in `Runtime.sweep` as `todo_wraps`): approved, every non-"theirs" item
  done/waiting/failed/stuck/dropped, nothing changed for `WRAP_QUIET_MS` (2 min), not their night, not
  paused; claimed with `wrapped_at` before `say` (idempotencyKey `todo-wrap:<id>`). Once only.
- **Linking**: on the result of task/timer/call/research/mail tools, `todo_list.not_started` names the
  approved list's items nothing is working yet (`nudge`). Added after the first real-model drive
  (2026-10-30), where the approval turn started the work and linked nothing.

## Offline
`node --test test/todo.test.js` (18): plan text, gate + fingerprint, grant yes/no (named business, known
person by facts and by people list, money, unnamed business, number found later, other conversation),
checklist redraw on task change and on a call outcome, wrap-up once (and its quiet window, their night,
via `Runtime.sweep`), nudge, flag off, owner mode.

## Live (real model, claude-cli)
1. **Cage, plan step** — `REASON_TODO=owner REASON_VERIFY_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234
   REASON_MASTER_NUMBER=+12025551234 bin/caged.sh start`, then `bin/inbound.sh text "<a list>"` →
   `{"tool":"todo_plan"}`, `{"tool":"confirm_request"}`; `bin/peek.sh thread` shows the plan;
   `bin/peek.sh confirms` a `todo_approve` row with the fingerprint target. The cage's call provider
   is the fake switched OFF (`src/calls/choose.js`), so the call step is drive 2.
2. **Whole road** — `bin/todo-drive.mjs` (real HTTP webhook, real Router/Runtime/Sendblue adapter with
   fetch injected, fake call provider ON, claude-cli turns; 2–4 turns):
   ```bash
   eval "$(bin/caged.sh env | sed 's/^/export /')" && REASON_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234 \
     REASON_MASTER_NUMBER=+12025551234 REASON_DB_PATH=$(mktemp -d)/todo.db node bin/todo-drive.mjs "$OUT"
   ```
   Ends `all ok`; `$OUT` holds the texts, the checklist HTML at each stage and the rows.
