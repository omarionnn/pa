// Google Places API (New), Text Search: the first source for nearby_places when a key is set
// (REASON_GOOGLE_PLACES_KEY). With no key this file is never loaded and nearby_places runs on the
// free OpenStreetMap sources alone (src/places.js), exactly as before.
//
// What it costs is decided by the field mask (Google's docs, read 2026-11-14: a request is billed
// at the highest SKU among the fields asked for):
//   - PRO (Text Search Pro: 5,000 free a month, then $32 per 1,000): id, displayName, formattedAddress,
//     shortFormattedAddress, location, businessStatus, googleMapsUri, primaryType. Used by default.
//   - ENTERPRISE (Text Search Enterprise: 1,000 free a month, then $35 per 1,000): the Pro fields plus
//     currentOpeningHours, nationalPhoneNumber, internationalPhoneNumber, rating, userRatingCount,
//     priceLevel, websiteUri. Only when the ask needs hours, a phone number or ratings.
//   "Only open now" is the `openNow` request parameter, not a field: it filters on Google's side and
//   stays on the Pro mask.
//
// A hard monthly cap per tier (REASON_GOOGLE_PLACES_PRO_MAX, default 4500; REASON_GOOGLE_PLACES_ENT_MAX,
// default 900: inside the free allowances), counted in the database by Google's billing month
// (Pacific time). A request is counted when it is SENT, so a timeout Google may still bill is
// counted too. Over a cap, on any error or after GOOGLE_MS, nearby_places uses the free sources and
// the person never hears about it.
//
// Google's terms (Places API policies, read 2026-11-14): Places content may not be cached or stored,
// except place IDs (no limit) and coordinates (up to 30 days). So nothing Google returns is put in
// nearby_places' cache; each result carries its place_id and its Google Maps link, and Google Maps is
// credited when a place is sent.
//
// The key is read from the environment at each call, sent only to places.googleapis.com in a
// header, and never logged or returned.

import * as db from "./db.js";
import { clock } from "./config.js";

export const GOOGLE_URL = "https://places.googleapis.com/v1/places:searchText";
/** Google gets this long; the free sources get the rest of nearby_places' budget. */
export const GOOGLE_MS = 2_500;
/** After a timeout or a 5xx, Google is skipped this long (a fast refusal like a bad key costs nothing, so no breaker for it). */
const BREAKER_MS = 2 * 60_000;
let downUntil = 0;
/** For the tests. */
export function resetGoogleState() { downUntil = 0; }

const PRO_FIELDS = ["id", "displayName", "formattedAddress", "shortFormattedAddress", "location", "businessStatus", "googleMapsUri", "primaryType"];
const ENT_FIELDS = ["currentOpeningHours", "nationalPhoneNumber", "internationalPhoneNumber", "rating", "userRatingCount", "priceLevel", "websiteUri"];
export const MASKS = {
  pro: PRO_FIELDS.map(f => `places.${f}`).join(","),
  enterprise: [...PRO_FIELDS, ...ENT_FIELDS].map(f => `places.${f}`).join(","),
};
/** Google's free monthly allowance and list price per 1,000 after it, per tier (pricing page, read 2026-11-14). */
export const TIERS = {
  pro: { free: 5_000, usdPer1000: 32, env: "REASON_GOOGLE_PLACES_PRO_MAX", defaultMax: 4_500 },
  enterprise: { free: 1_000, usdPer1000: 35, env: "REASON_GOOGLE_PLACES_ENT_MAX", defaultMax: 900 },
};
/** What the ask may need beyond the Pro fields. Any of them → Enterprise. */
export const DETAILS = ["hours", "phone", "rating", "website", "price"];

export const googleKey = () => String(process.env.REASON_GOOGLE_PLACES_KEY ?? "").trim();
export const configured = () => !!googleKey();
export function capOf(tier) {
  const raw = String(process.env[TIERS[tier].env] ?? "").trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? Math.floor(v) : TIERS[tier].defaultMax;
}

/** Google's billing month, "2026-11", in Pacific time (how Google Cloud billing closes a month). */
export function monthOf(ms = clock.now()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(new Date(ms));
  return `${p.find(x => x.type === "year").value}-${p.find(x => x.type === "month").value}`;
}

/** This month's count for a tier. */
export function used(tier, month = monthOf()) {
  try { return db.googlePlacesUsed(month, tier); } catch { return 0; }
}
/** Take one request from this month's cap, or false when it is used up (one statement, so two searches at once can't both take the last one). */
export function claim(tier, month = monthOf()) {
  try { return db.googlePlacesClaim(month, tier, capOf(tier)); } catch { return false; }
}

/** Estimated cost in cents for `n` requests of a tier this month: $0 inside the free allowance. */
export function estCents(tier, n) {
  const t = TIERS[tier];
  return Math.round(Math.max(0, n - t.free) * t.usdPer1000 / 10);
}

/** Which tier an ask needs: Enterprise only for hours, phone, ratings, website or price. */
export function tierFor({ details = [] } = {}) {
  return (Array.isArray(details) ? details : []).some(d => DETAILS.includes(String(d))) ? "enterprise" : "pro";
}

