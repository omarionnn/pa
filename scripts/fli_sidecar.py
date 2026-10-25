"""Reason's flight-search sidecar: Fli (PyPI "flights", pinned in scripts/fli-requirements.txt) over stdio.

One JSON object per line in, one per line out:
  in:  {"id": 1, "op": "search_flights" | "search_dates" | "airports" | "ping", "params": {...}}
  out: {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": {"kind", "type", "message", "status"}}

Error kinds Reason acts on: "blocked" (Google refused, throttled or consent-gated us),
"network" (timeout / unreachable), "parse" (Google answered in a shape Fli no longer reads),
"invalid" (bad input), "internal" (anything else).

Fli's own client does the HTTP, with its shipped rate limiter and retries untouched. The
only thing added here is a pass-through that *looks at* each response, because Fli 0.9.0
turns a refused request (HTTP 200 carrying an RPC error, e.g. [13]) into "no results" —
and Reason must never tell someone "no flights" when Google simply said no.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from datetime import datetime

# Run with `python -I`, which leaves the script's own folder off sys.path; the one sibling module
# is added back by its exact path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fli_wire import inspect_body  # noqa: E402

from fli.core import (
    build_date_search_segments,
    build_flight_segments,
    build_time_restrictions,
    parse_airlines,
    parse_alliances,
    resolve_airport,
    search_airports,
)
from fli.core.parsers import ParseError
from fli.models import (
    DateSearchFilters,
    FlightSearchFilters,
    LayoverRestrictions,
    MaxStops,
    PassengerInfo,
    SeatType,
    SortBy,
)
from fli.search import (
    SearchClientError,
    SearchConnectionError,
    SearchDates,
    SearchFlights,
    SearchHTTPError,
    SearchTimeoutError,
)
from fli.search.flights import SearchParseError

try:
    from importlib.metadata import version as _pkg_version

    FLI_VERSION = _pkg_version("flights")
except Exception:  # noqa: BLE001
    FLI_VERSION = "unknown"


class Blocked(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class _Watch:
    """Pass-through around Fli's shared client that records what each response looked like."""

    def __init__(self, inner):
        self._inner = inner
        self.seen: list[dict] = []
        self._lock = threading.Lock()

    def post(self, *args, **kwargs):
        response = self._inner.post(*args, **kwargs)
        note = inspect_body(response.text, str(getattr(response, "url", "") or ""))
        with self._lock:
            self.seen.append(note)
        return response

    def get(self, *args, **kwargs):
        return self._inner.get(*args, **kwargs)


def _client_for(searcher):
    watch = _Watch(searcher.client)
    searcher.client = watch
    return watch


def _check_refusals(watch: _Watch, *, got_results: bool):
    refused = [s for s in watch.seen if s.get("refused")]
    if not refused:
        return
    # A round trip expands several follow-up fetches; if the main page came back and only
    # some follow-ups were refused we still have real results, so only an all-empty answer
    # that came with a refusal counts as blocked.
    if not got_results:
        raise Blocked(refused[0]["why"])


class Unreadable(Exception):
    """Fli broke while reading Google's answer (not while checking our fields): a parse failure."""


def _searched(watch: _Watch, call):
    """Run Fli's search. A refusal seen on the wire wins over whatever Fli raised reading it, and a
    KeyError/ValueError from inside Fli's reader is Google's shape changing — never our input."""
    try:
        return call() or []
    except (Blocked, SearchClientError, SearchParseError):
        raise
    except Exception as e:  # noqa: BLE001
        refused = [s for s in watch.seen if s.get("refused")]
        if refused:
            raise Blocked(refused[0]["why"]) from e
        raise Unreadable(f"{type(e).__name__}: {str(e)[:250]}") from e


def _refused_count(watch: _Watch) -> int:
    return sum(1 for s in watch.seen if s.get("refused"))


STOPS = {
    "ANY": MaxStops.ANY,
    "NON_STOP": MaxStops.NON_STOP,
    "ONE_STOP_OR_FEWER": MaxStops.ONE_STOP_OR_FEWER,
    "TWO_OR_FEWER_STOPS": MaxStops.TWO_OR_FEWER_STOPS,
}
CABINS = {c.name: c for c in SeatType}
SORTS = {s.name: s for s in SortBy}


def _airports(codes: str):
    out = [resolve_airport(c.strip()) for c in str(codes or "").split(",") if c.strip()]
    if not out:
        raise ParseError(f"No airport codes in {codes!r}")
    return out


