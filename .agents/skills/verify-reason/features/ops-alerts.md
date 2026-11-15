# Ops alerts at the point of failure, and the watchdog outside the process

The owner hears about a failure the moment the code that watched it fail gives up — not on the next
five-minute ops pass — as one alert per kind of failure that updates instead of repeating. And
something outside the process says when Reason itself is down or hung. Code: `src/incidents.js`
(raise / resolve / sweep), the hooks that call it (below), the `incident:<key>` and `watchdog` rows
in `src/ops.js`, `GET /alive` in `src/http.js` (`ops.alive`), `scripts/watchdog.mjs`,
`deploy/reason-watchdog.{service,timer}`. Offline: `test/incidents.test.js` (20 tests at `8113bcf`).

## Sub-features

- **Raised where it fails, final failures only.** Hooks: the outbox giving up on a text
  (`settle` not-retryable or out of attempts, and `resolveUnknown` when Sendblue cannot say if it
  arrived) in `src/outbox.js`; a held action that failed or was stranded (`src/undo.js`); an unknown
  purchase outcome (`noteUnknownOutcome`, `src/trust.js`); a call that could not be placed
  (`src/tools.js`); a task that kept crashing / a reminder given up (`src/runtime.js`); a runtime
  error repeated 3x (`noteError`, `src/ops.js`, `threshold: 3`). A send the outbox will still retry
  is not raised.
