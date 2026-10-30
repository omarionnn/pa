// The walk itself, with nothing stored: a foot route from OSRM turned into the page's steps, and the
// streets, parks and water round it from Overpass. Pure but for the two network asks, and no database,
// so the directions page (src/pages/directions.js) can reroute with it and the static staging build and
// the sample trip never open one. Making and keeping a trip is src/trips.js.
import { config } from "./config.js";
import { haversine, lineOf, project } from "./pages/directionsclient.js";

const UA = "Reason/1.0 (personal-assistant; https://heyreason.com)";
/** A step shorter than this (a kerb, a crossing, a jog across a corner) is folded into the one before it. */
export const FOLD_M = 35;

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// ---------- words ----------
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const compassWord = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const MANEUVER_WORD = { left: "Turn left", right: "Turn right", "slight left": "Bear left", "slight right": "Bear right", "sharp left": "Turn sharply left", "sharp right": "Turn sharply right", straight: "Keep straight", uturn: "Turn around" };
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth"];

/** "910 m", "1.2 km". */
export function distanceWords(m) {
  const r = Math.round(m || 0);
  return r < 1000 ? `${Math.round(r / 10) * 10 || r} m` : `${(r / 1000).toFixed(1).replace(/\.0$/, "")} km`;
}
/** "12 min", "1 hr 50 min". */
export function minutesWords(seconds) {
  const mins = Math.max(1, Math.round((seconds || 0) / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ""}`;
}
const clockIn = (ms, tz) => new Date(ms).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
/** "7" on the hour, else "7:30": the design's "It starts at 7." */
export function startsLabel(ms, tz) {
  const t = clockIn(ms, tz).replace(/\s?[AP]M$/i, "");
  return t.endsWith(":00") ? t.slice(0, -3) : t;
}

// ---------- the walk ----------
/** The point `along` metres down a line. */
export function pointAt(line, along) {
  const a = Math.max(0, Math.min(line.total, along));
  for (let i = 1; i < line.points.length; i++) {
    if (line.cum[i] >= a) {
      const seg = line.cum[i] - line.cum[i - 1] || 1;
      const t = (a - line.cum[i - 1]) / seg;
      const p = line.points[i - 1], q = line.points[i];
      return { lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t };
    }
  }
  return line.points[line.points.length - 1];
}

/** The named street nearest p, within maxM metres, from the ways the map fill found. */
export function streetNear(p, streets, maxM = 18) {
  let best = null;
  for (const s of streets || []) {
    const pts = (s.c || []).map(([lng, lat]) => ({ lat, lng }));
    if (pts.length < 2) continue;
    const off = project(p, lineOf(pts)).off;
    if (off <= maxM && (!best || off < best.off)) best = { off, name: s.n };
  }
  return best ? best.name : "";
}

/**
 * OSRM's steps as the page's steps. A crossing or a kerb (a step under FOLD_M) and a "new name" that
 * goes straight on are folded into the step before, so the list is the turns a person would name. A
 * way with no name (a footpath, a sidewalk OpenStreetMap keeps apart from its street) takes the name of
 * the street it runs beside when the map fill has found one, and is otherwise described, never blank.
 */
export function stepsFromOsrm(raw, { placeName = "", line = null, streets = [], names = {} } = {}) {
  const ms = (raw || []).filter((s) => s && s.maneuver);
  const kept = [];
  ms.forEach((s0, i) => {
    const s = { ...s0, distance: s0.distance || 0 };
    const type = s.maneuver.type || "";
    const straight = !s.maneuver.modifier || s.maneuver.modifier === "straight";
    const inner = i > 0 && i < ms.length - 1 && kept.length > 0;
    if (inner && ((s.distance < FOLD_M && !/roundabout|rotary/.test(type)) || ((type === "new name" || type === "continue") && straight))) {
      kept[kept.length - 1].distance += s.distance;
      return;
    }
    kept.push(s);
  });
  const nameOf = (s) => {
    const own = (s.name || "").trim() || names[locKey(s.maneuver.location)] || "";
    if (own || !line || !streets.length) return own;
    const [lng, lat] = s.maneuver.location || [0, 0];
    const along = project({ lat, lng }, line).along;
    return streetNear(pointAt(line, along + 12), streets) || streetNear({ lat, lng }, streets);
  };
  const arrive = kept.length ? kept[kept.length - 1] : null;
  const side = arrive && arrive.maneuver.type === "arrive" ? (/left/.test(arrive.maneuver.modifier || "") ? "left" : /right/.test(arrive.maneuver.modifier || "") ? "right" : "") : "";
  return kept.map((s, i) => {
    const m = s.maneuver;
    const name = nameOf(s);
    const NAME = name.toUpperCase();
    const type = m.type || "";
    const isStart = type === "depart";
    const isArrive = type === "arrive";
    const isRound = /roundabout|rotary/.test(type);
    const turn = isArrive ? side || "straight" : isRound ? "roundabout" : isStart ? "straight" : /left/.test(m.modifier || "") ? "left" : /right/.test(m.modifier || "") ? "right" : "straight";
    let instr, fact, mark = "";
    if (isArrive) {
      instr = side ? `${placeName}, on your ${side}` : placeName;
      fact = side ? `ON YOUR ${side.toUpperCase()}` : "JUST AHEAD";
    } else if (isStart) {
      const dir = Number.isFinite(m.bearing_after) ? compassWord(m.bearing_after) : "";
      instr = name ? `${dir ? `Head ${dir}` : "Walk"} on ${name}` : dir ? `Head ${dir}` : "Start walking";
      fact = name ? `ALONG ${NAME}` : "THE WAY AHEAD";
      if (!name) mark = "Keep on the way in front of you. It has no street name.";
    } else {
      const exit = Number.isInteger(m.exit) && m.exit > 0 ? ORDINAL[m.exit - 1] || `${m.exit}th` : "";
      const verb = isRound ? `Roundabout: take the ${exit || "next"} exit` : type === "fork" ? (/left/.test(m.modifier || "") ? "Keep left" : "Keep right") : MANEUVER_WORD[m.modifier] || "Keep going";
      instr = name ? `${verb} on ${name}` : verb;
      fact = name ? `INTO ${NAME}` : "THE WAY AHEAD";
      if (!name) mark = "The way has no street name.";
    }
    const [lng, lat] = m.location || [0, 0];
    return {
      n: String(i + 1).padStart(2, "0"),
      instr,
      turn,
      street: isArrive ? String(placeName).toUpperCase() : NAME || "THE WAY AHEAD",
      fact,
      mark,
      d: isArrive ? "" : distanceWords(s.distance),
      ...(name && !isStart && !isArrive ? { into: `INTO ${NAME}` } : {}),
      lat: round6(lat),
      lng: round6(lng),
    };
  });
}

export const round6 = (x) => Math.round(x * 1e6) / 1e6;
export const locKey = (loc) => (Array.isArray(loc) ? `${round6(loc[0])},${round6(loc[1])}` : "");

/**
 * A walk from `from` to `to` from the foot router. Nothing about either point is logged or kept here.
 * Returns { ok, route, steps, metres, seconds, side, raw } or { ok: false, status, error }.
 */
export async function walkRoute(from, to, { routingUrl = config.directionsRouting, fetchImpl = fetch, placeName = "", streets = [], timeoutMs = 8000 } = {}) {
  if (!routingUrl) return { ok: false, status: 503, error: "no_routing" };
  const url = `${routingUrl.replace(/\/+$/, "")}/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`routing ${res.status}`);
    const data = await res.json();
    const r = data && data.routes && data.routes[0];
    if (!r || !r.geometry || r.geometry.coordinates.length < 2) throw new Error("no route");
    const route = r.geometry.coordinates.map(([lng, lat]) => ({ lat: round6(lat), lng: round6(lng) }));
    const raw = (r.legs || []).flatMap((leg) => leg.steps || []);
    const line = lineOf(route);
    const steps = stepsFromOsrm(raw, { placeName, line, streets });
    if (!steps.length) throw new Error("no steps");
    const last = raw.length ? raw[raw.length - 1] : null;
    const side = last && last.maneuver && last.maneuver.type === "arrive" && ["left", "right"].includes(steps[steps.length - 1].turn) ? steps[steps.length - 1].turn : "";
    return { ok: true, route, steps, raw, metres: r.distance ?? line.total, seconds: r.duration ?? line.total / 1.3, side };
  } catch (e) {
    return { ok: false, status: 502, error: "routing_failed", why: (e?.message ?? String(e)).split("\n")[0] };
  }
}