def _passengers(p: dict) -> PassengerInfo:
    return PassengerInfo(
        adults=int(p.get("adults") or 1),
        children=int(p.get("children") or 0),
        infants_in_seat=int(p.get("infants_in_seat") or 0),
        infants_on_lap=int(p.get("infants_on_lap") or 0),
    )


def _layovers(p: dict):
    lo, hi = p.get("min_layover"), p.get("max_layover")
    if lo is None and hi is None:
        return None
    return LayoverRestrictions(min_duration=lo, max_duration=hi)


def _code(enum_value) -> str:
    return getattr(enum_value, "name", str(enum_value)).lstrip("_")


def _iso(dt) -> str | None:
    return dt.isoformat(timespec="minutes") if isinstance(dt, datetime) else None


def _leg(leg) -> dict:
    return {
        "airline": _code(leg.airline),
        "airline_name": getattr(leg.airline, "value", None),
        "flight_number": leg.flight_number,
        "from": _code(leg.departure_airport),
        "to": _code(leg.arrival_airport),
        "depart": _iso(leg.departure_datetime),
        "arrive": _iso(leg.arrival_datetime),
        "minutes": leg.duration,
    }


def _layover(lo) -> dict:
    out = {"airport": _code(lo.airport), "minutes": lo.duration}
    if lo.overnight:
        out["overnight"] = True
    if lo.change_of_airport:
        out["change_of_airport"] = True
    return out


def _flight(f) -> dict:
    return {
        "price": f.price,
        "currency": f.currency,
        "minutes": f.duration,
        "stops": f.stops,
        "airline_name": f.primary_airline_name,
        "legs": [_leg(l) for l in f.legs],
        "layovers": [_layover(l) for l in (f.layovers or [])],
        "self_transfer": bool(f.self_transfer),
    }


def search_flights(p: dict) -> dict:
    window = p.get("departure_window")
    segments, trip_type = build_flight_segments(
        origin=_airports(p["origin"]),
        destination=_airports(p["destination"]),
        departure_date=p["departure_date"],
        return_date=p.get("return_date"),
        time_restrictions=build_time_restrictions(window) if window else None,
    )
    # Fli puts one window on both legs; "leave after work" is about the way out, so the return
    # leg gets its own (or none).
    if len(segments) > 1:
        back = p.get("return_window")
        segments[1].time_restrictions = build_time_restrictions(back) if back else None
    filters = FlightSearchFilters(
        trip_type=trip_type,
        passenger_info=_passengers(p),
        flight_segments=segments,
        stops=STOPS[p.get("max_stops") or "ANY"],
        seat_type=CABINS[p.get("cabin") or "ECONOMY"],
        sort_by=SORTS[p.get("sort_by") or "CHEAPEST"],
        airlines=parse_airlines(p.get("airlines")),
        airlines_exclude=parse_airlines(p.get("exclude_airlines")),
        alliances=parse_alliances(p.get("alliances")),
        alliances_exclude=parse_alliances(p.get("exclude_alliances")),
        layover_restrictions=_layovers(p),
    )
    searcher = SearchFlights()
    watch = _client_for(searcher)
    top_n = int(p.get("top_n") or 5)
    results = _searched(watch, lambda: searcher.search(filters, top_n=top_n, currency=p.get("currency") or "USD"))
    _check_refusals(watch, got_results=bool(results))
    itineraries = []
    for r in results:
        if isinstance(r, tuple):
            out, back = r[0], r[1]
            item = _flight(out)
            # Fli reads the round-trip total off the outbound row; the return row carries its own
            # price too, which Reason uses only to choose which return to show (src/flightsearch.js).
            item["return"] = _flight(back)
            itineraries.append(item)
        else:
            itineraries.append(_flight(r))
    return {
        "trip_type": trip_type.name,
        "count": len(itineraries),
        "fetches": len(watch.seen),
        # Some follow-up pages (a round trip's returns) refused while the main page answered: the
        # list is partial, and a flight missing from it is not proof it's gone.
        "refused_fetches": _refused_count(watch),
        "itineraries": itineraries,
    }


