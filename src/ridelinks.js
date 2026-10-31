// Uber ride links: coordinates for each end, and every link that leaves rebuilt from the current
// builder.
//
// On 2026-10-23, asked to "send it again", the model copied a link out of the thread verbatim
// instead of calling uber_link — a link from hours earlier, built before that day's fixes (no
// coordinates, the app-bound /looking path, the web page's JSON nobody's app reads). A rule in the
// prompt cannot make that impossible; this does. Whatever m.uber.com ride link is in a message on
// its way out — made by the tool this turn, copied from history, typed from memory — is read for
// its pickup and drop-off and rebuilt by sites.uberRideLink as it is now, so the link they get is
// always today's.
import * as db from "./db.js";
import { config } from "./config.js";
import { uberRideLink } from "./sites.js";

/** A saved place matching what the model wrote: its name ("home"), or its address, loosely. */
export function savedPlaceFor(c, text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || !c) return null;
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return db.getPlace(c, t) ?? db.listPlaces(c).find(p => p.address && (norm(p.address) === norm(t) || norm(t).startsWith(norm(p.address)) || norm(p.address).startsWith(norm(t)))) ?? null;
}

/**
 * The uber_link input with coordinates on each end that has an address but none: a saved place's
 * own pin first, else the address geocoded (OpenStreetMap, the same lookup set_place uses). A side
 * that cannot be placed keeps its words, and the link says so.
 */
export async function withCoords(input, c, { geocode = null } = {}) {
  const out = { ...input };
  const look = geocode ?? (await import("./places.js")).geocode;
  const place = async (text) => {
    const saved = savedPlaceFor(c, text);
    if (saved?.lat != null && saved?.lng != null) return { lat: saved.lat, lng: saved.lng, address: saved.address ?? text };
    const g = await Promise.resolve().then(() => look(text)).catch(() => null);
    return g ? { lat: g.lat, lng: g.lng, address: text } : null;
  };
  if (out.pickup_latitude == null && out.pickup_address) {
    const p = await place(out.pickup_address);
    if (p) Object.assign(out, { pickup_latitude: p.lat, pickup_longitude: p.lng, pickup_address: p.address });
  }
  if (out.latitude == null && out.address) {
    const d = await place(out.address);
    if (d) Object.assign(out, { latitude: d.lat, longitude: d.lng, address: d.address });
  }
  return out;
}


/** The geocoder rebuilt links use when the caller gives none. A seam for tests; null = OpenStreetMap. */
let defaultGeocode = null;
export function setRideGeocoder(fn) { defaultGeocode = fn; }

const RIDE_LINK = /https:\/\/m\.uber\.com\/(?:go\/)?(?:looking|ul)\/?\?[^\s<>"')]+/g;

/** The pickup and drop-off a ride link carries, in either shape it has ever been written in. */
export function readRideLink(url) {
  let q;
  try { q = new URL(url).searchParams; } catch { return null; }
  const json = (k) => { try { return JSON.parse(q.get(k) ?? "null"); } catch { return null; } };
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const p = json("pickup"), d = json("drop[0]");
  const out = {
    pickup_latitude: num(p?.latitude ?? q.get("pickup[latitude]")),
    pickup_longitude: num(p?.longitude ?? q.get("pickup[longitude]")),
    pickup_address: p?.addressLine1 ?? q.get("pickup[formatted_address]") ?? q.get("pickup[nickname]") ?? null,
    latitude: num(d?.latitude ?? q.get("dropoff[latitude]")),
    longitude: num(d?.longitude ?? q.get("dropoff[longitude]")),
    address: d?.addressLine1 ?? q.get("dropoff[formatted_address]") ?? q.get("dropoff[nickname]") ?? null,
  };
  for (const k of Object.keys(out)) if (out[k] === null || Number.isNaN(out[k])) delete out[k];
  return out.pickup_address || out.address || out.pickup_latitude != null ? out : null;
}

/**
 * The same text with every Uber ride link in it rebuilt by the current builder. Links that cannot
 * be read are left exactly as they are. Never throws: a failure here must not stop a message.
 */
export async function freshRideLinks(text, { conversationId = null, geocode = null, log = () => {} } = {}) {
  const s = String(text ?? "");
  const found = s.match(RIDE_LINK);
  if (!found) return s;
  let out = s;
  for (const url of new Set(found)) {
    try {
      const ends = readRideLink(url);
      if (!ends) continue;
      const placed = await withCoords(ends, conversationId, { geocode: geocode ?? defaultGeocode });
      const fresh = uberRideLink({ ...placed, client_id: config.uberClientId || null });
      if (fresh.ok && fresh.url !== url) {
        out = out.split(url).join(fresh.url);
        // Lengths and flags only: a ride link carries both ends' addresses and coordinates, and
        // none of that belongs in the server log.
        log({
          ride_link_rebuilt: conversationId,
          from_len: url.length,
          to_len: fresh.url.length,
          had_coords: ends.pickup_latitude != null || ends.latitude != null,
          had_client_id: /[?&]client_id=/.test(url),
        });
      }
    } catch (e) {
      // The error's name and code only: its message may quote the link or an address.
      log({ ride_link_rebuild_failed: conversationId, error: e?.name ?? typeof e, code: e?.code ?? null });
    }
  }
  return out;
}
