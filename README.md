# Reason

A personal assistant that lives in your texts. It handles what you hand it (looking things up, errands, calls, reminders, follow-ups, plans with your friends) and talks like a person.

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

### Everyone who texts it gets their own Reason

Not one owner and a crowd of strangers. Every person Reason works for has their own: their own
memory, plans, tasks, watchers, receipts, connected accounts, pages, call recordings and approvals.
Nothing one person stored, connected or agreed to is readable or usable from anybody else's
conversation, and a yes one person gives can never open a gate for another.

That is not a layer added on top — every table was already keyed by the conversation, and an
account **is** a conversation. The isolation is the scoping that was always there.

**Anyone may text the number. The master decides who gets one.**

`REASON_MASTER_NUMBER` is the master: a normal account with its own private Reason, plus admin
rights. (`REASON_OWNER_NUMBER` is still read, because that is what existing installs have.) When a
number with no account texts for the first time:

1. they get **one** line saying access is being asked for — and **no model turn is spent on what
   they said.** Their message is written down as a quote, not run;
2. the master gets a text: who is asking, their first message **quoted exactly**, and the question.

The master answers however people answer — "yeah go on", "nah not now", "who's that?" — and what
they meant is read by the same judge the confirm gate uses everywhere. Around it, code owns every
fact a model cannot be trusted with:

- the reply must be a real new message from the master's own number, after the ask;
- it is tied to **one** request, so a yes can never let in somebody it was not about;
- single use, with an expiry;
- only the master's number counts. Nobody can approve themselves, and somebody else texting "yes
  let them in" does exactly nothing.

`yes` creates the account and welcomes them; `no` sends one polite line; anything unclear grants
nothing and leaves the request waiting, with the master's own turn running as normal. Answering
costs no model turn and gets one reply, not two.

And the limits that stop this becoming a way to get at the master: a declined number is left alone
for a cool-off (`REASON_DECLINE_COOLOFF_DAYS`, default 7) and not raised again; only one request is
in front of the master at a time and the rest queue; there is an hourly ceiling on how many are put
to them; and somebody already waiting is told so once rather than on every message.

**What the master can do, by text:** see who is waiting (with their first message), see who has an
account and how much each has used, pause someone, resume them, remove them, block a number, or
delete somebody's Reason outright.

- **remove** stops Reason answering and **keeps their data** — "remove" sounds like deletion and is
  not. **delete** is the separate, irreversible one, and it goes through the confirm gate naming
  the person.
- **block** means no reply at all, and the master is never asked about that number again.
- **The master never sees another person's content.** Only the first message in a request, and
  usage counts. There is no tool that shows them anybody's conversation — not a missing one, a
  deliberately absent one.

**A daily limit per person**, on their messages (`REASON_MAX_TURNS_PER_DAY`) and on how often
Reason may interrupt them (`REASON_MAX_PROACTIVE_PER_DAY`). Counted in the database, so a restart
does not reset it, and 0 means uncapped. You pay for every turn.

**Export and delete are per person.** **Single-owner self-hosting is unchanged:** one number in
config and it behaves exactly as it did, with your existing data as the master's account — nothing
moved to get there.

"owner" inside Reason means *whoever's Reason this is*. Texting or ringing anybody else is still
acting on a third party and still goes through the confirm gate.

### Texting

Reason reaches people through a **channel**. The console is one; **Linq** (iMessage / RCS / SMS) is
the real one. Put `LINQ_API_KEY` and `LINQ_WEBHOOK_SECRET` in `.env`, point a Linq webhook
subscription at `https://your-host/channels/linq/webhook`, and set `REASON_OWNER_NUMBER` to your
own number in E.164.

`REASON_MASTER_NUMBER` is the master, read from config — nothing a message says can put a number on
it. Everyone else needs the master's yes (above). A conversation with no account behind it cannot
open the confirm gate, connect an account, submit anything, text anyone or place a call — refused
in code before the tool runs.

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

All of this is covered by the offline suite — **327 tests, 302 passing, 0 failing, 25 skipped**.
The 25 skipped need a real model; they all pass through the `claude-cli` backend (see below), and
have not been run against the API for want of credit.

- **An account per person**, fully separate, with the master approving each one by text — and a
  daily limit each, so nobody can run up the bill.
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
| **The model** | `ANTHROPIC_API_KEY`, with credit. Everything needs this, and a hosted install cannot use the subscription backend instead. |
| **A server to run on** | A host with a persistent disk and 1–2 GB of memory, plus `REASON_DATA_DIR` pointed at the mounted volume. See **Running it on a server**. |
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
src/accounts.js  whose Reason is whose: admission, account state, per-person caps
src/access.js    asking for a Reason, and the master's yes or no read through the gate
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

That is not left to anyone's good intentions. With a real channel connected, the subscription
backend **only ever answers the operator's own test numbers**:

