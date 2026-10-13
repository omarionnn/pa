---
name: verify-reason
description: Launch, doctor, drive and prove Reason (~/Desktop/pa). Use before claiming any user-facing change works — inbound messages, pages, location shares, generated images, the confirm gate.
---

# Verify Reason

Reason is a personal assistant that lives in somebody's iMessage thread. You are reading this
because you changed something and need to show it works, or because something looks wrong and you
need to know whether the instance is worth driving at all.

**The one thing to understand first.** The primary surface is a real phone, and **the live Reason
is on Hetzner** — `https://reason.tail3753c7.ts.net`, ssh `root@91.98.19.150` (or
`root@100.100.152.2` over Tailscale), systemd unit `reason`, an rsync copy at `/opt/reason`. That
hostname moved from the Mac to Hetzner on 2026-10-12; the old `ubuntu-4gb-nbg1-2.tail3753c7.ts.net`
no longer resolves (curl 000), and anything still naming it is dead. Nothing on this Mac is live:
the Mac's 8787 instance was stopped on 2026-10-12. The live instance holds live Sendblue
credentials and the production AgentCard credentials; one POST to its webhook runs a real turn and
sends a real iMessage to a real person, and a purchase there spends real money. So verification
never drives it. **Nor does anything else holding the same Sendblue keys get to answer**: on
2026-10-12 an idle second copy on Fly restarted, pulled the owner's "Yeah" out of Sendblue's
messages API through the startup catch-up, and answered it from a database three days stale. The
Fly app is scaled to zero and its auto-deploy workflow disabled; `catchUp()` now refuses unless
Sendblue's receive webhook names this install (see [features/inbound-message.md](features/inbound-message.md)). `bin/caged.sh start` brings up a second instance here with its own
port, its own SQLite file and every texting, calling and AgentCard credential blanked — the real
brain, the real tool loop, the real database, and no way out of the machine.

Repo: `~/Desktop/pa` (GitHub `omarionnn/pa`). All paths below are relative to
`.agents/skills/verify-reason/`; run the helpers from there or with their full path.

## Launch

Three ways in. Pick by what you need to prove.

**A — Offline test suite. No server.** The cheapest proof and the right first move for anything
tool-shaped, gate-shaped or adapter-shaped. ~2,550 assertions, no credentials, no network: the
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
lives in `$TMPDIR/reason-verify/` (`pid`, `port`, `secret`, `owner`, `serve.log`, `reason.db`),
plus the `images/`, `profiles/` and `shots/` roots it creates up front.

**`serve.log` carries the router's own decision log**, because `caged.sh` runs `serve.js --log`.
That flag is the only thing that turns it on (`src/serve.js:25`; without it `log` is `() => {}`),
and it is what makes a drive readable: `{"inbound":…,"auto_admitted":"+1…"}`,
`{"inbound":…,"duplicate":true}`, `{"inbound":…,"not_served":…,"why":…}`,
`{"webhook":"sendblue","status":200,"delivered":1}`, every `{"tool":…,"out":…}`, and the
`{"cli":{"stop":…,"turns":…,"cost":…}}` line for the turn. Read it by diffing the line count
around a drive. Message bodies are **not** in there (that needs `REASON_LOG_CONTENT=1`, which
`caged.sh` deliberately does not set) — `bin/peek.sh thread` is where to read those.

**C — Attach to the live instance on Hetzner, read-only.** Only to answer "is the thing people are
using healthy, and is the fix actually deployed". `bin/doctor.sh live` (ssh + the public `/health`
+ a checksum of `src/tools.js`, `src/http.js`, `src/agentcard.js`, `src/channels/sendblue.js` and
`src/serve.js` against this tree), `GET /p/<id>`
on the public address, `journalctl -u reason` and `sqlite3 /opt/reason/data/reason.db` over ssh.
Nothing else. The journal has the decision log because the unit has a `--log` drop-in.

Deploying there is an rsync of specific files, never the whole tree blind (another session's
uncommitted work rides along otherwise), **always excluding `data/` and `.env`**, then
`ssh root@91.98.19.150 systemctl restart reason` — a plain `kill` loses to `Restart=always`.
Verify with `bin/doctor.sh live`: the checksums must read "same as this tree".