- **Only a service down or money texts live (7a1476d, 2026-11-06).** `deliver` in
  src/incidents.js:80-91 texts an incident only when its `area` is in `URGENT_AREAS` —
  `messaging`, `calls`, `purchases` (src/opsdigest.js:136); `actions`, `reminders`, `tasks` and
  `runtime` are held as one line per episode for the once-a-day digest (`opsDigest.hold`, key
  `incident:<key>@<first_at>`; `flush` after `REASON_OPS_DIGEST_HOUR`, default 9). The 5-minute
  pass does the same for checks (`checkIsUrgent`, src/ops.js:821, in `settle`). Tests: `test/incidents.test.js`
  ("a runtime error goes to the daily digest…", "a non-urgent alert's whole episode is ONE digest
  line…"), `test/fewer-gates.test.js` section 4.
- **Spend warnings go live, beside the incidents** (#374, 2026-11-07). Not incidents: `startOps`
  (src/ops.js:947-950) wires `src/spend.js` `startAlerts` + `capWarnings` to `runtime.say(owner,
  digest.scrub(text), { toMaster, idempotencyKey: "ops:…" })` — the 80% daily/monthly heads-up after
  every pass, and the provider usage-limit refusal the moment `recordApi` sees it, once per episode.
  The `api_limit` row ("API usage limit (provider)") is `quiet` like the incident rows. Details,
  texts and the no-model drive (`bin/spend-alert-drive.mjs`): [api-caps.md](api-caps.md).
- **One alert per failure key.** Key = kind of failure, e.g. `send:sendblue:<error_key>`. Repeats
  bump `count` on the same `incidents` row. For an urgent area the owner gets the first text at once (idem key
  `incident:<key>@<first_at>:open`), at most one "Still failing … N times since 3:40pm" an hour,
  and one "Resolved: …". The link to `/ops?focus=incident:<key>` goes as its own bubble, so one
  alert is two outbox rows (`…:open#1`, `…:open#2`).
- **Never about itself.** An outbox row whose `idem_key` starts `incident:` that fails is not
  raised again — a dead channel does not loop. Refusals about the person (opted out,
  `PRE_REPLY_*`, unverified contact) and the console are never raised.
- **Auto-resolve.** The next text out over the same channel **to the address that failed**
  (`incidents.last_addr`, and not itself an `incident:` alert) closes the `send:<channel>:` alert
  ("texts are going out again"); otherwise each ops pass (`incidents.sweep`) closes one quiet for
  30 min. Only an alert that was texted gets a "Resolved" text.
- **Owed.** An alert raised before `incidents.start()` (startup recovery) is kept `owed=1` and sent
  when start() runs.
- **/ops rows.** `incident:<key>` rows (group `alive`, `quiet: true` — shown, never texted by the
  pass), and the pass skips texting a row an open alert covers (`covers`, e.g. `outbox`; texted or
  not yet), so one failure is one text, not two — `ops_state` then holds `alerted:outbox =
  incident@<since>`. A `watchdog` row reads `data/watchdog.json`.
- **`GET /alive`** — unauthenticated, cheap: `{ok, pid, up_s, loop_lag_ms, sweeping, sweep_age_ms,
  sweep_stuck, sweep_stuck_after_ms, open_alerts}`. `sweep_age_ms` is `null` for the first ~15s.
- **The watchdog** (`scripts/watchdog.mjs`, systemd timer every minute on the live server (OVH, root@15.204.113.250)): unit active?
  restarted on its own (`NRestarts` up)? `/alive` answers in 5s? sweep finishing? disk room? A
  problem must be seen on two runs in a row before it texts (a crash and a full disk text at once;
  event-loop lag over 5s needs three runs; a crash stays open 10 min after the last one, so a crash loop is one alert); then one text, at
  most one "still" an hour, and "resolved" only after 3 clean runs in a row. A problem is marked
  texted only when the send succeeded. Texts the owner straight through
  Sendblue's API (`REASON_WATCHDOG_SEND_URL` overrides the endpoint), imports nothing from `src/`,
  keeps state in `$REASON_DATA_DIR/watchdog.json`. `REASON_WATCHDOG_PING_URL` (healthchecks.io;
  not set on live yet — the owner owes the URL) is pinged after every run, `<url>/fail` when a
  problem is seen, never on `--dry`. `REASON_WATCHDOG_FAKE_SYSTEMD` (JSON of
  `ActiveState`/`SubState`/`NRestarts`) stands in for `systemctl show`; `REASON_WATCHDOG_DRY=1` /
  `--dry` prints instead of sending.

## How to get to it (user POV)

Nothing to do: when a text Reason owed somebody can't go, the owner's phone gets "Reason alert:
texts over sendblue are failing." with the error, what was tried, what to check next and the
`/ops` link — never for whom (`openText`, src/incidents.js:207-215; scrubbed by `digest.scrub`). When Reason hangs or dies, the watchdog texts "running but not answering" / "not
running", then "resolved".

## Driving it with the harness

**Offline first:** `node --test test/incidents.test.js` (20 tests: immediate alert, one row per key,
still/resolved, no loop, transient-then-retry never alerts, watchdog two-runs rule).

**Forced send failure in the cage.** A plain cage cannot do this: with sendblue `not_connected` the
router refuses before the outbox (`#ready` in `src/channels/router.js`), so no row, no incident.
Point sendblue at a local fake that refuses every send instead — sendblue reads `live`, but every
Sendblue request lands on this Mac:

```bash
cd .agents/skills/verify-reason; export TMPDIR=/tmp/rvcage   # sqlite3 refuses DBs under ~/.openclaw
mkdir -p /tmp/rvfake; P=18931                                # check the port is FREE first (lsof)
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node bin/fake-sendblue.mjs $P /tmp/rvfake/sb.jsonl fail \
  </dev/null >/tmp/rvfake/sb.log 2>&1 & echo $! >/tmp/rvfake/sb.pid
grep -q 'fake sendblue on' /tmp/rvfake/sb.log &&   # it died on EADDRINUSE otherwise — do not start the cage
  REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:$P bin/caged.sh start
bin/inbound.sh text "hello there"     # no model → "on it" line → outbox → 400 → final failure
sqlite3 -readonly /tmp/rvcage/reason-verify/reason.db \
  "SELECT key,count,texted_at,resolved_at FROM incidents; SELECT id,state,idem_key FROM outbox;"
```

Proves (2026-10-25, `230dc40`): `send:sendblue:cage_forced_failure|1|<ms>|` 4 ms after the failed
send, log
`{"incident":"send:sendblue:cage_forced_failure","count":1,"texted":true}`, outbox rows
`incident:send:sendblue:cage_forced_failure@<first_at>:open#1/#2` (both `failed` — the alert
itself cannot go) and the incident count still 1 (not re-raised). Repeat: a second inbound only
withholds the stall line (`stall_line_withheld`), so to repeat the failure seed queued rows —
`INSERT INTO outbox (idem_key,conversation_id,channel,address,body,state,next_attempt_at,created_at,updated_at)
VALUES ('verify:seed:1','dm:owner','sendblue','<owner>','seed','queued',0,<now ms>,<now ms>)` — and the
15s sweep's outbox pass sends them: `count` climbs on the same row (2 seeds → 5: the seeds plus
the two "heads up — that text … never actually went out" notices, which fail too), then holds; no
new `incident:` outbox rows.

Instead of `TMPDIR=/tmp/rvcage`, `REASON_VERIFY_RUN=/tmp/rv-<n> REASON_VERIFY_PORT=<port>` on every
`caged.sh`/`inbound.sh`/`peek.sh` call works the same (the DB is then `/tmp/rv-<n>/reason.db`, the
pid `/tmp/rv-<n>/pid`; swap 8796 below for that port). A worktree with no `.env` also needs
`REASON_MASTER_NUMBER=+12025551234` on `caged.sh start`, or the inbound lands in the access queue
and no send is attempted. Re-driven 2026-10-27 at `00f3300` that way: the same incident row, log
line and three `failed` outbox rows; the watchdog run below gave 3 sends.

**`/alive`:** `curl -s 127.0.0.1:8796/alive`.

**Watchdog against the cage.** Never without `REASON_WATCHDOG_SEND_URL` pointed at a capture
server — otherwise it posts to the real Sendblue with whatever keys the environment carries.

```bash
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node bin/fake-sendblue.mjs 18932 /tmp/rvfake/wd.jsonl ok \
  </dev/null >/tmp/rvfake/wd.log 2>&1 & echo $! >/tmp/rvfake/wd.pid
mkdir -p /tmp/rvwd; DEF='{"ActiveState":"active","SubState":"running","NRestarts":"0"}'
W() { (cd ../../.. && env -i PATH="$PATH" HOME="$HOME" REASON_DATA_DIR=/tmp/rvwd \
  REASON_WATCHDOG_ALIVE_URL=http://127.0.0.1:8796/alive \
  REASON_WATCHDOG_SEND_URL=http://127.0.0.1:18932/api/send-message \
  REASON_WATCHDOG_FAKE_SYSTEMD="${SD:-$DEF}" \
  REASON_MASTER_NUMBER=+12025550100 SENDBLUE_FROM_NUMBER=+12025550101 \
  node scripts/watchdog.mjs --print); }
W                                                   # healthy → {"seen":[],"texted":false}, nothing captured
kill -STOP $(cat /tmp/rvcage/reason-verify/pid); W; W; W   # hang (5s each) → texted on run 2 only:
                                                    #   "running but not answering (/alive: no answer in 5s)"
kill -CONT $(cat /tmp/rvcage/reason-verify/pid); sleep 2; W; W; W  # 3 clean runs → "resolved" on the 3rd
bin/caged.sh stop; SD='{"ActiveState":"failed","SubState":"failed","NRestarts":"0"}'; W; W  # → "not running (reason is failed/failed)"
grep -c send-message /tmp/rvfake/wd.jsonl           # 3 on 2026-10-25 at 230dc40
```

The `sleep 2` matters: `/alive`'s `loop_lag_ms` is the last 1s tick (`startLoopWatch` in
`src/ops.js`), so runs fired right after `kill -CONT` all read the stop as ~15s of lag and the
third texts a lag alert (lag needs three runs) instead of a clean "resolved" — seen 2026-10-25 at
`a744a3c`; a timing artifact of back-to-back runs, not the minute-apart timer. With the sleep:
alert, resolved, not running — 3 sends.

