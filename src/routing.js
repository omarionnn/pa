// Travel time between two points, via OSRM's public API (free, keyless, driving only).
//
// Used by the notice system to decide when a "leave by" text is worth sending. Nominatim's
// forward geocoding (src/places.js) turns a calendar event's location string into coordinates;
// this turns two sets of coordinates into a duration. Both are OpenStreetMap infrastructure,
// both are free, and neither needs a key — Nominatim asks for a user-agent and 1 req/sec.
//
// The OSRM demo server is rate-limited but fine for the notice sweep's cadence (one person,
// a handful of events, every two hours). A production install can point OSRM_BASE at its own
// instance or a commercial endpoint.

import { geocode } from "./places.js";

const OSRM = process.env.REASON_OSRM_BASE || "https://router.project-osrm.org";
const UA = "Reason/1.0 (personal-assistant)";

const geocodeCache = new Map();
const CACHE_TTL = 24 * 60 * 60_000;

async function cachedGeocode(query, opts) {
  const key = String(query).trim().toLowerCase();
  const hit = geocodeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.result;
  const result = await geocode(query, opts);
  geocodeCache.set(key, { result, at: Date.now() });
  if (geocodeCache.size > 200) {
    const oldest = [...geocodeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) geocodeCache.delete(oldest[0]);
  }
  return result;
}

/**
 * Driving time in minutes between two points, via OSRM.
 *
 * Returns `{ ok, minutes, distance_km }` or `{ ok: false, error }`.
 * `distance_km` is the route distance, not straight-line.
 */
export async function drivingTime(fromLat, fromLng, toLat, toLng, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng) ||
      !Number.isFinite(toLat) || !Number.isFinite(toLng)) {
    return { ok: false, error: "invalid coordinates" };
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `${OSRM}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res = await fetchImpl(url, { signal: ac.signal, headers: { "user-agent": UA } });
    if (!res.ok) return { ok: false, error: `osrm ${res.status}` };
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) return { ok: false, error: data.code || "no route" };
    const route = data.routes[0];
    return {
      ok: true,
      minutes: Math.round(route.duration / 60),
      distance_km: Math.round(route.distance / 100) / 10,
    };
  } catch { return { ok: false, error: "osrm unreachable" }; }
  finally { clearTimeout(t); }
}

/**
 * Travel time from coordinates to a location string (geocoded then routed).
 *
 * Returns `{ ok, minutes, distance_km, destination }` or `{ ok: false }`.
 */
export async function travelTimeTo(fromLat, fromLng, locationString, { fetchImpl = fetch } = {}) {
  const dest = await cachedGeocode(locationString, { fetchImpl });
  if (!dest) return { ok: false, error: "could not geocode destination" };
  const route = await drivingTime(fromLat, fromLng, dest.lat, dest.lng, { fetchImpl });
  if (!route.ok) return route;
  return { ...route, destination: dest.display_name };
}