// ---------- the map: streets, parks and water near the walk (Overpass) ----------
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const MINOR = /^(residential|unclassified|living_street|pedestrian|service|road)$/;
const MAX_POINTS = 24000;

/** The box the map needs: the route and the door, with ~170 m round them. */
export function boxAround(points) {
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
  const padLat = 0.0015, padLng = 0.0015 / Math.max(0.2, Math.cos((lats[0] * Math.PI) / 180));
  return { s: Math.min(...lats) - padLat, w: Math.min(...lngs) - padLng, n: Math.max(...lats) + padLat, e: Math.max(...lngs) + padLng };
}

export function overpassQuery(box, dest) {
  const b = `(${box.s.toFixed(5)},${box.w.toFixed(5)},${box.n.toFixed(5)},${box.e.toFixed(5)})`;
  return `[out:json][timeout:20];(`
    + `way["highway"]${b};`
    + `way["leisure"~"^(park|garden|playground)$"]${b};way["landuse"~"^(grass|recreation_ground|village_green)$"]${b};`
    + `way["natural"="water"]${b};way["waterway"="riverbank"]${b};`
    + `node["amenity"~"^(cafe|restaurant|bar|pub)$"]["name"](around:300,${dest.lat.toFixed(5)},${dest.lng.toFixed(5)});`
    + `);out geom qt;`;
}