// The tool's types as Google's Table A types (place-types page, read 2026-11-14).
const GOOGLE_TYPE = {
  restaurant: "restaurant", cafe: "cafe", bar: "bar", fast_food: "fast_food_restaurant", cinema: "movie_theater",
  theatre: "performing_arts_theater", park: "park", hospital: "hospital", pharmacy: "pharmacy", supermarket: "supermarket",
  gas_station: "gas_station", bank: "bank", hotel: "hotel", gym: "gym", library: "library", museum: "museum",
  bakery: "bakery", clothing: "clothing_store", bookstore: "book_store", ice_cream: "ice_cream_shop", nightclub: "night_club", pub: "pub",
};
const WORDS = { fast_food: "fast food", gas_station: "gas station", ice_cream: "ice cream", clothing: "clothing store", bookstore: "bookstore", cinema: "movie theater" };

const rad = (d) => d * Math.PI / 180;

/** The request body: a name near the point (bias circle), or a kind of place inside the box (restriction, nearest first). Exported for the tests. */
export function requestBody(lat, lng, type, { name, cuisine, radius = 1500, openNow = false } = {}) {
  const t = String(type ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const body = { languageCode: "en", pageSize: 20 };
  if (name) {
    body.textQuery = String(name);
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50_000, radius) } };
  } else {
    body.textQuery = cuisine ? `${cuisine} ${t === "cafe" ? "cafe" : "restaurant"}` : (WORDS[t] ?? t.replace(/_/g, " "));
    if (!cuisine && GOOGLE_TYPE[t]) { body.includedType = GOOGLE_TYPE[t]; body.strictTypeFiltering = true; }
    // Text Search takes only a rectangle as a restriction.
    const dLat = radius / 111_320;
    const dLng = radius / (111_320 * Math.max(0.01, Math.cos(rad(lat))));
    body.locationRestriction = { rectangle: { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } } };
    body.rankPreference = "DISTANCE";
  }
  if (openNow) body.openNow = true;
  return body;
}

const firstPart = (s) => (s ? String(s).split(",")[0].trim() || null : null);
const secondPart = (s) => (s ? String(s).split(",")[1]?.trim() || null : null);

/** Google's places in nearby_places' shape, plus what Google returned that the free sources lack. Nothing absent is filled in. */
export function mapPlaces(places, tier) {
  return (Array.isArray(places) ? places : []).filter(p => p && p.businessStatus !== "CLOSED_PERMANENTLY").map(p => {
    const hours = p.currentOpeningHours;
    const r = {
      name: p.displayName?.text ?? null,
      type: p.primaryType ?? null,
      cuisine: null,
      address: firstPart(p.shortFormattedAddress) ?? firstPart(p.formattedAddress),
      city: secondPart(p.shortFormattedAddress) ?? secondPart(p.formattedAddress),
      phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
      website: p.websiteUri ?? null,
      opening_hours: Array.isArray(hours?.weekdayDescriptions) && hours.weekdayDescriptions.length ? hours.weekdayDescriptions.join("; ") : null,
      latitude: Number(p.location?.latitude),
      longitude: Number(p.location?.longitude),
      place_id: p.id ?? null,
      google_maps_url: p.googleMapsUri ?? null,
    };
    if (p.formattedAddress) r.full_address = p.formattedAddress;
    if (typeof hours?.openNow === "boolean") r.open_now = hours.openNow;
    if (p.businessStatus === "CLOSED_TEMPORARILY") r.temporarily_closed = true;
    if (tier === "enterprise") {
      if (Number.isFinite(p.rating)) r.rating = p.rating;
      if (Number.isFinite(p.userRatingCount)) r.rating_count = p.userRatingCount;
      if (p.priceLevel && p.priceLevel !== "PRICE_LEVEL_UNSPECIFIED") r.price_level = String(p.priceLevel).replace(/^PRICE_LEVEL_/, "").toLowerCase();
    }
    return r;
  }).filter(r => r.name && Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
}

/**
 * Places from Google, or `{ ok: false, why }` when it was not asked (no key, cap reached, skipped
 * after a failure) or did not answer. Never throws; the caller falls back to the free sources.
 */
export async function googleSearch(lat, lng, type, { name, cuisine, radius = 1500, openNow = false, details = [], fetchImpl = fetch, timeoutMs = GOOGLE_MS, log = console.log } = {}) {
  const key = googleKey();
  if (!key) return { ok: false, why: "no_key" };
  if (clock.now() < downUntil) return { ok: false, why: "skipped" };
  const tier = tierFor({ details });
  if (!claim(tier)) return { ok: false, why: "cap", tier };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(GOOGLE_URL, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": MASKS[tier] },
      body: JSON.stringify(requestBody(lat, lng, type, { name, cuisine, radius, openNow })),
    });
    if (!res.ok) {
      if (res.status >= 500) downUntil = clock.now() + BREAKER_MS;
      // The status only: Google's error body can echo the request, and the key is in a header.
      try { log({ google_places: "error", status: res.status }); } catch {}
      return { ok: false, why: `http_${res.status}`, tier };
    }
    const data = await res.json();
    return { ok: true, tier, results: mapPlaces(data?.places, tier) };
  } catch (err) {
    downUntil = clock.now() + BREAKER_MS;
    const why = err?.name === "AbortError" ? "timeout" : "unreachable";
    try { log({ google_places: why }); } catch {}
    return { ok: false, why, tier };
  } finally { clearTimeout(t); }
}