def search_dates(p: dict) -> dict:
    window = p.get("departure_window")
    round_trip = bool(p.get("round_trip"))
    duration = int(p.get("trip_days") or 3)
    segments, trip_type = build_date_search_segments(
        origin=_airports(p["origin"]),
        destination=_airports(p["destination"]),
        start_date=p["start_date"],
        trip_duration=duration,
        is_round_trip=round_trip,
        time_restrictions=build_time_restrictions(window) if window else None,
    )
    filters = DateSearchFilters(
        trip_type=trip_type,
        passenger_info=_passengers(p),
        flight_segments=segments,
        stops=STOPS[p.get("max_stops") or "ANY"],
        seat_type=CABINS[p.get("cabin") or "ECONOMY"],
        airlines=parse_airlines(p.get("airlines")),
        airlines_exclude=parse_airlines(p.get("exclude_airlines")),
        alliances=parse_alliances(p.get("alliances")),
        alliances_exclude=parse_alliances(p.get("exclude_alliances")),
        layover_restrictions=_layovers(p),
        from_date=p["start_date"],
        to_date=p["end_date"],
        duration=duration if round_trip else None,
    )
    searcher = SearchDates()
    watch = _client_for(searcher)
    results = _searched(watch, lambda: searcher.search(filters, currency=p.get("currency") or "USD"))
    _check_refusals(watch, got_results=bool(results))
    dates = []
    for d in results:
        pair = list(d.date)
        dates.append(
            {
                "depart": pair[0].date().isoformat(),
                "return": pair[1].date().isoformat() if len(pair) > 1 else None,
                "price": d.price,
                "currency": d.currency,
            }
        )
    return {"trip_type": trip_type.name, "count": len(dates), "fetches": len(watch.seen), "refused_fetches": _refused_count(watch), "dates": dates}


def airports(p: dict) -> dict:
    """Local lookup only — no network."""
    matches = search_airports(str(p.get("query") or ""), limit=int(p.get("limit") or 8))
    return {"airports": [{"code": m.code.name.lstrip("_"), "name": m.name} for m in matches]}


OPS = {
    "search_flights": search_flights,
    "search_dates": search_dates,
    "airports": airports,
    "ping": lambda p: {"fli_version": FLI_VERSION},
}


def _error(e: BaseException) -> dict:
    if isinstance(e, Blocked):
        return {"kind": "blocked", "type": "Blocked", "message": str(e), "status": e.status}
    if isinstance(e, SearchHTTPError):
        status = e.status_code
        if status in (403, 429):
            kind = "blocked"
        elif status and status >= 500:
            kind = "network"
        else:
            kind = "invalid"
        return {"kind": kind, "type": type(e).__name__, "message": str(e), "status": status}
    if isinstance(e, (SearchTimeoutError, SearchConnectionError)):
        return {"kind": "network", "type": type(e).__name__, "message": str(e), "status": None}
    if isinstance(e, (SearchParseError, Unreadable)):
        return {"kind": "parse", "type": type(e).__name__, "message": str(e), "status": None}
    if isinstance(e, SearchClientError):
        return {"kind": "network", "type": type(e).__name__, "message": str(e), "status": None}
    if isinstance(e, (ParseError, KeyError, ValueError)):
        return {"kind": "invalid", "type": type(e).__name__, "message": str(e)[:300], "status": None}
    return {"kind": "internal", "type": type(e).__name__, "message": str(e)[:300], "status": None}


def _reply(obj: dict, lock: threading.Lock):
    line = json.dumps(obj, default=str)
    with lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _handle(msg: dict, lock: threading.Lock):
    rid = msg.get("id")
    op = OPS.get(msg.get("op"))
    if op is None:
        _reply({"id": rid, "ok": False, "error": {"kind": "invalid", "type": "UnknownOp", "message": str(msg.get("op"))}}, lock)
        return
    try:
        _reply({"id": rid, "ok": True, "result": op(msg.get("params") or {})}, lock)
    except Exception as e:  # noqa: BLE001
        err = _error(e)
        if err["kind"] == "internal":
            traceback.print_exc(file=sys.stderr)
        _reply({"id": rid, "ok": False, "error": err}, lock)


def main():
    lock = threading.Lock()
    running: list[threading.Thread] = []
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        # One thread per request so a slow search never blocks a ping; Fli's client
        # shares a single global rate limiter across threads.
        t = threading.Thread(target=_handle, args=(msg, lock), daemon=True)
        t.start()
        running = [r for r in running if r.is_alive()] + [t]
    # stdin closed (Reason shut us down): let in-flight answers finish writing.
    for t in running:
        t.join(timeout=120)


if __name__ == "__main__":
    main()
