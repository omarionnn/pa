# Reason

A general-purpose agent that lives in your texts. It plans things with you and your friends, runs errands in the chat, and talks like a person.

MIT licensed. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

## Run it

```bash
npm install
cp .env.example .env     # ANTHROPIC_API_KEY; REASON_PUBLIC_URL if pages should open off-machine
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

### Phone calls, and the recording

Reason does not dial. It hands a provider a goal — "ask if they have a table for 4 at 8 on
Saturday, and if not the nearest time" — plus the short list of facts that call is allowed to
share, and gets back something quotable: what happened, what was said, how long, what it cost, and
**the recording**. Calling anyone but you goes through the confirm gate first, with the exact
number and the exact goal shown to you before you say yes.

Every call is recorded and announces itself, and Reason never pays by phone — those are rules
rather than settings, and **The rules it keeps** below says where each one is enforced. The
mechanics:

**The audio arrives with the summary, in one message.** When a call ends, its recording is copied
into `data/recordings/` as a file Reason owns, and the next message Reason sends you carries both
the summary and the audio as a single message — attached by code reading the calls table, not by
the model remembering. So it cannot be forgotten, cannot be sent twice, and cannot be claimed when
it does not exist. Audio that fails to send stays queued rather than being marked delivered.

**A missing recording is a fault, and it is treated as one.** If a call was answered and the audio
is not there, the call row is marked `missing` with the reason, an **error** row goes on the action
ledger (`RECORDING MISSING for call #N`), and Reason is told to say plainly that the recording is
missing rather than quietly leaving it out. "Every call is recorded" is a promise, and a promise
that breaks silently is worse than one never made. A call nobody picked up is a different thing —
there was nothing to record — so it is marked `not_applicable` and raises no alarm, which is what
keeps the real fault visible.

A phone call is the worst possible place for a card number — it is recorded, the provider may
transcribe it, and the person on the other end is unverified — so the payment rule is enforced on
the request itself and again inside the call. Details below.

No telephony account is wired up. The only provider that runs is a fake one that dials nothing and
hands back a 4.8 KB test WAV, which is what the offline tests assert against.
**`docs/call-providers.md`** compares the real options on the three things that differ — does it
record, how you fetch the recording, what it costs — and recommends one.

### Pages

Some answers are not texts. A gift shortlist with pictures and prices, three days in Lisbon, a
plan with sections — sending that as a wall of messages is worse than useless on a phone. So Reason
can make a **page**: a small web page you open from a link, keep, and come back to.

- **It gives data, not markup.** The model picks from a fixed set of blocks — a heading, text, a
  picture, a comparison table, links, a row of cards, a question with options — and Reason's own
  template draws the HTML. There is no block that takes HTML or a script, every string is escaped
  on the way out, and content that is not one of those blocks is refused rather than rendered.
- **A picture has to be real.** An image can only go on a page if its address came back from a
  tool in that conversation — a page Reason actually read. It cannot type one from memory, because
  it would produce plausible dead ones. `web_lookup` now returns the real image addresses on a page
  it reads, which is where they come from.
- **The link does not change.** `page_update` edits the same page at the same link, so a link
  already sent still works. Reason is told to prefer that over making a second page.
- **Private by default.** The link alone does not open it. The first time on a new browser you are
  asked for a six-character code, which Reason gives you over your own channel; after that the
  browser stays signed in. Wrong codes are rate limited — five in fifteen minutes and that page
  locks, counted in the database so a restart does not reset it. A page that does not exist and a
  page you may not see answer identically, so the link space cannot be probed.
- **Shareable only when you ask.** Then anyone with the link can read it. Unsharing takes effect on
  the very next request. On a shared page the questions are read-only, so nobody can answer for you.
- **You can tap an answer**, and it comes back to Reason as an event turn — exactly once, claimed
  before the turn runs, still waiting in the table if the process was down when you tapped.

Set `REASON_PUBLIC_URL` to the address the listener is reachable at. Without it pages still work,
but only on this machine — and `capabilities` and `page_list` both say so rather than handing you a
link that will not open on your phone.

