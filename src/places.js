// Nearby places and (reverse) geocoding from OpenStreetMap data, all free and keyless.
//
// Nominatim: coordinates → address, words → coordinates, and a bounded search around a point.
// Photon (komoot): the same OSM data, searched around a point, with osm_tag filters.
// Overpass: tag queries ("every pharmacy within 1500 m"), the richest answer when it answers.
//
// The public Overpass servers stopped answering for days on end (2026-11: they connect, then never
// reply; overpass-api.de's own status page says 502), and nearby_places had them as its only
// source, so every "find X near me" failed. Now all three are asked at once inside one budget, and
// whatever answered is merged, de-duplicated and sorted by distance. Only when none of them
// answered is the honest "map service isn't answering" given.
//
// Usage rules kept: an identifying User-Agent on every request, at most one request a second to
// Nominatim across this whole process (a queue below), and answers cached for a few minutes.

import { clock } from "./config.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
export const PHOTON = "https://photon.komoot.io/api/";
export const UA = "Reason/1.0 (personal assistant; +https://app.heyreason.com)";

// The same four servers src/walk.js uses. Two are raced per search (a different two each time),
// never four in turn.
export const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
/** The whole search, every source together: on a text, and on a call. */
export const BUDGET_MS = 6_000;
export const CALL_BUDGET_MS = 4_000;
/** Overpass gets this long; when it does not answer it is skipped for BREAKER_MS. */
export const OVERPASS_MS = 2_500;
const BREAKER_MS = 5 * 60_000;
/** Each of Nominatim and Photon gets this long (inside the budget). */
const SOURCE_MS = 3_500;
/** When no source at all answered, the next asks in this window answer at once (the retry layer, the model asking again). */
const ALL_DOWN_MS = 60_000;
export const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 200;
/** Nominatim's rule: an absolute maximum of one request a second. */
export const NOMINATIM_GAP_MS = 1_000;

let overpassDownUntil = 0;
let allDownUntil = 0;
let overpassTurn = 0;
const cache = new Map();

const DOWN = {
  ok: false,
  down: true,
  error: "Couldn't load nearby places: the map service isn't answering right now.",
  next: "Do not call nearby_places again for this ask. Use web_search for the places instead, and say the list comes from a search.",
  // Every source was already asked at once inside one budget: another try straight away only waits
  // longer for the same answer (src/retry.js reads this).
  no_retry: true,
};

// Not unref'd: a search waiting for its Nominatim turn is real work the process must wait for.
const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Nominatim, one request a second for the whole process ----------

let nominatimNextAt = 0;
/**
 * A turn at Nominatim: waits for the next free second and books it. `maxWaitMs`: give up (false)
 * rather than wait longer than that. Uses the real clock, as the rule is about real seconds.
 */
export async function nominatimTurn({ maxWaitMs = Infinity, sleep = realSleep } = {}) {
  const now = Date.now();
  const at = Math.max(now, nominatimNextAt);
  if (at - now > maxWaitMs) return false;
  nominatimNextAt = at + NOMINATIM_GAP_MS;
  if (at > now) await sleep(at - now);
  return true;
}

/** For the tests: forget the cache, the breakers and the Nominatim queue. */
export function resetPlacesState() {
  cache.clear();
  overpassDownUntil = 0;
  allDownUntil = 0;
  overpassTurn = 0;
  nominatimNextAt = 0;
}