Both B and C need `.env` at the repo root (it holds `ANTHROPIC_API_KEY` or
`REASON_BACKEND=claude-cli`, `SENDBLUE_*`, `REASON_MASTER_NUMBER`). It is gitignored and already on
this machine. The caged instance reads it and then overrides the dangerous parts.

## Doctor

Run this first, every time, before concluding anything from a drive.

```bash
bin/doctor.sh          # the LIVE instance — Hetzner, over ssh (same as `bin/doctor.sh live`)
bin/doctor.sh 8796     # the caged one
bin/doctor.sh 8787     # a local dev instance on this Mac, if somebody started one — NOT live
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

Routes are enumerated in the header comment of `src/http.js`: 18 routes as of `20b321a`, including
`/img/{name}.(png|jpg)` (wired at `src/http.js:125`), `/p/{id}/card.png`, `/p/{id}/preview.mp4`,
`POST /access/web` (the website's form, matched at `:346` via `WEB_ACCESS_PATH`) and
`POST /agentcard/webhook` (`:338`). The comment is still missing four OAuth callbacks that exist in
the code — `/spotify/callback` (`:267`), `/github/callback` (`:290`), `/x/callback` (`:309`),
`/google/callback` (`:810`, its own function) — 22 routes total; `grep -n '_callback:' src/http.js`
finds them when the numbers move. It says so itself — *"Every route is matched by a
regex in `createServer` below, and that is the list of record; this one is a reader's index and
goes stale if nobody tends it."* Use it as the index, and confirm against the `exec` lines before
you depend on one.

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

### Baseline — 2,652 pass, **0 failures** on `wt/catchup-guard` (2026-10-13)

`npm run test:offline` on the `wt/catchup-guard` maintenance commit (2026-10-13): **2,721 tests,
2,652 passing, 0 failing, 69 skipped**, ~35s. Any failure is a real regression — investigate it.

Two things to know before believing a red run:

- **`main` at `e42894a` was red by two** — `2908618` (2026-10-12, "natural opening for outbound
  calls") changed the announcement to *"Hey, hi — this is an AI assistant calling for <owner>…"*
  and left `test/accounts.test.js:167` and `test/elevenlabs.test.js:274` asserting the old
  wording. Both are fixed on `wt/catchup-guard`, along with `test/call-inbound.test.js:157`, which
  compared two random draws of the inbound-call lead-in for byte equality and failed about one run
  in two.
- **A race that only showed under full-suite load:** `test/alerts.test.js:123` read the clock
  twice and asserted the two reads equal; it failed by 1 ms in two of five full runs on
  2026-10-13 (`1791866545657` vs `…658`) and passed 5/5 in isolation. Fixed on `wt/catchup-guard`
  (one `now` for both sides). The pattern to recognise: a red test that is green alone, with an
  `actual`/`expected` one millisecond apart, is a clock race, not a regression.

**Run `git status` before you believe any of these numbers.** A baseline is a property of a commit,
not of this machine, and the tree here is routinely dirty with work in flight — 10 modified files
and an untracked `src/places.js` on 2026-10-11. Two earlier readings of the same trap: on
2026-10-10 at `6c4cabf` the suite reported 2 failing in `test/longtask.test.js`, both from an
uncommitted `src/runtime.js` edit. A failure whose assertion holds at `HEAD` but not in the working
tree is uncommitted product work:

```bash
git diff --stat src/config.js test/niche.test.js   # which side of the failure is uncommitted
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
says what was asked as well as what came back. **It runs the command from the skill directory**, so
`bin/…` and `features/payloads/…` resolve but an in-process node drive does not: a recipe written
as `cd ~/Desktop/pa && node --env-file-if-exists=.env -e 'import("./src/tools.js")'` dies with
".env not found" and `ERR_MODULE_NOT_FOUND` under `.agents/skills/verify-reason/src`. Run those
with `REASON_EVIDENCE_CWD="$REPO" bin/evidence.sh run …`, or give the env file and the imports
absolute paths (2026-10-13: the whole in-process pass went into evidence this way). `00-provenance.txt` carries the UTC time, the exact
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
- **A send the cage refuses leaves no row and no attempt, only whatever the caller logs.**
  `Router.send` and `sendParts` both open with `#ready(channel)` (`src/channels/router.js`), which
  returns `{ok:false,status:"not_connected"}` *before* `outbox.sendDurable` is reached. So a
  not-connected channel means no `outbox` row, no adapter call, and nothing in `serve.log` unless
  that call site logs the failure itself — and not every one does. **A caller that drops the result
  is invisible here**, which makes "did Reason try to send X" unanswerable on the cage. Prove those
  offline against an injected `fetch`, or read the call site and say so.

