---
name: verify-reason
description: Launch, doctor, drive and prove Reason (~/Desktop/pa). Use before claiming any user-facing change works — inbound messages, pages, location shares, generated images, the confirm gate.
---

# Verify Reason

Reason is a personal assistant that lives in somebody's iMessage thread. You are reading this
because you changed something and need to show it works, or because something looks wrong and you
need to know whether the instance is worth driving at all.

**The one thing to understand first.** The primary surface is a real phone. The instance on port
8787 holds live Sendblue credentials; one POST to its webhook runs a real turn and sends a real
iMessage to a real person. So verification never drives it. `bin/caged.sh start` brings up a second
instance with its own port, its own SQLite file and every texting and calling credential blanked —
the real brain, the real tool loop, the real database, and no way out of the machine.

Repo: `~/Desktop/pa` (GitHub `omarionnn/pa`). All paths below are relative to
`.agents/skills/verify-reason/`; run the helpers from there or with their full path.

## Launch

Three ways in. Pick by what you need to prove.

**A — Offline test suite. No server.** The cheapest proof and the right first move for anything
tool-shaped, gate-shaped or adapter-shaped. ~2,430 assertions, no credentials, no network: the
model seam and `fetch` are both injected.

```bash
cd ~/Desktop/pa
npm run test:offline                   # the whole suite
node --test test/pages.test.js         # one file
```

**B — Caged instance. The real server, no way to reach a person.** For anything that has to come
in off the wire.

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start      # port 8796 by default; REASON_VERIFY_PORT to move it
bin/caged.sh status
bin/caged.sh stop       # teardown; see Cleanup
```

Ready is a log line, not a sleep — `caged.sh start` waits for
`listening on http://127.0.0.1:<port>` and prints the channel statuses it came up with. Both
texting channels must read `not_connected`; if either says `live`, stop and do not drive it.
Startup also prints `Reason is up · <date>`, the model backend, and the sweep interval. State
lives in `$TMPDIR/reason-verify/` (`pid`, `port`, `secret`, `owner`, `serve.log`, `reason.db`).

**C — Attach to the owner's live instance, read-only.** Only to answer "is the thing people are
using healthy, and is the fix actually deployed". `bin/doctor.sh`, `GET /health`, `GET /p/<id>`, and
reading `data/reason.db`. Nothing else.

Both B and C need `.env` at the repo root (it holds `ANTHROPIC_API_KEY` or
`REASON_BACKEND=claude-cli`, `SENDBLUE_*`, `REASON_MASTER_NUMBER`). It is gitignored and already on
this machine. The caged instance reads it and then overrides the dangerous parts.

## Doctor

Run this first, every time, before concluding anything from a drive.

```bash
bin/doctor.sh          # the live instance on 8787
bin/doctor.sh 8796     # the caged one
```

It is read-only and reports: who owns the port and for how long; the process's cwd against the
repo's `HEAD` and its start time against the last commit's time (**a process older than the commit
is running code you are not reading** — the single most common reason a verified fix "doesn't
work"); `GET /health`; whether `sweeping` is true (false means timers, tasks and held messages
will never fire, so half of Reason is dead and any drive that waits on one will hang); each
channel's status and what it is missing; outbox sent/failed; held inbound with any overdue; task,
timer and thread counts. It exits non-zero and says so when the instance is not worth driving.

## Drive

Four recipes. Each feature file in `features/` names the ones that apply to it.

**1 — One inbound message, down the real road.** The user path: adapter verifies the shared secret,
parses the payload, router dispatches, harm gate screens, real model turn, real tools, reply queued
for a channel that is not connected.

```bash
bin/inbound.sh text "where's the nearest coffee"
bin/inbound.sh file features/payloads/location.json    # a richer payload
```

`HTTP 200` with `{"ok":true,"delivered":1}` means a turn ran. `200` with `"ignored": "..."` means
the adapter dropped it deliberately (a group, an outbound echo, a status callback, a typing event)
— read `src/channels/sendblue.js:receive` to see which rule caught it. `401` means the
`sb-signing-secret` header did not match. The script refuses to point at 8787.

Payloads are Sendblue's own documented webhook shapes. `message_handle` must be unique per call or
the message is deduped and no turn runs; `inbound.sh text` and `inbound.sh file` stamp a fresh one.
**`inbound.sh -` does not** — stdin is posted verbatim, so a payload piped in twice is deduped and
the second call proves nothing. The sender is the `number` field, set from `REASON_MASTER_NUMBER` in
`.env`.

To drive the auth failure, which no helper covers, post with a wrong secret by hand:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$P/channels/sendblue/webhook" \
  -H 'content-type: application/json' -H 'sb-signing-secret: nope' \
  -d '{"content":"hi","number":"+10000000000","message_handle":"probe-401"}'   # → 401