async function getJson(url, { fetchImpl, timeoutMs, init = {} }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal, headers: { "user-agent": UA, ...(init.headers || {}) } });
    if (!res.ok) return { ok: false, error: `answered ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "timed out" : String(err?.message || err) };
  } finally { clearTimeout(t); }
}

export async function reverseGeocode(lat, lng, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  await nominatimTurn();
  const out = await getJson(
    `${NOMINATIM}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=json&addressdetails=1&zoom=18`,
    { fetchImpl, timeoutMs },
  );
  if (!out.ok || !out.data || typeof out.data !== "object") return null;
  const data = out.data;
  const a = data.address || {};
  return {
    display_name: data.display_name || null,
    neighbourhood: a.neighbourhood || a.suburb || a.city_district || null,
    road: a.road || null,
    city: a.city || a.town || a.village || null,
    postcode: a.postcode || null,
  };
}

/**
 * A place's coordinates from words. `near` ({ lat, lng }) prefers matches around there (Nominatim's
 * viewbox; `bounded` keeps to it, `span` degrees each way), so "Joe Coffee" from Union Square is the
 * one down the road, not one in Queens.
 */
export async function geocode(query, { fetchImpl = fetch, timeoutMs = 3000, near = null, bounded = false, span = 0.15 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return null;
  const box = near && Number.isFinite(near.lat) && Number.isFinite(near.lng)
    ? `&viewbox=${(near.lng - span).toFixed(4)},${(near.lat + span).toFixed(4)},${(near.lng + span).toFixed(4)},${(near.lat - span).toFixed(4)}${bounded ? "&bounded=1" : ""}`
    : "";
  await nominatimTurn();
  const out = await getJson(`${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=1${box}`, { fetchImpl, timeoutMs });
  const data = out.ok ? out.data : null;
  if (!Array.isArray(data) || !data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, display_name: data[0].display_name || q };
}

const TYPE_MAP = {
  restaurant:  { key: "amenity",  value: "restaurant" },
  cafe:        { key: "amenity",  value: "cafe" },
  bar:         { key: "amenity",  value: "bar" },
  fast_food:   { key: "amenity",  value: "fast_food" },
  cinema:      { key: "amenity",  value: "cinema" },
  theatre:     { key: "amenity",  value: "theatre" },
  park:        { key: "leisure",  value: "park" },
  hospital:    { key: "amenity",  value: "hospital" },
  pharmacy:    { key: "amenity",  value: "pharmacy" },
  supermarket: { key: "shop",     value: "supermarket" },
  gas_station: { key: "amenity",  value: "fuel" },
  bank:        { key: "amenity",  value: "bank" },
  hotel:       { key: "tourism",  value: "hotel" },
  gym:         { key: "leisure",  value: "fitness_centre" },
  library:     { key: "amenity",  value: "library" },
  museum:      { key: "tourism",  value: "museum" },
  bakery:      { key: "shop",     value: "bakery" },
  clothing:    { key: "shop",     value: "clothes" },
  bookstore:   { key: "shop",     value: "books" },
  ice_cream:   { key: "amenity",  value: "ice_cream" },
  nightclub:   { key: "amenity",  value: "nightclub" },
  pub:         { key: "amenity",  value: "pub" },
};
// A type that is itself an OSM key ("shop", "amenity"): any value of it.
const KEY_ONLY = new Set(["shop", "amenity", "tourism", "leisure", "craft", "office", "healthcare"]);
// Where a cuisine is asked for, these are the places that serve it.
const FOOD = new Set(["restaurant", "fast_food", "cafe", "food_court", "bar", "pub", "ice_cream"]);
// Words for a type when it is searched as text (Nominatim and Photon).
const WORD = { gas_station: "gas station", fast_food: "fast food", ice_cream: "ice cream", clothing: "clothes", bookstore: "books", gym: "gym" };

/** What a type means in OSM tags: `{ key, value }`, `{ key, value: null }` for any value, or `{ key: null, value }` for "any key with this value". */
function mappingOf(type) {
  const t = String(type ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (TYPE_MAP[t]) return TYPE_MAP[t];
  if (KEY_ONLY.has(t)) return { key: t, value: null };
  return { key: null, value: t };
}

const R = 6_371_000;
const rad = (d) => d * Math.PI / 180;
/** Metres between two points. */
export function distanceM(lat1, lng1, lat2, lng2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** A box `radius` metres each way from the point: { west, south, east, north }. */
function boxAround(lat, lng, radius) {
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.max(0.01, Math.cos(rad(lat))));
  return { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat };
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Does a place's name answer a name search: every word of the search is in it. */
function nameMatches(placeName, wanted) {
  const have = ` ${norm(placeName)} `;
  const words = norm(wanted).split(" ").filter(w => w.length > 1 || /\d/.test(w));
  if (!words.length) return true;
  return words.every(w => have.includes(` ${w} `) || have.replace(/ /g, "").includes(w));
}

function escapeSafe(s) { return String(s).replace(/[\\"|[\](){}]/g, ""); }

// ---------- the three sources: each returns { ok, results } (results already in the common shape) ----------

function overpassQuery(m, { cuisine, name, radius, lat, lng, limit }) {
  let filters;
  if (m.key && m.value) filters = `["${m.key}"="${escapeSafe(m.value)}"]`;
  else if (m.key) filters = `["${m.key}"]`;
  else filters = `[~"^(amenity|shop|tourism|leisure)$"~"^${escapeSafe(m.value)}$"]`;
  if (cuisine) filters += `["cuisine"~"${escapeSafe(cuisine)}",i]`;
  if (name) filters += `["name"~"${escapeSafe(name)}",i]`;
  // Nodes only: way+around is expensive in dense areas like Manhattan and routinely times out;
  // Nominatim and Photon cover the buildings.
  return `[out:json][timeout:5];node${filters}(around:${radius},${lat},${lng});out body qt ${Math.max(limit, 20)};`;
}

function fromOverpass(data, m, type) {
  return (data?.elements || []).map(el => {
    const tags = el.tags || {};
    return {
      name: tags.name || null,
      type: (m.key ? tags[m.key] : null) || tags.amenity || tags.shop || type,
      cuisine: tags.cuisine || null,
      address: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || null,
      city: tags["addr:city"] || null,
      phone: tags.phone || tags["contact:phone"] || null,
      website: tags.website || tags["contact:website"] || null,
      opening_hours: tags.opening_hours || null,
      latitude: el.lat ?? el.center?.lat,
      longitude: el.lon ?? el.center?.lon,
      _id: el.type && el.id != null ? `${el.type[0].toUpperCase()}${el.id}` : null,
      _src: "overpass",
    };
  });
}

async function askOverpass(query, parse, { fetchImpl, deadline }) {
  if (clock.now() < overpassDownUntil) return { ok: false, skipped: true };
  const start = overpassTurn++ % OVERPASS_SERVERS.length;
  const servers = [OVERPASS_SERVERS[start], OVERPASS_SERVERS[(start + 1) % OVERPASS_SERVERS.length]];
  const timeoutMs = Math.min(OVERPASS_MS, deadline - clock.now());
  const one = async (server) => {
    const out = await getJson(server, {
      fetchImpl, timeoutMs,
      init: { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query)}` },
    });
    if (!out.ok || !Array.isArray(out.data?.elements)) throw new Error(out.error || "no elements");
    return out.data;
  };
  try {
    const data = await Promise.any(servers.map(one));
    overpassDownUntil = 0;
    return { ok: true, results: parse(data) };
  } catch {
    overpassDownUntil = clock.now() + BREAKER_MS;
    return { ok: false };
  }
}

