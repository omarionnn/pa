# Flight search (SerpApi, then Duffel; the Fli sidecar is out of the path)

Somebody planning a trip asks what flights there are, or when it's cheapest to go. Reason asks a flight
source for live fares and answers with a short list and a Google Flights link per option. **Search
only** — nothing books, holds or pays; the person picks and pays on Google Flights. Shipped in #109
(`b04eb74`, 2026-10-25) on Fli; since free-flights (2026-11-06) the source is
`src/flightproviders.js`: **SerpApi's Google Flights engine** (`SERPAPI_API_KEY`), then **Duffel offer
requests** (`DUFFEL_ACCESS_TOKEN`), then ONE honest "prices aren't available" answer with the link. The
Fli sidecar (`src/fli.js`) was refused by Google from 2026-10-24 and is no longer called; only its
`FliError` and answer shape remain (`src/flightsearch.js:1-5`, `src/flightproviders.js:1-27`). Design
notes: `docs/flight-search.md`.

## Sub-features

- **A search** — `flight_search` (`src/flightsearch.js` `runFlightSearch`): metro airports as a
  comma list per side (≤8), cabin, stops, hour windows, airlines/alliances, layovers, party
  (≤9, lap infants ≤ adults). Returns `search_id`, `applied` (the constraints said back), `found`,
  `headline` ("from $X", never "the cheapest"), `options`, `limits`.
- **A refinement** — `refine_of: <search_id>` plus only what changed; `clear: [...]` drops a field
  back to the default (`mergeConstraints`). A `refine_of` from another conversation is "no flight
  search N for this person".
- **Sources, in order** (`FlightProviders.searchFlights`, `src/flightproviders.js:346`): SerpApi, then
  Duffel, each tried once. Each search is counted per calendar month (UTC) **before** it is sent
  (`db.reserveFlightProviderSearch`) and a source at its cap is skipped until the month turns:
  `SERPAPI_MONTHLY_LIMIT` (default 240, under the free plan's 250), `DUFFEL_MONTHLY_LIMIT` (default
  1000). A search that errors still counts. Each outcome is a `provider_calls` row under
  `flights_serpapi` / `flights_duffel` (`LEDGER`).
- **No source answered** (no key, cap used, or both failed) → `FliError("unavailable")` →
  `unavailable(link)` (`src/flightsearch.js:432`): `kind: "unavailable"`, the Google Flights `link`
  on their route and dates (`askedLink`), and a `say` telling the model to say it ONCE, promise no
  retry, start no task/watch, give no prices from memory. On a wake that isn't their message within
  24 h of being told (`ALREADY_TOLD_MS`, `db.lastFlightsUnavailableAt`) → `alreadyTold`: NO_REPLY and
  finish the task. This replaced the week-of-11-02 "still trying" texts. Other kinds (`blocked`,
  `network`, `timeout`, `parse`, `down`, `internal`) still go through `couldntCheck`; `invalid` is a
  plain `error`.
- **A date sweep** — `flight_dates` (`runDateSweep`): **no source has a fare calendar**, so
  `searchDates()` always throws `unavailable` (`src/flightproviders.js:376`) and a sweep answers with
  the link, even with keys set. One sweep per message is still enforced (`offers.turnState(c).flightSweep`,
  "One date sweep per request", `src/flightsearch.js:542`).
- **A re-check before recommending** — `flight_verify {search_id, option}` (`runVerify`): same
  search again (SerpApi with `no_cache`), same itinerary key → `still_there`, `price_then`/`price_now`;
  gone → `still_there:false` + `fresh_options`; a passed date is refused; a round trip listed by
  Duffel that can't be re-checked is `couldnt_check`, never "sold out".
- **The record** — every search/sweep/verify is a `flight_searches` row (conversation-scoped,
  outcome `ok`/`empty`/the error kind, e.g. `unavailable`).
- **/ops "Flight search"** — `src/ops.js:533` `flightSearchCheck`: `off` with neither key ("no
  SERPAPI_API_KEY or DUFFEL_ACCESS_TOKEN — searches answer with a Google Flights link"); else per source
  `<name> <used>/<limit> this month, N searches today`, `warn` at the cap or after a failed last call.
  `quiet: true` (shown, never texted) unless the last failure is `auth` or `provider` (a bad key).

## How to get to it (user POV)

"flights from nyc to miami dec 12", "no layovers", "what about business", "is that $195 one still
there?". The model expands metros, sets the fields and calls the tools; the reply is a short list with
prices, times, stops and links — or, with no source, one message with the Google Flights link.

## Driving it with the harness

**Offline first** — `node --test test/flight-search.test.js test/flights.test.js test/flight-providers.test.js`
(31 + 58 + 19 = 108 pass on 2026-11-07, rel/verify-maint). The suite hands a fake source in through
`ctx.fli` (`src/tools.js:17189`); `test/flight-providers.test.js` uses recorded SerpApi/Duffel bodies
in `test/fixtures/flights/` and an injected `fetchImpl`, so nothing leaves the process.

**The no-source path on the cage (default; no network).** The cage does NOT blank `SERPAPI_API_KEY` /
`DUFFEL_ACCESS_TOKEN` (`bin/caged.sh` blanks texting, calling, AgentCard and Uber only), so blank them
yourself in the drive process. With `caged.sh env` exported plus `SERPAPI_API_KEY= DUFFEL_ACCESS_TOKEN=`:
`runTool("flight_search", {origin:"JFK,EWR,LGA", destination:"MIA", depart_date:"<future>",
max_stops:"NON_STOP", show:3}, ctx)` → `ok:false, couldnt_check:true, kind:"unavailable"`, a `link`,
the "say it ONCE … Nothing is retrying" `say`; `flight_dates` → the same `unavailable`;
`ops.flightSearchCheck()` → `state:"off"`. Driven so 2026-11-07 (evidence `20261107T1400Z-g2/tool-drive.out`).

**With a real key** — every search spends the owner's monthly allowance (SerpApi free plan 250/month)
and reaches the network: not a verification drive. Prove the source mapping offline.

**The real-model drive** — `bin/flights-unavailable-drive.mjs` (one ask + six task wakes → exactly ONE
message with the link; `FLIGHT_DRIVE_FAKE_BLOCKED=1` replays the old refused path). Subscription
turns: see SKILL.md "Baseline — free flight sources".

## Gotchas

- An `unavailable` is not "no flights": the answer must never say none exist.
- Prices follow the server's IP, so every SerpApi request sends `currency` (USD unless set,
  `src/flightproviders.js:74`).
- No per-flight deep links; the link is a Google Flights search for the route and date, and the option
  names the flight numbers to pick there.
- Fare rules (bags, seats, basic economy) are never checked; an unusually cheap fare says so in `limits`.
- The old Fli recipes (throwaway `uv` venv + `FLI_PYTHON`, `scripts/fli-smoke.mjs` on Hetzner, the
  30-minute Google back-off) drive code that is no longer on the search path; don't use them to prove
  flight search.