## Cleanup

```bash
bin/caged.sh stop
```

Kills the pid written at launch and nothing else — **never by process name**, because the owner's
live Reason shares the command line. It waits for the process to go, confirms the port is free
(and fails loudly if something still holds it), and removes `$TMPDIR/reason-verify/` with the
throwaway database, profiles, shots and images.

It does not touch: `data/reason.db`, the live instance on Hetzner, `.env`, or
`evidence/` — proof survives teardown. After cleanup, confirm it: `ls evidence/<your-dir>/`.

Run cleanup after a **failed** iteration too. A caged instance left behind holds the port and the
next `start` refuses.

## Helpers

All executable, all run from `.agents/skills/verify-reason/`.

| Script | What it does |
|---|---|
| `bin/caged.sh start\|stop\|status\|env` | The caged instance. `env` prints the exports for driving tools in-process against its database. |
| `bin/doctor.sh [live\|port]` | Read-only health verdict. Default `live` = Hetzner over ssh; a port = a local instance. |
| `bin/inbound.sh text "…" \| file <p> \| -` | POST one webhook to the caged instance. Refuses 8787. |
| `bin/peek.sh thread\|inbound\|outbox\|pages\|confirms\|ledger\|schema <t>\|sql "…"` | Read the caged database. `schema` first when a column name is in doubt. |
| `bin/evidence.sh new <slug>` / `run <dir> <name> -- cmd…` | Make an evidence folder; run a command into it. |

## Feature map

`features/README.md` and one file per user-facing feature: what it is, how a person reaches it, how
to drive it here, and what end state proves it. That map is the maintained source — when you change
behaviour, change its feature file in the same commit.

## Facts worth not rediscovering

- **The live instance is Hetzner, not a port on this Mac.** Since 2026-10-12 nothing on this
  machine is live; a process on 8787 here is a dev checkout somebody started, and if its `/health`
  says `sendblue: live` it is a *duplicate* on the live number — stop it, do not drive it.
  **8799 is already taken** by the local ticket-delivery sandbox; the caged default is 8796.
- `caged.sh` blanks `AGENTCARD_*` as well as the texting and calling credentials. On the cage every
  purchase tool answers `not_configured` and `/agentcard/webhook` answers 401 — that is the cage
  holding, and the money paths are proved in `test/agentcard.test.js` against the fixture.
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
- **A restart polls Sendblue for what it missed, and only the webhook owner may.** `serve.js`
  calls each channel's `catchUp()` once the port is open (`3c45286`); Sendblue's pulls the last
  90 s of inbound from `GET /api/v2/messages` after asking `GET /api/account/webhooks` whether the
  receive list names `${REASON_PUBLIC_URL}/channels/sendblue/webhook`. On the cage Sendblue is
  not connected, so the startup log has **no** `catch-up:` line at all — that silence is correct.
  A local instance with real keys and the Mac's public URL would print `catch-up: skipped for
  sendblue — Sendblue delivers to https://reason.tail3753c7.ts.net/…, not …`; the live one logs
  `{"inbound":"<handle>","duplicate":true}` for anything it already answered, or
  `catch-up: recovered N message(s)`. Pinned in `test/sendblue.test.js` ("catch-up on restart").
- **The page link and the image URL point at two different public hosts, and neither is the
  cage.** `REASON_PAGES_URL=https://reason.omarinyarko.com/p` (Netlify proxy → Hetzner) builds
  the page link; `REASON_PUBLIC_URL=https://reason.tail3753c7.ts.net` builds `/img/…`. Swap either
  host for `127.0.0.1:<caged port>` before curling.
- Worktrees have no `.env`; `ln -s ~/Desktop/pa/.env <worktree>/.env` (gitignored) before
  `caged.sh start` from one, or the cage comes up with no backend.
