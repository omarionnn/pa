// Flight search: what `flight_search`, `flight_dates` and `flight_verify` (src/tools.js) do between
// the model's tool call and the flight source — SerpApi's Google Flights engine, then Duffel
// (src/flightproviders.js). The Fli sidecar (src/fli.js) that scraped Google Flights directly was
// refused by Google from 2026-10-24 and is no longer in the path; its answer shape is kept, so the
// `sidecar` below is anything with `searchFlights` / `searchDates`.
//
// The model reads the meaning — "NYC" is JFK,EWR,LGA, "leave after work" is a departure window,
// "no layovers" is NON_STOP, "make it five days" moves the return date — and passes plain fields.
// This file does not read anybody's words. It checks the fields, turns them into what Fli takes,
// and turns what comes back into a short list a person can choose from, with the limits said in
// the result so the model has them when it matters:
//
//   - **"from $X", never "the cheapest flight".** Fli returns what Google's page showed for that
//     search, not every fare that exists, so the headline is a floor of what was seen.
//   - **Fare rules were not checked.** Fli's basic-economy, bags and emissions filters are not used
//     (they don't apply reliably on Fli's current transport), so a fare that looks unusually cheap
//     comes back with a line saying bags and seats weren't checked.
//   - **A family search that comes back empty is not "no flights".** Google returns thin results
//     for searches with children or infants.
//   - **Every price is a live quote** — nothing is cached — and `flight_verify` re-runs the search
//     before a specific fare is recommended, so a stale price is never sent as current.
//   - **Multi-city is not priced.** Legs can be searched one at a time, and the total is said to
//     possibly differ from a real multi-city fare.
//   - **Blocked is not empty.** When Google refuses or the sidecar is down the result says Reason
//     couldn't check, and never that no flights exist.
//
// Search only: nothing here books, holds or pays. The hand-off is a Google Flights link where the
// person reviews the flight and pays the airline or agent themselves.

import { FliError } from "./fli.js";
import { bookingEnabled } from "./flightbook.js";
import { connectAllowedFor } from "./shopconnect.js";

export const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];
export const STOPS = ["ANY", "NON_STOP", "ONE_STOP_OR_FEWER", "TWO_OR_FEWER_STOPS"];
export const SORTS = ["CHEAPEST", "DURATION", "DEPARTURE_TIME", "ARRIVAL_TIME"];
export const ALLIANCES = ["ONEWORLD", "SKYTEAM", "STAR_ALLIANCE"];
export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** Round trips expand the first `top_n` outbound options into returns: 1 + top_n page fetches. */
export const DEFAULT_TOP_N = 5;
export const MAX_TOP_N = 10;
/** The longest date range one sweep may cover (the owner's spec). Fli fetches it in ≤61-day pages. */
export const MAX_SWEEP_DAYS = 93;
export const SWEEP_PAGE_DAYS = 61;
/** A fare under this share of the search's median is "unusually cheap" and gets the fare-rules line. */
export const CHEAP_RATIO = 0.6;
/** Days either side of a date that count as "the dates around it" in a sweep comparison. */
export const NEARBY_DAYS = 3;
export const MAX_AIRPORTS_PER_SIDE = 8;

const SAY_COULDNT = "I couldn't check flights right now";

// ---------- checking what the model passed ----------