```bash
REASON_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234 npm run serve
```

Those numbers get answers. Every other number — including somebody who is invited — gets a single
"not available yet" line and **no model turn**, because every turn here comes out of one person's
personal plan rather than out of an install's budget. With `REASON_TEST_NUMBERS` empty there is
nobody it may legitimately answer, so it **refuses to start**:

```
$ LINQ_API_KEY=... REASON_BACKEND=claude-cli npm run serve
Refusing to start: REASON_BACKEND=claude-cli with linq set up and no test numbers.
…
Either set REASON_TEST_NUMBERS to Omari's own number(s) to test over linq, or serve other
people properly: set ANTHROPIC_API_KEY to a key with credit…
```

**An Anthropic API key with credit is required before anybody but the operator is served.** That is
the rule, it is in the startup log, and it is checked per message in code
(`servesOnThisBackend` in `src/backends/guard.js`) rather than trusted. A personal Claude
subscription is not a service: no per-install billing, no rate limit anyone else is entitled to, no
prompt cache. The console and the fake channel are always fine — they only ever reach the operator
— and the channel rule is an allowlist, so an adapter added later is treated as external by
default. `npm run chat` and `REASON_BACKEND=claude-cli npm test` are unaffected.

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

## Running it on a server

Reason is a long-running process with a database and a browser. It does not need a laptop, and
leaving it on one means it stops when the lid closes. Nothing here is deployed anywhere — this is
what a host needs from you.

```bash
docker build -t reason .
docker run -d --name reason \
  -p 8787:8787 \
  -v reason-data:/data \
  -e ANTHROPIC_API_KEY=sk-... \
  -e REASON_OWNER_NAME=Omari \
  -e REASON_OWNER_NUMBER=+12025551234 \
  -e REASON_PUBLIC_URL=https://reason.example.com \
  -e LINQ_API_KEY=... -e LINQ_WEBHOOK_SECRET=... \
  reason
```

**The volume is not optional.** Everything Reason keeps lives under `REASON_DATA_DIR` (`/data` in
the image): the database, call recordings, saved browser logins and screenshots. Without a volume
mounted there, a restart forgets every plan, every memory and every login. One directory so there
is one thing to mount and one thing to back up.

**Config is environment only.** There is no config file, so there is nothing to copy and nothing
to leave behind. `REASON_HOST` and `REASON_PORT` are what it binds; `REASON_PUBLIC_URL` is the
address it hands out in page links, which is usually not the same thing. Without
`REASON_PUBLIC_URL` pages still work but their links only open on the box itself, and Reason says
so rather than texting you a dead link.

**What the box needs.** A persistent disk you can mount. Enough memory for Node plus a Chromium —
budget **1 GB and prefer 2 GB**, because the browser is the hungry part and a 512 MB box will kill
it mid-errand. One always-on instance; Reason is not built to run two copies against one database.

**Stopping it is safe.** The container takes `SIGTERM` straight to `node` — no npm wrapper to
swallow it — and `src/serve.js` then stops sweeping, lets the turn that is running finish, and
gives a wake time back to any task that was mid-step so nothing is left asleep for good. `/health`
answers from the database and the adapters rather than from uptime, so a host's health check is
checking something real.

**The `claude-cli` backend cannot be used on a server.** It shells out to a `claude` CLI that is
logged in as a person on their own machine; there is no such login in a container, and a personal
subscription is not a thing to serve other people from anyway. **A hosted Reason needs
`ANTHROPIC_API_KEY` with credit.** That is not a preference — with no key no turn can run, and the
startup log says so.

**Webhooks.** Point your texting provider's webhook at
`https://your-host/channels/linq/webhook`. That has to be HTTPS from the provider's side, which
means something terminating TLS in front — most hosts do this for you. Reason itself speaks plain
HTTP and does not want to hold certificates.

### What has not been tried

**The image has never been built.** There is no Docker on the machine this was written on, so the
Dockerfile is reviewed and unbuilt: the base image tag is checked against the `playwright` version
in `package.json` by a test, and the rest is read rather than run. Expect to fix something the
first time you build it. The properties around it — one data directory, environment-only config,
the public URL, the graceful stop, `/health` — are covered by tests that do run. See
`docs/unverified.md`.

## Keeping this file honest

**Standing rule for this repo: every commit that changes what Reason can do also updates this
README, in the same commit.** Not afterwards, not in a cleanup pass. The README is the only place
somebody can find out what is real without reading the tests, so a commit that moves the line and
leaves this file behind has made the project less honest, whatever it added.

What it has to keep current: what Reason does today, what is built but unverified, what is not
connected and what you must supply by name, how to run it, and the rules it keeps. Nothing goes in
the "working today" list that has not passed a test. If something is built but unproven, it goes in
the second bucket with the reason — and into `docs/unverified.md`, test by test.
