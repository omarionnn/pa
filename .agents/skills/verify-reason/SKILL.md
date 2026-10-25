---
name: verify-reason
description: Launch, doctor, drive, deploy and prove Reason (~/Desktop/pa). Use before claiming any user-facing change works — inbound messages, pages, location shares, generated images, the confirm gate, shopping, AgentCard and flight search — and before and after deploying to Hetzner.
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
tool-shaped, gate-shaped or adapter-shaped. ~3,490 tests (see Baseline), no credentials, no network: the
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

What the cage sets, beyond the blanks (all in `bin/caged.sh start`, and the same in `caged.sh env`):

- **Its own session.** The server is started under `setsid` (perl's `POSIX::setsid` on macOS), so
  it outlives the command that started it. An agent's command runner kills the whole process group
  when one command ends; before this (2026-10-23) the cage answered doctor and was gone by the next
  command, and every drive was `ECONNREFUSED`. If you ever see that, `bin/caged.sh status` first.
- **The API backend** (`REASON_BACKEND=api`, override with `REASON_VERIFY_BACKEND`). This Mac's
  `claude` is logged in to the same subscription live Reason uses; on 2026-10-20 verification turns
  through it spent the shared 5-hour limit and live Reason was down for four hours. Startup prints
  `model: the Anthropic API (…)` — if it says "the claude CLI", stop.
- **Its own data dir** (`REASON_DATA_DIR=$RUN/data`). Page cards, previews and illustrations are
  written under it; before 2026-10-23 a caged page landed in the checkout's real `data/cards`.
- **Uber blanked** (`UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`) alongside texting, calling and AgentCard.
- **Reason's paid API key blanked** (`ANTHROPIC_API_KEY=`, since #115 on 2026-10-25: no verification
  spends it). Startup then says `NO ANTHROPIC_API_KEY set, so no turn can run` and the Anthropic
  provider row reads `not set up` — drive tools (Drive 2) and routes (Drive 3). Only
  `REASON_VERIFY_ALLOW_API=1` keeps the key, on purpose, and the PR says so.
- **Its own ElevenLabs inbound secrets** — `ELEVENLABS_LLM_SECRET` and `ELEVENLABS_WEBHOOK_SECRET`
  are the cage's secret, never the real ones, so `bin/call-turn.sh` (Drive 5) can drive a call turn.

The cage still reads every other key from `.env`, so some drives spend money or reach the network:
a web search (whichever `REASON_SEARCH_PROVIDER` this Mac's `.env` names), `page_create`'s
illustration and picture search (export `GEMINI_API_KEY= OPENAI_API_KEY=` and pass
`pictures: { search: null }` — see [features/pages.md](features/pages.md)), and
`subscription_cancel_start`, which drives a real browser to the merchant's sign-in page.
Startup also prints `Reason is up · <date>`, the model backend, and the sweep interval. State
lives in `$TMPDIR/reason-verify/` (`pid`, `port`, `secret`, `owner`, `serve.log`, `reason.db`),
plus the `images/`, `profiles/` and `shots/` roots it creates up front.

**`serve.log` carries the router's own decision log**, because `caged.sh` runs `serve.js --log`.
That flag is the only thing that turns it on (`src/serve.js:30–31`; without it `log` is `() => {}`),
and it is what makes a drive readable: `{"inbound":…,"auto_admitted":"+1…"}`,
`{"inbound":…,"duplicate":true}`, `{"inbound":…,"not_served":…,"why":…}`,
`{"webhook":"sendblue","status":200,"delivered":1}`, every `{"tool":…,"out":…}`, and the
`{"cli":{"stop":…,"turns":…,"cost":…}}` line for the turn. Read it by diffing the line count
around a drive. Message bodies are **not** in there (that needs `REASON_LOG_CONTENT=1`, which
`caged.sh` deliberately does not set) — `bin/peek.sh thread` is where to read those.

**C — Attach to the live instance on Hetzner, read-only.** Only to answer "is the thing people are
using healthy, and is the fix actually deployed". `bin/doctor.sh live` (ssh + the public `/health`
+ a checksum of **every file under `src/`** against this tree, the `data/` backups, any `.env.bak*`,
and the rolling-backup timer), `GET /p/<id>` on the public address, `journalctl -u reason` and
`sqlite3 -readonly /opt/reason/data/reason.db` over ssh. Nothing else. The journal has the
decision log because the unit has a `--log` drop-in (`/etc/systemd/system/reason.service.d/log.conf`).