### Your data

```bash
npm run data:export > reason-export.json   # everything: pages, call recordings (base64), the lot
npm run data:export -- dm:owner            # one conversation
npm run data:export -- --no-audio          # the rows, without the recordings' bytes
npm run data:delete -- --yes               # wipe it, recordings deleted off disk too
```

A delete removes the audio files, not just the rows. An export carries the bytes inside it with
each recording's sha256, and says `missing: true` for any file the database claims to have but
cannot find.

## Where this actually is

Three honest buckets. Nothing is in the first one unless a test passes on it.

### Working today

All of this is covered by the offline suite — **264 tests, 239 passing, 0 failing, 25 skipped**.
The 25 skipped need a real model; they all pass through the `claude-cli` backend (see below), and
have not been run against the API for want of credit.

- **Plans.** Make one, change any detail, lock it, cancel it, mark it done. It tracks what is still
  open and will not lock while something is.
- **Reminders and timers** that fire real turns at real times.
- **Tasks that outlive a message.** Chasing someone, waiting on a reply, a multi-step errand. A row
  in the database with a goal, a next wake time and a progress log, so killing the process loses
  nothing. Reason only speaks about one when something actually changed.
- **Watchers.** Watch a page, come back when a specific thing changes on it.
- **Follow-ups.** When a plan with open questions goes quiet for hours, Reason picks it back up on
  its own — at most once per plan per day, twice per conversation.
- **Memory about people.** Facts, preferences, who someone is; read it all back, or forget a person
  outright.
- **A real browser** it drives itself: open a page, read it, click, fill a form, screenshot. One
  profile per conversation so logins stick between turns. The final commit click always needs your
  explicit yes.
- **Reading one web page** and answering from what it actually says.
- **The confirm gate**, the **action ledger** ("what did you do today" is read off a table, never
  from memory), and the **connected-accounts registry**.
- **`npm run serve`** — the long-running process with its sweep and webhook listener.
- **Export and delete**, call recordings and pages included.
- **Pages** — made, updated at the same link, private behind a one-time code, shareable on request,
  with a tapped answer coming back as one event turn. Against the HTTP handler, no browser needed.
- **Phone calls** as far as they can go without an account: the provider interface, the recorded
  announcement, the recording store, the audio arriving with the summary in one message, and the
  never-pay-by-phone guard. Against a fake provider that dials nothing.

### Built, but never run against the real thing

Written carefully, offline-tested, and **unproven**. Do not treat any of it as working.
`docs/unverified.md` is the full ledger, test by test.

- **The Linq channel** (iMessage / RCS / SMS). Written from Linq's published Partner API v3 docs,
  signature checking per the webhook spec they document. No key has ever sent a real text.
- **Sending an attachment over Linq** — their documented pre-upload flow, so a call recording can
  ride along with the summary. Same caveat: never run.
- **The API path.** All 25 live tests now pass — but through the `claude-cli` backend on a Claude
  subscription, not through the Anthropic API that Reason actually ships on (there is no credit on
  this machine). Same prompts, same tools, different backend: no prompt cache, and the CLI owns the
  tool loop. So the behaviour is proved with a real model; the path it will run on is not. In this
  repo "live tested" means *via claude-cli*, and `docs/unverified.md` says so test by test.
- **Whether a real call keeps its promises.** Code can prove a call request cannot carry payment
  details and cannot be placed without the recorded announcement. Whether a real voice agent says
  the announcement first and holds the line when a restaurant pushes for a card is a property of
  whichever provider gets bought — and it is the first thing to test on the first real call.

### Not connected, and what you have to supply

Reason says all of this itself when asked: the `capabilities` tool and `account_list` report every
one of these as not connected, with what is missing. It starts up fine with none of them.

