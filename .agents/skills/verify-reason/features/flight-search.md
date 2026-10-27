# Flight search (Fli)

Somebody planning a trip asks what flights there are, or when it's cheapest to go. Reason reads live
fares from Google Flights' public search through [Fli](https://github.com/punitarani/fli) (PyPI
`flights` 0.9.0, a Python sidecar) and answers with a short list and a Google Flights link per
option. **Search only** — nothing books, holds or pays; the person picks and pays on Google Flights.
Shipped in #109 (`b04eb74`, 2026-10-25). Design notes: `docs/flight-search.md`.

## Sub-features

- **A search** — `flight_search` (`src/flightsearch.js` `runFlightSearch`): metro airports as a
  comma list per side (≤8), cabin, stops, hour windows, airlines/alliances, layovers, party
  (≤9, lap infants ≤ adults). Returns `search_id`, `applied` (the constraints said back), `found`,
  `headline` ("from $X", never "the cheapest"), `options`, `limits`.
- **A refinement** — `refine_of: <search_id>` plus only what changed; `clear: [...]` drops a field
  back to the default (`mergeConstraints`). A `refine_of` from another conversation is "no flight
  search N for this person".
- **A date sweep** — `flight_dates` (`runDateSweep`): Google's fare calendar, ≤93 days, one fetch
  per ≤61-day page; `trip_days` for a round trip, `depart_weekdays` filtered after the fact
  (`sweepView`). **One sweep per message**: a second in the same turn is refused
  (`offers.turnState(c).flightSweep`, `src/tools.js` `case "flight_dates"`).
- **A re-check before recommending** — `flight_verify {search_id, option}` (`runVerify`): same
  search again, same itinerary key → `still_there`, `price_then`/`price_now`, `moved`/`change`; gone
  → `still_there:false` + `fresh_options`; a passed date is refused; a partly refused recheck is
  `couldnt_check`, never "gone".
- **Couldn't check ≠ no flights** — any sidecar failure is `{couldnt_check:true, kind, link}` with a
  `say` line (`couldntCheck`); kinds `blocked`, `network`, `timeout`, `parse`, `down`, `internal`.
  `link` (`askedLink`, #114) is Google Flights on the asked route and date (first airport of a metro
  list), and `say` tells the model to send it, say it couldn't pull live fares, and give no prices
  from memory — a refused search still hands the person something useful.
  `invalid` is a plain `error` (the request was wrong, not the service).
- **The sidecar** — `src/fli.js` `FliSidecar`: started on demand, stopped after 10 idle minutes,
  restarted after a crash (called down after 3 in 5 min), **30-minute back-off after Google refuses**
  (every later call in that window is `blocked` at 0 ms without asking Google). Python is
  `FLI_PYTHON` or `/home/reason/fli-venv/bin/python` (`DEFAULT_PYTHON`).
- **The record** — every search/sweep/verify is a `flight_searches` row (conversation-scoped) and a
  `provider_calls` row for provider `fli` (the call ledger).
