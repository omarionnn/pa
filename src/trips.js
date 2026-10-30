// Real trips: the walk Reason makes when somebody asks to be walked somewhere (the `directions` tool).
//
// A trip is made once, here, and stored (db.trips): where it ends (a Reason event's released address, a
// saved place, or a place looked up on OpenStreetMap), where it starts (the person's live location or a
// place they named), the walk between from a foot router, and the time they want to be there if there
// is one. The page at /d/<id> (src/pages/directions.js) draws every screen from that row; the phone
// then compares its own GPS against the route, and only a reroute ever sends a position back.
//
// Everything outside is free and keyless OpenStreetMap infrastructure Reason already uses: Nominatim
// for places (src/places.js), OSRM for the walk (FOSSGIS's foot profile, REASON_DIRECTIONS_ROUTING_URL),
// Overpass for the streets, parks and water the map draws (the map has no tiles). Overpass is often
// slow, so the map is filled in after the trip is made: the link works at once, and the shapes follow.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as events from "./events.js";
import { config, clock } from "./config.js";
import { tzFor } from "./series.js";
import { savedPlaceFor } from "./ridelinks.js";
import { drivingTime } from "./routing.js";
import { haversine, lineOf, project, LONG_WALK_M } from "./pages/directionsclient.js";
import { walkRoute, stepsFromOsrm, shapesFrom, boxAround, overpassQuery, overpass, pointAt, round6, locKey, distanceWords, minutesWords, startsLabel } from "./walk.js";
export { walkRoute, stepsFromOsrm, shapesFrom, streetNear, distanceWords, minutesWords, startsLabel, FOLD_M } from "./walk.js";

/** A trip lasts a day past the walk (or past being made): then the row, and the route in it, go. */
export const TRIP_KEEP_MS = 24 * 60 * 60 * 1000;
/** Further than this in a straight line is not a walk at all: the tool says so and offers a ride. */
export const MAX_WALK_M = 40000;
/** The furthest ahead a trip can be made for. */
export const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the tool waits for the map before answering anyway (it carries on filling behind). */
export const MAP_WAIT_MS = 8000;

const clockIn = (ms, tz) => new Date(ms).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

/** Is directions on for this conversation? "owner": the owner's only. */
export function tripsOnFor(conversationId) {
  if (config.directionsOn === true) return true;
  return config.directionsOn === "owner" && !!conversationId && accounts.ownerOf(conversationId).isOperator;
}