| What | What you must supply |
|---|---|
| **The model** | `ANTHROPIC_API_KEY`, with credit. Everything needs this. |
| **Page links that open on a phone** | `REASON_PUBLIC_URL`, the address this listener is reachable at. Pages work without it; their links just only open on this machine, and Reason says so. |
| **Texting** | `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_FROM_NUMBER`, plus `REASON_OWNER_NUMBER` set to your own number and a webhook subscription pointed at your host. |
| **Phone calls** | An account with a provider that records every call — `docs/call-providers.md` compares them and recommends one — then `REASON_TELEPHONY_KEY` and `REASON_PHONE_NUMBER`. |
| **Payments** | `REASON_PAYMENTS_KEY`. |
| **Gmail, Calendar, Drive** | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` — and note the credentials are only half of it: there is no email, calendar or documents tool written yet, so supplying these does not make them work. |
| **Spotify** | A developer app and your authorisation. The exact credentials are not settled, because nothing is built for it yet — so nothing here invents a variable name for it. |
| **OpenTable, Uber, Lyft, DoorDash, Uber Eats, Amazon, airlines, Ticketmaster, Fandango** | You, signed in once in Reason's own browser. These are reached as you would reach them, through the site, so they need saved logins — which is itself not built yet. |

Picked, and genuinely not started: everything in the table from Gmail downwards, plus Reason's own
email address, real bookings and checkouts with the exact total approved, group texts with polls,
documents and decks, and plug-in apps. `docs/features.md` has the agreed order under
**Decided 2026-10-04**.

## The rules it keeps

These are the point of the project rather than features of it. Each one says where it is actually
enforced, because a rule that lives only in a prompt is a hope.

**Only the click that really commits needs a yes, and a yes covers the details.** Picking a time,
opening a form and filling it in commit the owner to nothing, so they cost nothing — a yes spent
navigating to a form is a yes that is gone by the time the booking button arrives. *Enforced in
code* (`clickCommits` in `src/tools.js`): what gates a click is read off the element, not off
anybody's description of it. A link navigates and is free; anything else is judged by **the page's
own label**; a label that cannot be read is treated as a commit; a link that takes money is gated
anyway, because a one-tap charge cannot be undone. The model's own account of what a click will do
is recorded on the receipt and ignored by the guard. The booking Reason finally submits is checked
against the one the owner agreed to, so a yes for the 8:00 table will not book the 9:00 one.

**It confirms before it spends money or contacts anyone.** Anything that costs something or reaches
a third party stops and asks first, and the question names the exact thing — the number, the words,
the amount. *Enforced in the tool* (`src/trust.js`): the model cannot approve on your behalf,
cannot grant a confirmation in the same turn it asked, cannot spend one yes twice or after it goes
stale, cannot carry a yes over to details you never saw, and cannot point a yes for one person at
somebody else.

**Every call is recorded, and every call says so.** Before anything else, a call tells whoever picks
up that it is an AI assistant calling on your behalf and that the call is recorded. There is no
switch. *Enforced in code*: the line is built in `src/calls/provider.js` and passed to the provider
as its own argument, a provider handed a call without it refuses to dial, a provider that cannot
record cannot place a call at all, and a recording that goes missing on an answered call is
reported to you and written to the ledger as an error.

**It never pays by phone.** No card number, no expiry, no security code, no bank details, no PIN,
read out on a call, for any reason, including to hold a booking. *Enforced twice in code*: the call
request is scanned before the dial (`src/calls/payments.js`) and refused if it carries payment
details, and every call separately carries a standing instruction to decline, ask for a payment
link or another way, and report back.

**It is never you.** Reason is your assistant acting for you, and it says so. *Enforced in code for
calls* — the announcement says "on behalf of" and cannot be edited by the model. *A prompt rule for
texts*: it is told never to write as though you typed it and never to sign your name. That half is
not yet something code checks, and it is listed here rather than claimed as airtight.

There is also a shorter one: **it does not write, run or ship code.** No scripts, no repositories,
no pull requests, no deploys. Not a missing integration, not planned. The `capabilities` tool keeps
this and the payment rule in a `wont_do` list, separate from the things that are merely not
connected, because "I can't do that yet" and "I don't do that" are different answers.

### The confirm gate, in detail

- **The gate reads meaning, not words.** What a reply means is decided by a separate narrow model call that sees only the action as described and the owner's answer, verbatim — no history, no tools, a forced `yes`/`no`/`change`/`unclear` verdict. Word lists cannot do this job: "no problem, book it" is a go-ahead, and "ok but make it 9 instead" is not, though it reads as a yes to any substring match and would book the 8:00 that was just rejected. A reply that approves but moves any detail comes back `change`, which authorizes nothing and sends Reason back to ask again with the corrected summary. Anything the judge cannot read — an error, a timeout, an off-schema answer — is `unclear`, and `unclear` never grants. Code still owns every fact a model cannot be trusted with: that a real new message arrived after the ask, single use, expiry, one action per yes, and the owner's exact words on the record.
- **A receipt for everything.** Every action that touched the outside world writes an append-only ledger row: what was attempted, what came back, when, and which yes authorized it. "What did you do today?" is answered from that table.
- **Nothing is faked.** A provider with no credentials on this machine reports `not_connected` and names the exact variables that are missing. An app that has been *chosen* but has no code behind it also reports `not_connected`, and says that nothing is built for it — credentials for an integration nobody wrote do not make it work, and `connectable` would be the quiet overclaim this registry exists to prevent. Trying to connect one is refused rather than recorded. `/accounts` shows what Reason can reach; `account_revoke` cuts it off with no second confirmation.

## Layout

```
src/agent.js     the brain: system prompt + tool loop (Claude via the Anthropic SDK)
src/tools.js     tool schemas, input validation, guards; the only way state changes
src/trust.js     the confirm gate, the action ledger, the connected-accounts registry
                 (including the apps chosen but not built, so nothing claims to work)
