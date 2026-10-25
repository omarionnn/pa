# Claude subscription usage on /ops

The owner opens `/ops` and sees how close each Claude subscription is to its limits, under
**Claude subscriptions**. Shipped in #116 (2026-10-25). Code: `src/subusage.js`, the rows from
`subscriptionChecks` in `src/ops.js`, the line from `trendFor` in `src/pages/ops.js`, the route
`POST /ops/usage` in `src/http.js`, the Mac side in `scripts/usage-reporter.py` +
`scripts/com.reason.usage-reporter.plist`.

## Sub-features

- **Reason's subscription** (`subscription:reason`) — the `claude` CLI logged in on Hetzner as
  `reason`. `5-hour N% · resets … · week N% · resets … · K CLI runs today · read Xm ago`. Amber at
  ≥80% of the 5-hour window ("nearly full — Reason stops replying at 100%"), red at 100% of either
  window or `status: rejected`. Amber/red go through `settle`, so the owner is texted once per
  episode (after the 4-minute blip window), and "back to normal" once when it resets.
- **Where Reason's numbers come from.** A streamed CLI run (pictures) prints a `rate_limit_event`;
  `cliRuns` in `src/backends/cli.js` hands every finished run to `subusage.noteCliRun`, which counts
  it (`provider_calls` as `claude-subscription`) and keeps the reading. Text turns use
  `--output-format json`, which carries no rate-limit field, so `subusage.backstop` reads
  `GET https://api.anthropic.com/api/oauth/usage` with the CLI's token from
  `/home/reason/.claude/.credentials.json` — no model call, at most once per 15 min, only if the CLI
  ran since the last reading, only on `REASON_BACKEND=claude-cli`, never with an expired token.
- **A window that has reset since the reading reads 0% · reset** (nothing used in the new one yet).
- **The coding subscription (Mac)** (`subscription:coding`) — pushed every 10 min by the launchd
  agent `com.reason.usage-reporter`, HMAC-SHA256 over `<ts>.<body>` with
  `REASON_USAGE_INGEST_SECRET` (Hetzner `/opt/reason/.env`; Mac `~/.config/reason-usage/.env`).
  Always `ok` and `quiet`: never amber, never texted. Older than 25 min → "last seen X ago (the Mac
  is asleep or offline)". Never pushed → `off` ("Not set up").
- **The ingest** — 204 kept; 401 bad signature or clock >5 min off; 409 replay (timestamp not newer
  than the last kept); 400 no numbers; 413 >4 KB; 404 when no secret is set.
- **24h line** — the 5-hour % by hour on a 0–100 scale, an hour with no reading carrying the last.
- Only numbers are stored (`subscription_usage`, pruned to two days).

## How to get to it (user POV)

Open `reason.omarinyarko.com/ops`, sign in, open "N checks fine ▸" → **Claude subscriptions**. When
Reason's window passes 80% the row is pinned under "Needs you" and the owner got one text.

## Driving it with the harness

Offline: `node --test test/subusage.test.js` (12, all pinned).

Cage (`bin/caged.sh start`; the cage passes its own secret as `REASON_USAGE_INGEST_SECRET`):

```bash
R=$TMPDIR/reason-verify; S=$(cat $R/secret); P=$(cat $R/port); ts=$(($(date +%s)*1000))
B='{"five_pct":36,"week_pct":45,"turns_today":7}'
sig=$(printf '%s' "$ts.$B" | openssl dgst -sha256 -hmac "$S" -hex | awk '{print $NF}')
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:$P/ops/usage \
  -H "x-reason-timestamp: $ts" -H "x-reason-signature: sha256=$sig" -d "$B"   # → 204
# same again → 409; another secret → 401; ts 10 min old → 401 (each logged as usage_ingest_refused)
bin/peek.sh sql "SELECT source, five_pct, week_pct, turns_today FROM subscription_usage"
```

Seen exactly so on 2026-10-25. The row text: run `ops.runChecks({probe:async()=>({ok:true,status:200})})`
from a module file with `caged.sh env` exported and print `checks.filter(c=>c.id.startsWith("subscription:"))`.

Live (read-only): the rows in `/ops.json` after sign-in, or on Hetzner
`sqlite3 -readonly /opt/reason/data/reason.db "select source,datetime(at/1000,'unixepoch'),five_pct,week_pct,via from subscription_usage order by at desc limit 4"`.
Mac: `launchctl list | grep com.reason.usage-reporter` and `tail ~/.config/reason-usage/reporter.log`
(`pushed 204 · 5h N% · week N% · K requests today`).

## Gotchas

- **Never drive Reason's subscription with a probe turn.** The cage runs on the API backend for that
  reason; the backstop is the only extra request and it is not a model call.
- `caged.sh env` does not export `REASON_BACKEND`, so a `node --env-file=.env` script beside the cage
  reads `.env`'s `claude-cli` and the Reason row says "no reading yet" rather than "not on the CLI
  backend". Harmless — the backstop then finds no `~/.claude/.credentials.json` on this Mac (the
  token is in the keychain) and skips.
- `sqlite3` on the cage DB is refused under the OpenClaw state dir; use `bin/peek.sh sql`.
- The Mac reporter reads the CLI's token from the keychain item `Claude Code-credentials`. It never
  refreshes it: an expired token means a push with counts only until the CLI next runs.
- Stop the reporter: `launchctl bootout gui/$(id -u)/com.reason.usage-reporter`.