- **/ops "Flight search · Fli"** — `src/ops.js` `flightSearchCheck`, read off the LAST REAL SEARCH in
  the ledger, never probed: `off` (not installed), `ok` ("ready · no searches yet" / "healthy · last
  search …"), `bad` (blocked / down), `warn` (any other failure). Since #114 a `blocked`, `network`
  or `timeout` row is `quiet` — shown on /ops, never texted (`settle` skips it); `down` and `parse`
  still text the owner.

## How to get to it (user POV)

"flights from nyc to miami dec 12", "no layovers", "what about business", "cheapest time to fly to
Lisbon in March", "is that $195 one still there?". The model expands metros, sets the fields and
calls the tools; the reply is a short list with prices, times, stops and links.

## Driving it with the harness

**Offline first** — `node --test test/flight-search.test.js test/flights.test.js` (87 pass at
`b04eb74`, 32 + 56 = 88 at `00f3300`); the suite hands a fake sidecar in through `ctx.fli`, so no Python and no Google.
`test/fixtures/fli/` holds recorded Google responses (incl. `refused-rpc13.txt`).

**On the cage, for real (Drive 2).** This Mac has no Fli; make a throwaway venv and point the cage at
it (Python 3.12 — the Mac's 3.9 can't install `flights`):

```bash
uv venv "${REASON_VERIFY_RUN:-/tmp/rv}-fli-venv" --python 3.12
VIRTUAL_ENV="${REASON_VERIFY_RUN:-/tmp/rv}-fli-venv" uv pip install -r ~/Desktop/pa/scripts/fli-requirements.txt
export FLI_PYTHON="${REASON_VERIFY_RUN:-/tmp/rv}-fli-venv"/bin/python    # before caged.sh start AND the in-process drive
```

Then, with `caged.sh env` exported, `runTool("flight_search", {origin:"JFK,EWR,LGA",
destination:"MIA", depart_date:"<future YYYY-MM-DD>", max_stops:"NON_STOP", show:3}, ctx)` →
`ok:true`, a `search_id`, `found` > 0, `headline` "from $…", `applied` saying "nonstop only".
`flight_verify {search_id, option:1}` → `still_there:true`, `price_now`. `flight_dates` over 21 days
→ `swept: "… (21 dates, 1 page fetch)"`; a **second** `flight_dates` in the same turn →
`ok:false`, "One date sweep per request". End state: three `flight_searches` rows for `dm:owner`
(`bin/peek.sh sql "select id,kind,outcome,found from flight_searches"`), `provider_calls` row
`fli` with calls 3 / failures 0, and `flightSearchCheck()` → `ok`, "healthy · last search …".
Seen exactly so on 2026-10-25 from this Mac (37 nonstops, from $195). On 2026-10-27 the same drive
from this Mac came back `couldnt_check`, kind `blocked`, with the route `link`, the sweep at the
back-off, `flight_searches` outcome `blocked` and `/ops` `bad`, `quiet:true` — Google refusing this
Mac's address that hour, not the code; don't retry to "check". `rm -rf "${REASON_VERIFY_RUN:-/tmp/rv}-fli-venv"` after.

Without `FLI_PYTHON` the same drive is the not-installed path: `couldnt_check`, kind `down`, a
`link` ("Flights from JFK to MIA on <date> one way"), and `/ops` reads `off`. That path needs no
Google traffic, so it is the default cage drive; driven so 2026-10-25 at #114.

**The quiet /ops row, no Google traffic** — with `caged.sh env` exported, `db.recordProviderCall({provider:"fli",
day, ok:false, status:0, ms:240, error:"blocked: …"})`, then `ops.flightSearchCheck({sidecar:{installed:()=>true}})`
→ `bad`, `quiet:true`; `ops.settle({report:{at, checks:[row]}})` three hours on → `changes: []`.
Record `"down: …"` instead → no `quiet` key (that one still texts). Re-driven so 2026-10-27. Seen exactly so 2026-10-25.

**On Hetzner — the gated smoke test, once, by hand only** (after an install or a Fli upgrade; never
on a schedule, never from /ops):

```bash
ssh root@91.98.19.150 'cd /opt/reason && sudo -u reason env REASON_FLI_SMOKE=1 \
  FLI_PYTHON=/home/reason/fli-venv/bin/python node --env-file=.env scripts/fli-smoke.mjs --record \
  > /tmp/fli-smoke.out 2>&1; grep -E "\"(name|ok|kind|error)\"" /tmp/fli-smoke.out; rm /tmp/fli-smoke.out'
```

`--record` writes the outcomes to the ledger so `/ops` reads the smoke run as the last search. Read
the row without the page: `sudo -u reason node --env-file=.env -e 'const o=await
import("./src/ops.js");console.log(JSON.stringify(o.flightSearchCheck()))'` in `/opt/reason`.

## Gotchas

- **Hetzner's IP was refused by Google on 2026-10-25.** The post-deploy smoke's first search came
  back `blocked` ("Google returned an RPC error [13] with no data") in 243 ms, and the other three
  cases were the sidecar's own 30-minute back-off at 0 ms. The same search from this Mac, minutes
  later, returned 37 flights. So a `blocked` on live is about the server's address, not the code;
  there is no workaround by design. Don't re-run the smoke to "check" — that is the traffic that
  keeps an address refused.
- **The 2026-10-25 refusal was transient.** One hand-run search from Hetzner at ~09:58 UTC (JFK→MIA,
  no `--record`) returned 136 flights from $210 in 902 ms. Treat a `blocked` as "back off and hand
  over the link", not as "the server is banned".
- **A hand-set `alerted:flights` hold must be deleted after the deploy that needed it.** #114 held
  the owner's alert with one in `ops_state`; it was still there on 2026-10-25 13:23 UTC, half an
  hour after the deploy. Left in place, the next good search is a `told` check gone `ok`, and
  `settle` texts him "back to normal" about a problem he never heard of. Check with
  `sqlite3 data/reason.db "select k from ops_state where k like 'alerted:%'"` after any such deploy.
- **A smoke `--record` that fails turns the /ops row `bad`.** Since #114 a `blocked`/`network`/
  `timeout` row is quiet, but a `down` or `parse` one is texted to the owner by the sustained-alert
  path (`settle`, `ALERT_AFTER_MS`). To test one search without touching /ops, build `FliSidecar({onOutcome:null})`
  in place of the 4-case smoke script.
- **The live sidecar uses `/home/reason/fli-venv` by default** — the unit sets no `FLI_PYTHON`
  (`/proc/<pid>/environ` has none), and `DEFAULT_PYTHON` is that path.
- Prices follow the server's IP (EUR from Germany), so every request sends `curr=USD`.
- No per-flight deep links exist in 0.9.0; the link is a Google Flights search for the route and
  date, and the option names the flight numbers to pick there.
- Fare rules (bags, seats, basic economy) are never checked; an unusually cheap fare says so in
  `limits`.
