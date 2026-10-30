// Nearby places and reverse geocoding via OpenStreetMap (free, no API key).
//
// Nominatim handles coordinates → address. Overpass handles "find X near Y".
// Both are free and keyless — Nominatim asks for a user-agent and 1 req/sec.

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
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

export async function nearbyPlaces(lat, lng, type, { cuisine, name, radius = 1500, limit = 10, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
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
    const t = setTimeout(() => ac.abort(), timeoutMs);
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

  // Try node-only on each server (fast), then full query as a last resort.
  const attempts = [
    ...OVERPASS_SERVERS.map(s => [s, nodeQuery]),
    [OVERPASS_SERVERS[0], fullQuery],
  ];

  let lastErr;
  for (const [server, query] of attempts) {
    const out = await run(server, query);
    if (!out.ok) { lastErr = out.error; continue; }
    const results = parse(out.data);
    if (results.length === 0 && query === nodeQuery) continue;
    return { ok: true, results, count: results.length };
  }
  return { ok: false, error: lastErr || "all Overpass servers failed" };
}

function escapeSafe(s) { return s.replace(/[\\"|[\](){}]/g, ""); }

export const placeTypes = Object.keys(TYPE_MAP);