```

**2 — A tool directly, against the caged database.** For tools whose proof is what they wrote, with
no model needed. This is how most of the offline suite works.

```bash
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const r = await runTool("page_create", { title: "Proof", blocks: [{ type: "text", text: "hi" }] },
                          { conversationId: "dm:owner", messages: [] });
  console.log(JSON.stringify(r, null, 2));
'
```

`runTool(name, input, ctx)` is the one entry point. `ctx` needs `conversationId` and `messages`
(the thread so far, newest last, each `{ role, content }` with content shaped
`"[Sat, Oct 10, 2026, 3:00 PM] Omari: ..."`). Several tools read the owner's last message out of
`ctx.messages` — the confirm gate above all — so a wrong `ctx` fails for reasons that look like
product bugs.

**3 — An HTTP route.** For what a browser or a phone fetches.

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s "http://127.0.0.1:$P/health" | node -e 'console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync(0,"utf8")),null,2))'
curl -si "http://127.0.0.1:$P/p/<id>?k=<owner-key>" | head -40    # a page, as the owner opens it
curl -si "http://127.0.0.1:$P/p/<id>"                             # the same page without the key
curl -si "http://127.0.0.1:$P/img/<file>.png" | head -5           # a generated image
```

Routes are enumerated in the header comment of `src/http.js` — though that comment is behind the
code: it says "there are three routes" and does not mention `/img/` (wired at `src/http.js:114`),
`/p/<id>/card.png` or `/p/<id>/preview.mp4`. Read the `exec` lines in `createServer`, not the
header.

The page routes answer HTML, and their failures are interchangeable on purpose: a private page, a
wrong key and an id that never existed all give **401** and the identical code gate, so a 401 tells
you nothing about whether the link is real. Check the `pages` row instead. See
[features/pages.md](features/pages.md) for the table and the body-hash check that proves it.

**4 — A whole scripted model turn, with the model stated.** When the point is that a tool result
leads the model somewhere, and you cannot afford a real model's variance. Replace the seam:

```js
const agent = await import("./src/agent.js");
const real = agent.model.create;
agent.model.create = async (params) => ({ /* a Messages response: content blocks, stop_reason… */ });
// … drive the turn; the REAL runTool, gate and database still run …
agent.model.create = real;
```

`src/agent.js` exports `model = { create }` for exactly this; `test/trustline-loop.test.js` is the
worked example. Do not fake the tool loop itself — that proves nothing about the loop.

### Baseline — the suite is GREEN at `d42f909`

`npm run test:offline` is **green** as of `d42f909` (2026-10-10): 2,465 passing, 0 failing, 69
skipped. Any failure is a real regression — investigate it.

**Run `git status` before you believe that number.** The baseline is a property of a commit, not of
this machine, and the tree here is routinely dirty with work in flight. On 2026-10-10 at `6c4cabf`
with three modified files the suite reported **2 failing** in `test/longtask.test.js`, both from an
uncommitted edit to `src/runtime.js` — green at the commit, red in the tree. A failure whose
assertion text exists at `HEAD` but not in the working file is uncommitted product work, not a
regression:

```bash
git show HEAD:src/runtime.js | grep -c 'the assertion string'   # present at HEAD
grep -c 'the assertion string' src/runtime.js                   # gone in the tree → in-flight work
```

## Evidence

A proof is a folder. One per run, timestamped, with the provenance already in it.

```bash
dir=$(bin/evidence.sh new location-share)
bin/evidence.sh run "$dir" 01-doctor   -- bin/doctor.sh 8796
bin/evidence.sh run "$dir" 02-inbound  -- bin/inbound.sh file features/payloads/location.json
bin/evidence.sh run "$dir" 03-thread   -- bin/peek.sh thread
bin/evidence.sh run "$dir" 04-inbound-row -- bin/peek.sh inbound
```

`evidence.sh run` writes `<name>.cmd`, `<name>.out` and `<name>.exit` side by side, so the proof
says what was asked as well as what came back. `00-provenance.txt` carries the UTC time, the exact
`HEAD`, the uncommitted-file list, the node version and the caged pid/port — a proof that cannot be
pinned to a commit is an anecdote.

Land in `evidence/<UTC>-<slug>/`, gitignored on purpose: it is the record of one run on one
machine, not source.

What makes it a proof, not a screenshot:

- **The real user path.** Inbound goes through the webhook, not a direct `runtime.handle()` call.
  A page is fetched over HTTP the way the owner's phone fetches it.
