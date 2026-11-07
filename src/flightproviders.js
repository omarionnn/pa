// Where flight prices come from, since Google Flights stopped answering the Fli scraper (2026-10-24:
// 27 of 27 searches refused the week of 11-02). Two paid-by-the-owner APIs on their free or near-free
// tiers, tried in this order, and then one honest answer:
//
//   1. **SerpApi, Google Flights engine** (`SERPAPI_API_KEY`). The free plan is 250 searches a month.
//      Every search is counted here, per calendar month (UTC), BEFORE it is sent, and at
//      `SERPAPI_MONTHLY_LIMIT` (240 unless set) it is not used again until the month turns — so the
//      plan's own limit is never reached and nothing is ever billed.
//   2. **Duffel offer requests** (`DUFFEL_ACCESS_TOKEN`). Search only — nothing here creates an order,
//      holds a seat or pays. Duffel charges a fraction of a cent per search past its free ratio when
//      nothing is booked, so it is counted the same way and capped at `DUFFEL_MONTHLY_LIMIT` (1000).
//   3. **Neither one answered** (no key, used up for the month, or an error): `FliError("unavailable")`,
//      which src/flightsearch.js turns into ONE message — flight prices aren't available right now,
//      here is Google Flights on your route and dates. No retry loop, no back-off timer to wait out,
//      no "still trying".
//
// Without either key this file sends nothing anywhere: every search is `unavailable` immediately.
//
// Both answers are turned into the same shape the Fli sidecar returned (scripts/fli_sidecar.py
// `_flight`), so the short list, the verify and the booking match in src/flightsearch.js read them
// unchanged: `{ count, source, itineraries: [{ price, currency, minutes, stops, airline_name, legs,
// layovers, return?, link? }] }`, every time an airport's own wall clock (`YYYY-MM-DDTHH:MM`).
//
// Date sweeps (`flight_dates`) have no provider: neither API has a fare calendar, and pricing 93 days
// one search at a time would spend a month of SerpApi in an afternoon. They answer `unavailable` with
// the Google Flights link, whose own date grid shows the same thing.

import { FliError } from "./fli.js";

export const SERPAPI_URL = "https://serpapi.com/search.json";
export const DUFFEL_URL = "https://api.duffel.com/air/offer_requests";
/** Under the free plan's 250, so a few searches in flight at the turn of the month still fit. */
export const SERPAPI_DEFAULT_LIMIT = 240;
/** ~$5 a month at Duffel's excess-search rate, if every one of them were billed. */
export const DUFFEL_DEFAULT_LIMIT = 1000;
export const SERPAPI_TIMEOUT_MS = 40_000;
/** Duffel waits up to `supplier_timeout` for the airlines, then answers with what it has. */
export const DUFFEL_SUPPLIER_TIMEOUT_MS = 20_000;
export const DUFFEL_TIMEOUT_MS = 45_000;
/** The most itineraries kept from one answer; the short list shows at most 8. */
export const MAX_ITINERARIES = 40;

export const LEDGER = { serpapi: "flights_serpapi", duffel: "flights_duffel" };

const env = () => process.env;
const limitOf = (name, dflt) => {
  const n = Number(env()[name]);
  return Number.isFinite(n) && n >= 0 && String(env()[name] ?? "").trim() !== "" ? Math.floor(n) : dflt;
};
export const monthOf = (at) => new Date(at).toISOString().slice(0, 7);

// ---------- SerpApi: Google Flights ----------

const SERP_SORT = { CHEAPEST: 2, DEPARTURE_TIME: 3, ARRIVAL_TIME: 4, DURATION: 5 };
const SERP_STOPS = { ANY: 0, NON_STOP: 1, ONE_STOP_OR_FEWER: 2, TWO_OR_FEWER_STOPS: 3 };
const SERP_CLASS = { ECONOMY: 1, PREMIUM_ECONOMY: 2, BUSINESS: 3, FIRST: 4 };

