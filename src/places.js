// Nearby places and reverse geocoding via OpenStreetMap (free, no API key).
//
// Nominatim handles coordinates → address. Overpass handles "find X near Y".
// Both are free and keyless — Nominatim asks for a user-agent and 1 req/sec.

const NOMINATIM = "https://nominatim.openstreetmap.org";
import { clock } from "./config.js";

// The same four servers src/walk.js uses.
export const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// One search gets this long in all, however many servers it tries. When every server fails, the
// next searches skip them for BREAKER_MS and answer at once, so the reply does not wait on them.
const BUDGET_MS = 8_000;
const BREAKER_MS = 5 * 60_000;
let overpassDownUntil = 0;
const DOWN = {
  ok: false,
  down: true,
  error: "Couldn't load nearby places: the map service isn't answering right now.",
  next: "Do not call nearby_places again for this ask. Use web_search for the places instead, and say the list comes from a search.",
};
const UA = "Reason/1.0 (personal-assistant)";

export async function reverseGeocode(lat, lng, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `${NOMINATIM}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=json&addressdetails=1&zoom=18`,
      { signal: ac.signal, headers: { "user-agent": UA } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address || {};
    return {
      display_name: data.display_name || null,
      neighbourhood: a.neighbourhood || a.suburb || a.city_district || null,
      road: a.road || null,
      city: a.city || a.town || a.village || null,
      postcode: a.postcode || null,
    };
  } catch { return null; }
  finally { clearTimeout(t); }
}

/**
 * A place's coordinates from words. `near` ({ lat, lng }) prefers matches around there (Nominatim's
 * viewbox; `bounded` keeps to it, `span` degrees each way), so "Joe Coffee" from Union Square is the
 * one down the road, not one in Queens.
 */
export async function geocode(query, { fetchImpl = fetch, timeoutMs = 3000, near = null, bounded = false, span = 0.15 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const box = near && Number.isFinite(near.lat) && Number.isFinite(near.lng)
    ? `&viewbox=${(near.lng - span).toFixed(4)},${(near.lat + span).toFixed(4)},${(near.lng + span).toFixed(4)},${(near.lat - span).toFixed(4)}${bounded ? "&bounded=1" : ""}`
    : "";
  try {
    const res = await fetchImpl(
      `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=1${box}`,
      { signal: ac.signal, headers: { "user-agent": UA } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, display_name: data[0].display_name || q };
  } catch { return null; }
  finally { clearTimeout(t); }
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

export async function nearbyPlaces(lat, lng, type, { cuisine, name, radius = 1500, limit = 10, fetchImpl = fetch, timeoutMs = 4_000 } = {}) {
  if (clock.now() < overpassDownUntil) return { ...DOWN };
  const deadline = clock.now() + BUDGET_MS;
  const mapping = TYPE_MAP[type] || { key: "amenity", value: type };

  let filters = `["${mapping.key}"="${mapping.value}"]`;
  if (cuisine) filters += `["cuisine"~"${escapeSafe(cuisine)}",i]`;
  if (name) filters += `["name"~"${escapeSafe(name)}",i]`;

  // Nodes first — fast and covers most POIs. Ways (building outlines) are
  // added only when nodes return too few results, because way+around is
  // expensive in dense areas like Manhattan and routinely times out.
  const nodeQuery = `[out:json][timeout:10];`
    + `node${filters}(around:${radius},${lat},${lng});`
    + `out body qt ${limit};`;
  const fullQuery = `[out:json][timeout:10];(`
    + `node${filters}(around:${radius},${lat},${lng});`
    + `way${filters}(around:${radius},${lat},${lng});`
    + `);out center body qt ${limit};`;

  const parse = (data) => (data.elements || []).map(el => {
    const tags = el.tags || {};
    return {
      name: tags.name || null,
      type: tags[mapping.key] || type,
      cuisine: tags.cuisine || null,
      address: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || null,
      city: tags["addr:city"] || null,
      phone: tags.phone || tags["contact:phone"] || null,
      website: tags.website || tags["contact:website"] || null,
      opening_hours: tags.opening_hours || null,
      latitude: el.lat ?? el.center?.lat,
      longitude: el.lon ?? el.center?.lon,
    };
  }).filter(r => r.name);

  async function run(server, query) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(timeoutMs, deadline - clock.now()));
    try {
      const res = await fetchImpl(server, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) return { ok: false, error: `Overpass returned ${res.status}` };
      return { ok: true, data: await res.json() };
    } catch (err) {
      return { ok: false, error: err.name === "AbortError" ? "timed out" : String(err.message || err) };
    } finally { clearTimeout(t); }
  }

  // Node-only on each server in turn (fast) until one answers; if it found none, the full query
  // on that same server, which is up.
  for (const server of OVERPASS_SERVERS) {
    if (clock.now() >= deadline) break;
    const out = await run(server, nodeQuery);
    if (!out.ok) continue;
    let results = parse(out.data);
    if (results.length === 0 && clock.now() < deadline) {
      const full = await run(server, fullQuery);
      if (full.ok) results = parse(full.data);
    }
    overpassDownUntil = 0;
    return { ok: true, results, count: results.length };
  }
  overpassDownUntil = clock.now() + BREAKER_MS;
  return { ...DOWN };
}

function escapeSafe(s) { return s.replace(/[\\"|[\](){}]/g, ""); }

export const placeTypes = Object.keys(TYPE_MAP);