function fromNominatim(data) {
  return (Array.isArray(data) ? data : []).map(p => {
    const a = p.address || {};
    const x = p.extratags || {};
    return {
      name: p.name || p.namedetails?.name || null,
      type: p.type || null,
      cuisine: x.cuisine || null,
      address: [a.house_number, a.road].filter(Boolean).join(" ") || null,
      city: a.city || a.town || a.village || a.suburb || null,
      phone: x.phone || x["contact:phone"] || null,
      website: x.website || x["contact:website"] || null,
      opening_hours: x.opening_hours || null,
      latitude: parseFloat(p.lat),
      longitude: parseFloat(p.lon),
      _id: p.osm_type && p.osm_id != null ? `${String(p.osm_type)[0].toUpperCase()}${p.osm_id}` : null,
      _key: p.category || p.class || null,
      _src: "nominatim",
    };
  });
}

async function askNominatim(q, box, { fetchImpl, deadline, limit, sleep }) {
  // A turn in the one-a-second queue, only if it comes soon enough to be any use.
  const room = deadline - clock.now();
  if (!(await nominatimTurn({ maxWaitMs: room - 1_000, sleep }))) return { ok: false, skipped: true };
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=${limit}`
    + `&viewbox=${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)},${box.south.toFixed(5)}&bounded=1`;
  const out = await getJson(url, { fetchImpl, timeoutMs: Math.min(SOURCE_MS, deadline - clock.now()) });
  if (!out.ok || !Array.isArray(out.data)) return { ok: false };
  return { ok: true, results: fromNominatim(out.data) };
}

function fromPhoton(data) {
  return (Array.isArray(data?.features) ? data.features : []).map(f => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    return {
      name: p.name || null,
      type: p.osm_value || null,
      cuisine: null,
      address: [p.housenumber, p.street].filter(Boolean).join(" ") || null,
      city: p.city || p.district || null,
      phone: null,
      website: null,
      opening_hours: null,
      latitude: Number(lat),
      longitude: Number(lon),
      _id: p.osm_type && p.osm_id != null ? `${String(p.osm_type)[0].toUpperCase()}${p.osm_id}` : null,
      _key: p.osm_key || null,
      _src: "photon",
    };
  });
}

async function askPhoton(q, tag, box, { fetchImpl, deadline, lat, lng, limit }) {
  const params = new URLSearchParams({ q, lat: lat.toFixed(5), lon: lng.toFixed(5), limit: String(limit), lang: "en" });
  params.set("bbox", `${box.west.toFixed(5)},${box.south.toFixed(5)},${box.east.toFixed(5)},${box.north.toFixed(5)}`);
  if (tag) params.append("osm_tag", tag);
  const out = await getJson(`${PHOTON}?${params}`, { fetchImpl, timeoutMs: Math.min(SOURCE_MS, deadline - clock.now()) });
  if (!out.ok || !Array.isArray(out.data?.features)) return { ok: false };
  return { ok: true, results: fromPhoton(out.data) };
}

// ---------- the search ----------

const FIELDS = ["name", "type", "cuisine", "address", "city", "phone", "website", "opening_hours"];

/** One list from several sources: the same place once (same OSM object, or the same name within 80 m), fields filled from each. */
function merge(lists) {
  const out = [];
  for (const r of lists.flat()) {
    const same = out.find(o => (r._id && o._id === r._id)
      || (norm(o.name) === norm(r.name) && distanceM(o.latitude, o.longitude, r.latitude, r.longitude) < 80));
    if (!same) { out.push({ ...r, _srcs: new Set([r._src]) }); continue; }
    for (const f of FIELDS) if (same[f] == null && r[f] != null) same[f] = r[f];
    same._srcs.add(r._src);
  }
  return out;
}

/**
 * Places of a kind near a point, nearest first: `{ ok: true, results, count, answered_by }`, or the
 * honest `DOWN` result when no source answered. Each result: name, type, cuisine, address, city,
 * phone, website, opening_hours (only when the source has them; never made up), latitude,
 * longitude, distance_m. `budgetMs`: the whole search, every source (CALL_BUDGET_MS on a call).
 */
export async function nearbyPlaces(lat, lng, type, { cuisine, name, radius = 1500, limit = 10, fetchImpl = fetch, budgetMs = BUDGET_MS, sleep = realSleep } = {}) {
  lat = Number(lat); lng = Number(lng);
  radius = Math.max(100, Math.min(50_000, Number(radius) || 1500));
  const key = JSON.stringify([String(type ?? "").toLowerCase(), String(cuisine ?? "").toLowerCase(), String(name ?? "").toLowerCase(), radius, limit, lat.toFixed(3), lng.toFixed(3)]);
  const hit = cache.get(key);
  if (hit && hit.until > clock.now()) return { ...hit.value, results: hit.value.results.map(r => ({ ...r })), cached: true };
  if (clock.now() < allDownUntil) return { ...DOWN };

  const deadline = clock.now() + budgetMs;
  const m = mappingOf(type);
  const box = boxAround(lat, lng, radius);
  const word = WORD[String(type ?? "").toLowerCase()] ?? (m.value || m.key || String(type ?? "")).replace(/_/g, " ");
  const text = name || cuisine || word;
  // Photon's filter: the tag for a category search ("amenity:pharmacy", "shop", ":party"); none on a
  // name search, where the type the model gave is often loose ("shop" for a party store).
  const tag = name ? null : (m.key && m.value ? `${m.key}:${m.value}` : m.key ? m.key : `:${m.value}`);
  const many = name ? 15 : 40;

  const [over, nomi, phot] = await Promise.all([
    askOverpass(overpassQuery(m, { cuisine, name, radius, lat, lng, limit }), (d) => fromOverpass(d, m, type), { fetchImpl, deadline }),
    askNominatim(text, box, { fetchImpl, deadline, limit: many, sleep }),
    askPhoton(text, cuisine ? "amenity" : tag, box, { fetchImpl, deadline, lat, lng, limit: name ? 15 : 30 }),
  ]);
  const answered = [["overpass", over], ["nominatim", nomi], ["photon", phot]].filter(([, o]) => o.ok);
  if (!answered.length) {
    allDownUntil = clock.now() + ALL_DOWN_MS;
    return { ...DOWN };
  }
  allDownUntil = 0;

  // What each text source found that is not what was asked: a street called "Pharmacy Lane", a
  // shop called "Party & Craft" for "Party City", a ramen shop's neighbour.
  const fits = (r) => {
    if (!r.name || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) return false;
    if (r._src === "overpass") return true; // its query is the filter
    if (name) return nameMatches(r.name, name);
    if (cuisine) return FOOD.has(String(r.type)) && (nameMatches(r.name, cuisine) || (r.cuisine != null && norm(r.cuisine).includes(norm(cuisine))));
    if (m.key && m.value) return r._key === m.key && r.type === m.value;
    if (m.key) return r._key === m.key;
    return r.type === m.value;
  };
  const found = merge(answered.map(([, o]) => o.results.filter(fits)))
    .map(r => ({ ...r, distance_m: Math.round(distanceM(lat, lng, r.latitude, r.longitude)) }))
    .filter(r => r.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
  const by = new Set();
  const results = found.map(({ _id, _key, _src, _srcs, ...r }) => { for (const s of _srcs) by.add(s); return r; });
  const value = {
    ok: true, results, count: results.length,
    // Which sources answered (for the journal): the ones whose places are in the list, else all that answered.
    answered_by: (by.size ? [...by] : answered.map(([s]) => s)).join("+"),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { until: clock.now() + CACHE_MS, value });
  return { ...value, results: results.map(r => ({ ...r })) };
}

export const placeTypes = Object.keys(TYPE_MAP);