/** "jfk, ewr ,LGA" → ["JFK","EWR","LGA"], or an error string. Codes only; the model expands metros. */
export function airportList(value, side) {
  const codes = [...new Set(String(value ?? "").split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return { error: `${side}: give at least one airport code` };
  const bad = codes.filter(c => !/^[A-Z]{3}$/.test(c));
  if (bad.length) return { error: `${side}: ${bad.join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} a three-letter airport code — expand a city into its airports yourself (NYC → JFK,EWR,LGA)` };
  if (codes.length > MAX_AIRPORTS_PER_SIDE) return { error: `${side}: at most ${MAX_AIRPORTS_PER_SIDE} airports` };
  return { codes };
}

/** Google's own rule for who can fly together: 1-9 people, a lap infant per adult at most. */
export function partyError({ adults = 1, children = 0, infants_in_seat = 0, infants_on_lap = 0 } = {}) {
  const total = adults + children + infants_in_seat + infants_on_lap;
  if (adults < 1) return "at least one adult has to be travelling";
  if (total > 9) return `that's ${total} travellers — one search takes 9 at most; split the group into two searches`;
  if (infants_on_lap > adults) return `${infants_on_lap} lap infants but ${adults} adult${adults === 1 ? "" : "s"} — each lap infant needs an adult; count the extra ones as infants_in_seat`;
  return null;
}

function isoDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
const DAY_MS = 86_400_000;
export const daysBetween = (a, b) => Math.round((isoDay(b) - isoDay(a)) / DAY_MS);
export const addDays = (s, n) => new Date(isoDay(s).getTime() + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Fli swaps a window whose start is after its end (its TimeRestrictions validator), so "after 10pm,
 * before 6am" would silently become 6am-10pm — the opposite of what was asked.
 */
function windowWraps(after, before) {
  if (after == null || before == null || after <= before) return null;
  return `a departure window can't wrap past midnight (${after}:00 to ${before}:00) — search the evening and the early morning as two searches, or drop one end`;
}

function hourWindow(after, before) {
  if (after == null && before == null) return null;
  const a = after ?? 0;
  const b = before ?? 23;
  return `${a}-${b}`;
}

/**
 * The constraints of a search, merged with the search it refines. `clear` names fields to drop
 * ("any airline is fine now"); everything else they said before stays until they change it.
 */
export function mergeConstraints(previous, input, clear = []) {
  const out = { ...(previous || {}) };
  for (const [k, v] of Object.entries(input || {})) {
    if (v === undefined || ["refine_of", "clear", "show"].includes(k)) continue;
    out[k] = v;
  }
  for (const k of clear || []) delete out[k];
  return out;
}

/** What the sidecar is asked, or `{ error }` for the model to fix and ask again. */
export function toSidecarFlights(q, { today }) {
  const from = airportList(q.origin, "origin");
  if (from.error) return from;
  const to = airportList(q.destination, "destination");
  if (to.error) return to;
  if (from.codes.some(c => to.codes.includes(c))) return { error: "origin and destination share an airport" };
  const depart = isoDay(q.depart_date);
  if (!depart) return { error: "depart_date has to be YYYY-MM-DD" };
  if (q.depart_date < today) return { error: `depart_date ${q.depart_date} is in the past (today is ${today})` };
  if (q.return_date != null) {
    if (!isoDay(q.return_date)) return { error: "return_date has to be YYYY-MM-DD" };
    if (q.return_date < q.depart_date) return { error: "return_date is before depart_date" };
  }
  const party = { adults: q.adults ?? 1, children: q.children ?? 0, infants_in_seat: q.infants_in_seat ?? 0, infants_on_lap: q.infants_on_lap ?? 0 };
  const pe = partyError(party);
  if (pe) return { error: pe };
  const wraps = windowWraps(q.depart_after_hour, q.depart_before_hour) || windowWraps(q.return_after_hour, q.return_before_hour);
  if (wraps) return { error: wraps };
  if (q.min_layover_minutes != null && q.max_layover_minutes != null && q.min_layover_minutes > q.max_layover_minutes) {
    return { error: "min_layover_minutes is more than max_layover_minutes" };
  }
  return {
    params: {
      origin: from.codes.join(","),
      destination: to.codes.join(","),
      departure_date: q.depart_date,
      return_date: q.return_date ?? null,
      departure_window: hourWindow(q.depart_after_hour, q.depart_before_hour),
      return_window: hourWindow(q.return_after_hour, q.return_before_hour),
      cabin: q.cabin || "ECONOMY",
      max_stops: q.max_stops || "ANY",
      sort_by: q.sort_by || "CHEAPEST",
      airlines: q.airlines?.length ? q.airlines.map(s => s.toUpperCase()) : null,
      exclude_airlines: q.exclude_airlines?.length ? q.exclude_airlines.map(s => s.toUpperCase()) : null,
      alliances: q.alliances?.length ? q.alliances : null,
      exclude_alliances: q.exclude_alliances?.length ? q.exclude_alliances : null,
      min_layover: q.min_layover_minutes ?? null,
      max_layover: q.max_layover_minutes ?? null,
      top_n: Math.min(MAX_TOP_N, Math.max(1, q.more_options ?? DEFAULT_TOP_N)),
      currency: "USD",
      ...party,
    },
  };
}

export function toSidecarDates(q, { today }) {
  const from = airportList(q.origin, "origin");
  if (from.error) return from;
  const to = airportList(q.destination, "destination");
  if (to.error) return to;
  if (!isoDay(q.from_date) || !isoDay(q.to_date)) return { error: "from_date and to_date have to be YYYY-MM-DD" };
  const start = q.from_date < today ? today : q.from_date;
  if (q.to_date < start) return { error: "to_date is before from_date (or today)" };
  const days = daysBetween(start, q.to_date) + 1;
  if (days > MAX_SWEEP_DAYS) {
    return { error: `that's ${days} days — one sweep covers ${MAX_SWEEP_DAYS} at most. Pick the ${MAX_SWEEP_DAYS} days that matter most, or ask them before running a second sweep` };
  }
  const party = { adults: q.adults ?? 1, children: q.children ?? 0, infants_in_seat: q.infants_in_seat ?? 0, infants_on_lap: q.infants_on_lap ?? 0 };
  const pe = partyError(party);
  if (pe) return { error: pe };
  const roundTrip = q.trip_days != null;
  return {
    params: {
      origin: from.codes.join(","),
      destination: to.codes.join(","),
      start_date: start,
      end_date: q.to_date,
      round_trip: roundTrip,
      trip_days: roundTrip ? q.trip_days : null,
      departure_window: hourWindow(q.depart_after_hour, q.depart_before_hour),
      cabin: q.cabin || "ECONOMY",
      max_stops: q.max_stops || "ANY",
      airlines: q.airlines?.length ? q.airlines.map(s => s.toUpperCase()) : null,
      exclude_airlines: q.exclude_airlines?.length ? q.exclude_airlines.map(s => s.toUpperCase()) : null,
      currency: "USD",
      ...party,
    },
    days,
    pages: Math.ceil(days / SWEEP_PAGE_DAYS),
    weekdays: q.depart_weekdays?.length ? q.depart_weekdays : null,
  };
}

// ---------- saying what came back ----------

export function money(amount, currency = "USD") {
  if (amount == null) return null;
  const whole = Math.round(amount);
  return currency === "USD" ? `$${whole.toLocaleString("en-US")}` : `${whole.toLocaleString("en-US")} ${currency}`;
}
export function minutesWords(m) {
  if (m == null) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}
/** "2026-11-24T00:45" is the airport's own wall clock; it is formatted as-is, never shifted. */
export function wallClock(iso) {
  if (!iso) return null;
  const d = new Date(`${iso.length === 16 ? iso + ":00" : iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).replace(" ", "").toLowerCase();
  return `${day}, ${time}`;
}

/**
 * The hand-off link. Fli 0.9.0 returns no per-flight Google Flights URL (its README says it does;
 * the installed package does not), so this opens Google Flights on the same airports, dates, cabin
 * and travellers, and the option's flight numbers are named next to it so they can pick that row.
 */
export function googleFlightsLink({ from, to, depart, ret = null, cabin = "ECONOMY", adults = 1, children = 0, infants = 0 }) {
  const cabinWords = { ECONOMY: "", PREMIUM_ECONOMY: " premium economy", BUSINESS: " business class", FIRST: " first class" }[cabin] ?? "";
  const people = [];
  if (adults > 1) people.push(`${adults} adults`);
  if (children) people.push(`${children} child${children === 1 ? "" : "ren"}`);
  if (infants) people.push(`${infants} infant${infants === 1 ? "" : "s"}`);
  const q = `Flights from ${from} to ${to} on ${depart}${ret ? ` through ${ret}` : " one way"}${cabinWords}${people.length ? ` for ${people.join(" ")}` : ""}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=USD&hl=en`;
}

function legsWords(legs) {
  return legs.map(l => `${l.airline}${l.flight_number} ${l.from}→${l.to}`).join(", ");
}
function layoverWords(layovers) {
  return (layovers || []).map(l => `${l.airport} ${minutesWords(l.minutes)}${l.overnight ? " overnight" : ""}${l.change_of_airport ? " (change airports)" : ""}`);
}
function airlineOf(f) {
  return f.airline_name || [...new Set(f.legs.map(l => l.airline_name || l.airline))].join(" + ");
}

function sideView(f) {
  const first = f.legs[0];
  const last = f.legs[f.legs.length - 1];
  return {
    airline: airlineOf(f),
    flights: legsWords(f.legs),
    depart: wallClock(first?.depart),
    arrive: wallClock(last?.arrive),
    duration: minutesWords(f.minutes),
    stops: f.stops,
    layovers: layoverWords(f.layovers),
    ...(f.self_transfer ? { self_transfer: true } : {}),
  };
}

function rawLegs(legs) {
  return (legs || []).map(l => ({ from: l.from, to: l.to, depart: l.depart, arrive: l.arrive, airline: l.airline, flight_number: l.flight_number }));
}

/** A key that names the same flights on a recheck: every leg's flight number and day. */
export function itineraryKey(item) {
  const part = (f) => (f?.legs || []).map(l => `${l.airline}${l.flight_number}@${String(l.depart).slice(0, 10)}`).join("+");
  return item.return ? `${part(item)}|${part(item.return)}` : part(item);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The short list. For a round trip, Fli pairs each of the first `top_n` outbound flights with every
 * return; the list keeps one pairing per outbound (the lowest, then quickest return), so five
 * options are five different ways out rather than one flight five times.
 */
export function shortList(result, params, { show = 5 } = {}) {
  let items = result.itineraries || [];
  if (params.return_date) {
    const best = new Map();
    for (const it of items) {
      const k = itineraryKey({ legs: it.legs });
      const cur = best.get(k);
      // Fli reads the round-trip total off the outbound row, so every pairing of one outbound
      // carries the same price; the return row's own price is what tells the returns apart. Rank
      // on it, so the return shown next to "$613" is the one Google priced lowest with that way
      // out, not just the quickest.
      const rank = (x) => [x.return?.price ?? x.price ?? Infinity, x.return?.minutes ?? Infinity];
      if (!cur || rank(it)[0] < rank(cur)[0] || (rank(it)[0] === rank(cur)[0] && rank(it)[1] < rank(cur)[1])) best.set(k, it);
    }
    items = [...best.values()];
  }
  if ((params.sort_by || "CHEAPEST") === "CHEAPEST") {
    items = [...items].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.minutes - b.minutes);
  }
  const prices = (result.itineraries || []).map(i => i.price).filter(p => p != null);
  const mid = median(prices);
  return items.slice(0, show).map((it, i) => {
    const first = it.legs[0];
    const opt = {
      option: i + 1,
      price: it.price != null ? money(it.price, it.currency || "USD") : null,
      ...(it.price == null ? { price_note: "Google didn't show a price for this one in the list — it shows on Google Flights" } : {}),
      ...sideView(it),
      // The legs as Fli gave them — airports and the airport's own wall clock — so a booking can be
      // matched leg by leg against what AgentCard offers (src/flightbook.js itineraryMatches).
      legs: rawLegs(it.legs),
      ...(it.return ? { return: { ...sideView(it.return), legs: rawLegs(it.return.legs) } } : {}),
      // SerpApi hands back the real Google Flights page for the search; otherwise one is built.
      link: it.link || googleFlightsLink({
        from: first.from, to: it.legs.at(-1).to, depart: String(first.depart).slice(0, 10),
        ret: it.return ? String(it.return.legs[0].depart).slice(0, 10) : (params.return_date || null),
        cabin: params.cabin, adults: params.adults, children: params.children,
        infants: (params.infants_in_seat || 0) + (params.infants_on_lap || 0),
      }),
      key: itineraryKey(it),
    };
    if (it.price != null && mid != null && prices.length >= 5 && it.price < mid * CHEAP_RATIO) opt.unusually_cheap = true;
    return opt;
  });
}

/** The constraints applied, in words, so the model can say them back when the ask was loose. */
export function constraintsWords(p) {
  const out = [`${p.origin} → ${p.destination}`, p.return_date ? `${p.departure_date} to ${p.return_date}` : `${p.departure_date}, one way`];
  const party = [`${p.adults} adult${p.adults === 1 ? "" : "s"}`];
  if (p.children) party.push(`${p.children} child${p.children === 1 ? "" : "ren"}`);
  if (p.infants_in_seat) party.push(`${p.infants_in_seat} infant${p.infants_in_seat === 1 ? "" : "s"} in a seat`);
  if (p.infants_on_lap) party.push(`${p.infants_on_lap} lap infant${p.infants_on_lap === 1 ? "" : "s"}`);
  out.push(party.join(", "));
  if (p.cabin && p.cabin !== "ECONOMY") out.push(p.cabin.toLowerCase().replace("_", " "));
  if (p.max_stops && p.max_stops !== "ANY") out.push({ NON_STOP: "nonstop only", ONE_STOP_OR_FEWER: "at most one stop", TWO_OR_FEWER_STOPS: "at most two stops" }[p.max_stops]);
  if (p.departure_window) out.push(`leaving between ${p.departure_window.replace("-", ":00 and ")}:00`);
  if (p.return_window) out.push(`coming back between ${p.return_window.replace("-", ":00 and ")}:00`);
  if (p.airlines) out.push(`only ${p.airlines.join("/")}`);
  if (p.exclude_airlines) out.push(`not ${p.exclude_airlines.join("/")}`);
  if (p.alliances) out.push(`${p.alliances.join("/")} only`);
  if (p.exclude_alliances) out.push(`no ${p.exclude_alliances.join("/")}`);
  if (p.min_layover) out.push(`layovers at least ${minutesWords(p.min_layover)}`);
  if (p.max_layover) out.push(`layovers at most ${minutesWords(p.max_layover)}`);
  if (p.sort_by && p.sort_by !== "CHEAPEST") out.push(`sorted by ${p.sort_by.toLowerCase().replace("_", " ")}`);
  return out;
}

/** The limits worth saying, for this search. The model says the ones that matter, not all of them. */
export function limitsFor({ params, found, options = [], refused = 0, source = "fli", notes = [], returnsNotListed = false }) {
  const seen = source === "duffel"
    ? "what the airlines on Duffel offered for this search (some low-cost carriers, Southwest among them, aren't there)"
    : "what Google's page showed for this search";
  const out = [
    `Coverage: ${found} itineraries came back — ${seen}, not every fare that exists. Say "from $X", never "the cheapest flight".`,
    "Live quote: prices change; if they're about to book, flight_verify re-checks first.",
  ];
  if (options.some(o => o.unusually_cheap)) {
    out.push("A fare here is well under the rest: baggage, seat selection and whether it's basic economy were NOT checked — say so next to it.");
  } else {
    out.push("Basic economy, bags and seat rules were not checked for any fare here; a like-for-like comparison with main cabin isn't possible from this search.");
  }
  const family = (params.children || 0) + (params.infants_in_seat || 0) + (params.infants_on_lap || 0);
  if (family && !found) out.push("Searches with children or infants often come back thin or empty from Google — this does NOT mean there are no flights. Say that, and suggest checking the link directly.");
  else if (family) out.push("Results for searches with children or infants can be thinner than for adults alone.");
  if (refused > 0) out.push(`Partial: Google refused ${refused} of the pages this search needed (Reason is backing off), so this list is missing options — say it's a partial list, not everything.`);
  if (params.return_date && returnsNotListed) out.push("Round trip: each price is the WHOLE trip, but only the way out is listed — they pick the return flight on the link. Say that; don't invent return times.");
  else if (params.return_date && source === "fli") out.push(`Round trip: the first ${params.top_n} ways out were paired with returns (${1 + params.top_n} page fetches). More options means a slower search.`);
  out.push(...notes);
  return out;
}

/**
 * A sweep, shown: the lowest few date pairs, each with what the dates around it cost INSIDE THIS
 * SWEEP — so "$120 less than the weekend around it" is a number from this data, never a memory of
 * what fares usually are.
 */
export function sweepView(result, { weekdays = null, show = 5 } = {}) {
  const all = (result.dates || []).filter(d => d.price != null);
  const dayName = (s) => WEEKDAYS[(isoDay(s).getUTCDay() + 6) % 7];
  const pool = weekdays ? all.filter(d => weekdays.includes(dayName(d.depart))) : all;
  const sorted = [...pool].sort((a, b) => a.price - b.price || a.depart.localeCompare(b.depart));
  const prices = all.map(d => d.price);
  const picks = sorted.slice(0, show).map(d => {
    const near = all.filter(x => x !== d && Math.abs(daysBetween(d.depart, x.depart)) <= NEARBY_DAYS).map(x => x.price);
    const nearMid = median(near);
    return {
      depart: d.depart,
      depart_day: dayName(d.depart),
      ...(d.return ? { return: d.return } : {}),
      price: money(d.price, d.currency || "USD"),
      ...(nearMid != null ? {
        nearby_median: money(nearMid, d.currency || "USD"),
        vs_nearby: nearMid > d.price ? `${money(nearMid - d.price)} less than the median of the ${near.length} dates within ${NEARBY_DAYS} days` : nearMid < d.price ? `${money(d.price - nearMid)} more than the median of the ${near.length} dates within ${NEARBY_DAYS} days` : "same as the dates around it",
      } : {}),
    };
  });
  return {
    picks,
    dates_priced: all.length,
    ...(weekdays ? { matching_weekdays: pool.length } : {}),
    sweep_low: prices.length ? money(Math.min(...prices)) : null,
    sweep_median: prices.length ? money(median(prices)) : null,
    sweep_high: prices.length ? money(Math.max(...prices)) : null,
  };
}

// ---------- failures, said honestly ----------

/** What the model gets when the sidecar couldn't answer. Never "no flights". */
/** The hand-off link for a search that couldn't run: the asked route and dates on Google Flights. */
export function askedLink(params) {
  if (!params?.origin || !params?.destination) return null;
  const first = (codes) => String(codes).split(",")[0].trim();
  const depart = params.departure_date || params.start_date;
  if (!depart) return null;
  return googleFlightsLink({
    from: first(params.origin), to: first(params.destination), depart, ret: params.return_date || null,
    cabin: params.cabin, adults: params.adults || 1, children: params.children || 0,
    infants: (params.infants_in_seat || 0) + (params.infants_on_lap || 0),
  });
}

/**
 * No flight source answered (no key, the month's free searches used, or an error): ONE honest line
 * with the Google Flights link. Nothing retries in the background, so nothing may be promised. The
 * week of 2026-11-02 a task re-ran a refused search for nine hours and texted "still trying" six
 * times without ever getting a price — this is the answer that replaces that.
 */
export function unavailable(link = null) {
  return {
    ok: false,
    couldnt_check: true,
    kind: "unavailable",
    say: `Flight prices aren't available right now. Tell them that ONCE, in one message${link ? ", with `link` (Google Flights on their route and dates, where they can see live prices themselves)" : ""}. Nothing is retrying: don't say you're still trying or will keep checking, don't offer to try again later, and don't start a task, watch or reminder to search again. Give no prices, airlines or times from memory, and say nothing that sounds like "no flights". Don't search flights again this turn. If this is a task's wake, finish the task now (task_finish, outcome: flight prices unavailable, link sent).`,
    ...(link ? { link } : {}),
  };
}

/** The same failure on a wake that isn't their message, after they were already told: say nothing. */
export function alreadyTold(link = null) {
  return {
    ok: false,
    couldnt_check: true,
    kind: "unavailable",
    already_told: true,
    say: "Flight prices still aren't available, and they were already told so (with the Google Flights link). This turn is not a message from them: send them NOTHING about flights — reply NO_REPLY — and if this is a task's wake, finish the task (task_finish, outcome: flight prices unavailable, link sent). Don't search again.",
    ...(link ? { link } : {}),
  };
}

/** Hours within which a second "unavailable" on a wake (not their message) stays silent. */
export const ALREADY_TOLD_MS = 24 * 60 * 60 * 1000;

function failed(c, err, link, { db, eventTurn = false, now = () => Date.now() }) {
  if (err instanceof FliError && err.kind === "unavailable") {
    const told = db.lastFlightsUnavailableAt?.(c);
    if (eventTurn && told != null && now() - told < ALREADY_TOLD_MS) return alreadyTold(link);
    return unavailable(link);
  }
  return couldntCheck(err, link);
}

export function couldntCheck(err, link = null) {
  const kind = err instanceof FliError ? err.kind : "internal";
  if (kind === "unavailable") return unavailable(link);
  const why = {
    blocked: "Google refused or throttled the search (Reason backs off rather than working around it)",
    network: "Google Flights couldn't be reached",
    timeout: "the search took too long",
    parse: "Google answered in a shape the flight reader no longer understands",
    down: "the flight search service isn't running",
    internal: "the flight search failed",
  }[kind] || "the flight search failed";
  return {
    ok: false,
    couldnt_check: true,
    kind,
    say: `${SAY_COULDNT} — ${why}. This is NOT "no flights": say you couldn't pull live fares right now, ${link ? "send them `link` (Google Flights on their route and date) to look themselves" : "and offer to try again later"}, and give no prices or flights from memory. Don't search again this turn${kind === "blocked" ? " — Reason is backing off from Google on purpose" : ""}, and don't apologise twice.`,
    ...(link ? { link } : {}),
    ...(err?.retryAt ? { retry_after: new Date(err.retryAt).toISOString() } : {}),
  };
}

// ---------- the three operations ----------

const fromCentsOf = (result) => {
  const ps = (result.itineraries || result.dates || []).map(x => x.price).filter(p => p != null);
  return ps.length ? Math.round(Math.min(...ps) * 100) : null;
};

/**
 * Run a flight search for conversation `c`. `deps` = `{ sidecar, db, today }`; tests pass fakes.
 * Returns what the tool hands the model.
 */
export async function runFlightSearch(c, input, { sidecar, db, today, now = () => Date.now(), eventTurn = false }) {
  let base = null;
  if (input.refine_of != null) {
    const prev = db.getFlightSearch(c, input.refine_of);
    if (!prev || prev.kind !== "flights") return { ok: false, error: `no flight search ${input.refine_of} for this person — run a new one` };
    base = prev.params.asked || null;
  }
  const asked = mergeConstraints(base, input, input.clear);
  const built = toSidecarFlights(asked, { today });
  if (built.error) return { ok: false, error: built.error };
  const params = built.params;
  const show = Math.min(8, Math.max(1, input.show ?? 5));
  const t0 = now();
  let result;
  try {
    result = await sidecar.searchFlights(params);
  } catch (e) {
    if (e instanceof FliError && e.kind === "invalid") return { ok: false, error: `Fli refused the search: ${e.message}` };
    const out = failed(c, e, askedLink(params), { db, eventTurn, now });
    db.recordFlightSearch(c, { kind: "flights", params: { asked, sent: params }, outcome: e.kind || "internal", ms: now() - t0 });
    return out;
  }
  const options = shortList(result, params, { show });
  const fromCents = fromCentsOf(result);
  const id = db.recordFlightSearch(c, {
    kind: "flights", params: { asked, sent: params }, outcome: result.count ? "ok" : "empty",
    found: result.count, fromCents, options, ms: now() - t0,
  });
  return {
    ok: true,
    search_id: id,
    applied: constraintsWords(params),
    found: result.count,
    headline: fromCents != null ? `${params.return_date ? "round trip " : ""}from ${money(fromCents / 100)}` : null,
    options,
    limits: limitsFor({ params, found: result.count, options, refused: result.refused_fetches || 0, source: result.source || "fli", notes: result.notes || [], returnsNotListed: !!result.returns_not_listed }),
    note: result.count
      ? `Present these as a short list: price, airline, times, duration, stops and layover airports, and the link (it opens Google Flights on this route and date — they pick the flight with these numbers there and pay there${(bookingEnabled(c) && !connectAllowedFor(c)) ? "" : "; Reason never books"}). ${(bookingEnabled(c) && !connectAllowedFor(c)) ? "There are two ways to finish, and which one is THEIR choice: book it themselves from that link, or ask you to book it here (flight_book, with their approval before any money moves). Keep the link on every option and offer both without steering either way. " : ""}To change something they said ('no layovers', 'leave after work', 'make it five days'), call flight_search again with refine_of and ONLY the fields that change. Before recommending one specific fare, flight_verify it.`
      : "Nothing came back for these exact constraints. That is what the flight source showed for this search, not proof no flight exists — say what was searched and offer to loosen something (stops, times, nearby airports, dates).",
  };
}

export async function runDateSweep(c, input, { sidecar, db, today, now = () => Date.now(), alreadySwept = false, eventTurn = false }) {
  if (alreadySwept) {
    return { ok: false, error: "One date sweep per request. You already ran one for this message — present what it found; if they want a wider or different range, ask them first, then sweep on their next message." };
  }
  const built = toSidecarDates(input, { today });
  if (built.error) return { ok: false, error: built.error };
  const t0 = now();
  let result;
  try {
    result = await sidecar.searchDates(built.params);
  } catch (e) {
    if (e instanceof FliError && e.kind === "invalid") return { ok: false, error: `Fli refused the sweep: ${e.message}` };
    const out = failed(c, e, askedLink(built.params), { db, eventTurn, now });
    db.recordFlightSearch(c, { kind: "dates", params: { asked: input, sent: built.params }, outcome: e.kind || "internal", ms: now() - t0 });
    return out;
  }
  const view = sweepView(result, { weekdays: built.weekdays, show: Math.min(8, Math.max(1, input.show ?? 5)) });
  const id = db.recordFlightSearch(c, {
    kind: "dates", params: { asked: input, sent: built.params }, outcome: result.count ? "ok" : "empty",
    found: result.count, fromCents: fromCentsOf(result), options: view.picks, ms: now() - t0,
  });
  const p = built.params;
  return {
    ok: true,
    search_id: id,
    swept: `${p.origin} → ${p.destination}, departing ${p.start_date} to ${p.end_date}${p.round_trip ? `, ${p.trip_days}-day trips` : ", one way"} (${built.days} dates, ${built.pages} page fetch${built.pages === 1 ? "" : "es"})`,
    ...view,
    limits: [
      "Every comparison you make has to come from the numbers in this result (vs_nearby, sweep_median, sweep_low/high) — never from what fares usually cost.",
      "These are the lowest fares Google's calendar showed per date for this search, not a check of every flight; a specific flight's price can differ. Use flight_search on a date before recommending a fare.",
      "Live quote: nothing is cached.",
      ...(((p.children || 0) + (p.infants_in_seat || 0) + (p.infants_on_lap || 0)) && !result.count ? ["Family searches often come back thin or empty — not proof there are no flights."] : []),
    ],
    note: "Show the few lowest date pairs with prices. Don't run another sweep for this message; if they want a different range, ask first.",
  };
}

/**
 * Before one specific fare is recommended: run the same search again, find the same flights, and
 * say what the price is NOW. A price that moved is said as moved; a flight that's gone is said gone.
 */
export async function runVerify(c, input, { sidecar, db, today = null, now = () => Date.now(), eventTurn = false }) {
  const prev = db.getFlightSearch(c, input.search_id);
  if (!prev || prev.kind !== "flights") return { ok: false, error: `no flight search ${input.search_id} for this person` };
  const opt = prev.options.find(o => o.option === input.option);
  if (!opt) return { ok: false, error: `search ${input.search_id} had no option ${input.option} (it showed ${prev.options.length})` };
  const params = prev.params.sent;
  if (today && params.departure_date < today) return { ok: false, error: `that search was for ${params.departure_date}, which has passed — run a new flight_search` };
  const t0 = now();
  let result;
  try {
    // `fresh`: a recheck is never a cached copy of the first search.
    result = await sidecar.searchFlights(params, { fresh: true });
  } catch (e) {
    if (e instanceof FliError && e.kind === "invalid") return { ok: false, error: `Fli refused the recheck: ${e.message}` };
    const out = failed(c, e, opt.link || askedLink(params), { db, eventTurn, now });
    db.recordFlightSearch(c, { kind: "flights", params: prev.params, outcome: e.kind || "internal", ms: now() - t0 });
    return { ...out, price_then: opt.price, stale: true, note: `Couldn't re-check. The ${opt.price} from earlier is NOT current — if you mention it, say it was the price when you looked, not now.` };
  }
  const exact = (result.itineraries || []).find(it => itineraryKey(it) === opt.key) || null;
  // Missing from a list Google only partly answered is not "gone": it may sit on a refused page.
  if (!exact && result.refused_fetches > 0) {
    db.recordFlightSearch(c, { kind: "flights", params: prev.params, outcome: "blocked", found: result.count, ms: now() - t0 });
    return { ...couldntCheck(new FliError("blocked", "part of the recheck was refused"), opt.link || askedLink(params)), price_then: opt.price, stale: true, note: `Couldn't re-check that one — Google refused part of the search. The ${opt.price} from earlier is NOT current; say it was the price when you looked.` };
  }
  const options = shortList(result, params, { show: prev.options.length || 5 });
  db.recordFlightSearch(c, {
    kind: "flights", params: prev.params, outcome: result.count ? "ok" : "empty",
    found: result.count, fromCents: fromCentsOf(result), options, ms: now() - t0,
  });
  if (!exact) {
    return {
      ok: true, still_there: false, price_then: opt.price, flights: opt.flights,
      note: "That exact itinerary didn't come back on the recheck — it may have sold out or dropped off Google's list. Say so; don't send the old price as current. Offer what the fresh search shows instead.",
      fresh_options: options.slice(0, 3),
    };
  }
  const nowPrice = exact.price != null ? money(exact.price, exact.currency || "USD") : null;
  const thenAmount = Number(String(opt.price ?? "").replace(/[^0-9.]/g, "")) || null;
  const moved = thenAmount != null && exact.price != null && Math.round(exact.price) !== Math.round(thenAmount);
  return {
    ok: true,
    still_there: true,
    flights: opt.flights,
    price_then: opt.price,
    price_now: nowPrice,
    moved,
    ...(moved ? { change: exact.price > thenAmount ? `up ${money(exact.price - thenAmount)}` : `down ${money(thenAmount - exact.price)}` } : {}),
    checked_at: new Date(now()).toISOString(),
    link: opt.link,
    note: moved
      ? `The price moved: say it's ${nowPrice} now (was ${opt.price}). Never send the old one as current.`
      : nowPrice
        ? `Still ${nowPrice} as of just now. It's a live quote and can change before they book.`
        : "Still listed as of just now, but Google didn't show its price in the list — the link shows it. Don't quote a number.",
  };
}