/** Overpass's answer as the trip's map, the named streets (server-only, for naming steps) and what is nearby. */
export function shapesFrom(data, { dest, placeName = "" } = {}) {
  const map = { major: [], minor: [], parks: [], water: [], pois: [], labels: [] };
  const streets = [];
  const nearby = [];
  let points = 0;
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  for (const el of (data && data.elements) || []) {
    const tags = el.tags || {};
    if (el.type === "node") {
      if (tags.name && dest && tags.name.trim().toLowerCase() !== String(placeName).trim().toLowerCase()) {
        nearby.push({ name: tags.name.trim(), m: haversine(dest, { lat: el.lat, lng: el.lon }) });
      }
      continue;
    }
    const g = el.geometry;
    if (el.type !== "way" || !Array.isArray(g) || g.length < 2 || g.length > 1500) continue;
    const c = g.map((p) => [r5(p.lon), r5(p.lat)]);
    const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
    // A cycle lane's name is never what a person walking calls the street beside it.
    if (tags.highway && tags.name && tags.highway !== "cycleway") streets.push({ n: tags.name.trim(), c });
    if (points + c.length > MAX_POINTS) continue;
    let into = null;
    if (tags.highway && MAJOR.test(tags.highway)) into = map.major;
    else if (tags.highway && MINOR.test(tags.highway)) into = map.minor;
    else if (!tags.highway && closed && (tags.leisure || tags.landuse)) into = map.parks;
    else if (!tags.highway && closed && (tags.natural === "water" || tags.waterway === "riverbank")) into = map.water;
    if (!into) continue;
    into.push(c);
    points += c.length;
  }
  nearby.sort((a, b) => a.m - b.m);
  const near = nearby.slice(0, 2).map((p) => `${p.name.toUpperCase()}, ${Math.max(1, Math.round(p.m / 1.3 / 60))} MIN`).join(" · ");
  return { map, streets, nearby: near };
}

// ---------- the door: entrances and landmarks at the end (Overpass) ----------
/** How far round the end a landmark (a shop, a café, a church) is still "next to" it. */
export const LANDMARK_M = 45;
/** An entrance node this far from the end counts as the place's own door when no building is mapped round it. */
export const ENTRANCE_NEAR_M = 30;

/**
 * The small question asked about the end alone: the building the end is in and its entrances (entrance=*
 * nodes on its outline), any entrance right beside it, and the named places round it.
 */
export function arrivalQuery(dest) {
  const at = `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`;
  const near = (m, f) => `node(around:${m},${at})${f};`;
  return `[out:json][timeout:15];is_in(${at})->.a;way(pivot.a)["building"]->.b;.b out body;`
    + `(node(w.b)["entrance"];${near(ENTRANCE_NEAR_M, '["entrance"]')})->.e;.e out body;`
    + `(${["shop", "amenity", "tourism", "historic", "leisure"].map((k) => near(LANDMARK_M + 15, `["name"]["${k}"]`)).join("")})->.l;.l out body;`;
}

const ENTRANCE_KIND = { main: "MAIN ENTRANCE", yes: "ENTRANCE", home: "FRONT DOOR", staircase: "ENTRANCE", service: "SIDE ENTRANCE" };
// Never somewhere to send a person in by.
const NOT_A_WAY_IN = /^(exit|emergency|no)$/;
const LANDMARK_SKIP = /^(bench|waste_basket|bicycle_parking|parking|parking_entrance|atm|vending_machine|post_box|telephone|drinking_water|recycling|charging_station|toilets|fountain|clock)$/;
// A named point that is a whole area ("Flatiron District", tourism=attraction) is not something a door is next to.
const isLandmark = (t) => (t.shop ? true : t.amenity ? !LANDMARK_SKIP.test(t.amenity) : t.tourism ? /^(hotel|hostel|museum|gallery)$/.test(t.tourism) : t.historic ? /^(monument|memorial|church)$/.test(t.historic) : !!t.leisure && /^(fitness_centre|sports_centre)$/.test(t.leisure));

/**
 * What the end's own door and neighbours are, from arrivalQuery's answer: { entrance, look, landmark }.
 * `entrance` is the arrival line under the caption ("MAIN ENTRANCE ON EAST 21ST STREET, NEXT TO
 * GRAMERCY PHARMACY"), `look` the sentence after "It's on your right." ("Look for the main entrance.").
 * Both "" when OpenStreetMap knows nothing, so the page says what it said before.
 */