`env -i` keeps the real `.env`'s Sendblue keys out; run from the repo root without
`--env-file`. `--print` prints `{"seen":[…],"texted":bool}` per run. Never write the default as
`"${SD:-{…}}"`: bash closes the expansion at the JSON's first `}` and appends a stray `}`
when `SD` is set (`Unexpected non-whitespace character after JSON`).

**The 5-minute pass:** the cage's first pass runs 20s after start (`{"ops":…,"texted":…}` in
`serve.log`), the next 5 min later; `/ops.json` answers 401 on the cage (no password hash), so wait
for the second pass (past `ALERT_AFTER_MS`, 4 min). Proof: the `outbox` row in `ops_checks` is
`bad`, `ops_state` has `alerted:outbox|incident@…`, and the pass's own text (it did text — the
cage's Context.dev and embeddings rows) does not mention the outbox.

## Webhook 401 alert (`src/webhookalert.js`, #408 + #410)

Two refused Sendblue deliveries inside 10 min open `webhook:sendblue:rejected` and text the owner;
the next accepted (2xx) delivery resolves it. Only refusals that look like Sendblue's own count
(`looksReal`: a JSON body in Sendblue's shape AND a secret header or `X-Sendblue-Signature`), so a
scanner's `{}` is a journal line, never an alert. `webhook:` incidents are exempt from the 30-min
quiet sweep (quiet = nothing came in, not fixed). Offline: `test/webhookalert.test.js`.

**Caged drive (2026-11-08, `7aedef4`), no model turn:** use a status-callback body
(`{"status":"DELIVERED","number":…,"message_handle":…,"from_number":…}`) so a signed post runs no
turn. `{}` unsigned → 401, no incident; the body with `sb-signing-secret: wrong` twice → 401 ×2, the
incident opens and its text lands on the cage console; the body with `sb-signing-secret: $(cat
$RUN/secret)` → 200 and "Resolved: …" on the console. Read `incidents` with `node:sqlite`
(`readOnly`), not sqlite3 (guarded under `~/.openclaw`). **On live, never post two shaped refusals
— that texts the owner;** one unsigned `{}` is safe.

## A person's flag to the team (`team_flag`, `src/teamflag.js`, 5ba3abb2)

What a person sees: when something is left wrong that Reason cannot fix itself (a sign-out that never
took, a payment with no confirmation), Reason may ask "Can I flag this to Reason's team? I'd send: "…""
with the exact words. Only their typed yes sends it; the operator's thread gets five lines: "Flag from a
Reason user", the masked sender (`+…9876~<hash>`), the time, the quoted report, `Ref: TF-xxxxxx`.
Live state: no switch, on for everyone (`team_flag` in the tool list, `src/tools.js:4480`), never on a
call or an event turn; the operator's lookup `admin_flag_lookup` (`src/tools.js:4603`) is operator-only.

- Code owns the words (`cleanReport`, `src/teamflag.js:121`): one paragraph, ≤400 chars, no links, no
  card/password/code-like strings, no full number, email or street address, no names on record. At most 3
  sent a person a day, 20 from everyone (`PER_DAY` / `ALL_PER_DAY`, `src/teamflag.js:26-28`). The text is
  keyed as an operator notice (`ops:`), like the alerts above.
- The cue is "something new they can choose", never a retry (`offerCue`); see
  [retry-not-offer.md](retry-not-offer.md).
- The operator texts "look up TF-xxxxxx" → `lookupForOperator` (`src/teamflag.js:262`): when proposed and
  sent, the masked sender, the kinds of the last few things Reason did. Never a word of content.
- Offline: `node --test test/team-flag.test.js` (17; all pass 2026-11-14 in the misc group 122/122).
- Drive, no model, nothing sent: the evidence script `evidence/20261114T232201Z-g4-team-flag/team-flag-drive.mjs`
  under `bin/caged.sh env` (or a throwaway `REASON_DB_PATH`): propose → nothing sent, a Ref; the card number
  hidden in the shown words; send before a yes → `not_granted`; a typed yes → one operator text, five lines,
  no full number; resend → `already_spent`; on a call → `on_call`; an event turn → `not_their_turn`; the
  operator's lookup works, a user's → `master_only`. All ok on `7d5b5f54`.

## Gotchas

- `$TMPDIR` here is under `~/.openclaw`, and this machine's sqlite3 guard refuses any DB there:
  export `TMPDIR=/tmp/rvcage` before `caged.sh start` and give sqlite3 the literal path.
- Port 8811 was already taken by a local Python server on 2026-10-25; the fake died on
  `EADDRINUSE` and a cage started anyway would have posted to that server. Check the fake's
  "fake sendblue on" line before starting the cage.
- A schema change to `incidents` needs a fresh cage DB (`caged.sh stop` removes it).
- With every send failing, the next owner turn marks the alert rows told (`undelivered_told`).