src/db.js        SQLite (node:sqlite): conversations, plans, timers, tasks, people, calls,
                 threads, watches, ledger, confirmations, accounts
src/runtime.js   per-conversation turn queue + the sweep: timers, tasks, watchers, dropped threads
src/serve.js     the long-running process; src/http.js is its listener and serves pages
src/channels/    Channel interface (send, send-with-an-attachment, typing, receive) + console,
                 fake and Linq adapters, and the router that decides whose conversation an
                 inbound message belongs to
src/pages/       what a page may contain (content.js), our HTML template (render.js), and who
                 gets to see one — codes, cookies, rate limit (access.js)
src/calls/       CallProvider interface, a fake, the recording store (audio Reason owns), and
                 the never-pay-by-phone guard. No paid provider is wired up;
                 docs/call-providers.md compares the real ones
src/backends/    the owner's local claude-cli backend, the MCP server behind it, and the guard
                 that stops it serving anybody else
src/chat.js      terminal console
src/data.js      export / delete your data
test/            flow tests (assert DB state, never wording) + guard unit tests
docs/design.md   what Reason can do, what stays in code, milestones
docs/features.md the agreed feature list and build order (Decided 2026-10-04)
docs/call-providers.md  which telephony provider to buy, and why
docs/unverified.md      every live test that has not passed against the current code
```

## Testing on a Claude subscription (owner only, local)

The live tests prove the model reads real messages correctly, so they need a real model, so they
cost API credit. With none, they can be run through the `claude` CLI against a Claude subscription
instead:

```bash
REASON_BACKEND=claude-cli npm test
```

As of 2026-10-04 **all 25 live tests pass this way** — a booking really lands, once, after a real
yes, with a receipt, and a changed detail really is re-asked. That proves the behaviour with a real
model; it does not prove the API path, which is what Reason ships on. See `docs/unverified.md`.

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

## Keeping this file honest

**Standing rule for this repo: every commit that changes what Reason can do also updates this
README, in the same commit.** Not afterwards, not in a cleanup pass. The README is the only place
somebody can find out what is real without reading the tests, so a commit that moves the line and
leaves this file behind has made the project less honest, whatever it added.

What it has to keep current: what Reason does today, what is built but unverified, what is not
connected and what you must supply by name, how to run it, and the rules it keeps. Nothing goes in
the "working today" list that has not passed a test. If something is built but unproven, it goes in
the second bucket with the reason — and into `docs/unverified.md`, test by test.