/** The query string for one search (serpapi.com/google-flights-api). */
export function serpapiQuery(p, { key, fresh = false } = {}) {
  const q = {
    engine: "google_flights",
    api_key: key,
    departure_id: p.origin,
    arrival_id: p.destination,
    outbound_date: p.departure_date,
    type: p.return_date ? 1 : 2,
    travel_class: SERP_CLASS[p.cabin] ?? 1,
    adults: p.adults ?? 1,
    children: p.children ?? 0,
    infants_in_seat: p.infants_in_seat ?? 0,
    infants_on_lap: p.infants_on_lap ?? 0,
    sort_by: SERP_SORT[p.sort_by] ?? 2,
    stops: SERP_STOPS[p.max_stops] ?? 0,
    currency: p.currency || "USD",
    hl: "en",
    gl: "us",
  };
  if (p.return_date) q.return_date = p.return_date;
  const window = (w) => (w ? w.split("-").map(Number).join(",") : null);
  if (p.departure_window) q.outbound_times = window(p.departure_window);
  if (p.return_date && p.return_window) q.return_times = window(p.return_window);
  // SerpApi takes include OR exclude, never both, with alliances in the same list. Include wins
  // (it is the narrower ask); an exclude alongside it is applied to the answer instead.
  const include = [...(p.airlines || []), ...(p.alliances || [])];
  const exclude = [...(p.exclude_airlines || []), ...(p.exclude_alliances || [])];
  if (include.length) q.include_airlines = include.join(",");
  else if (exclude.length) q.exclude_airlines = exclude.join(",");
  if (p.min_layover != null || p.max_layover != null) q.layover_duration = `${p.min_layover ?? 0},${p.max_layover ?? 1440}`;
  // A re-check before booking must not be SerpApi's one-hour cache of the first search.
  if (fresh) q.no_cache = true;
  return q;
}

const wall = (s) => (s ? String(s).trim().replace(" ", "T").slice(0, 16) : null);
const splitFlightNumber = (s) => {
  const m = String(s ?? "").trim().match(/^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$/i);
  return m ? { airline: m[1].toUpperCase(), flight_number: m[2] } : { airline: String(s ?? "").slice(0, 2).toUpperCase(), flight_number: String(s ?? "").slice(2).trim() };
};

function serpItinerary(it, currency) {
  const legs = (it.flights || []).map((f) => ({
    ...splitFlightNumber(f.flight_number),
    airline_name: f.airline || null,
    from: f.departure_airport?.id,
    to: f.arrival_airport?.id,
    depart: wall(f.departure_airport?.time),
    arrive: wall(f.arrival_airport?.time),
    minutes: f.duration ?? null,
  }));
  if (!legs.length) return null;
  const names = [...new Set(legs.map((l) => l.airline_name).filter(Boolean))];
  return {
    price: typeof it.price === "number" ? it.price : null,
    currency,
    minutes: it.total_duration ?? legs.reduce((s, l) => s + (l.minutes || 0), 0),
    stops: legs.length - 1,
    airline_name: names.join(" + ") || null,
    legs,
    layovers: (it.layovers || []).map((l) => ({ airport: l.id, minutes: l.duration, ...(l.overnight ? { overnight: true } : {}) })),
    self_transfer: false,
  };
}

/** A SerpApi answer, in the sidecar's shape. A Google page with no flights is `count: 0`, not an error. */
export function fromSerpapi(body, p) {
  const currency = p.currency || "USD";
  const exclude = new Set((p.airlines?.length ? p.exclude_airlines : null) || []);
  const rows = [...(body.best_flights || []), ...(body.other_flights || [])]
    .map((it) => serpItinerary(it, currency))
    .filter(Boolean)
    .filter((it) => !it.legs.some((l) => exclude.has(l.airline)))
    .slice(0, MAX_ITINERARIES);
  const link = body.search_metadata?.google_flights_url || null;
  // Round trip: SerpApi prices the whole trip on each way out; the returns are one more search each
  // (`departure_token`), which this does not spend. The person picks the return on Google Flights.
  return {
    source: "serpapi",
    count: rows.length,
    ...(p.return_date ? { returns_not_listed: true } : {}),
    itineraries: link ? rows.map((r) => ({ ...r, link })) : rows,
  };
}