- **The action and the resulting state.** Not just `HTTP 200`: the row that landed. `bin/peek.sh`
  reads the caged database — `thread` (what the model was handed and said back, including tool_use
  and tool_result blocks), `inbound`, `outbox` (with `state` and `last_error`), `pages`,
  `confirms`, `ledger`.
- **Side effects checked where they live.** A page is a row in `pages` *and* HTML on `/p/<id>`. A
  generated image is a file under `$REASON_IMAGEN_OUTPUT` *and* bytes on `/img/<file>`. A gated
  action is a `confirmations` row with `granted_at` and `granted_quote` *and* a row in
  `action_ledger`. A sent message is an `outbox` row in state `sent`.
- **Mocks only at a boundary production already isolates.** The model seam, the injected `fetch`
  in the channel adapters, and the fake Imagen provider are all real seams the code ships with.
  Faking `runTool`, the gate, or the database is not verification.
- **On the caged instance, a reply never leaves.** Expect `could not send over sendblue: ... not
  connected` in `serve.log`. That line is the cage working, not a failure — but it means **the
  send path itself is unproven here**. Anything about delivery, media attachment, tapbacks or
  threading has to be proved in the offline suite, where the adapter's `fetch` is injected and the
  request shape is asserted. See `docs/unverified.md`.

## Cleanup

```bash
bin/caged.sh stop
```

Kills the pid written at launch and nothing else — **never by process name**, because the owner's
live Reason shares the command line. It waits for the process to go, confirms the port is free
(and fails loudly if something still holds it), and removes `$TMPDIR/reason-verify/` with the
throwaway database, profiles, shots and images.

It does not touch: `data/reason.db`, the live instance on 8787, `.env`, or
`evidence/` — proof survives teardown. After cleanup, confirm it: `ls evidence/<your-dir>/`.

Run cleanup after a **failed** iteration too. A caged instance left behind holds the port and the
next `start` refuses.

## Helpers

All executable, all run from `.agents/skills/verify-reason/`.

| Script | What it does |
|---|---|
| `bin/caged.sh start\|stop\|status\|env` | The caged instance. `env` prints the exports for driving tools in-process against its database. |
| `bin/doctor.sh [port]` | Read-only health verdict. Default 8787. |
| `bin/inbound.sh text "…" \| file <p> \| -` | POST one webhook to the caged instance. Refuses 8787. |
| `bin/peek.sh thread\|inbound\|outbox\|pages\|confirms\|ledger\|schema <t>\|sql "…"` | Read the caged database. `schema` first when a column name is in doubt. |
| `bin/evidence.sh new <slug>` / `run <dir> <name> -- cmd…` | Make an evidence folder; run a command into it. |

## Feature map

`features/README.md` and one file per user-facing feature: what it is, how a person reaches it, how
to drive it here, and what end state proves it. That map is the maintained source — when you change
behaviour, change its feature file in the same commit.

## Facts worth not rediscovering

- Port 8787 is the live instance. **8799 is already taken** by the local ticket-delivery sandbox;
  the caged default is 8796.
- Webhook auth is a shared secret in a header, not an HMAC over the body — header
  `sb-signing-secret` (override `SENDBLUE_WEBHOOK_SECRET_HEADER`), compared in constant time. No
  timestamp, so no replay window. This is Sendblue's design, documented in `src/channels/sendblue.js`.
- `REASON_BURST_QUIET_MS` is the window an arriving message waits in to see whether more of the
  same thought is coming (default 2500ms). `caged.sh` sets it to **0**, so a webhook runs its turn
  the moment it lands. Set it back deliberately if bursts are what you are testing
  (`test/burst.test.js`).
- Isolation is all env: `REASON_DB_PATH`, `REASON_PROFILE_ROOT`, `REASON_SHOT_ROOT`,
  `REASON_IMAGEN_OUTPUT`, `REASON_PORT`. There is no `--config`.
- `data/`, `*.db` and `*.log` are gitignored, so a caged run can never dirty the tree.
- `src/tools.js` is ~12,000 lines. Never read it whole: `grep -n 'name: "<tool>"' src/tools.js` for
  the schema, then `grep -n 'case "<tool>"' src/tools.js` for the implementation.
- The live model backend here is `REASON_BACKEND=claude-cli` (the owner's Claude subscription), not
  the API. `test/live.js` gates every live test on that or an `ANTHROPIC_API_KEY`, which is what
  keeps `npm run test:offline` green with no credentials. Real-model turns are **not
  deterministic** — assert on what landed in the database, never on wording.
- `REASON_AUTO_ADMIT=1` on this install, so any number is served. `REASON_TEST_NUMBERS` only gates
  the `claude-cli` backend. Drive as `REASON_MASTER_NUMBER` anyway, so the access flow stays out of
  the way.
