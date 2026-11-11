---
name: verify-reason
description: Launch, doctor, drive, deploy and prove Reason (~/Desktop/pa). Use before claiming any user-facing change works — inbound messages, pages, location shares, generated images, the confirm gate, shopping, AgentCard, flight search and events — and before and after deploying to Hetzner.
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
tool-shaped, gate-shaped or adapter-shaped. ~3,600 tests (see Baseline), no credentials, no network: the
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
  `model: the Anthropic API (…)` — if it says "the claude CLI", stop, unless you chose the CLI below.
  **The one deliberate exception: a text turn on the subscription** (since #227, 2026-10-27, every
  text-side model call is CLI-only, so this is the only way to see the harm screen, said check,
  mid-turn read or extraction run on the cage). `REASON_VERIFY_BACKEND=claude-cli
  REASON_TEST_NUMBERS=+12025551234 bin/caged.sh start` (with no `.env` the cage's owner is that
  number; without `REASON_TEST_NUMBERS` startup refuses: "claude-cli with sendblue set up and no
  test numbers"). The key stays blank — never add `REASON_VERIFY_ALLOW_API`. Each turn spends the
  live subscription's 5-hour limit: a handful of turns, never a suite. Recipe and evidence in
  [features/inbound-message.md](features/inbound-message.md) ("The harm screen beside the turn").
- **Its own data dir** (`REASON_DATA_DIR=$RUN/data`). Page cards, previews and illustrations are
  written under it; before 2026-10-23 a caged page landed in the checkout's real `data/cards`.
- **Uber blanked** (`UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`) alongside texting, calling and AgentCard.
  So are the flight sources (`SERPAPI_API_KEY`, `DUFFEL_ACCESS_TOKEN`, since 2026-11-07, start and `env`):
  a cage `flight_search` on a checkout with a `.env` would otherwise spend the owner's monthly allowance
  (`src/flightproviders.js:314`); blank, it answers `unavailable` with the Google Flights link.
- **Reason's paid API key blanked** (`ANTHROPIC_API_KEY=`, since #115 on 2026-10-25: no verification
  spends it; `caged.sh env` blanks it too, for in-process drives). Startup then says `NO ANTHROPIC_API_KEY set, so no turn can run` and the Anthropic
  provider row reads `not set up` — drive tools (Drive 2) and routes (Drive 3). A webhook text
  still runs the road up to the model and stops there, which is the core-path proof the cage can
  give: `{"harm_screen_skipped":"no_model"}`, `{"turn_failed":"dm:owner","why":"Could not resolve
  authentication method…"}`, the "on it" text refused (`started_message_failed` … not connected),
  then `{"webhook":"sendblue","status":200,"delivered":1}`; a call turn answers "Sorry — something
  broke on my end. Say that again?" with `lookups: []` (2026-10-25). Only
  `REASON_VERIFY_ALLOW_API=1` keeps the key, on purpose, and the PR says so.
- **Optionally, a fake Sendblue** (`REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:<port>`, loopback
  only): fake keys + `SENDBLUE_API_BASE` at `bin/fake-sendblue.mjs`, so sendblue reads `live` but
  every request lands on this Mac. The one exception to "both channels `not_connected`" — a
  not-connected channel is refused before the outbox, so the outbox's failure paths and the alerts
  they raise can only be driven this way ([features/ops-alerts.md](features/ops-alerts.md)). Start
  the fake first and check its "fake sendblue on" line: if its port was taken, the cage would post
  to whatever owns it.
- **No phone line** — `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` blanked, so
  GPT-Live (the only call voice) reports not connected, nothing dials, and every Twilio-signed
  GPT-Live webhook here refuses a signature made for the live install (403).

