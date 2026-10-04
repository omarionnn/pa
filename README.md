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
npm run serve            # Reason as a process that stays up (see below)
npm run test:offline     # the whole deterministic suite; needs no key and must be green
npm test                 # adds the live tests against the real model
```

Console commands: `/skip 2h` moves Reason's clock forward and fires anything that comes due, `/plans`, `/timers`, `/tasks`, `/ledger`, `/accounts`, `/reset`, `/log`.

### Working between messages

`npm run chat` only thinks while you are typing. `npm run serve` is Reason as a process that stays
up:

- it sweeps on an interval — timers that fire, **tasks** it is working on, watchers re-checking a
  page, plans that went quiet with questions still open;
- it listens on `http://127.0.0.1:8787` for inbound channel webhooks (`POST
  /channels/<name>/webhook`) and answers `GET /health` with what is really running;
- it starts cleanly with no credentials at all, and says what is missing rather than pretending.

A **task** is work that outlives a message: chasing a handyman, waiting on a reply, anything
multi-step. It is a row in SQLite with a goal, a next wake time and a short progress log, so
killing the process loses nothing — the next one picks it up. Reason speaks about a task only when
something actually changed; a step that moved nothing is held back by code, whatever the model
wrote. A step that keeps crashing is retried a bounded number of times and then reported honestly.
Ask "what are you working on" and the answer is read off that table.

### Texting

Reason reaches people through a **channel**. The console is one; **Linq** (iMessage / RCS / SMS) is
the real one. Put `LINQ_API_KEY` and `LINQ_WEBHOOK_SECRET` in `.env`, point a Linq webhook
subscription at `https://your-host/channels/linq/webhook`, and set `REASON_OWNER_NUMBER` to your
own number in E.164.

`REASON_OWNER_NUMBER` is the whole security boundary and it is worth being exact about. A number
that is not on that list gets its own conversation and **cannot** open the confirm gate, connect an
account, submit anything, text anyone or place a call — refused in code before the tool runs, so
there is not even a confirmation row for a stranger's "yeah go ahead" to land on. Leave it empty
and every inbound text is a stranger's, which is the safe default but means Reason can do nothing
for you over text.

Nothing in the Linq adapter has ever run against the real API. It is written from Linq's public
Partner API v3 docs and its signature verification follows the Standard Webhooks spec they
document. Until a real key sends a real text, treat it as unproven — see `docs/unverified.md`.

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
src/db.js        SQLite (node:sqlite): conversations, plans, timers, tasks, people, calls,
                 threads, watches, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + the sweep: timers, tasks, watchers, dropped threads
src/serve.js     the long-running process; src/http.js is its listener
src/channels/    Channel interface + console, fake and Linq adapters, and the router that
                 decides whose conversation an inbound message belongs to
src/calls/       CallProvider interface + a fake. No paid provider is wired up.
src/backends/    the owner's local claude-cli backend and the MCP server behind it
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

## Testing on a Claude subscription (owner only, local)

The live tests prove the model reads real messages correctly, so they need a real model, so they
cost API credit. With none, they can be run through the `claude` CLI against a Claude subscription
instead:

```bash
REASON_BACKEND=claude-cli npm test
```

**This is for the owner's own machine and nothing else.** It is not how Reason is deployed, it is
not supported for other installs, and the API backend in `src/agent.js` is untouched and remains
the default. Nothing here reads the CLI unless `REASON_BACKEND` says so.

That is not left to anyone's good intentions. **`npm run serve` refuses to start** when
`REASON_BACKEND=claude-cli` and a channel other people could text is set up:

```
$ LINQ_API_KEY=... REASON_BACKEND=claude-cli npm run serve
Refusing to start: REASON_BACKEND=claude-cli with linq set up.
…
Before anyone but Omari can text this, an Anthropic API key with credit has to be in place:
set ANTHROPIC_API_KEY and either drop REASON_BACKEND or set REASON_BACKEND=api.
```

A personal Claude subscription is not a service: no per-install billing, no rate limit anyone else
is entitled to, no prompt cache. So an API key with credit is the price of letting anybody but the
owner text Reason, and the check is in code (`src/backends/guard.js`), before a port is bound or
the database is opened. The console and the fake channel are explicitly fine — they only ever
reach the owner — and the rule is an allowlist, so a channel adapter added later blocks by default
rather than needing somebody to remember it. A half-configured channel counts as configured. `npm
run chat` and `REASON_BACKEND=claude-cli npm test` are unaffected.

How it works: `src/backends/claude-cli.js` runs one turn as `claude -p` in headless mode and points
it at Reason's own tools, served over a loopback port by the Reason process itself
(`src/backends/mcp-http.js`, MCP streamable HTTP). The server is started for the turn and closed
after it, bound to 127.0.0.1 on a port the OS picks. Claude Code's own tools (Bash, Read, WebFetch
and the rest) are denied, so a turn cannot succeed by going around Reason. The confirm gate's judge
and the watcher's page check take the same route.

The point of serving the tools in-process rather than as a CLI-spawned subprocess is that the
tools are then *the same code in the same process*: one SQLite writer, one Chromium that stays open
across turns, and every tool call landing in the same log the API backend writes. The gate, the
owner check and the ledger are exercised, not simulated.

What it does not give you, honestly:

- **No prompt cache.** Each turn is a fresh process, so the system prompt is re-sent every time.
  Slower and more subscription tokens than the API path.
- **The CLI owns the tool loop.** `REASON_MAX_TOOL_ROUNDS` does nothing here; `REASON_CLI_MAX_TURNS`
  (default 30) is the CLI's own budget, and the loop's stopping rule is the CLI's, not Reason's.
- **History is text only.** The API path keeps the model's own tool calls and results in the
  message list; a fresh CLI process cannot. Open confirmations are spelled out in the prompt to
  restore that, but the model does not see what its earlier tool calls returned.
- **Tool names arrive prefixed.** Over MCP the model sees `mcp__reason__browser_submit` and will
  sometimes write that into `confirm_request`. The gate normalises the prefix away (`toolName()` in
  `src/trust.js`) so a yes still matches the tool it was for.

Knobs: `REASON_CLI_MODEL` (default `opus`, to match the API path — the gate tests pass on opus and
not reliably on sonnet), `REASON_CLI_MAX_TURNS`, `REASON_CLI_TIMEOUT_MS`, `REASON_CLI_BIN`, and
`REASON_CLI_DEBUG=<file>` to append every CLI result envelope for debugging.

## Status

Milestone 1 (DM only) in progress.

Live: plans (create/change/lock/cancel/done); timers that fire real event turns; durable tasks
that survive a restart; watchers; dropped-thread follow-up; memory about people; a real browser
with the commit click gated; the confirm gate; the action ledger; the connected-accounts registry;
`npm run serve` with its webhook listener; export/delete.

Built but unproven against the real thing: the **Linq** channel — docs-faithful, offline-tested,
never once run against Linq's API.

Not connected: email, calendar, payments, venue search, and phone calls (the interface and a fake
provider exist; no paid telephony account is wired up, and `capabilities` says so).