export async function searchSerpapi(p, { key, fetchImpl = fetch, fresh = false, timeoutMs = SERPAPI_TIMEOUT_MS } = {}) {
  const qs = new URLSearchParams(Object.entries(serpapiQuery(p, { key, fresh })).map(([k, v]) => [k, String(v)]));
  let res;
  try {
    res = await fetchImpl(`${SERPAPI_URL}?${qs}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new FliError(e?.name === "TimeoutError" ? "timeout" : "network", `SerpApi: ${e?.message || e}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* read below */ }
  // "Google hasn't returned any results for this query." is an answer: nothing matched.
  if (body?.error && /hasn'?t returned any results/i.test(body.error)) return { source: "serpapi", count: 0, itineraries: [] };
  if (!res.ok || !body || body.error) {
    const kind = res.status === 429 ? "exhausted" : res.status === 401 ? "auth" : "provider";
    throw new FliError(kind, `SerpApi ${res.status}: ${String(body?.error || "no JSON").slice(0, 160)}`, { status: res.status });
  }
  return fromSerpapi(body, p);
}

// ---------- Duffel: offer requests ----------

const DUFFEL_CABIN = { ECONOMY: "economy", PREMIUM_ECONOMY: "premium_economy", BUSINESS: "business", FIRST: "first" };
const DUFFEL_CONNECTIONS = { NON_STOP: 0, ONE_STOP_OR_FEWER: 1, TWO_OR_FEWER_STOPS: 2, ANY: 2 };
const first = (codes) => String(codes ?? "").split(",")[0].trim();
const hhmm = (h, end) => `${String(h).padStart(2, "0")}:${end ? "59" : "00"}`;
function timeRange(window) {
  if (!window) return null;
  const [a, b] = window.split("-").map(Number);
  return { from: hhmm(a, false), to: hhmm(b, true) };
}

/** The request body (duffel.com/docs/api/v2/offer-requests/create-offer-request). One airport a side. */
export function duffelBody(p) {
  const out = { origin: first(p.origin), destination: first(p.destination), departure_date: p.departure_date };
  const dep = timeRange(p.departure_window);
  if (dep) out.departure_time = dep;
  const slices = [out];
  if (p.return_date) {
    const back = { origin: out.destination, destination: out.origin, departure_date: p.return_date };
    const ret = timeRange(p.return_window);
    if (ret) back.departure_time = ret;
    slices.push(back);
  }
  const passengers = [
    ...Array.from({ length: p.adults ?? 1 }, () => ({ type: "adult" })),
    ...Array.from({ length: p.children ?? 0 }, () => ({ type: "child" })),
    // A lap infant is Duffel's `infant_without_seat`; one in their own seat is given by age.
    ...Array.from({ length: p.infants_on_lap ?? 0 }, () => ({ type: "infant_without_seat" })),
    ...Array.from({ length: p.infants_in_seat ?? 0 }, () => ({ age: 1 })),
  ];
  return { data: { slices, passengers, cabin_class: DUFFEL_CABIN[p.cabin] ?? "economy", max_connections: DUFFEL_CONNECTIONS[p.max_stops] ?? 2 } };
}

/** "PT2H26M" / "P1DT2H" → minutes. */
export function isoMinutes(s) {
  const m = String(s ?? "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  return m ? (Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : null;
}
const wallMinutes = (a, b) => Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60_000);

function duffelSide(slice) {
  const segs = slice?.segments || [];
  if (!segs.length) return null;
  const legs = segs.map((s) => ({
    airline: s.marketing_carrier?.iata_code || s.operating_carrier?.iata_code || "",
    airline_name: s.marketing_carrier?.name || s.operating_carrier?.name || null,
    flight_number: String(s.marketing_carrier_flight_number || s.operating_carrier_flight_number || ""),
    from: s.origin?.iata_code,
    to: s.destination?.iata_code,
    depart: wall(s.departing_at),
    arrive: wall(s.arriving_at),
    minutes: isoMinutes(s.duration),
  }));
  const layovers = legs.slice(0, -1).map((l, i) => {
    const next = legs[i + 1];
    return {
      airport: l.to,
      minutes: wallMinutes(l.arrive, next.depart),
      ...(String(l.arrive).slice(0, 10) !== String(next.depart).slice(0, 10) ? { overnight: true } : {}),
      ...(l.to !== next.from ? { change_of_airport: true } : {}),
    };
  });
  const names = [...new Set(legs.map((l) => l.airline_name).filter(Boolean))];
  return {
    minutes: isoMinutes(slice.duration) ?? legs.reduce((s, l) => s + (l.minutes || 0), 0),
    stops: legs.length - 1,
    airline_name: names.join(" + ") || null,
    legs,
    layovers,
    self_transfer: false,
  };
}

/** A Duffel answer, in the sidecar's shape: filters Duffel doesn't take are applied here. */
export function fromDuffel(body, p) {
  const want = new Set(p.airlines || []);
  const avoid = new Set(p.exclude_airlines || []);
  const inWindow = (minutes) => (p.min_layover == null || minutes >= p.min_layover) && (p.max_layover == null || minutes <= p.max_layover);
  const rows = [];
  for (const o of body?.data?.offers || []) {
    const out = duffelSide(o.slices?.[0]);
    if (!out) continue;
    const back = p.return_date ? duffelSide(o.slices?.[1]) : null;
    if (p.return_date && !back) continue;
    const all = [...out.legs, ...(back?.legs || [])];
    if (want.size && !all.every((l) => want.has(l.airline))) continue;
    if (all.some((l) => avoid.has(l.airline))) continue;
    if (![...out.layovers, ...(back?.layovers || [])].every((l) => inWindow(l.minutes))) continue;
    const price = Number(o.total_amount);
    rows.push({ ...out, price: Number.isFinite(price) ? price : null, currency: o.total_currency || "USD", ...(back ? { return: back } : {}) });
  }
  const sorters = {
    CHEAPEST: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    DURATION: (a, b) => a.minutes - b.minutes,
    DEPARTURE_TIME: (a, b) => String(a.legs[0].depart).localeCompare(String(b.legs[0].depart)),
    ARRIVAL_TIME: (a, b) => String(a.legs.at(-1).arrive).localeCompare(String(b.legs.at(-1).arrive)),
  };
  rows.sort(sorters[p.sort_by] || sorters.CHEAPEST);
  const notes = [];
  if (String(p.origin).includes(",") || String(p.destination).includes(",")) notes.push(`Only ${first(p.origin)} → ${first(p.destination)} was searched (this source takes one airport a side); the other airports they could use weren't — say so if it matters.`);
  if (p.alliances?.length || p.exclude_alliances?.length) notes.push("The alliance filter couldn't be applied on this source — check the airlines listed yourself.");
  return { source: "duffel", count: rows.length, itineraries: rows.slice(0, MAX_ITINERARIES), ...(notes.length ? { notes } : {}) };
}

export async function searchDuffel(p, { token, fetchImpl = fetch, timeoutMs = DUFFEL_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(`${DUFFEL_URL}?return_offers=true&supplier_timeout=${DUFFEL_SUPPLIER_TIMEOUT_MS}`, {
      method: "POST",
      headers: {
        "Accept-Encoding": "gzip",
        Accept: "application/json",
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(duffelBody(p)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new FliError(e?.name === "TimeoutError" ? "timeout" : "network", `Duffel: ${e?.message || e}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* read below */ }
  if (!res.ok || !body?.data) {
    const why = body?.errors?.[0]?.message || body?.errors?.[0]?.title || "no JSON";
    throw new FliError(res.status === 401 ? "auth" : res.status === 429 ? "exhausted" : "provider", `Duffel ${res.status}: ${String(why).slice(0, 160)}`, { status: res.status });
  }
  return fromDuffel(body, p);
}

// ---------- the chain ----------

/**
 * The flight source the tools use. Same face as the Fli sidecar (`searchFlights`, `searchDates`,
 * `installed`, `lastOutcome`), so src/flightsearch.js needs no second path. `deps` is the test seam:
 * `{ fetchImpl, now, usage: { reserve(provider, month, limit), count(provider, month) }, record }`.
 */
export class FlightProviders {
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
    this.now = deps.now || (() => Date.now());
    this.usage = deps.usage || null;
    this.record = deps.record === undefined ? recordInLedger : deps.record;
    this.log = deps.log || ((...a) => console.error("[flights]", ...a));
    this.outcome = null;
  }

  keys() {
    return { serpapi: (env().SERPAPI_API_KEY || "").trim(), duffel: (env().DUFFEL_ACCESS_TOKEN || "").trim() };
  }
  limits() {
    return { serpapi: limitOf("SERPAPI_MONTHLY_LIMIT", SERPAPI_DEFAULT_LIMIT), duffel: limitOf("DUFFEL_MONTHLY_LIMIT", DUFFEL_DEFAULT_LIMIT) };
  }
  /** Any key at all. With none, nothing is ever sent. */
  installed() {
    const k = this.keys();
    return !!(k.serpapi || k.duffel);
  }
  lastOutcome() {
    return this.outcome;
  }
  async _usage() {
    if (this.usage) return this.usage;
    const db = await import("./db.js");
    return { reserve: db.reserveFlightProviderSearch, count: db.flightProviderSearches };
  }
  /** This month's count and limit per provider, for /ops. */
  async month() {
    const u = await this._usage();
    const m = monthOf(this.now());
    const lim = this.limits();
    return { month: m, serpapi: { used: u.count("serpapi", m), limit: lim.serpapi }, duffel: { used: u.count("duffel", m), limit: lim.duffel } };
  }

  _note(provider, state, detail, ms) {
    this.outcome = { at: this.now(), provider, state, detail: detail ? String(detail).slice(0, 200) : null, ms };
    try { this.record?.(this.outcome); } catch { /* the ledger is never worth a search */ }
  }

  /** SerpApi, then Duffel, then `unavailable` — each tried once, never twice. */
  async searchFlights(params, { fresh = false } = {}) {
    const keys = this.keys();
    const limits = this.limits();
    const usage = await this._usage();
    const month = monthOf(this.now());
    const tried = [];
    const steps = [
      ["serpapi", keys.serpapi, (p) => searchSerpapi(p, { key: keys.serpapi, fetchImpl: this.fetchImpl, fresh })],
      ["duffel", keys.duffel, (p) => searchDuffel(p, { token: keys.duffel, fetchImpl: this.fetchImpl })],
    ];
    for (const [name, key, run] of steps) {
      if (!key) { tried.push(`${name}: no key`); continue; }
      // Counted before it is sent: a search that errors may still have been billed.
      if (!usage.reserve(name, month, limits[name])) { tried.push(`${name}: ${limits[name]} searches used this month`); continue; }
      const t0 = this.now();
      try {
        const result = await run(params);
        this._note(name, result.count ? "ok" : "empty", null, this.now() - t0);
        return result;
      } catch (e) {
        const err = e instanceof FliError ? e : new FliError("provider", e?.message || String(e));
        this._note(name, err.kind, err.message, this.now() - t0);
        this.log(`${name} failed (${err.kind}): ${err.message}`);
        tried.push(`${name}: ${err.kind}`);
      }
    }
    throw new FliError("unavailable", `no flight source answered (${tried.join("; ")})`, { tried });
  }

  /** No provider has a fare calendar; see the header. */
  async searchDates() {
    throw new FliError("unavailable", "date sweeps have no flight source", { tried: ["dates: no source"] });
  }
}

function recordInLedger(o) {
  Promise.all([import("./db.js"), import("./accounts.js")])
    .then(([db, accounts]) => db.recordProviderCall({
      provider: LEDGER[o.provider],
      day: accounts.today(o.at),
      ok: o.state === "ok" || o.state === "empty",
      status: 0,
      ms: o.ms,
      error: o.state === "ok" || o.state === "empty" ? "" : `${o.state}: ${o.detail || ""}`,
      at: o.at,
    }))
    .catch(() => {});
}

let shared = null;
/** The process-wide flight source. Tests build their own `FlightProviders`. */
export function flightProviders() {
  if (!shared) shared = new FlightProviders();
  return shared;
}
