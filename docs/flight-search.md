# Flight search (Fli)

Reason searches flights through [Fli](https://github.com/punitarani/fli) (PyPI `flights`, pinned
`0.9.0` in `scripts/fli-requirements.txt`). Search only: nothing books, holds or pays. The
hand-off is a Google Flights link; the person books and pays there.

- `scripts/fli_sidecar.py` — the Python child, one JSON line in and one out, calling Fli's own
  `SearchFlights` / `SearchDates` with its shipped rate limiter and retries untouched.
- `scripts/fli_wire.py` — reads each Google response as data, a refusal or a consent page.
- `src/fli.js` — starts the child on demand, restarts it after a crash (called down after 3 in 5
  minutes), stops it after 10 idle minutes, backs off for 30 minutes after Google refuses.
- `src/flightsearch.js` — field checks, the short list, the limits, the sweep comparisons, and
  re-verification (`flight_search`, `flight_dates`, `flight_verify` in `src/tools.js`).
- `/ops` → "Flight search · Fli", read off the last real search in the call ledger. Never probed. A Google refusal, an unreachable Google or a timeout is shown there and never texted to the owner (nothing he can fix; the sidecar backs off itself); a sidecar that won't start or a page Fli can't read is texted like any other row.

## Integration path, and why

1. **Fli's MCP server (`fli-mcp`)**: tried first, not used. In 0.9.0 it takes adults only, has no
   `top_n` and no weekday filter, flattens Fli's typed errors into a string, and reports a refused
   request as a successful search with zero flights. `pip install flights` also leaves it unable to
   start: `fastmcp` is only in the `[all]` extra.
2. **TypeScript port**: there is no `fli-js` on npm. The repo's port is published as
   `@punitarani/fli` at `0.0.3`, far behind the Python package, so it was not used.
3. **A sidecar of our own over Fli the library**: used. It is the smallest wrapper that keeps
   children and infants, `top_n` and typed errors, and can tell a refusal from an empty result.

## What the installed 0.9.0 does, against its README (checked 2026-10-24/25)

| README claim | Installed 0.9.0 |
|---|---|
| MCP server has two tools, `search_flights` and `search_dates` | **Three**: plus `find_airports`. |
| Per-flight Google Flights deep links | **None** in search results. `booking_token` exists, but it is for Fli's follow-up booking-options call, not a link. Reason links to a Google Flights search for the option's airports and dates, and names the flight numbers to pick there. |
| ~20-45 itineraries per search | `show_all_results` defaults to on: the live one-way metro search returned **300**, and the round trip returned 91. |
| `search_dates` costs one page fetch per date | **One fetch per ≤61-day page** (Google's fare calendar): a 21-day sweep took 0.06s, and 93 days is 2 fetches. |
| Weekday filters on `search_dates` | **CLI only** (a filter applied after the results come back). Reason does the same in `sweepView`. |
| Multi-city raises an unsupported error | **No error**: `TripType.MULTI_CITY` is built and sent, with a note that distinct city pairs may time out. Reason still doesn't price multi-city as one fare. |
| Emissions, bags, exclude-basic-economy unsupported on the current transport | All three are still encoded into the request (`filters[1][10]`, `[28]`, segment `[13]`). Whether Google honours them was not tested, to keep live traffic small. Reason uses none of the three, so fare rules are always "not checked". |
| Error types and a circuit breaker | Typed errors exist: `SearchClientError`, `SearchTimeoutError`, `SearchConnectionError`, `SearchHTTPError(status_code)`, `SearchParseError`. **There is no breaker**, so Reason's 30-minute back-off is in `src/fli.js`. |
| Rate limiting and retries | 10 requests a second (token bucket, shared across threads), and 3 tries with exponential back-off. Used as shipped. |
| `max_stops` values `ONE_STOP`, `TWO_PLUS_STOPS` (MCP descriptions) | The enum is `NON_STOP`, `ONE_STOP_OR_FEWER` and `TWO_OR_FEWER_STOPS`. |

**Currency follows the server's IP.** From Hetzner (Germany), prices came back in EUR, so every
request sends `curr=USD`.

**A refusal looks like an empty result.** Google answers with HTTP 200 and an RPC error payload
(`[["wrb.fr",null,null,null,null,[13]],…]`, recorded in `test/fixtures/fli/refused-rpc13.txt`).
Fli parses that as no results; `fli_wire.py` calls it refused.

## Smoke test

Run it by hand after an install or upgrade. Never put it on a schedule.
`REASON_FLI_SMOKE=1 FLI_PYTHON=/home/reason/fli-venv/bin/python node --env-file=.env scripts/fli-smoke.mjs --record`

`--record` puts the outcomes in the call ledger, so the `/ops` row reads the smoke run as the last real search.