export function arrivalFacts(data, { dest, arriveAt = dest, placeName = "", streets = [] } = {}) {
  const els = (data && data.elements) || [];
  const onBuilding = new Set(els.filter((e) => e.type === "way" && Array.isArray(e.nodes)).flatMap((e) => e.nodes));
  const same = (n) => String(n || "").trim().toLowerCase() === String(placeName).trim().toLowerCase();
  const doors = [];
  const marks = [];
  for (const el of els) {
    if (el.type !== "node" || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const t = el.tags || {};
    const p = { lat: el.lat, lng: el.lon };
    if (t.entrance) {
      if (NOT_A_WAY_IN.test(t.entrance) || t.access === "private" || t.access === "no") continue;
      const own = onBuilding.has(el.id);
      if (!own && haversine(dest, p) > ENTRANCE_NEAR_M) continue;
      doors.push({ t, p, own, rank: (own ? 0 : 10) + (t.entrance === "main" ? 0 : t.entrance === "service" ? 4 : 2), m: haversine(arriveAt, p) });
    } else if (t.name && !same(t.name) && isLandmark(t)) {
      marks.push({ name: t.name.trim(), p });
    }
  }
  doors.sort((a, b) => a.rank - b.rank || a.m - b.m);
  const door = doors[0] || null;
  const from = door ? door.p : dest;
  const mark = marks.map((x) => ({ ...x, m: haversine(from, x.p) })).filter((x) => x.m <= LANDMARK_M).sort((a, b) => a.m - b.m)[0] || null;

  const parts = [];
  let look = "";
  if (door) {
    const t = door.t;
    const label = t.ref ? `ENTRANCE ${String(t.ref).trim().toUpperCase()}` : t.name && !same(t.name) ? String(t.name).trim().toUpperCase() : ENTRANCE_KIND[t.entrance] || "ENTRANCE";
    const street = String(t["addr:street"] || streetNear(door.p, streets, 25) || "").trim();
    parts.push(street ? `${label} ON ${street.toUpperCase()}` : label);
    look = t.ref ? `Look for the entrance marked ${String(t.ref).trim()}.` : `Look for the ${(ENTRANCE_KIND[t.entrance] || "ENTRANCE").toLowerCase()}.`;
  }
  if (mark) {
    parts.push(`NEXT TO ${mark.name.toUpperCase()}`);
    if (!look) look = `It’s next to ${mark.name}.`;
  }
  return { entrance: parts.join(", "), look, landmark: mark ? mark.name : "" };
}

/** A day is long enough for a door not to move; a failed ask is retried after ten minutes, not every trip. */
export const ARRIVAL_CACHE_MS = 24 * 60 * 60 * 1000;
export const ARRIVAL_RETRY_MS = 10 * 60 * 1000;
const ARRIVAL_CACHE_MAX = 300;
const arrivalCache = new Map();
/** For tests: start with nothing remembered. */
export function clearArrivalCache() { arrivalCache.clear(); }

/**
 * The end's door and neighbours, asked of Overpass once per place (cached by the end's spot, ~1 m), and
 * never more than one ask at a time per place. Fails soft: { entrance: "", look: "" } and the page says
 * "It's on your right" as before. Only the end is sent, never where the walk starts.
 */
export async function arrivalFor(dest, { fetchImpl = fetch, servers, now = Date.now(), arriveAt, placeName = "", streets = [] } = {}) {
  const key = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  let hit = arrivalCache.get(key);
  // Still being asked: share that ask. Answered: kept a day. Failed: asked again after ten minutes.
  if (hit && hit.done && now - hit.at >= (hit.data ? ARRIVAL_CACHE_MS : ARRIVAL_RETRY_MS)) { arrivalCache.delete(key); hit = null; }
  if (!hit) {
    if (arrivalCache.size >= ARRIVAL_CACHE_MAX) arrivalCache.delete(arrivalCache.keys().next().value);
    const entry = { at: now, done: false, data: null };
    // Overpass often takes 30–45 s from a busy server; this runs behind the trip, so it can wait.
    entry.ask = overpass(arrivalQuery(dest), { fetchImpl, servers, timeoutMs: 45000 }).catch(() => null)
      .then((data) => { entry.data = data; entry.done = true; return data; });
    arrivalCache.set(key, entry);
    hit = entry;
  }
  const data = await hit.ask;
  if (!data) return { ok: false, entrance: "", look: "", landmark: "" };
  return { ok: true, ...arrivalFacts(data, { dest, arriveAt: arriveAt || dest, placeName, streets }) };
}

export async function overpass(query, { fetchImpl = fetch, timeoutMs = 15000, servers = OVERPASS } = {}) {
  for (const server of servers) {
    try {
      const res = await fetchImpl(server, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.elements)) return data;
    } catch { /* the next server */ }
  }
  return null;
}