The cage still reads every other key from `.env`, so some drives spend money or reach the network:
a web search (whichever `REASON_SEARCH_PROVIDER` this Mac's `.env` names), `page_create`'s
illustration and picture search (export `GEMINI_API_KEY= OPENAI_API_KEY=` and pass
`pictures: { search: null }` — see [features/pages.md](features/pages.md)), and
`subscription_cancel_start`, which drives a real browser to the merchant's sign-in page.
Startup also prints `Reason is up · <date>`, the model backend, and the sweep interval. State
lives in `$TMPDIR/reason-verify/` (`pid`, `port`, `secret`, `owner`, `serve.log`, `reason.db`),
plus the `images/`, `profiles/` and `shots/` roots it creates up front.

**`serve.log` carries the router's own decision log**, because `caged.sh` runs `serve.js --log`.
That flag is the only thing that turns it on (`src/serve.js:33`, `verbose = process.argv.includes("--log")`; without it `log` is `() => {}`),
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
155 files read the same; at `b04eb74` (after #109, pid started 03:53:03 UTC on 2026-10-25) all 161; at `f3669e8` (after #129, pid started 18:25:17 UTC) all 170. A DIFFERS is a real deploy gap — check it.

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

   **A per-file deploy goes through the same staging.** On 2026-11-07 (#385) `rsync -av --files-from`
   straight from the Mac into `/opt/reason` carried uid 502:staff onto every directory on the path
   (`src/`, `assets/`, …, mode 0700), so the `reason` user could not open `src/serve.js`: "Cannot find
   module", restart loop for ~35 s until `chown reason:reason` on those paths. After any copy:
   `cd /opt/reason && find src assets scripts test web-island .agents -not -user reason` → empty.

   No `--delete` on the second rsync: `/opt/reason` holds `data/`, `.env` and `node_modules/`,
   which are the server's own. If `package-lock.json` changed, run `npm ci --omit=dev` in
   `/opt/reason` as `reason` before the restart. A schema change is tried first on a copy of the
   live `reason.db` (scp it down, run the new code's `db.js` against the copy) before any of this.
   A column added only inside a `CREATE TABLE IF NOT EXISTS` never reaches live — the table is
   already there — so every new column also needs an `addColumnIfMissing`. On 2026-10-25 live's
   `accounts` had no `state`: reads fell back to "active", writes (`admin_pause/resume/remove`, the
   harm pause) would have thrown. Check with `sqlite3 -readonly … "SELECT name FROM
   pragma_table_info('<table>')"` on live, never on a fresh test DB. `db.js` needs a
   `REASON_TOKEN_KEY` to load (a throwaway one is fine on a copy), and it migrates the copy before
   anything else fails — pull a fresh copy for a clean before/after.
   If `deploy/reason-watchdog.{service,timer}` are new or changed, install them in their own ssh
   command after the copy: `cp /opt/reason/deploy/reason-watchdog.* /etc/systemd/system/ &&
   systemctl daemon-reload && systemctl enable --now reason-watchdog.timer` (it texts the owner
   straight through Sendblue, so the first run against a healthy Reason must capture nothing —
   `journalctl -u reason-watchdog -n 5`).

4. **Restart only when idle — and idle includes a call still settling.** Run `bin/idle.sh --wait`
   right before the restart and restart only on `IDLE`. Busy is a live call, a call that ended under
   2 minutes ago, or one whose after-call steps began and did not finish (`settle_started_at` without
   `settled_at`). On 2026-10-31 call 57 ended at 19:33:54 and a restart at 19:34:06 — "no live call" —
   killed the turn sending Omari the summary and the audio. Since then a boot finishes such a call
   once (`resumeSettles`, src/calls/postcall.js: `after-call: finished N call(s)` in the journal), but
   that is the net, not the plan: the cut-off line ("you were saying something as I hung up") is lost
   on a resume. Every builder waits.

   **Idle also means no sign-in in progress and no checkout running.** On 2026-11-10 restarts at
   22:38:55 and 22:45:33 UTC killed two live Notion sign-ins mid-flow: those sessions live only in the
   process. The process now writes what it holds to `data/busy.json` (src/busy.js, its own pid; kind +
   site + a one-way id, nothing personal), and idle.sh reads it — or, on code from before it, the
   running pid's journal. A `shop_runs` row `running` touched in the last 30 minutes is busy too.
   **Every deploy kit restarts through `/root/reason-restart.sh`** (scripts/safe-restart.sh; it runs
   `/root/reason-idle.sh` = this idle.sh with `REASON_LIVE_SSH=local`, waits up to 20 min, restarts,
   checks health). Never `systemctl restart reason` by hand in a deploy; `--force` is for a rollback
   only, and the report says it was forced. When copying a new idle.sh, also copy it to
   `/root/reason-idle.sh` (`chmod 700`).

   **Then restart in its own ssh command, and prove a NEW process started AFTER the copy.** On
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
   "same as this tree", `sweeping` yes, `sendblue` live, `process started` after the copy,
   `watchdog timer` `ActiveState=active` with a recent `LastTrigger`, `GET /alive` JSON. Watch
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
Since #352 (2026-11-07) `/health` without the operator's signed-in `reason_page` session names
nobody: `owner` is null (doctor drops the "· owner" part), `holding` rows have no
`conversation_id`, a contact's `channel_limits.scope` reads `contact` and `why` has addresses
taken out; Reason's own line numbers (`channels[].number`, `line:` scopes) stay. Every count is
where it was. To see whose message is held, read `pending_inbound` over ssh, not `/health`.
The non-zero exits include **`STALE`** (since 2026-11-06): a local process serving another checkout than this one,
or started before `HEAD` was committed. Before that the cwd and the two times were only printed, and a
cage left running from `~/Desktop/pa-speed6` for eight days read all clear against a newer worktree.
`caged.sh start` answers `already running` for any cage in the default run dir, whoever started it —
leave somebody else's alone and start your own beside it: `export REASON_VERIFY_RUN=$TMPDIR/reason-verify-<name>
REASON_VERIFY_PORT=<free port>` for `caged.sh start|env|stop` and `doctor.sh caged` alike.
On live it also reports the outside watchdog (`reason-watchdog.timer` state + last run,
`data/watchdog.json`'s age) and the server's own `GET /alive` on its `REASON_PORT` (8788);
`ActiveState=inactive` with no last run, or `/alive` → `not found`, means that code is not deployed.
Live doctor sends **no POST** by default: the AgentCard webhook probe (an unsigned POST, 401 =
failing closed) runs only with `REASON_DOCTOR_POST_PROBE=1`.

## Drive

**Sign-in sessions are hashed (2026-11-08).** `page_sessions.token` holds `sha256(token)` hex, never
the cookie. Every "temporary owner `page_sessions` row" in a feature file means: make it with
`db.startPageSession(pageId, token, { conversationId })` (or INSERT `db.sessionKey(token)`), send the
raw token as the cookie, and delete it by `db.sessionKey(token)` — a raw INSERT opens nothing, is
hashed at the next boot, and then a delete by the raw token silently misses, leaving a live 90-day
session. /ops opens only on a `page_id 'ops'` session in the `reason_ops` cookie, and every POST to it
needs a same-origin Origin.

**Keys for a drive never go on a command line (2026-11-08).** A call-quality drive on Hetzner ran
`sudo -u reason env -i …` with the OpenAI key and the Claude token written inline before `node`; `env`, `sudo`,
`ssh host "…"` and `docker -e` all make an inline `NAME=value` part of argv, so `ps` showed both keys
to every user on the box. A drive that needs a real key reads it from a 0600 env file with
`node --env-file`, made by `bin/drive-env.sh` (names in, path out; values never touch argv):

```bash
E=$(sudo -u reason .agents/skills/verify-reason/bin/drive-env.sh OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN)
sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason USER=reason LOGNAME=reason \
  REASON_DB_PATH=$(sudo -u reason mktemp -d)/q.db node --env-file="$E" .agents/skills/verify-reason/bin/<drive>.mjs …
rm -f "$E"
```

On the Mac, the test token: `E=$(mktemp) && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(security
find-generic-password -s reason-test-claude-token -w)" > "$E"` (`printf` is a shell builtin), then
`env -i … node --env-file="$E" …; rm -f "$E"`. Never `KEY=… node`, never `--key`, never a key inside
an ssh command string. `test/no-secrets-on-argv.test.js` fails on any inline credential in skills,
scripts, docs or shell files (dummy values such as `cage`/`cage-fake`/`probe-not-a-key`/`x` are fine).

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
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
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
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
curl -s "http://127.0.0.1:$P/health" | node -e 'console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync(0,"utf8")),null,2))'
curl -si "http://127.0.0.1:$P/p/<id>?k=<owner-key>" | head -40    # 401 + the code gate: a fresh curl is a new browser (features/pages.md)
curl -si "http://127.0.0.1:$P/p/<id>"                             # the same page without the key
curl -si "http://127.0.0.1:$P/img/<file>.png" | head -5           # a generated image
```

Routes are enumerated in the header comment of `src/http.js`: 20 routes there (GET and HEAD), including
`GET /alive` (the watchdog's cheap read, #133), `GET /i/{token}` (also `/p/i/{token}`, the invite page — #104, dark behind `REASON_INVITES_OPEN`),
`/img/{name}.(png|jpg|webp|gif)` (`imgRoute`), `/p/{id}/card.png`, `/p/{id}/preview.mp4`,
`POST /access/web` (the website's form, via `WEB_ACCESS_PATH`) and `POST /agentcard/webhook`. The
comment is missing routes that exist in the code: five OAuth callbacks — `/spotify/callback`,
`/github/callback`, `/uber/callback`, `/x/callback`, `/google/callback` (`googleCallbackRequest`);
`grep -n '_callback:' src/http.js` finds them — plus `/spotify/join`, `POST /parallel/webhook`,
`POST /ops/usage` (the Mac's signed usage push), the event pages `/e/{id}` and
`/e/{id}/(join|who|signin|signout)` (also under `/p/`), `/ops` and `/ops.json` (behind a password when `REASON_OPS_PASSWORD_HASH` is set, else the texted
code; on the cage both answer **401** without the sign-in. This Mac's `.env` has no hash
(2026-11-07); `caged.sh` passes one through from the shell, so start with a throwaway hash to drive
the password gate; never read or change a real hash), and the site's static files (`/`, `/privacy`, `/terms`, `/og.png`,
`/favicon.svg`, `/apple-touch-icon.png`, `/reason.vcf` + `/reason-<sha8>.vcf`). Line numbers churn; grep. It says so itself — *"Every route is matched by a
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

**5 — A phone call, turn by turn, with no phone.** Every call is GPT-Live over Twilio
(`src/calls/gptlive.js`); GPT-Live hands each turn to Reason in process (`reasonTurn` → `llmRequest`
in `src/calls/voice.js`). There is **no HTTP route to a call turn** (the old `/calls/elevenlabs/*`
routes are gone and 404), so call turns are driven in process, on a throwaway database, by the
drives in `bin/` — never against the cage's API key:

```bash
# no model at all: replays stored owner calls through the real turn with a scripted model seam
node bin/call-filler-drive.mjs …            # header comment says which private inputs it reads
# real model on claude-cli (never the API): who-are-you on an own call, another user's, a business
D=$(mktemp -d) && REASON_DB_PATH=$D/id.db node bin/call-identity-drive.mjs
# the cage's GPT-Live routes, no model: inbound TwiML (unsigned → 403) and the dead ElevenLabs paths (404)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:$PORT/calls/elevenlabs/llm
```

The cage cannot place or receive a real call (no Twilio keys), and the GPT-Live session drives
(`gptlive-drive.mjs`, `gptlive-inbound-drive.mjs`, `gptlive-line-drive.mjs`) need a real
`OPENAI_API_KEY` — they are owner-run, not part of a no-model pass. Prove latency on Hetzner, not
here. See [features/call-completeness.md](features/call-completeness.md) and
[features/gptlive-calls.md](features/gptlive-calls.md).

Machines on a call Reason places (a recording, a menu, a mailbox, hold) are driven on the real model
through claude-cli, not the cage and not the API:

```bash
D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/machines.db \
  node bin/call-machines-drive.mjs        # five cases from live call 45's words, "ok" each
```

See [features/call-machines.md](features/call-machines.md).

GPT-Live as the voice (`REASON_CALL_VOICE=gptlive`, operator only) is driven with a real GPT-Live
session and Reason's real turn on claude-cli behind a fake Twilio stream: `bin/gptlive-drive.mjs` (one question)
and `bin/call-quality-drive.mjs` (a whole own call from a clips dir: holding lines, answer length, talk-over), on
Hetzner, see [features/gptlive-calls.md](features/gptlive-calls.md).

**6 — A scheduled call, with the fake provider.** "Call me at 7": the real `timer_set`, the real
Runtime sweep and `call_place`, the fake call provider and the fake channel, in process under the
cage's env. No model, no phone, nothing leaves the machine.

```bash
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/timer-call.db node bin/timer-call-drive.mjs   # 20 steps, "all ok"
```

See [features/scheduled-calls.md](features/scheduled-calls.md).

**7 — Reason Web memory + chat history, over real HTTP.** The page, CORRECT/FORGET as links, the form
posts and the script's JSON posts, guesses yes/no, at volume (counts, Show N more, a filter, the guess
card, search with pen underlines), chat history (days, a day read-only, search, 404, signed out),
cross-account and cross-site refusals, checked against the store, `recall` and the profile note. The
filer gets a scripted reader; no model is called.

```bash
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/mem.db node bin/web-memory-drive.mjs   # 27 steps, all ok
```

See [features/web-memory.md](features/web-memory.md) and [features/web-history.md](features/web-history.md).

**8b — Reason Web drafts (`REASON_WEB_DRAFTS`), one real claude-cli turn in Chromium.** A scratch
instance on this Mac (never Hetzner, never `.env`) with the switch on; the reply must show as a draft
before the saved line lands, and no draft may be left behind. Steps and env in the feature file.

```bash
node bin/web-drafts-drive.mjs http://localhost:8799 "$TOKEN" "$OUT" "how do i get from lisbon airport to the centre?"   # "ok — first words …"
```

See [features/web-drafts.md](features/web-drafts.md).

**9 — The first-chat onboarding, end to end, on its own cage.** Two brand-new numbers (a hello, and a
request first; `REASON_ONBOARDING=test` for those numbers only) through the real webhook, router and
outbox onto `bin/fake-sendblue.mjs`; the reads and the one request's turn on the subscription. Own run dir + port:

```bash
REASON_VERIFY_RUN=/tmp/rv-onboarding REASON_VERIFY_PORT=8823 bin/onboarding-drive.sh evidence/<UTC>-onboarding   # "all ok" (13 checks)
```

See [features/onboarding.md](features/onboarding.md).

### Baseline — event help line (2026-11-11, PR #488 event-help-line, not merged, no flag)

Scoped maintain pass for [features/events.md](features/events.md) "Help line". Offline: `test/event-help-line.test.js`
14/14 (link + iOS/Android/other sms shapes, off → 404 + new code on; https-only ticket link; the public page's three
items under the description + preview line; brand-new number via code: account `helpline_event`, no access request, no
onboarding/cards/contact card, never `joined_via_event`; limited tools in the list AND at runTool, no address before
the password, a guest after it; limited even with auto-admit, not counted by `signupsFull`; voice + honesty prompt;
existing user keeps their own Reason; organizer's own text not counted; relay both ways, per-person cap, off stops
questions, host name sanitized; guessing (5 misses), spam (busy line once/hour), declined number kept out; manage-page
block + answer from the page). `bin/events-drive.mjs` under `caged.sh env` + temp DB: all ok, 129 steps, 8 new `hl:`
steps. SQL ratchet baseline +11 event-level statements (code lookup, counts, organizer-checked answer) and the
`signupsFull` statement re-keyed. Suite: 6,533 tests, 0 failing from the branch; 7 ops tests (`ops.test.js`,
`ops-gate.test.js`, `ops-password`) fail on this Mac only because the disk is 83% full (server check → warn) — env,
not code. **Not provable here:** a real model's wording in the help-line voice, iOS/Android Messages actually opening
from an in-app browser (Instagram), Posh's page accepting the link.

### Baseline — paid events (Stripe Connect tickets; 2026-11-11, PR event-paid, not merged, flag off)

Scoped maintain pass for [features/events.md](features/events.md) "Paid events". Offline: `test/event-paid.test.js`
16/16 against a fake Stripe (`STRIPE_API_BASE` on 127.0.0.1; nothing reaches Stripe). `bin/events-drive.mjs` under
`env -i` + temp DB: all ok, 120 steps, 17 new `pay:` steps (price before payouts → one setup link on the events
domain; account.updated readies payouts and texts the organizer; $25 quote = $26.06 total / organizer $24.37; a right
password by text gets the Checkout link + 15-min hold, not a join; the Checkout is a destination charge with the fee
and two lines; asked twice = same link; completed webhook joins + receipt + welcome, duplicate changes nothing; an open
hold counts against the cap; the sweep releases it after 15 min and expires the page; event_guests shows who paid;
refund by text needs the yes pinned to the amount, refuses an unknown guest first, reverses transfer + refunds fee,
guest leaves and is told; dashboard login link; cancel refunds everyone). Suite after the rebase on #405: see the PR
body. `event_refund` added to `GATED_ACTIONS` + `NEVER_STANDING` (trustline test); eventpay's id/session/intent-keyed SQL
added to `test/fixtures/unscoped-sql-baseline.json`. **Not provable here:** Connect — the Stripe account answered
"You can only create new accounts if you've signed up for Connect" (test mode, 2026-11-11); real Checkout, Apple Pay,
real webhooks, the Express onboarding page.

### Baseline — table pictures (render_table, PR #463, 2026-11-10, not merged, flag off)

Offline suite in the worktree (fresh `npm ci`, `ANTHROPIC_API_KEY=` + paid-key guard): 6,352 tests, 6,212 pass,
**0 fail**, 140 skipped (148 s). New: `test/render-table.test.js` (24, no browser) and
`test/render-table-png.test.js` (real Chromium → `/tmp/render-table-preview/`: light, dark, 10-row split; 2160 px
wide, 150–325 KB, 220–680 ms a picture). Not provable here: Sendblue fetching the public address (live host only).
See [features/table-images.md](features/table-images.md).

### Baseline — the card's CVC after Face ID + paid-row ledger release (cvc-recollect, #411, 2026-11-08)

Offline suite under `env -i` (fresh `npm ci` in the worktree): 5,814 tests, 5,681 pass, 131 skipped, 2 fail — web-ongoing "the desktop margin" (date-dependent, fails on main too) and pages-busy-buttons "name=value" (load flake: 4/4 alone on the branch and on main; an earlier full run also flaked ops "a check's 'since'", 33/33 alone). New: `test/cvc-recollect-1108.test.js` (15; 12 source mutations all caught). Drives: `bin/passkey-drive.mjs` all ok with new scenario (k) (Face ID → "Enter your card's 3-digit code to finish." → Finish → paid with the same intent; Crossmint's island stood in at the network layer); `bin/spend-unknown-drive.mjs` all ok. Every Crossmint fake now answers `GET /api/unstable/order-intents/{id}` (payRow reads the rails before handing the intent over). See [features/passkey-pay.md](features/passkey-pay.md) "The card's CVC after Face ID".
### Baseline — event guest questions (up to 3 questions on joining, optional or required; ask guests already in; 2026-11-11, PR #405)

Scoped maintain pass for [features/events.md](features/events.md) "Guest questions". Offline:
`test/event-guest-questions.test.js` 14/14 (+3 on 2026-11-11: required by page and by text with the held password,
required on/off rules, ask_guests gated + sweep rules); full `npm run test:offline` after the rebase on #467: SUITE_NUMBERS.
`bin/events-drive.mjs` under `caged.sh env` + temp DB: all ok, 103 steps, 22 `ask:` steps (the 10 from 11-08, +12:
required yes names it; join page REQUIRED tag + browser `required`, blank refused; text join `needs_answers` → in once
answered, welcome then; required can't be cleared; ask_guests yes with names + text, 3 owed, night holds, morning sends
each once, second ask has nobody; optional again with answers standing). Not proven: the real model asking a required
question before "you're in", a live ask text arriving. The SQL ratchet baseline gained the per-event statements.

### Baseline — event edit-limits (guest-list privacy + cap after creation; 2026-11-08, PR event-edit-limits, not merged)

Scoped maintain pass for [features/events.md](features/events.md) "Guest-list privacy and the cap after
creation". Offline: `test/event-edit-limits.test.js` 11/11. `bin/events-drive.mjs` under `caged.sh env` + temp
DB: all ok, with 6 new `limits:` steps (cap under the count takes nobody off and closes joins, texting nobody;
no cap reopens; showing a private list asks for the yes first naming who is asked; with it nobody unchosen is
listed; each is asked once; hiding is quiet). Not proven: the real model reading a texted request, a live
send of the ask, the `list_chosen` backfill on a copy of live.

Owner decisions 2026-11-08 (yes to all three, before merge): ask once behind the yes; the organizer goes on
their own list when it's shown; the full wording stays. Maintain pass: features/events.md decisions line;
events-drive +2 `limits:` steps (organizer listed + told; full wording, no waitlist) → 8 `limits:` steps, all ok.

### Baseline — event some-guests (message only some guests; 2026-11-08, PR event-some-guests, not merged)

Scoped maintain pass for [features/events.md](features/events.md) "Message only some guests". Offline:
`test/event-some-guests.test.js` 17/17; full `npm run test:offline` under `env -i` passes except the known
web-ongoing desktop-margin test. `bin/events-drive.mjs` under `caged.sh env` + temp DB: all ok, with 5 new
`some:` steps (guest_id on the list, gate target + `reaches` name who, a non-guest pick refused before a yes,
only picked unmuted guests texted, a scheduled pick sent once to the picked guest only). Not proven: the real
model picking guests from a texted request, and a live send.

Owner decisions 2026-11-08 (maintain pass before merge): "joined since" reads
`event_attendees.first_joined_at` (new column, backfilled from `joined_at` on boot; a rejoin keeps it),
muted guests sit in the pick list unlabeled, the section is "Message guests". `test/event-some-guests.test.js`
19/19 (+2: rejoin not new, muted unlabeled); events-drive all ok with a 6th `some:` step (left and came back →
joined-since reaches 0). Migration tried on a `.backup` of live `reason.db` in `/tmp/rtrial` on the box:
three columns added, 7/7 attendees backfilled, `integrity_check` ok. Hetzner over the public IP can crawl
(~7 KB/s scp on 2026-11-08); the Tailscale address `100.100.152.2` was the one that finished.

### Baseline — security holes (sec-holes, 2026-11-08)
`npm run test:offline` under `env -i`: 5,681 tests, 5,525 passing, 25 failing — exactly main fa3f487's 25 (video.test.js without yt-dlp, web-ongoing #5), none new. New: `test/sec-holes-1108.test.js` (5). What changed for a driver: **`page_sessions.token` is sha256(token) hex** — a drive that reads or edits a row by token must use `db.sessionKey(token)` (web-drive, web-settings-drive updated; Web Settings' sign-out handle is `sessionHandle(db.sessionKey(token))`); rows from before are hashed in place on boot. **/ops opens only on its own sign-in** (page_id `ops`) in its own cookie `reason_ops` (host-only, SameSite=Strict); a Web `reason_page` cookie no longer opens it, an old ops-made `reason_page` still does and is moved. **Every POST /ops** must be same-origin (Origin/Referer = the ops host or the Funnel, never files./events.; Sec-Fetch-Site same-origin if sent) or it is 403. **opspassword.clientIp** believes only the signed website address or Caddy's (loopback + X-Reason-Caddy), else the socket. **localUpload** reads a Web upload only for its own conversation (explicit `conversationId`, else the zonescope turn). Drives: web-drive 15/15, web-settings-drive 29/29, signin-link 10/10, events-drive 64/64, web-memory-drive 27/27, web-settings-index 13/13.

### Baseline — call-hearing (quiet-speech lift, ask once, no therapist tone, turn_log; 2026-11-08)

Scoped maintain pass for the GPT-Live hearing change ([features/gptlive-calls.md](features/gptlive-calls.md),
"What it hears"). Doctor live rc 0 before the drives. Offline: `test/call-hearing.test.js` 16/16. On Hetzner (code
copied to /tmp, recordings never copied off): `bin/call-hearing-levels.mjs` on call 76, quiet −45.0 → −30.4 dBFS, loud
unchanged, 0 clipped. `bin/gptlive-drive.mjs --expect hearing` with real GPT-Live + claude-cli (test token, scratch
config): the −51 dBFS clip went from wrong (off, 2/2) to right (on, 2/2), and `calls.turn_log` was written with level/boost.
Not proven: a real phone call.

### Baseline — the monthly free tier + sign-up ceiling (trial-rules, 2026-11-09, not merged)

`npm run test:offline` in the worktree: 6,001 tests, 5,870 passing, 131 skipped, 0 failing. New
`test/free-tier-monthly.test.js` (13). `bin/free-tier-drive.mjs` all ok; `bin/paywall-drive.mjs` all ok
(flag unset = old trial unchanged). Live needs `REASON_FREE_TIER=monthly`; see [features/paywall.md](features/paywall.md).

### Baseline — #385 bubble-only contact photo LIVE + the paywall ON (2026-11-07)

origin/main `cf415f7` (#385 on `b047383`): 5,610 tests, 5,478 passing, 131 skipped, 1 failing (web-ongoing
"the desktop margin", date-dependent, fails on main too). Live, read-only, nothing sent:
`bin/contact-card.mjs --live https://reason.tail3753c7.ts.net --files https://files.heyreason.com` ok
(PHOTO sha256 `a703eb17…` = `assets/reason-contact.jpg`, the files domain serves the same
`/reason-f5964369.vcf`); `/apple-touch-icon.png?v=<ICON_VERSION>` = `94b4a094…` 180×180; `/pay/done` and
`/pay/back` 200 (the paywall is on); `/p/<id>` 401 signed out; `ops_state.paywall_on_since`
1794094636519, 14 accounts before it. `bin/paywall-drive.mjs` 23 ok + all ok (offline).

### Baseline — release 11-07b (spend-alert + shop-small + call-pickup)

Branch `rel-1107` (origin/main `bb0b91b` + #374 spend-alert, #376 shop-small, #379 call-pickup);
suite: see release. Scoped maintain pass, no model on the API, nothing sent: `bin/spend-alert-drive.mjs`
(new) 16/16, `bin/spend-unknown-drive.mjs` 14/14, `bin/passkey-drive.mjs` 23/23 (step e relabelled 30 min),
`bin/recall-figures-drive.mjs` all ok, in-process call-pickup probe (opener words, μ-law, stub TTS,
outcome labels, /ops pickup row, one mailbox text) 17/17; `test/spend-alert`, `call-pickup`,
`call-goalmet`, `call-machines` and the shop-small files pass on their own. `scripts/shop-fit-drive.mjs`
on claude-cli: 4/6 then 5/6 (the PR said 6/6) — `checkFit` came back `unclear, error:true` in 3 of 12
calls and fails open. `bin/gptlive-line-drive.mjs` not run (real OpenAI key + GPT-Live: Hetzner, owner-run).
New feature file: [tool-limits.md](features/tool-limits.md). A worktree whose `node_modules` is empty
cannot load `src/` (no `@anthropic-ai/sdk`) — check `ls node_modules/@anthropic-ai` before a drive.

### Baseline — release 11-07 (recall-rank + unverified-plus)

Release head `36db733` (branch `rel/unverified-fix`: origin/main `8a1fe18` + #354 recall ranking /
`busy_timeout` + #335 no "(unverified)" / receipts say "them" / unchecked prices dropped / money words
within 4 words / forget clears recall + `recall_reindex`), suite run as
`env -i HOME=$HOME PATH=$PATH node --import ./test/paid-key-guard.js --test test/*.test.js`:
**5,415 tests, 5,283 passing, 131 skipped, 1 failing** — `test/web-ongoing.test.js` "5. the desktop
margin" ("the margin types the day"), date-dependent and failing the same on main `8a1fe18`
(5,359 / 5,227 / 1). `test/video.test.js` needs `yt-dlp` on `PATH`: a minimal `env -i PATH` without
`~/.local/bin` gives 26 pass / **24 fail** there — that is the "25 failing on main" report, not a
regression; keep `PATH=$PATH` from a shell that has it. New feature files this release:
[recall.md](features/recall.md), [no-false-done.md](features/no-false-done.md),
[security-boundaries.md](features/security-boundaries.md); `bin/recall-figures-drive.mjs` 19/19 at
`36db733` (and 4 FAIL + a missing table at `8a1fe18`). `bin/timer-call-drive.mjs` (20/20) and
`bin/web-convo-drive.mjs` (18/18) repaired the same day — both were stale against #326 / `7a1476d`.

### Baseline — free flight sources (free-flights, 2026-11-06)

`node --test test/*.test.js` under `env -i`: 5,251 tests, 5,120 passing, 131 skipped, **0 failing** (main c6ce172: 5,235 / 5,104 / 0). New: `test/flight-providers.test.js` (17, recorded SerpApi + Duffel bodies in `test/fixtures/flights/`). Drive on the real model, no flight keys: `bin/flights-unavailable-drive.mjs` — one ask + six task wakes → exactly one message with the Google Flights link. On a Mac the sealed CLI (#336) can't read the Keychain login; write `CLAUDE_CODE_OAUTH_TOKEN` from `security find-generic-password -s reason-test-claude-token -w` into an env file for `node --env-file` ("Keys for a drive" above; the test account's token — never the `Claude Code-credentials` item, which is this Mac's own login) with a scratch `CLAUDE_CONFIG_DIR=$(mktemp -d)`, into the drive's shell only, never echoed. `FLIGHT_DRIVE_FAKE_BLOCKED=1` replays the old refused-Google path on main.

### Baseline — sealed CLI turns (fix/sealed-engine-context, 2026-11-06)

`npm test` (worktree of origin/main 842f41f + this branch, no `.env`): 5,235 tests, 5,104 passing, 131 skipped, **0 failing**. New: `test/cli-sealed.test.js` (4; 3 fail on 842f41f). `bin/cli-seal-probe.mjs` on Hetzner with the branch code and the real CLI 2.1.296: control leaks the operator email + AGENTS.md, sealed run clean. See [features/cli-sealed.md](features/cli-sealed.md).

### Baseline — the paywall win rule (wt/win-rule, #325, 2026-11-01)

`node --test test/*.test.js` under `env -i` (ANTHROPIC_API_KEY empty, fresh `npm ci` in the worktree): 5,139 tests, 5,006 passing, 131 skipped, 2 failing — web-ongoing "the desktop margin" (date-dependent) and order-flow-1031 "pinned 13:56" (load flake), both known and failing on main too. New: `test/paywall-win.test.js` (11; 8 of the first 9 fail on c67e5c9), `test/paywall.test.js` 23 (one done task seeded wherever the ask is expected). Muted drive `bin/paywall-drive.mjs`: 24/24 ok. Fresh review: one blocker, closed in code — `stamps.completions` knows AgentCard orders only, so `plan.wins` adds `shop_runs` placed orders (the live buy path) for both the win and the recap; notes closed: `extended` only under the 30th, `cancel()` says the trial's real length. No schema change; live stays `REASON_PAYWALL=owner`. See [features/paywall.md](features/paywall.md).

### Baseline — the free trial and the subscription (wt/paywall, #323, 2026-10-31)

`node --test test/*.test.js` under `env -i` (ANTHROPIC_API_KEY empty, fresh `npm ci` in the worktree): 5,124 tests, 4,992 passing, 131 skipped, 1 failing — web-ongoing "the desktop margin" (date-dependent, fails on main too). New: `test/paywall.test.js` (23 after the review fixes; the file cannot load on cc35319, `src/plan.js` missing). Muted drive `bin/paywall-drive.mjs`: 14/14 ok. Fresh review: no blockers; its four correctness notes closed in code (the ask always precedes a lapse, a hand-set `free`/`paid` releases on the next turn, `invoice.paid` after a cancel keeps the cancel, a webhook that throws gives its event-id claim back and answers 500). Schema tried on a `.backup` copy of live `reason.db` first: `plan` (15 columns) and `stripe_events` created, `integrity_check` ok, 13 accounts, 0 plan rows. Live ships with `REASON_PAYWALL=off` appended to `.env`; live `.env` already carries a `STRIPE_SECRET_KEY` (an `sk_test_` key) and `STRIPE_PUBLISHABLE_KEY`, no `STRIPE_PRICE_ID` or `STRIPE_WEBHOOK_SECRET`. See [features/paywall.md](features/paywall.md).

### Baseline — No daily call limit for the operator (wt/call-cap-operator, 2026-10-31)

`npm run test:offline` (fresh `npm ci` in the worktree): 5,078 tests, 4,945 passing, 2 failing — web-ongoing #5 "the desktop margin" and onboarding "going quiet … never at night", both known (date / time of day, fail on main too). `withinCap` (src/accounts.js) skips "call" and "call_minutes" for the operator's conversation when `REASON_CALL_CAPS_EXEMPT=operator` (the default; `none` caps him again). One gate covers every path: `call_place` (tools.js) and `overCallCap` (calls/inbound.js, both voices). The per-call ceiling and API spend caps are untouched. Cap tests in call-inbound, timer-call and bland pin `REASON_CALL_CAPS_EXEMPT=none`; the default is proven in accounts.test.js (operator past 12 calls / 45 min allowed, another person capped) and bland.test.js (operator `call_place` past the caps goes through). `scripts/announce.js` gained owner-only `calls-unlimited-1031` (`--to-owner` only).

### Baseline — Daily spending limit per person (wt/spend-cap, #317, 2026-10-31)

`npm run test:offline` under `env -i` (after the review fix, 399c435): 5,048 tests, 4,915 passing, 131 skipped, 2 failing — web-ongoing "the desktop margin" (date-dependent) and onboarding "going quiet: one nudge later" (time-of-day; both fail on main 05a40c4 too, checked). A first run also tripped order-flow "pinned 13:56" and two web-signin tests under load; all three pass alone. New: `test/spend-cap-1031.test.js` (12; fail on 05a40c4: no `src/spendcap.js`). Fresh review found one blocker — a raise's Face ID was prompt-only — closed in code (`confirmChange` → `needs_face_id`, 12th test). Schema tried on a copy of live `reason.db` first: `pay_approvals.kind` added by ALTER (existing rows → `pay`), `daily_caps` + `cap_changes` created, `integrity_check` ok. Wording pins moved in `test/shopping-everyone-1031.test.js` and `test/sites.test.js` (the over-cap line now names Settings → Shopping, never the env var). See [features/spend-cap.md](features/spend-cap.md).

### Baseline — calls to businesses on GPT-Live, phase 3 (wt/gptlive-thirdparty, #316, 2026-10-31)

`node --test test/*.test.js` (ANTHROPIC_API_KEY empty): 5,064 tests, 4,931 passing, 131 skipped, 2 failing — web-ongoing "the desktop margin" and onboarding "going quiet … never at night", both failing on untouched main too (date / time of day); order-flow-1031 "pinned 13:56" flakes on main as well (2/12). New: `test/gptlive-thirdparty.test.js` (29). Drives `bin/gptlive-line-drive.mjs --scene human|ivr|voicemail|hold` all `ok` on the merged code (real GPT-Live + claude-cli). Live flag `REASON_THIRD_PARTY_VOICE=owner`. See [features/gptlive-calls.md](features/gptlive-calls.md) "Phase 3".

### Baseline — Shopping for everyone (wt/shopping-everyone, #315, 2026-10-31)

`npm run test:offline` under `env -i` (fresh `npm ci` in the worktree): 5,034 tests, 4,901 passing, 131 skipped, 2 failing — web-ongoing "the desktop margin" (date-dependent, fails on main too) and order-flow-1031 "pinned 13:56 … never goes out" (load flake: 14/14 alone, three runs; 195/195 with the other shopping suites). New: `test/shopping-everyone-1031.test.js` (7; three fail on afc6ce8). Muted drives: `bin/passkey-drive.mjs` 23/23 and `bin/passkey-drive.mjs --non-owner` 23/23. Live flags `REASON_SHOP_CONNECT`, `REASON_CHOICE_CARDS`, `REASON_PASSKEY_PAY` appended as `on`. See [features/shop-connect.md](features/shop-connect.md) "Everyone".

### Baseline — the card's email rule (wt/card-email-rule, #292, 2026-10-31)

`npm run test:offline` under `env -i` (fresh `npm ci` in the worktree): 4,953 tests, 4,821 passing, 131 skipped, 1 failing (web-ongoing-volume "the desktop margin", date-dependent, fails on main too). New: `test/card-email-rule.test.js` (9). Muted passkey drive: all ok. See [features/passkey-pay.md](features/passkey-pay.md) "The email rule".

### Baseline — a saved card is registered for order intents (wt/card-registration, 2026-10-31)

`npm run test:offline` under `env -i` (fresh `npm ci` in the worktree): 4,926 tests, 4,794 passing, 131 skipped, 1 failing (web-ongoing "the desktop margin", date-dependent, fails on main too). New: `test/card-registration.test.js` (9). Fixtures in passkey-pay, checkout-job, checkout-anticipate and shopconnect tests seed their card `registered = 1`, as does the passkey drive. Muted passkey drive: all ok. See [features/passkey-pay.md](features/passkey-pay.md) "The card's order-intent registration".

### Baseline — Face ID approval survives a payment that fails to start (wt/faceid-approve, #288, 2026-10-31)

`npm run test:offline` under `env -i`: 4,905 tests, 4,773 passing, 131 skipped, 1 failing (web-ongoing, date-dependent, fails on main too). `test/passkey-pay.test.js` +6: a refused order intent reopens the link under a fresh challenge (first assertion replay → `not_verified`, next tap pays, then `link_used`); the page's `failed` screen + 410 copy; counter 0 twice + www. origin; unknown outcome keeps the link used; `shop_status` hands a fresh `approve_url` only when the last link was used up/ran out; `askedFor` plain words. Drive `bin/passkey-drive.mjs` 23 ok / 0 fail; new scenario (j) drives the real page through Crossmint refusing → "Face ID worked. The payment didn't start." → Try again → paid, run stage `paid`, "Paid $26.65" texted; shots `passkey-payment-did-not-start.png`, `passkey-paid-after-retry.png`. Live cause (pay_approval_log 16:23 UTC): `approved` → `pay_failed order_intent_failed` → `rejected link_used`.

### Baseline — checkout anticipates the form (fix/checkout-anticipate-1031, 2026-10-31)

`npm run test:offline` under `env -i` (fresh `npm ci` in the worktree; the main checkout's node_modules lacks `@simplewebauthn/server`): 4,908 tests, 4,776 passing, 131 skipped, 1 failing (web-ongoing, date-dependent, fails on main too). New: `test/checkout-anticipate.test.js` (9; the file does not load on de5943d, `src/shipping.js` missing). `test/checkout-job.test.js` wording pin moved to the clock-time deadline. See [features/checkout-anticipate.md](features/checkout-anticipate.md).

### Baseline — choice cards: one photo short is not a list (fix/choice-cards-fallback-1031, 2026-10-31)

`npm test` under `env -i` (NO .env in the worktree — a copied .env turns on the real-model tests): 4,883 tests, 4,751 passing, 131 skipped, 1 failing (web-ongoing, date-dependent, fails on main too). New: `test/choice-cards-fallback-1031.test.js`. See [features/choice-cards.md](features/choice-cards.md).

### Baseline — purchase approval by passkey (wt/passkey-approve, #285, 2026-10-31)

`npm run test:offline` under `env -i`: 4,867 tests, 4,735 passing, 131 skipped, 1 failing. The failure is web-ongoing, which also fails on main because it depends on the date. New: `test/passkey-pay.test.js`. Muted drive `bin/passkey-drive.mjs` (real HTTP, Chromium with a CDP virtual authenticator as `localhost`, Crossmint stand-in in the process, no texts, no model): setup ceremony, approve → exactly one order intent, replay `link_used`, decline, expired 410, `details_changed`, UV off refused, the texted yes doesn't pay, made-up token 404, flag off 404. Signed-out `/web/connect/passkey` still gets Connect's 410 through the http.js:331 fall-through (see [features/passkey-pay.md](features/passkey-pay.md)).

### Baseline — ride link log carries no link text (fix/ride-link-log, 2026-10-31)

`npm run test:offline` under `env -i`: 4,846 tests, 4,715 passing, 131 skipped, **0 failing**. `ride_link_rebuilt` logs lengths/flags only and `ride_link_rebuild_failed` the error name/code; the new `test/ridelinks.test.js` case fails on b2e9c25 and passes here.

### Baseline — sign-in "couldn't check" + settle race (fix/flight-signin-unknown, #279, 2026-10-30)

`npm run test:offline` under `env -i`: 4,843 tests, 4,712 passing, 131 skipped, **0 failing**. The flights load flake ("no code but signed in", "the press needs a yes") is fixed, not skipped: `browser.settle()` cancels its own pending blank navigation (CDP `Page.stopLoading`) when its goto times out, so a late about:blank can no longer interrupt the next `goto`. `test/flights.test.js` 58/58 in 5/5 runs alongside a full suite (and 5/5 full suites 0 failing). An unknown sign-in probe is retried once, never revokes a live sign-in, and reaches the person as `blocked: "could_not_check_signin"` ("couldn't check right now", never "signed out", no sign-in ask). 8 new tests in `test/signin.test.js` + `test/flights.test.js` fail on f8f2f48/df1b653 and pass here. In-process drive on a fresh cage-env DB with real Chromium: fine → signed in; cut off once → signed in; cut off twice → could_not_check_signin, sign-in kept, flight untouched; signed out → not_signed_in as before.

### Baseline — to-do list (wt/todo-list-v1, 2026-10-30)

4,833 tests / 4,702 pass / 0 fail / 131 skipped (`npm run test:offline` under `env -i`, rebased on origin/main f8f2f48). New: `test/todo.test.js` (24, clock pinned to midday: the wrap-up keeps out of their night). Live: cage plan step on claude-cli + `bin/todo-drive.mjs` all ok — see [features/todo-list.md](features/todo-list.md).

### Baseline — Crossmint only for buys (wt/crossmint-only-buys, 2026-10-30)

`npm run test:offline`: 4,798 tests, 4,667 passing, 131 skipped, 0 failing. New: `test/crossmint-only-buys.test.js` (7). Cage over the subscription (owner, card seeded): the CeraVe ask → store_checkout, no AgentCard tool. See [features/shop-connect.md](features/shop-connect.md) "Crossmint only".

### Baseline — first-chat onboarding (feat/first-chat-onboarding, 2026-10-30)

`npm run test:offline` under `env -i` (rebased on origin/main 5bbd733, after both #270 reviews): 4,791 tests, 4,660 passing, 131 skipped, 0 failing, 0 cancelled (`test/onboarding.test.js` 38, `test/onboarding-migration.test.js` 2; +16 skipped: the opt-in `test/onboarding-live.test.js` — 16/16 on the subscription, sensitive texts + the harm screen included). Cage: `bin/onboarding-drive.sh` 11/11. See [features/onboarding.md](features/onboarding.md).

### Baseline — card + store sign-in paper redesign (wt/card-signin-redesign, #271, 2026-10-30)
4,725 tests / 4,610 pass / 0 fail / 115 skipped (`npm run test:offline` under `env -i`, merged with origin/main a5e3c62). Cage (own port + `REASON_VERIFY_RUN`, owner, real JWT key, no Crossmint server key): 11/11 per [features/shop-connect.md](features/shop-connect.md) drive, plus an Amazon sign-in link → 200, one plain input (email), password sealed, no "Crossmint" in visible copy.

### Baseline — NO_REPLY never reaches a person (wt/noreply-midtext, #272, 2026-10-30)
4,704 tests / 4,589 pass / 0 fail / 115 skipped (`npm test` under `env -i`, branch merged with origin/main 963e3eb). New: `test/no-reply-midtext.test.js` (11), `test/no-reply-sanitizer.test.js` (9). Caged drive over the fake Sendblue: see [features/no-reply-marker.md](features/no-reply-marker.md).

### Baseline — reply to one message on Web (wt/web-reply-to, 2026-10-30)
4,662 tests / 4,547 pass / 0 fail / 115 skipped (`npm test`, worktree of origin/main eb76521 + this branch). `bin/web-reply-drive.mjs`: 27 ok.

### Baseline — place cards show the room (wt/choice-interiors, 2026-10-30)

`npm run test:offline` under `env -i`: 4,605 tests, 4,490 passing, 115 skipped, 0 failing. `test/choicecards.test.js` 42 (look stubbed). Cage over the subscription (owner): places ask → 2 cards, Bluestone's counter (inside) and Devoción's signed storefront; a directory page whose top photos were the neighbours' street views → numbered list, no wrong photo. See [features/choice-cards.md](features/choice-cards.md).

### Baseline — Shop Connect owner-only (wt/shop-connect, 2026-10-30)

`npm run test:offline` under `env -i`: 4,639 tests, 4,522 passing, 115 skipped, 2 failing — both `test/flights.test.js` (known load flake; 56/56 alone). `test/shopconnect.test.js` 16. Cage with `REASON_SHOP_CONNECT=owner` and a real JWT key, no Crossmint server key: owner sees `shop_pay`, a stranger doesn't; owner card link 200 with boot jwt + `frame-src` Crossmint only; stranger's and made-up tokens → 410 "run out"; jwks.json one kid, no private parts. See [features/shop-connect.md](features/shop-connect.md).

### Baseline — choice cards owner-only + listing check (wt/choice-cards, 2026-10-30)

`npm run test:offline` under `env -i`: 4,588 tests, 4,471 passing, 115 skipped, 2 failing — both `test/flights.test.js` (known load flake; 56/56 alone). New: `test/choicecards.test.js` (25). Cage over the subscription with `REASON_CHOICE_CARDS=owner`: non-owner saw no tool; owner got 2 cards in order; "2" → card 2. See [features/choice-cards.md](features/choice-cards.md).

### Baseline — research room + one follow-up (fix/research-room-and-continue, 2026-10-30)

`npm run test:offline` under `env -i`: 4,551 tests, 4,434 passing, 115 skipped, 2 failing — both in `test/flights.test.js` (known flake; 56/56 alone). New: `test/research-room.test.js` (11). In-process drive over the subscription: `bin/research-room-drive.mjs`, 10 steps all ok, see [features/research-room.md](features/research-room.md).

### Baseline — asks run out (fix/stale-asks-expire, 2026-10-30)

`npm run test:offline` under `env -i` (on #252): 4,551 tests, 4,436 passing, 115 skipped, 0 failing. New: `test/stale-asks.test.js` (9, all 9 fail on origin/main); `test/access.test.js` +2 (an access ask lives `REASON_ACCESS_WINDOW_MIN`, and an expired one decides the request expired). Deploy sweep: `node --env-file-if-exists=.env scripts/expire-stale-asks.js --dry-run`, then without. See [features/confirm-gate.md](features/confirm-gate.md).

### Baseline — link-card attachments dropped (fix/link-preview-attachments, 2026-10-30)

`npm run test:offline` under `env -i`: 4,532 tests, 4,417 passing, 115 skipped, 0 failing. New: `test/link-preview-attachment.test.js` (7). Cage over the subscription: 1 turn + 1 ignored part, see [features/inbound-message.md](features/inbound-message.md).

### Baseline — per-person time zone (wt/user-timezone, 2026-10-30)

`npm run test:offline` under `env -i`: 4,525 tests, 4,410 passing, 115 skipped, 0 failing. New: `test/time-zone.test.js` (26). Cage over the subscription: 3 turns, see [features/time-zone.md](features/time-zone.md).

### Baseline — 4,298 pass, 2 flaky after "owner" means this thread (fix/owner-means-this-thread, 2026-10-28)

`npm test` with no .env: 4,414 tests, 4,298 passing, 2 failing, 114 skipped, both in `test/flights.test.js` (`ref` reads `.elements` of undefined under full-suite load). That file alone is 56/56 both with and without this change, so they are a load flake, not a regression. New: `test/owner-means-this-thread.test.js` (11, 8 of them fail on the old code). Real-model lane `REASON_BACKEND=claude-cli node --import ./test/paid-key-guard.js --test test/flow-owner-thread.test.js`: the model sent `to:"owner"` from a tester's thread and it reached the tester. See [features/confirm-gate.md](features/confirm-gate.md).

### Baseline — 4,220 pass, 0 failures after the wax-seal book (wt/stamps-wax, 2026-10-27)

`npm run test:offline` under `env -i`: 4,334 tests, 4,220 passing, 0 failing. New: `test/stamps-wax.test.js` (18); `bin/web-seals-drive.mjs`: 12 steps, all ok. See [features/web-stamps-wax.md](features/web-stamps-wax.md).

### Baseline — the sign-in page is never dead (wt/signin-progress, #299, 2026-10-31)
`npm run test:offline` under `env -i` (fresh `npm ci` in the worktree): 4,972 tests, 4,840 passing, 131 skipped, 1 failing (web-ongoing "the desktop margin", date-dependent, fails on main too). New: `test/signin-progress.test.js` (9). `test/passkey-pay.test.js` decline no longer matches a ms timestamp that happens to contain 4242. Cage drive `bin/shop-connect-live-drive.mjs` 18/18 (real Chromium). Live after deploy (pid 1077161): a made-up token → 410 "This link has expired. Ask me for a new one."; `shop_links.answered_at` present. See [features/shop-connect.md](features/shop-connect.md) "Never a dead page".

### Baseline — 4,175 pass, 0 failures after Stamps (wt/stamps, 2026-10-27)

`npm run test:offline` under `env -i`: 4,297 tests, 4,175 passing, 0 failing, 122 skipped. New: `test/stamps.test.js` (12), `test/stamps-web.test.js` (12); `bin/web-stamps-drive.mjs`: 11 steps, all ok. See [features/web-stamps.md](features/web-stamps.md).

### Baseline — 4,151 pass, 0 failures on main after #217 (00f3300, 2026-10-27)

`npm run test:offline` under `env -i`: 4,273 tests, 4,151 passing, 122 skipped, 0 failing, ~65s.
Every web/events/album/timer drive above (each with `REASON_DB_PATH=$(mktemp -d)/x.db`) all ok;
`doctor.sh live`: pid 713098, all 210 `src/` checksums same as main. Drives refuse to start without
a fresh temp `REASON_DB_PATH`; `caged.sh env` alone is not enough.

### Baseline — 3,952 pass, 0 failures after Reason Web v2 Settings + notifications (wt/v2-settings, 2026-10-27)

v2 Settings edit states 5A–5D (four-value reach honoured by `keptOnWeb`, sign-out-everywhere confirm, invite just made + cancel from Web), L8 busy words, theme switch in Settings only, notifications 8A–8C (`/web/signal`, tab title + filled favicon, in-app line, per-browser notifications), Web icons I1. `test/web-settings-edit.test.js` (11), `test/web-notify.test.js` (13); `bin/web-settings-drive.mjs`: 29 steps, all ok. `npm run test:offline` under `env -i`: 4,075 tests, 3,952 passing; 1 load flake (`flight-search` sidecar) passes alone. See [features/web-settings.md](features/web-settings.md), [features/web-notify.md](features/web-notify.md).
**8 — Reason Web Saved, over real HTTP.** The list (kinds, find, groups), an opened page framed from
its own route, FIND IT IN THE CHAT into the thread, PIN / REMOVE / PUT IT BACK form posts, refusals.

```bash
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/saved.db node bin/web-saved-drive.mjs   # 21 steps, all ok
```

See [features/web-saved.md](features/web-saved.md).

### Baseline — 3,949 pass after Reason Web v2 edge (wt/v2-edge, 2026-10-27)

`npm run test:offline` under `env -i`: **4,072 tests, 3,949 passing**, 1 failing = the known flaky
`test/flights.test.js` sidecar (56/56 alone). New: `test/web-edge.test.js` (12) and
`test/web-edge-browser.test.js` (9 Chromium drives: L6/L7/6B, L3, L3 motion, L4, L5, 9B, E1, E5, F1).
See [features/web-edge.md](features/web-edge.md).

### Baseline — 3,878 pass, **0 failures** after Reason Web Settings (wt/web-settings, 2026-10-26)

`/web/settings` real end to end: reach preference honoured by `src/deliver.js` (`keptOnWeb`), browsers list + revoke, connected, invites, theme per account. 21 pinned tests (`test/web-settings.test.js`, `test/web-settings-migration.test.js`); `bin/web-settings-drive.mjs` under `caged.sh env`: 17 steps, all ok. `npm run test:offline` under `env -i`: **4,000 tests, 3,878 passing, 0 failing, 122 skipped.** See [features/web-settings.md](features/web-settings.md).

### Baseline — 3,786 pass, **0 failures** on main after #167, #166 and Reason Web sign-in (W1, #168, 2026-10-26)

Sign in by number at `/web`, dark behind `REASON_WEB` (W0's foundations merged as #165 the same morning: 3,867 / 3,745 / 0 / 122). Eighteen pinned tests in `test/web-signin.test.js`; `bin/web-drive.mjs` under `caged.sh env` drives form → stranger (same bytes, no text) → Kofi (code through the outbox, keyed `wsign:`) → wrong → right (303 + cookie) → reused → landing → sign-out refused without the secret / cross-site → sign-out → owner-only mode, 14/14 ok; `bin/web-preview.mjs` draws the four PNGs. Run with `env -i` and no `.env` on the W1 branch alone: 3,885 / 3,763 / 0 / 122; with #167 and #166 merged in: **3,908 tests, 3,786 passing, 0 failing, 0 cancelled, 122 skipped.** Domain move (Web at heyreason.com/web, signed Netlify proxy; events on events.heyreason.com, `test/domains.test.js`), on top of #170 + review fixes: **3,918 / 3,796 / 0 / 0 cancelled / 122** (8 pinned). See [features/web-signin.md](features/web-signin.md).

Web composer (2026-10-26): `+` uploads (POST /web/upload, bytes-typed, capped, kept under data/web-uploads), drop anywhere, slips on the line, voice (tap = dictate on the line, hold = Listening; browser speech where it exists, else heard on the server by src/voice.js), and photos / voice notes / file slips in the thread from `/web/media/…` behind sign-in only. Web files go through the same router attachments as a texted photo/PDF and are read from disk by src/media.js. 15 unit + real-HTTP tests (`test/web-compose.test.js`) and 5 Chromium drives (`test/web-compose-browser.test.js`). See [features/web-compose.md](features/web-compose.md). v2 (wt/v2-compose, 10-27): + sheet, slip states + typed limits enforced by the server (photos fitted, .docx/text read), "on it." from `src/doing.js`, voice 4B/4C/4E + L9; 6 more Chromium drives in `test/web-uploads-voice.test.js`; `npm run test:offline` under `env -i`: 3,941 pass, 0 fail.

### Earlier — 3,727 pass, **0 failures** after scheduled calls (wt/timer-call, 2026-10-26)

A timer can end in a phone call: `timer_set` with `then_call` ("call me at 7", a wake-up call) places
`call_place` to the person's own number when it fires, opening with why; refusals, caps and an
unanswered call become one text; "remind me" stays a text. Twenty pinned tests in
`test/timer-call.test.js`; `bin/timer-call-drive.mjs` under `caged.sh env`: 20 steps, all ok. See
[features/scheduled-calls.md](features/scheduled-calls.md). `npm run test:offline` with no `.env`
loaded: **3,849 tests, 3,727 passing, 0 failing, 122 skipped.**

### Earlier — 3,714 pass, **0 failures** after the store-rejected-after-approval fix (2026-10-26)

A null-order_id `order.failed` after an approval is now matched to the waiting purchase by its buy conversation and recorded (`placement_*` columns); the re-confirm says the store rejected the order (code and reason), that the approval was used up so AgentCard needs a fresh one, nothing charged, and sends the new link — never "the approval didn't count"; a second failure on the same cart stops with no third link; every approval text carries the total and the hold ceiling AgentCard's card shows; `purchase_track` carries the failure code and reason; a changed cart on the same conversation starts the count over. Three pinned tests in `test/agentcard.test.js` (`--test-name-pattern="2026-10-26"`). Caged drive 2026-10-26 (port 8813): the incident's own unsigned event bounced 401 fail-closed and `peek.sh schema agentcard_purchases` lists the four placement columns. See [features/agentcard.md](features/agentcard.md). **3,836 tests, 3,714 passing, 0 failing, 122 skipped.**

### Earlier — 3,711 pass, **0 failures** after event albums (#163, 2026-10-26)

One private photo album per event behind `REASON_EVENT_ALBUMS`. Fourteen pinned tests in `test/event-album.test.js` (nine for the album, five for the check-in nudges and check-in by name); `bin/album-drive.mjs` under `caged.sh env` drives note → add → check-in → release (one text) → late upload (none) → expiry (files gone) → the end-of-event nudge → "everyone except" → "everyone" again (nothing), all ok; the cage (`REASON_EVENTS=on REASON_EVENT_ALBUMS=on caged.sh start`) answered `/e/<id>/album/manage?t=<organizer_token>` with the gate ("Text me a code", no album content), the bare path with no cookie 404, the organizer's page with the organizer's `reason_page` cookie (check-in list, "Check everyone in", release button), 404 for a stranger's cookie byte-identical to a dead link, and 200 under `/p/e/…`; `toolsFor(<guest>)` lists the four album tools only with the flag on. Maintenance pass 2026-10-26 at `0b9d2c4`: every citation in the feature file re-grepped, clean. See [features/event-albums.md](features/event-albums.md). **3,833 tests, 3,711 passing, 0 failing, 122 skipped.**

### Earlier — 3,697 pass, **0 failures** after invites for one person (#162, 2026-10-26)

Per-person switch `invite_allowances.enabled`; `scripts/grant-invites.js <number|conversation> <count> [--apply] | --off` (dry run by default, prints the owner's message, never sends). Caged check: with `caged.sh env` exported, insert an account (node:sqlite), run the script dry then `--apply` against the CAGE db, and `toolsFor(conv)` shows the four non-master invite tools while a stranger shows none. Never `--apply` on live without the owner's person + count. No-name invite flow + rename pinned in test/invites.test.js. **3,819 tests, 3,697 passing, 0 failing, 122 skipped.**

### Baseline — 3,687 pass, **0 failures** after the invite card (#159, 2026-10-26)

Per-inviter card `GET /i/{token}/card.png` (also `/p/i/…`; src/invitecard.js, fonts inline from assets/fonts, cached `data/invite-cards/<sha16>.png` by name + INVITE_CARD_VERSION, `assets/og.png` if no browser). Invite og:title "Reason — your personal concierge", description "Free for you, for good.". Caged check: insert an `invites` row (node:sqlite), `curl -o x.png 127.0.0.1:8796/p/i/<token>/card.png` → 200 image/png 1200×630; POST → 405; unknown token → 404. **3,809 tests, 3,687 passing, 0 failing, 122 skipped.**
**Cached pictures carry the pen (2026-10-26, #177 + #178):** the invite card (`INVITE_CARD_VERSION`), the drawn event cover (`DRAWN_COVER_VERSION` in src/eventcover.js; `g-<id>-<hash>.jpg`, `?v=g…`) and the page card (`<id>-r<rev>-<BRAND_ART>.png`, `?v=<rev>-<BRAND_ART>`) are each drawn once and kept. When the pen in `src/pages/brand.js` changes, bump all three. Prove it on the live card's pixels, not the HTML: #175 went live with red pages and orange cards.

### Baseline — 3,682 pass, **0 failures** after the invite page v2 (#156, 2026-10-25)

Invite page `/i/{token}`: heading in the homepage headline face (Instrument Serif italic, Google Fonts link in the head), calling leads the examples, cost line "Nothing. <Inviter> got you in early, and early people never pay for Reason…" over `3b96256`: **3,804 tests, 3,682 passing, 0 failing, 122 skipped**. Caged check: insert an `invites` row into the cage db with `node:sqlite` (external sqlite3 is refused under the OpenClaw state dir), then `curl 127.0.0.1:8796/i/<token>`. `flights.test.js` / `pages-busy-buttons.test.js` can fail under load while a cage or Playwright run shares the machine; rerun alone before calling it red.

### Baseline — 3,672 pass, **0 failures** after the tagline "Your personal concierge" (2026-10-25)

Tagline on the home page, invite page (+ og:description), README, package.json over `dd5412c`: **3,794 tests, 3,672 passing, 0 failing, 122 skipped** (assertions tightened in `test/site.test.js` + `test/invites.test.js`; `bin/tagline.mjs` checks both pages in-process and `--live`).

### Baseline — 3,672 pass, **0 failures** after the card note "Your personal concierge" (2026-10-25)

Card NOTE "Your personal concierge" + REV bump over `0961f7a`: **3,794 tests, 3,672 passing, 0 failing, 122 skipped** (+1 in `test/contact.test.js`; `bin/contact-card.mjs` now checks the NOTE). One earlier full run had 2 `test/flights.test.js` failures under load that pass in isolation (3/3, also on untouched main) — re-run before calling it red. Before that:

Contact card photo brand orange + `scripts/card-to-owner.js` over `780e91a`: **3,792 tests, 3,670 passing, 0 failing, 122 skipped** (+5, `test/contact-card-orange.test.js` — pins the photo sha; the blue one must never return). Before that:

Busy form buttons over `17e6843`: **3,787 tests, 3,665 passing, 0 failing, 122 skipped** (+4, `test/pages-busy-buttons.test.js`). Before that:

Light pages on the site's paper over `7e81701`: **3,783 tests, 3,661 passing, 0 failing, 122 skipped** (+3, `test/pages-paper.test.js`; `test/pages-phone.test.js` table-fade "clean" now relative to the paper card). Before that:

No blue on pages + orange cache-busted favicon over `42df809`: **3,780 tests, 3,658 passing, 0 failing, 122 skipped** (+4, `test/pages-no-blue.test.js`). Before that:

Maintain pass over `d53bd0b` (2026-10-25 18:10): the same 3,776 / 3,654 / 0 / 122 — one run read 3,653 + 1 fail, `test/flights.test.js` "no code but signed in", the load flake below; 56/56 three times alone.

Orange wordmark bubble over `2646137`: **3,776 tests, 3,654 passing, 0 failing, 122 skipped** (no new tests; `test/wordmark.test.js` bubble pins moved from #0A84FF to the brand orange). Before that:

Brand orange #B8460B + wordmark in footers and link cards over `72ac153`: **3,776 tests, 3,654 passing, 0 failing, 122 skipped** (+3, `test/wordmark.test.js`; `documents` pin moved: the printed foot is "Written by" + the wordmark). Before that:

`accounts.state` migration over `87905fe`: **3,773 tests, 3,651 passing, 0 failing, 122 skipped** (+3, `test/accounts-state-migration.test.js`). Before that:

Theme switch everywhere over `2788e26`: **3,770 tests, 3,648 passing, 0 failing, 122 skipped** (+3, `test/theme-everywhere.test.js`; `ops`, `ops-gate`, `pages-intro`, `pages-theme`, `event-cover` pins moved: every page now carries the theme script). Before that:

Announce `--to-owner` over `92a924e`: **3,767 tests, 3,645 passing, 0 failing, 122 skipped** (+2, `test/announce.test.js`). Before that:

Event link card + covers (spec §14) over `c0aea70`: **3,765 tests, 3,643 passing, 0 failing, 122 skipped** (+14 `test/event-cover.test.js`; the +2 skips are `test/event-cover-live.test.js`, the real-model flyer reads — `REASON_LIVE_FLYER=1`, 2/2 on the subscription). Before that:

Announce `state`-column fix over `4979e41`: **3,749 tests, 3,629 passing, 0 failing, 120 skipped** (+1, `test/announce.test.js`). Before that:

Site wordmark over `99612fd`: **3,748 tests, 3,628 passing, 0 failing, 120 skipped** (+3, `test/wordmark.test.js`; `pages-intro` now expects "reasning" with the bubble as the o). Before that:

Owner announcements (`scripts/announce.js`, `test/announce.test.js` +11) over `094fbc6`: **3,745 tests, 3,625 passing, 0 failing, 120 skipped**. Before that:

Immediate alerts + watchdog (#133) over `6015f9f`: **3,734 tests, 3,614 passing, 0 failing, 120 skipped**. Before that, six-digit codes:

Six-digit codes over `d2cabc5`: **3,710 tests, 3,590 passing, 0 failing, 120 skipped**. The browser
files (`pages-browser`, `-intro`, `-phone`, `-theme`) find the gate's box by its label,
`Six-digit code`; run them with nothing else using Chromium — two suites at once time every one out
at 30 s, which reads like a regression and is not.

`npm run test:offline` at `230dc40` (wt/immediate-alerts, `test/incidents.test.js` 19/19): **3,715 tests, 3,595
passing, 0 failing, 120 skipped**. Before it, at `f3669e8` (main after #129, foreground): **3,695 tests, 3,575 passing,
0 failing, 0 cancelled, 120 skipped**. (Events #121–#125 over `5b1c573`: 3,655 tests, 3,537 passing,
0 failing, 118 skipped — the 4 new skips are `test/flow-events.test.js`, the real-model event flows — run them on
the claude-cli subscription: 4/4 on 2026-10-25). Under load `test/flights.test.js` (check-in: "no code
but signed in", "the press needs a yes") failed in about one full run in three during this work and
passed 4/4 alone here and on the pre-events base `ae01d96` — the load flake below, not events.
(Before events — the moment-aware prompt, `wt/moment-aware` (#120) over `21b3940`: 3,569 tests, 3,455 passing, 0 failing,
0 cancelled, 114 skipped; under load `test/flights.test.js:497` and `:510` failed once and passed
56/56 alone on this branch and on main — a load flake, not this change.) (The API hard caps over
`7682af8`: 3,564 / 3,454 / 0 / 110; #118, owner-only booking, over `92de923`: 3,556 / 3,446 / 0 / 110;
#111 over `2d5ff03`: 3,554 / 3,444 / 0 / 110 — the extra skip is the gated live e-ticket reader;
#116 over `5ba31fb`: 3,502 / 3,393 / 0 / 109; #115, the API-spend diet: 3,490 / 3,381 / 0 / 109; 3,486 / 3,377 before
its review fixes; #112 over `5c93467`: 3,459 / 3,350 / 0 / 109, same as #114 over `d0dad69`; `b04eb74`, after PR #109: 3,458 / 3,349 / 0 / 109; `587f67a`, after PR #97: 3,282 / 3,202 / 0 / 80; `226ff17`, after PR #82: 3,169 / 3,097 / 0 / 72; `b44ffc9`, after PR #70: 3,146 / 3,075 / 0 / 71; `b2861c2`, after
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
  and left `test/accounts.test.js:167` and the old provider's test asserting the old
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
| `bin/drive-env.sh NAME…` | Copies only the named keys from `/opt/reason/.env` (or `REASON_ENV_FILE`) into a new 0600 file and prints its path, for `node --env-file`. The only way a drive gets a real key — see "Keys for a drive" under Drive. |
| `bin/caged.sh start\|stop\|status\|env` | The caged instance. `env` prints the exports for driving tools in-process against its database. |
| `bin/delete-coverage-drive.mjs` | Under `caged.sh env`, from the repo root: seeds every table for a test + control person, runs `deleteData`, scans for anything of theirs left. Exit 0 = nothing unexplained, control untouched. See [features/data-delete.md](features/data-delete.md). |
| `bin/recall-figures-drive.mjs` | Under `caged.sh env`, from the repo root, `OPENAI_API_KEY=` and a mktemp `REASON_DB_PATH`: recall ranking + the "nothing saved" filter, forget clearing recall (sealed), the figures gate on the reply and `message_send`, receipts without the operator's name, own-files-only. 19 steps, no model, no network. See [features/recall.md](features/recall.md). |
| `bin/doctor.sh [live\|port]` | Read-only health verdict. Default `live` = Hetzner over ssh: service + pid start, every `src/` file checksummed, `data/` backups, `.env.bak*`, backup timer, `/health`, `reason-watchdog.timer` + `data/watchdog.json` age, `GET /alive`. A port = a local instance. |
| `bin/inbound.sh text "…" \| file <p> \| -` | POST one webhook to the caged instance. Refuses 8787. |
| `bin/peek.sh thread\|inbound\|outbox\|pages\|confirms\|ledger\|schema <t>\|sql "…"` | Read the caged database. `schema` first when a column name is in doubt. |
| `bin/fake-sendblue.mjs <port> <capture.jsonl> [ok\|fail]` | A loopback stand-in for api.sendblue.com: logs every request, answers sends 200 or 400. For `REASON_VERIFY_FAKE_SENDBLUE` and `REASON_WATCHDOG_SEND_URL`. Background it under setsid like `caged.sh` (a bare `&` dies with the agent's command). |
| `bin/cli-seal-probe.mjs [--unsealed]` | What a non-owner's CLI turn puts in front of the model, read off the wire: the real `claude` via `runClaudeCli`, `ANTHROPIC_BASE_URL` on a loopback stand-in (no model, no bill, no message). Must show 0 emails, no AGENTS.md, no repo path; `--unsealed` is the control. See [features/cli-sealed.md](features/cli-sealed.md). |
| `bin/evidence.sh new <slug>` / `run <dir> <name> -- cmd…` | Make an evidence folder; run a command into it. |
| `bin/onboarding-drive.sh [outdir] [before]` | The first-chat onboarding end to end: its own fake Sendblue + cage (claude-cli, two test numbers), seven texts, 13 checks, `transcript.txt` with both sides and the gaps; `before` = flag off. Tears both down. |
| `bin/tagline.mjs [--out <dir>] \| --live <url>` | Tagline "Your personal concierge" on the home page + an invite page (body and og:description), old "lives in your texts" gone. In-process uses its own temp DB and a fake channel; `--live` is one read-only GET /. |

## Feature map

`features/README.md` and one file per user-facing feature: what it is, how a person reaches it, how
to drive it here, and what end state proves it. That map is the maintained source — when you change
behaviour, change its feature file in the same commit.

Reason Web thread scrolling (S2 note, S3 DONE lines, TODAY ↓, L1/L2/L10, SR4): [features/web-thread.md](features/web-thread.md);
`bin/web-thread-preview.mjs` drives and draws it beside the reference boards.

Recall (done things first, no "nothing saved" handed back, forget clears recall): [features/recall.md](features/recall.md). No false "done" (the claim check): [features/no-false-done.md](features/no-false-done.md); `bin/no-false-done-drive.mjs`. Security boundaries (own files, inbound-call secret, `/health` redaction): [features/security-boundaries.md](features/security-boundaries.md).

Sealed CLI turns (no operator email / AGENTS.md / repo path in a person's CLI turn): [features/cli-sealed.md](features/cli-sealed.md); `bin/cli-seal-probe.mjs`.

Reason Web Saved (phone tab S-A/S-B, desktop list + opened page, pin/remove): [features/web-saved.md](features/web-saved.md).
Your pages (the wordmark on a page Reason made → its owner's pages list, sign-in round trip, own only): [features/pages-index.md](features/pages-index.md); `bin/pages-index-drive.mjs` (20 steps).
Reason Web Ongoing (tab, margin, at volume + See all 2A–2C, home rows, details 2A–2E + approval, 9D): [features/web-ongoing.md](features/web-ongoing.md);
`bin/web-ongoing-preview.mjs` draws every state beside the handoff's reference pages. `bin/web-ongoing-live-drive.mjs` proves D5 (margin, rail, tab badge and the phone tab follow live).
Reason Web v2 edge (body=hey + hint, code-error pen, loading L3–L7, E1 404, E5 maintenance switch, keyboard
focus F1): [features/web-edge.md](features/web-edge.md); driven in Chromium by `test/web-edge-browser.test.js`.
Reason Web §4h plumbing (while you were out, take it back, working line counts): [features/web-small-details-plumbing.md](features/web-small-details-plumbing.md); `test/web-4h-plumbing.test.js`.
Reason Web §4h small details (pen writes in, stamp lands, paper grain, late night): [features/web-motion.md](features/web-motion.md);
driven in Chromium by `test/web-4h-motion-browser.test.js`.
Reason Web daily edition Home (REASON_WEB_DAILY; edition table, overnight claude-cli greeting, one question → Memory): [features/web-daily.md](features/web-daily.md); `test/web-daily.test.js`.
Reason Web Stamps + shared stamps (`REASON_WEB_DAILY`; awarding at real completions, the book, share/revoke, `/s/<id>` + og card, redaction): [features/web-stamps.md](features/web-stamps.md); `bin/web-stamps-drive.mjs` drives and draws it beside `reference/stamps.html`.
Reason Web wax-seal book (`REASON_STAMPS_WAX` on top of `REASON_WEB_DAILY`, or everyone at `REASON_STAMPS_ALL`; seals, patch/ticket/suite key, compliments card + story, Home tile): [features/web-stamps-wax.md](features/web-stamps-wax.md); `bin/web-seals-drive.mjs` drives and draws it.
Reason Web shell (wordmark text + nowrap, logo → `/web?home`, link cards for `/web`, `/privacy`, `/terms`): [features/web-shell.md](features/web-shell.md).
Walking directions, Route + Escort, and real trips (`REASON_DIRECTIONS` off/`owner`/on; the `directions` tool, trips at `/d/<id>` behind the code gate; `/d/sample` with `REASON_DIRECTIONS_SAMPLE`; MapLibre, no tiles/key; suncalc night switch): [features/directions.md](features/directions.md); `test/directions.test.js`, `test/trips.test.js`; `bin/directions-drive.mjs` (muted: `--mute-audio` + a speech recorder, never a sound) drives the walk, diffs the hand-off's 48 screens, and walks a real trip through the gate: the door line from OpenStreetMap, arrive-by vs event wording, the trip deleted on arrival and END ESCORT, walking on after "turn around" (154/154 at the iPhone branch); `bin/directions-iphone.mjs` checks the page at iPhone size under Safari's bar (21/21).
Pages Reason makes v2 (`REASON_PAGES_V2`; LIVE since 2026-10-27, #196 — start the cage with `REASON_PAGES_V2=1`): [features/pages-v2.md](features/pages-v2.md); `scripts/pages-v2-preview.mjs` + `scripts/pages-v2-compare.mjs`. Print (§4h-8, `src/pages/print.js`): same file, "Print"; `pages-v2-preview.mjs <dir> --print`.

Research room (fair page share per planned query, big-question caps, one background follow-up per run, per-person daily cap): [features/research-room.md](features/research-room.md); `test/research-room.test.js`, `bin/research-room-drive.mjs`.

First-chat onboarding (`REASON_ONBOARDING`; opener → name → what it means → "what do you want to call me?" → the card under that name → one thing to try, a call or an event; no "what do you do"; detours, one nudge, existing accounts exempt; event + invite joiners too): [features/onboarding.md](features/onboarding.md); `test/onboarding.test.js`, `bin/onboarding-drive.sh`.

Per-person time zone (`REASON_TZ_ASK`; guess + ask once before the first clock-time action, held action finished by the answer, travel asked once, `config.tz` = their clock inside their turn/page): [features/time-zone.md](features/time-zone.md); `test/time-zone.test.js`.

Reason Web reply to one message (`REASON_WEB_REPLY` off/`owner`/on; button, composer line, quote lines, read as an inline reply): [features/web-reply.md](features/web-reply.md); `test/web-reply.test.js`, `bin/web-reply-drive.mjs` (HTTP + Chromium + touch).
Reason Web notes + file chips (no flag; a shared location / inline reply / contact card drawn as a tag, never the model's note — no coordinates, no tool instructions, no U+FFFD "?"; a file Reason texted is a chip linking `/web/media/m/<row>/<i>`, served from `outbox.media.file` only for the signed-in conversation and only inside the documents/images roots; inline only pdf/raster image/audio/video/text, else attachment): [features/web-notes.md](features/web-notes.md); `test/web-notes.test.js`, `test/web-file-chip.test.js`; `bin/web-notes-drive.mjs` (real HTTP, caged, no sound): 12 steps incl. another person 404, signed out 404, symlink out of the root 404.

Reason Web audio chips (no flag; voice notes and call recordings play inline, owner-only `/web/media/m/<row>/<i>`, .caf → .m4a in `data/web-audio`, Range for iPhone): [features/web-audio.md](features/web-audio.md); `test/web-audio-chip.test.js`, `bin/web-audio-drive.mjs [--shots=DIR]` (HTTP + WebKit + Chrome).

Purchase approval by passkey (`REASON_PASSKEY_PAY` off/`owner`/on — `on` for everyone since 2026-10-31, as are `REASON_SHOP_CONNECT` and `REASON_CHOICE_CARDS`, see features/shop-connect.md "Everyone"; needs `REASON_SHOP_CONNECT`; `/web/connect/passkey` setup, `/web/approve/{token}` Face ID link, one use, 5 min, bound to the payment row; with a passkey saved, a texted yes never pays): [features/passkey-pay.md](features/passkey-pay.md); `test/passkey-pay.test.js`, `bin/passkey-drive.mjs [--shots=DIR]` (HTTP + Chromium virtual authenticator, muted).

To-do list (`REASON_TODO` off/`owner`/on; the plan, the one yes, the list's call grant, the checklist page, the wrap-up): [features/todo-list.md](features/todo-list.md); `test/todo.test.js`, `bin/todo-drive.mjs` (whole road on claude-cli with the fake call provider on).

## Facts worth not rediscovering

- **A no-key cage is not model-free.** Background memory extraction always runs `claude -p` on haiku
  (`src/extract.js` `extractMessages`), so a memorable webhook text on any cage spends one subscription
  run and writes real `person_facts` rows (seen 2026-10-30: `extraction|cli`, 2 facts). Drive a handful
  of texts, not a burst.
- **The design handoffs moved** to `~/Desktop/Project files/Reason/handoffs/` (2026-10-30). Pass the
  folder explicitly to `bin/web-thread-preview.mjs` and `bin/web-preview.mjs` if their defaults miss.
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
  so every `bin/inbound.sh` drive is unreachable until it is topped up — drive
  tools (Drive 2) and routes (Drive 3) instead, and do **not** switch the cage to the CLI except for
  the few text turns Launch B's subscription exception allows. Do not
  spend Reason's key to find out either (no "one Haiku call" check since 2026-10-25): read the live
  /ops "API spend" row, or `model_usage.low_credit` on Hetzner. Model-turn proof comes from the
  real-model test lanes, which run on the subscription (see below) — prompt evals that only need the
  model, not the cage, included: see the proactive-catches entry in [features/README.md](features/README.md).
- **On the cage, an API-backend turn can end with no words** and the reply becomes the hardcoded
  "ugh my bad, something broke on my end. say that again?" (`src/agent.js:568`). Seen 2026-10-23:
  `memory_page` → `request_done` → an empty final message, 1 of 3 identical asks. Live runs the
  `claude-cli` backend and has never sent that line, so it is an API-path gap; re-ask before calling
  a feature broken.
- `REASON_BURST_QUIET_MS` is the window an arriving message waits in to see whether more of the
  same thought is coming (default 2500ms since 2026-10-28, was 4000ms; Web `REASON_BURST_QUIET_WEB_MS` 500ms; capped at `REASON_BURST_MAX_MS` 10000ms). `caged.sh` sets it to **0**, so a webhook runs its turn
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
- **Where each model call runs** (since #227, 2026-10-27, `src/spend.js` header: never bill the
  API): **every text-side model call is on the subscription**, with no API path and no API
  fallback — replies, extraction, the profile, the judge, the watcher, photo notes, the
  said-ledger's record (extraction, the profile and the record through the background lane,
  `src/background.js`: one job at a time, ≥15 s apart, never while a reply turn is in flight,
  parked while the CLI reports a limit), and the three per-message side checks: the **harm screen**
  (`claude -p` on `REASON_HARM_CLI_MODEL` haiku, `REASON_HARM_CLI_TIMEOUT_MS` 20 s, run *beside* the
  turn, `Runtime._screen` → `{verdict:"pending", ready, refuse}`; every tool and the reply await
  `ready`), the **one-thought sorter** (`src/onethought.js`, `REASON_MIDTURN_CLI_MODEL` haiku, 12 s)
  and the **said pre-send check** (`REASON_SAID_CHECK_CLI_MODEL` haiku, 8 s, its process pre-started
  with the turn by `said.warmCheck` → `startWarm` in `src/backends/cli.js`). A side call whose CLI
  failed outright trips `sideCallsOut()` (`src/backends/cli.js`): every side call fails fast for
  `SIDE_OUT_MS` (30 s). The only paid calls left are **phone calls** and their screen
  (`call_harm`, `REASON_CALL_BACKEND=api`) and the API backend itself, which live does not run.
  So on a `claude-cli` install a `model_usage` row with `via='api'` and a text feature (`harm`,
  `said_check`, `onethought`, `extraction`) is a regression. **Since #329 (2026-11-02, `src/backends/side.js`)
  an install on `REASON_BACKEND=api` runs every side lane — titles, greeting, onboarding read, mid-turn
  read, said ledger, a call's goal, extraction, profile, fact filing, photo looks — on the API key
  with the same prompts and schema** (`sideModelOn()`: CLI always; API only with a key, never under
  the test runner without `setSideApiClient`). Live is still `claude-cli` (read 2026-11-06), so the
  paragraph above is what live does; the cage (`api`, key blanked) has `sideModelOn() === false` and
  runs none of them. The cap and fallback text below are from 2026-10-25 and now
  only bite calls; the "Pre-reply checks" row always reads `ok`, "on the subscription, never the
  paid API". Every call is counted in `model_usage` by
  feature (`$` estimated off `config.apiPrices`; CLI runs counted without `$`); the /ops row
  **"API spend today / 7d by feature"** reads `$X of $cap today · calls $Z of $cap · $Y of $cap this
  month` first. The caps are **hard stops** since 2026-10-25 — see
  [features/api-caps.md](features/api-caps.md): past `REASON_API_DAILY_CAP_USD` ($1) every paid use
  but calls skips the API (`apiOut(feature)` / `callApi` in `src/spend.js`) until local midnight;
  `REASON_API_MONTHLY_CAP_USD` ($10) does the same until the 1st. Calls are never stopped or moved
  by any cap: `REASON_API_CALL_DAILY_CAP_USD` ($2) only texts the owner. Each cap texts the owner once; the midnight lift is silent.
  The **"Pre-reply checks"** row (`api_fallback`, `fallbackCheck` in `src/spend.js`) no longer reads
  `model_usage` or texts anybody since #227: it is always `ok`, "on the subscription, never the paid
  API" (the 2026-10-25 dry-key / "Back on the API" texts and their cage drive are gone with the API
  side checks). Pinned in `test/api-spend.test.js` and `test/never-the-api.test.js` (a fake API
  server sees zero requests from a text turn).
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
  cage.** `REASON_PAGES_URL=https://files.heyreason.com` (both this Mac's `.env` and
  Hetzner's, set 2026-10-26 when the domain moved; before that `https://files.reason.omarinyarko.com`, and `https://reason.omarinyarko.com/p` until 2026-10-24) builds the page link
  as `https://files.heyreason.com/<id>?k=…`, no `/p`; `REASON_PUBLIC_URL=https://reason.tail3753c7.ts.net` builds `/img/…`. Swap either
  host for `127.0.0.1:<caged port>` before curling.
- Worktrees have no `.env`; for verification leave it so — the cage runs on defaults (owner
  `+12025551234`, no `/ops` password, the API backend with no key, so no model turn), which is what
  every no-model drive wants. Never link or copy the real `.env` into a worktree. With no `.env`,
  `REASON_PUBLIC_URL` is unset, so tool URLs come back `http://127.0.0.1:<port>` and page image
  blocks refuse them: export an https `REASON_PUBLIC_URL` for in-process drives.