/** The bare link (the preview's address) and the owner's link (with the key), on the pages host. */
export function tripUrl(t) {
  const base = (config.pagesUrl || config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}/d/${t.id}`;
}
export const ownerTripUrl = (t) => `${tripUrl(t)}?k=${t.owner_key}`;

/**
 * The trip's map, filled from OpenStreetMap: the shapes the page draws, the one street label the design
 * keeps, what is nearby for "You're early", and the street names for any step that had none. Saved on
 * the row; a failure leaves the trip as it was (the route still draws, on plain ground).
 */
export async function fillTripMap(id, { fetchImpl = fetch, log = () => {}, servers, reverse = null, pauseMs = 1100 } = {}) {
  const row = db.getTrip(id);
  if (!row) return { ok: false, error: "no_trip" };
  const t = row.trip;
  lastFill.set(id, clock.now());
  // A walk this long is too much map to ask Overpass for; its steps are named one by one instead.
  const data = t.walkM > MAP_MAX_M ? null : await overpass(overpassQuery(boxAround([...t.route, t.destination]), t.destination), { fetchImpl, servers });
  if (!data) {
    log({ directions: "map", ok: false, trip: id });
    await nameByReverse(id, { fetchImpl, reverse, pauseMs, log });
    return { ok: false, error: "overpass_unreachable" };
  }
  const { map, streets, nearby } = shapesFrom(data, { dest: t.destination, placeName: t.name });
  const line = lineOf(t.route);
  const raw = row.trip._raw || null;
  const steps = raw ? stepsFromOsrm(raw, { placeName: t.name, line, streets }) : t.steps;
  // The one street label: the longest named step's street, halfway along it.
  const named = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.street && s.street !== "THE WAY AHEAD" && !/^ON YOUR|^JUST AHEAD/.test(s.fact));
  let label = null;
  for (const { s, i } of named) {
    const a = project({ lat: s.lat, lng: s.lng }, line).along;
    const b = i + 1 < steps.length ? project({ lat: steps[i + 1].lat, lng: steps[i + 1].lng }, line).along : line.total;
    if (!label || b - a > label.len) label = { len: b - a, text: s.street, at: pointAt(line, (a + b) / 2) };
  }
  if (label && steps.length) map.labels = [{ text: label.text, lat: round6(label.at.lat), lng: round6(label.at.lng) }];
  const next = { ...t, map, steps, nearby: nearby || t.nearby || "", firstStreet: firstStreetOf(steps) };
  db.updateTrip(id, next, { streets });
  log({ directions: "map", ok: true, trip: id, lines: map.major.length + map.minor.length, streets: streets.length });
  return { ok: true };
}

/** The longest walk whose map is asked for; past it the box is too big for Overpass to answer in time. */
export const MAP_MAX_M = 4000;
/** When each trip's map was last asked for, so opening the page retries a failed fill at most this often. */
const lastFill = new Map();
export const REFILL_GAP_MS = 10 * 60 * 1000;

/** Opening a trip whose map never came: ask again in the background, at most every REFILL_GAP_MS. */
export function refillIfBare(row, opts = {}) {
  const m = row?.trip?.map;
  if (!m || m.major.length || m.minor.length || row.trip.walkM > MAP_MAX_M) return false;
  if (clock.now() - (lastFill.get(row.id) ?? 0) < REFILL_GAP_MS) return false;
  // Only the last few minutes matter; anything older is forgotten, so the map never grows.
  for (const [k, at] of lastFill) if (clock.now() - at >= REFILL_GAP_MS) lastFill.delete(k);
  lastFill.set(row.id, clock.now());
  fillTripMap(row.id, opts).catch(() => {});
  return true;
}

/**
 * When Overpass cannot answer: each nameless step's street from Nominatim's reverse lookup, a second
 * apart (its rule), at most MAX_REVERSE of them. Only the steps change; the map stays as it was.
 */
const MAX_REVERSE = 10;
async function nameByReverse(id, { fetchImpl = fetch, reverse = null, pauseMs = 1100, log = () => {} } = {}) {
  const row = db.getTrip(id);
  const raw = row?.trip?._raw;
  if (!raw) return;
  const look = reverse ?? (await import("./places.js")).reverseGeocode;
  const line = lineOf(row.trip.route);
  const names = {};
  const kept = stepsFromOsrm(raw, { placeName: row.trip.name });
  const want = kept.filter((s, i) => i < kept.length - 1 && s.street === "THE WAY AHEAD").slice(0, MAX_REVERSE);
  for (const [k, s] of want.entries()) {
    if (k) await new Promise((r) => setTimeout(r, pauseMs));
    const along = project({ lat: s.lat, lng: s.lng }, line).along;
    const p = pointAt(line, along + 12);
    const r = await Promise.resolve().then(() => look(p.lat, p.lng, { fetchImpl })).catch(() => null);
    if (r && r.road) names[locKey([s.lng, s.lat])] = r.road;
  }
  if (!Object.keys(names).length) return;
  const fresh = db.getTrip(id);
  if (!fresh) return;
  const steps = stepsFromOsrm(raw, { placeName: fresh.trip.name, names });
  db.updateTrip(id, { ...fresh.trip, steps, firstStreet: firstStreetOf(steps) });
  log({ directions: "names", ok: true, trip: id, named: Object.keys(names).length });
}

function firstStreetOf(steps) {
  const s = steps[0];
  if (!s) return "";
  return s.street && s.street !== "THE WAY AHEAD" ? `ALONG ${s.street}` : "";
}

// ---------- making one ----------
/** Where a place named in words is: a saved place's own pin, else OpenStreetMap. */
async function placeOf(c, { text, lat, lng }, geocode, { near = null, pauseMs = 1100 } = {}) {
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, address: text || "", saved: null };
  const words = String(text ?? "").trim();
  if (!words) return null;
  const saved = savedPlaceFor(c, words);
  if (saved && saved.lat != null && saved.lng != null) return { lat: saved.lat, lng: saved.lng, address: saved.address || words, saved: saved.name };
  // "Joe Coffee, 141 East 21st Street" is often found only as its address: the words, then without the
  // name in front. One second apart, which is all Nominatim asks.
  const parts = words.split(",").map((x) => x.trim()).filter(Boolean);
  const tries = [words, ...(parts.length > 2 ? [parts.slice(1).join(", ")] : parts.length === 2 && /\d/.test(parts[1]) ? [parts[1]] : [])];
  // Near the start first (a walk is a few kilometres; Brooklyn has an East 21st Street too), then anywhere.
  const asks = near ? [...tries.map((q) => [q, { near, bounded: true, span: 0.05 }]), ...tries.map((q) => [q, { near }])] : tries.map((q) => [q, {}]);
  for (const [i, [q, opts]] of asks.entries()) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const g = await Promise.resolve().then(() => geocode(q, opts)).catch(() => null);
    if (g) return { lat: g.lat, lng: g.lng, address: q !== words ? q : shortAddress(g.display_name) || words, saved: null };
  }
  return null;
}

/** Nominatim's long name, cut to what fits under a title: "350, 5th Avenue, Manhattan". */
function shortAddress(s) {
  return String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3).join(", ");
}

/**
 * Make a trip for this conversation. `input` is the tool's: to / to_latitude / to_longitude, event_id,
 * from / from_latitude / from_longitude, arrive_by (their wall clock, YYYY-MM-DDTHH:MM), place_name.
 * Returns what the tool answers with.
 */
export async function makeTrip(c, input, { fetchImpl = fetch, geocode = null, log = () => {}, now = clock.now(), mapWaitMs = MAP_WAIT_MS, servers, pauseMs = 1100 } = {}) {
  const look = geocode ?? (await import("./places.js")).geocode;
  const tz = tzFor(c);

  // Where to. A Reason event gives its own name, address, start and link, as this person may see them.
  let name = String(input.place_name ?? "").trim();
  let startsAt = null;
  let links = null;
  let toText = input.to;
  if (input.event_id != null) {
    const role = events.roleIn(c, input.event_id);
    if (!role) return { ok: false, error: `They aren't in an event #${input.event_id}. event_list shows the ones they are.` };
    const ev = role.ev;
    const organizer = role.role === "organizer";
    if (!ev.location || (!organizer && !ev.location_released)) {
      return { ok: false, error: "The organizer hasn't shared where it is yet, so there is nowhere to walk them to. Say that plainly." };
    }
    toText = ev.location;
    name = name || ev.name;
    if (ev.starts_at != null && (organizer || ev.time_released)) startsAt = ev.starts_at;
    links = { event: { label: "See the event →", url: events.eventUrl(ev) } };
  }
  // Where from, first, so the place is looked for near them. Never guessed: their live location, a
  // recent pin, or a place they named.
  const from = await placeOf(c, { text: input.from, lat: input.from_latitude, lng: input.from_longitude }, look, { pauseMs });
  if (!from) {
    return {
      ok: false, needs: "origin",
      error: "Where are they starting from? Call get_location (a live share or a recent pin), or use the place they said they are; then call directions again with from_latitude/from_longitude or from. If there is nothing, ask them to share their location (get_location with action 'request').",
    };
  }
  const to = await placeOf(c, { text: toText, lat: input.to_latitude, lng: input.to_longitude }, look, { near: from, pauseMs });
  if (!to) return { ok: false, error: `Couldn't find "${String(toText ?? "").slice(0, 120)}" on the map. Ask them for the address, or the place's full name and area (or find it with nearby_places and pass its coordinates).` };
  const crow = haversine(from, to);
  if (crow > MAX_WALK_M) {
    return { ok: false, too_far: true, error: `That is ${distanceWords(crow)} away in a straight line, which is not a walk. Offer a ride instead (uber_link).` };
  }

  if (!startsAt && input.arrive_by) {
    const at = events.parseStartsAt(input.arrive_by, tz);
    if (at == null) return { ok: false, error: "arrive_by must be their wall-clock time as YYYY-MM-DDTHH:MM." };
    startsAt = at;
  }
  // A walk is for the next few days: the row (and the start in it) is never kept for months.
  if (startsAt != null && startsAt > now + MAX_AHEAD_MS) {
    return { ok: false, error: "That is more than a week away. Walking directions are made nearer the day; offer to make them then." };
  }
  if (startsAt != null && startsAt < now - 60 * 60000) startsAt = null;
  if (!name) name = to.saved ? to.saved.charAt(0).toUpperCase() + to.saved.slice(1) : String(toText ?? "").split(",")[0].trim() || "There";

  const walk = await walkRoute(from, to, { fetchImpl, placeName: name });
  if (!walk.ok) {
    log({ directions: "trip", ok: false, why: walk.why || walk.error });
    return { ok: false, error: "The walking route couldn't be worked out just now. Say so plainly; offer a maps link to the address instead." };
  }

  const metres = Math.round(walk.metres);
  const walkWords = `${minutesWords(walk.seconds)} walk · ${distanceWords(metres)}`.toUpperCase();
  let far = null;
  if (metres > LONG_WALK_M) {
    const drive = await drivingTime(from.lat, from.lng, to.lat, to.lng, { fetchImpl }).catch(() => ({ ok: false }));
    far = { walk: `${distanceWords(metres)} · ${minutesWords(walk.seconds)} on foot`.toUpperCase(), drive: drive && drive.ok ? `ABOUT ${minutesWords(drive.minutes * 60).toUpperCase()} BY CAR` : "" };
  }

  const trip = {
    made: clockIn(now, tz),
    name,
    address: to.address || String(toText ?? ""),
    walk: walkWords,
    walkM: metres,
    ...(far ? { far } : {}),
    firstStreet: firstStreetOf(walk.steps),
    entrance: "",
    nearby: "",
    side: walk.side,
    ...(startsAt != null ? { startsAt, startsLabel: startsLabel(startsAt, tz) } : {}),
    ...(links ? { links } : {}),
    destination: { lat: round6(to.lat), lng: round6(to.lng) },
    route: walk.route,
    steps: walk.steps,
    map: { major: [], minor: [], parks: [], water: [], pois: [], labels: [] },
  };
  // OSRM's own steps ride along on the row (stripped from the page) so the map fill can name the unnamed ones.
  const row = db.createTrip(c, { ...trip, _raw: walk.raw }, { expiresAt: Math.max(now, startsAt ?? now) + TRIP_KEEP_MS });
  log({ directions: "trip", ok: true, trip: row.id, metres, steps: walk.steps.length });

  const filling = fillTripMap(row.id, { fetchImpl, log, servers }).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  const mapped = await Promise.race([filling, new Promise((r) => setTimeout(() => r(null), mapWaitMs).unref?.())]);

  const leaveBy = startsAt != null ? startsAt - walk.seconds * 1000 - 5 * 60000 : null;
  return {
    ok: true,
    link: ownerTripUrl(row),
    name,
    walk: walkWords.toLowerCase(),
    ...(startsAt != null ? { be_there_by: clockIn(startsAt, tz), leave_by: leaveBy > now ? clockIn(leaveBy, tz) : "now" } : {}),
    ...(far ? { long_walk: true } : {}),
    map: mapped && mapped.ok ? "drawn" : "still filling in (the route is there already)",
    say: "Send the link with one short line: it opens Reason's walking directions, where Escort walks them there turn by turn from their phone's location, which stays on their phone. Name the walk time."
      + (startsAt != null ? " Say when to leave to be there on time." : "")
      + (far ? " It is a long walk: the page offers a ride as well; offer one in the same line (uber_link)." : ""),
  };
}

/** The page's own copy of a trip: the row's JSON without what only the server keeps. */
export function pageTrip(row) {
  const { _raw, ...trip } = row.trip;
  return { ...trip, id: row.id };
}

/** For a reroute: name the new way's steps from the streets the map fill found. */
export function tripStreets(row) {
  return row?.streets || [];
}