Until 2026-10-24 `doctor.sh live` compared only five files (`src/tools.js`, `src/http.js`,
`src/agentcard.js`, `src/channels/sendblue.js`, `src/serve.js`), so a missing `src/purchasesnote.js`
or a stale `src/db.js` read as "deployed". It now walks `src/` on both sides and names any file that
differs or exists on one side only. At `587f67a` (after #97, live pid started 14:52:34 UTC) all
155 files read the same; at `b04eb74` (after #109, pid started 03:53:03 UTC on 2026-10-25) all 161. A DIFFERS is a real deploy gap — check it.

**Never call AgentCard from a probe.** No `/api/v2/oauth/token`, no `/api/v2/connect/refresh`, no
introspection, no `/buy/*` read — not with the org credentials, not with a person's token. A
refresh spends the stored refresh token and hands back the only pair that works
(`src/agentcard.js` `refreshConnection`); on 2026-10-24 a probe used up the owner's last refresh
token and his card connection had to be made again. What AgentCard has is read on live from the
rows and the journal (`agentcard_purchases`, `agentcard_events`, `{"tool":"purchase_track",…}`),
and the money paths are proved offline against `test/fixture-agentcard.js`.

**Hetzner has a second unit, `reason-sandbox`** (`/opt/reason-sandbox`, port 8799, AgentCard
sandbox, no messaging). It is normally `inactive`. Never start it to verify something here; it is
not the cage and is not this skill's to drive.

**The database is backed up by a timer, and that is the only copy kept.** `reason-backup.timer`
runs `/usr/local/bin/reason-rolling-backup` at 04:00 and 16:00 New York time: a WAL-safe
`.backup` to a temp file, `PRAGMA integrity_check`, then `mv` over
`/opt/reason/data/reason.db.bak-rolling`. Exactly one copy, ever. `journalctl -u reason-backup`
shows `rolling backup ok: <bytes> at <UTC>`. `doctor.sh live` reports the file list and the timer's
last/next run.

### Deploying to Hetzner

Only when code changed — a change to this skill's docs or `bin/` never needs a deploy or a
restart. Every step below is from a lesson learned the hard way; skip none.

1. **A fresh checkout of the latest `origin/main`, never a working tree.** Not `~/Desktop/pa`
   (another session's uncommitted work rides along), not a branch worktree that was merged an hour
   ago (it is missing whatever merged since).

   ```bash
   cd ~/Desktop/pa && git fetch origin
   SHA=$(git rev-parse --short origin/main); W=/tmp/reason-deploy-$SHA
   git worktree add --detach "$W" origin/main && cd "$W" && git status --porcelain   # must be empty
   # every merged PR is in it — not just yours:
   gh pr list --repo omarionnn/pa --state merged --limit 15 --json number,mergeCommit \
     --jq '.[] | "\(.number) \(.mergeCommit.oid)"' | while read n c; do
       git merge-base --is-ancestor "$c" HEAD && echo "#$n present" || echo "#$n MISSING"; done
   ```

2. **Back up live once, under a name that says it is temporary.** As `reason`, WAL-safe:
   `ssh root@91.98.19.150 'cd /opt/reason/data && sudo -u reason sqlite3 reason.db ".backup reason.db.bak-predeploy"'`.
   **Never** `cp .env .env.bak…` or any other copy of `.env` — it is every secret in one more
   file, and none is needed: `.env` is never touched by a deploy.

3. **Stage, then copy as `reason:reason`.** This Mac's `rsync` is Apple's openrsync (no
   `--chown`) and `/opt/reason` must stay owned by `reason:reason` (a root-owned file there is a
   crash on the next write). **`--exclude .git`, never `--exclude .git/`**: in a worktree `.git` is
   a *file*, which the trailing-slash pattern does not match, so it was shipped to `/opt/reason`.
   Record the PID before and the time the copy finished.

   ```bash
   PID0=$(ssh root@91.98.19.150 systemctl show reason -p MainPID --value)
   rsync -a --delete --exclude data/ --exclude .env --exclude node_modules --exclude .git \
     ./ root@91.98.19.150:/tmp/reason-deploy/
   COPIED=$(ssh root@91.98.19.150 'rsync -a --chown=reason:reason --exclude data/ --exclude .env \
     --exclude node_modules --exclude .git /tmp/reason-deploy/ /opt/reason/ && rm -rf /tmp/reason-deploy \
     && date -u +%s')
   echo "copy finished $COPIED"
   ```

   No `--delete` on the second rsync: `/opt/reason` holds `data/`, `.env` and `node_modules/`,
   which are the server's own. If `package-lock.json` changed, run `npm ci --omit=dev` in
   `/opt/reason` as `reason` before the restart. A schema change is tried first on a copy of the
   live `reason.db` (scp it down, run the new code's `db.js` against the copy) before any of this.

4. **Restart in its own ssh command, then prove a NEW process started AFTER the copy.** On
   2026-10-24 `… && systemctl restart reason` at the end of a chained ssh line was silently skipped
   twice: the files were new, the old process kept running the old code, and only the start time
   gave it away. A plain `kill` loses to `Restart=always`.

   ```bash
   ssh root@91.98.19.150 systemctl restart reason
   ssh root@91.98.19.150 'systemctl show reason -p MainPID --value; \
     date -u -d "$(systemctl show reason -p ExecMainStartTimestamp --value)" +%s'
   # → a PID that is not $PID0, and a start time ≥ $COPIED. Either one wrong: it did not restart.
   ```

5. **Prove it, then clean up.** `bin/doctor.sh live` from the deploy worktree: every `src/` file
   "same as this tree", `sweeping` yes, `sendblue` live, `process started` after the copy. Watch
   `journalctl -u reason -f` through one real turn if the change is on the turn path. **Only then**
   delete the pre-deploy copy, so `data/` holds `reason.db.bak-rolling` alone:
   `ssh root@91.98.19.150 'rm -f /opt/reason/data/reason.db.bak-predeploy; ls /opt/reason/data'`,
   and `git worktree remove "$W"`.

Both B and C need `.env` at the repo root (it holds `ANTHROPIC_API_KEY` or
`REASON_BACKEND=claude-cli`, `SENDBLUE_*`, `REASON_MASTER_NUMBER`). It is gitignored and already on
this machine. The caged instance reads it and then overrides the dangerous parts.

## Doctor

Run this first, every time, before concluding anything from a drive.

```bash
bin/doctor.sh          # the LIVE instance — Hetzner, over ssh (same as `bin/doctor.sh live`)
bin/doctor.sh caged    # the caged one, on whatever port `caged.sh start` wrote (or `bin/doctor.sh 8796`)
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

`HTTP 200` with `{"ok":true,"delivered":1}` means a turn ran. `{"ok":true,"accepted":true}` means
the turn is still running: the webhook answers the provider after `REASON_WEBHOOK_ANSWER_MS` (5s)
and the turn finishes in the background — wait for its `could not send over sendblue` line in
`serve.log` before reading the thread. Messages posted while a turn runs are merged into one turn
("they sent the following as N separate texts"), even with `REASON_BURST_QUIET_MS=0`, so wait
between drives when each should be its own turn. `200` with `"ignored": "..."` means
the adapter dropped it deliberately (a group, an outbound echo, a status callback, a typing event)
— read `src/channels/sendblue.js:receive` to see which rule caught it. `401` means the
`sb-signing-secret` header did not match — or was missing and Sendblue could not confirm the
message (always the case on the cage; see [features/inbound-message.md](features/inbound-message.md)).
The script refuses to point at 8787.

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

**Some tools also read the turn, not just `ctx`.** `src/offers.js` keeps per-conversation turn
state that the runtime opens with `offers.beginTurn(conversationId, theirText, "user")`: the
reply's figures check reads its sources, and `deal_watch_set` refuses unless the turn is a `user`
turn whose own text contains `said`. A bare `runTool("deal_watch_set", …)` answers "'said' has to
be their own words from this message" however `ctx.messages` reads (2026-10-24). Call
`offers.beginTurn` first — see [features/shopping.md](features/shopping.md).

**3 — An HTTP route.** For what a browser or a phone fetches.

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s "http://127.0.0.1:$P/health" | node -e 'console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync(0,"utf8")),null,2))'
curl -si "http://127.0.0.1:$P/p/<id>?k=<owner-key>" | head -40    # 401 + the code gate: a fresh curl is a new browser (features/pages.md)
curl -si "http://127.0.0.1:$P/p/<id>"                             # the same page without the key
curl -si "http://127.0.0.1:$P/img/<file>.png" | head -5           # a generated image
```

Routes are enumerated in the header comment of `src/http.js`: 19 routes there (GET and HEAD), including
`GET /i/{token}` (also `/p/i/{token}`, the invite page — #104, dark behind `REASON_INVITES_OPEN`),
`/img/{name}.(png|jpg|webp|gif)` (`imgRoute`), `/p/{id}/card.png`, `/p/{id}/preview.mp4`,
`POST /access/web` (the website's form, via `WEB_ACCESS_PATH`) and `POST /agentcard/webhook`. The
comment is missing routes that exist in the code: five OAuth callbacks — `/spotify/callback`,
`/github/callback`, `/uber/callback`, `/x/callback`, `/google/callback` (`googleCallbackRequest`);
`grep -n '_callback:' src/http.js` finds them — plus `/spotify/join`, `POST /parallel/webhook`,
`/ops` and `/ops.json` (behind a password when `REASON_OPS_PASSWORD_HASH` is set — this Mac's
`.env` sets it, so on the cage both answer **401** without the sign-in; `caged.sh` does not blank
it; never read or change the hash), and the site's static files (`/`, `/privacy`, `/terms`, `/og.png`,
`/favicon.svg`, `/apple-touch-icon.png`, `/reason.vcf`). Line numbers churn; grep. It says so itself — *"Every route is matched by a
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

**5 — A phone call, turn by turn, with no phone.** ElevenLabs reaches Reason through the custom-LLM
endpoint (`POST /calls/elevenlabs/llm`, OpenAI chat-completions over SSE) and sends each turn as the
call's spoken words only. `bin/call-turn.sh` posts exactly that to the cage, with the cage's own
bearer, against an `in_progress` owner call row it creates — the real call model on the API, the
harm screen, Reason's tools, the real database:

```bash
bin/call-turn.sh new                                         # a fresh owner call + empty history
bin/call-turn.sh "can you check what the price of gold is?"  # → {"first_content_ms":…} and Reason: …
bin/call-turn.sh "no, it's okay."                            # the history so far is sent each turn
bin/call-turn.sh show                                        # the call row and its lookups record
```

Read `voice_turn` / `call_tool` / `call_llm_first_content_ms` in `serve.log`. The cage cannot place
or receive a real call (no ElevenLabs key), and its timings are this Mac to Anthropic with no
ring-time cache warm-up — prove latency on Hetzner, not here. See
[features/call-completeness.md](features/call-completeness.md).

### Baseline — 3,379 pass, **0 failures** on the API-spend diet over `675c3d1` (2026-10-25)

`npm run test:offline` on `wt/api-spend-diet` over `675c3d1` (2026-10-25), with the owner's
"ran dry" text: **3,488 tests, 3,379 passing, 0 failing, 0 cancelled, 109 skipped**. (3,486 / 3,377
before it; #112 over `5c93467`: 3,459 / 3,350 / 0 / 109, same as #114 over `d0dad69`; `b04eb74`, after PR #109: 3,458 / 3,349 / 0 / 109; `587f67a`, after PR #97: 3,282 / 3,202 / 0 / 80; `226ff17`, after PR #82: 3,169 / 3,097 / 0 / 72; `b44ffc9`, after PR #70: 3,146 / 3,075 / 0 / 71; `b2861c2`, after
PR #60: 3,124 / 3,053 / 0 / 71.) Any failure is a real regression — investigate it. (2026-10-13 on
`wt/catchup-guard`: 2,721 / 2,652 / 0 / 69.)

Three things to know before believing a red run:

- **`cancelled` is not `fail`.** A suite started in the background by an agent's runner (`… &`, a
  detached job) reported `fail 0` but `cancelled 3` on 2026-10-24 — `test/pages-phone.test.js`,
  `test/sites.test.js`, `test/subscriptions.test.js`, each *"Promise resolution is still pending
  but the event loop has already resolved"*. All three passed alone, and the same suite in the
  foreground read 0 cancelled. Run it in the foreground and read `cancelled` as well as `fail`.

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
| `bin/doctor.sh [live\|port]` | Read-only health verdict. Default `live` = Hetzner over ssh: service + pid start, every `src/` file checksummed, `data/` backups, `.env.bak*`, backup timer, `/health`. A port = a local instance. |
| `bin/inbound.sh text "…" \| file <p> \| -` | POST one webhook to the caged instance. Refuses 8787. |
| `bin/call-turn.sh new \| "…" \| show` | One spoken call turn against the cage's custom-LLM endpoint; `show` prints the call's lookups record. |
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
  A webhook with **no** header is checked against Sendblue's own API (`confirmUnsigned`, #64) and
  runs only if Sendblue has that message.
- **No API credit means no model on the cage.** On 2026-10-25 both this Mac's and Hetzner's
  `ANTHROPIC_API_KEY` answered 400 "Your credit balance is too low". The cage runs turns on the API,
  so every `bin/inbound.sh` / `bin/call-turn.sh` drive is unreachable until it is topped up — drive
  tools (Drive 2) and routes (Drive 3) instead, and do **not** switch the cage to the CLI. Do not
  spend Reason's key to find out either (no "one Haiku call" check since 2026-10-25): read the live
  /ops "API spend" row, or `model_usage.low_credit` on Hetzner. Model-turn proof comes from the
  real-model test lanes, which run on the subscription (see below) — prompt evals that only need the
  model, not the cage, included: see the proactive-catches entry in [features/README.md](features/README.md).
- **On the cage, an API-backend turn can end with no words** and the reply becomes the hardcoded
  "ugh my bad, something broke on my end. say that again?" (`src/agent.js:537`). Seen 2026-10-23:
  `memory_page` → `request_done` → an empty final message, 1 of 3 identical asks. Live runs the
  `claude-cli` backend and has never sent that line, so it is an API-path gap; re-ask before calling
  a feature broken.
- `REASON_BURST_QUIET_MS` is the window an arriving message waits in to see whether more of the
  same thought is coming (default 4000ms, capped at `REASON_BURST_MAX_MS` 10000ms). `caged.sh` sets it to **0**, so a webhook runs its turn
  the moment it lands. Set it back deliberately if bursts are what you are testing
  (`test/burst.test.js`).
- Isolation is all env: `REASON_DB_PATH`, `REASON_PROFILE_ROOT`, `REASON_SHOT_ROOT`,
  `REASON_IMAGEN_OUTPUT`, `REASON_PORT`. There is no `--config`.
- `data/`, `*.db` and `*.log` are gitignored, so a caged run can never dirty the tree.
- `src/tools.js` is ~15,500 lines. Never read it whole: `grep -n 'name: "<tool>"' src/tools.js` for
  the schema, then `grep -n 'case "<tool>"' src/tools.js` for the implementation.
- The live install's text backend is `REASON_BACKEND=claude-cli` (the owner's Claude subscription);
  its CALLS run on the API (`REASON_CALL_BACKEND=api`, `REASON_CALL_MODEL=claude-sonnet-5-5`, with
  `thinking: between_tools` since PR #59). The cage runs texts on the API too (see Launch B), never
  on this Mac's `claude`. `test/live.js` gates every live test on the `claude-cli` backend, which is what
  keeps `npm run test:offline` green with no credentials. Real-model turns are **not
  deterministic** — assert on what landed in the database, never on wording.
- **No test ever spends Reason's paid API key** (since 2026-10-25, after $10 went overnight on
  builders' real-model lanes with `claude-opus-5-5`). `test/paid-key-guard.js` is loaded before every
  test file (`--import` in both `npm test` scripts, and by `test/live.js`): it deletes
  `ANTHROPIC_API_KEY` from the test process and, when one was there, sets `REASON_BACKEND=claude-cli`
  so the lane still runs — on the subscription. Every opt-in real-model lane (flow-*, the proactive
  eval, the intent and harm lanes) therefore runs through `claude`. Only `REASON_TEST_ALLOW_API=1`
  keeps the key, and `test/live.js`'s label then says so; set it only for a lane that has to prove the
  API path itself, and say so in the PR. Never run a lane with `node --env-file=.env --test` and no
  `--import ./test/paid-key-guard.js`. Pinned in `test/api-spend.test.js`. The subscription those
  lanes use is this Mac's `claude` login — the same one live Reason replies on (see Launch B) — so a
  full real-model run competes with live replies for the 5-hour limit: run the one lane the change
  touches, not all of them.
- **Where each model call runs** (2026-10-25, `src/spend.js` header): replies, extraction, the
  profile, the judge, the watcher, photo notes and the said-ledger's record on the **subscription**
  (extraction and the profile through the background lane, `src/background.js`: one job at a time,
  ≥15 s apart, never while a reply turn is in flight, parked while the CLI reports a limit — never
  an API fallback); the harm screen, purchase-topic, the one-thought sorter and the pre-send check on
  the **API, `claude-haiku-5-5`**, cached instructions, with the CLI as fallback when the API cannot
  answer; **calls** on the API exactly as configured. Every call is counted in `model_usage` by
  feature (`$` estimated off `config.apiPrices`; CLI runs counted without `$`); the /ops row
  **"API spend today / 7d by feature"** goes red when a paid call is refused for credit and amber past
  `REASON_API_DAILY_CAP_USD` (default $1), and texts the owner through the sustained-alert path.
  Refusals for credit are counted on that row, but the text is the **"Pre-reply checks"** row's
  (`api_fallback`, `fallbackCheck` in `src/spend.js`): red while the latest paid side-check call was
  refused for credit, or the last three all failed — read off `model_usage`, not a time window, so a
  quiet night is not a recovery. Once sustained it texts the owner ONE line in his words ("The API
  key ran dry, so the pre-reply checks switched to the subscription; replies may be a few seconds
  slower until you top up." + the /ops link, `alert` on the check), and ONE "Back on the API: …"
  (`recovered`) when a paid check works again. Cage drive (2026-10-25, key blanked): seed two
  `low_credit` rows and an `ops_checks` `api_fallback` row 10 min old with a node script (this
  Mac's `sqlite3` is refused under `~/.openclaw`; set `REASON_VERIFY_RUN=/tmp/…`), insert a
  `page_sessions` row for the owner conversation, `POST /ops.json action=check` with the
  `reason_page` cookie → `serve.log` shows the one text, a second pass `texted:false`, and after one
  recorded successful `harm` call the one "Back on the API". Pinned in `test/api-spend.test.js`
  ("owner: …").
  Read it on live: `sqlite3 -readonly /opt/reason/data/reason.db "SELECT feature, via, COUNT(*),
  ROUND(SUM(cost_usd),4) FROM model_usage WHERE at > (strftime('%s','now')-86400)*1000 GROUP BY 1,2"`.
- The live Sendblue line is **+1 (656) 216-7455** since 2026-10-23, a dedicated `inbound_only` line
  (the shared +1 808 line is gone from the account). Reason can only text people who have texted it
  first, which is why the website's "Text Reason" button is an `sms:` link to that number. Sendblue's
  verified-contact routes (the old ~10-person cap) no longer exist: `/v3/verified-contacts` answers
  `verified_contacts_not_available`. The 2026-10-12 doctor output naming +1 808… is history.
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
  cage.** `REASON_PAGES_URL=https://files.reason.omarinyarko.com` (both this Mac's `.env` and
  Hetzner's, read 2026-10-24; it was `https://reason.omarinyarko.com/p` before) builds the page link
  as `https://files.reason.omarinyarko.com/<id>?k=…`, no `/p`; `REASON_PUBLIC_URL=https://reason.tail3753c7.ts.net` builds `/img/…`. Swap either
  host for `127.0.0.1:<caged port>` before curling.
- Worktrees have no `.env`; `ln -s ~/Desktop/pa/.env <worktree>/.env` (gitignored) before
  `caged.sh start` from one, or the cage comes up with no backend.
