// Venue search via Google Places API (New).
//
// Written from Google's docs (developers.google.com/maps/documentation/places/web-service/text-search,
// read 2026-10-08):
//   POST https://places.googleapis.com/v1/places:searchText
//   key in an `X-Goog-Api-Key` header
//   field mask in an `X-Goog-FieldMask` header (only billed for what you ask for)
//   body: { textQuery, maxResultCount, locationBias? }
//
// Pricing (as of 2026-10-08, Pay-as-you-go):
//   - Text Search (Basic): $32 per 1,000 requests (name, address, type, rating, hours)
//   - Text Search (Advanced): $35 per 1,000 (adds reviews, price level)
//   - $200/month free credit covers ~6,000 basic searches
//
// Nothing here has ever run against Google. There is no GOOGLE_PLACES_API_KEY in this process's
// environment, so every path below has only ever answered an injected fetch. docs/unverified.md
// says so.
import { config } from "./config.js";

export function venueStatus({ apiKey = config.placesKey } = {}) {
  if (apiKey) return { connected: true, provider: "google_places", what: "Google Places (venue search)" };
  return {
    connected: false,
    provider: "google_places",
    missing: ["GOOGLE_PLACES_API_KEY"],
    why: "No venue search is connected, so Reason cannot find restaurants, bars, or places by name, type, or location. Connecting it needs GOOGLE_PLACES_API_KEY.",
  };
}

const BASIC_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours",
  "places.regularOpeningHours",
  "places.googleMapsUri",
  "places.location",
  "places.primaryType",
  "places.primaryTypeDisplayName",
].join(",");

export function venueProvider({
  apiKey = config.placesKey,
  base = config.placesBase,
  fetchImpl = fetch,
  timeoutMs = config.placesTimeoutMs,
} = {}) {
  return {
    name: "google_places",

    async search(query, { location = null, radius = null, maxResults = 10 } = {}) {
      if (!apiKey) return { ok: false, ...venueStatus({ apiKey }) };

      const body = { textQuery: query, maxResultCount: Math.min(maxResults, 20) };

      if (location) {
        body.locationBias = {
          circle: {
            center: { latitude: location.lat, longitude: location.lng },
            radius: radius ?? 5000,
          },
        };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/v1/places:searchText`, {
          method: "POST",
          signal: ac.signal,
          headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": BASIC_FIELDS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          return { ok: false, error: `Google Places refused: ${res.status} ${res.statusText}. ${text.slice(0, 300)}` };
        }

        let json;
        try { json = JSON.parse(text); } catch {
          return { ok: false, error: "Google Places answered with something that was not JSON." };
        }

        const places = (json.places ?? []).map(p => ({
          id: p.id,
          name: p.displayName?.text ?? null,
          address: p.shortFormattedAddress ?? p.formattedAddress ?? null,
          full_address: p.formattedAddress ?? null,
          type: p.primaryTypeDisplayName?.text ?? p.primaryType ?? null,
          types: (p.types ?? []).slice(0, 5),
          rating: p.rating ?? null,
          reviews: p.userRatingCount ?? null,
          price_level: priceTag(p.priceLevel),
          open_now: p.currentOpeningHours?.openNow ?? null,
          hours: formatHours(p.regularOpeningHours),
          maps_url: p.googleMapsUri ?? null,
          lat: p.location?.latitude ?? null,
          lng: p.location?.longitude ?? null,
        }));

        return { ok: true, places, count: places.length, query };
      } catch (e) {
        const why = e.name === "AbortError"
          ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
          : e.message;
        return { ok: false, error: `Could not reach Google Places: ${why}.` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function priceTag(level) {
  if (!level) return null;
  const tags = {
    PRICE_LEVEL_FREE: "Free",
    PRICE_LEVEL_INEXPENSIVE: "$",
    PRICE_LEVEL_MODERATE: "$$",
    PRICE_LEVEL_EXPENSIVE: "$$$",
    PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
  };
  return tags[level] ?? null;
}

function formatHours(hours) {
  if (!hours?.periods?.length) return null;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return hours.periods.slice(0, 7).map(p => {
    const day = days[p.open?.day] ?? "?";
    const open = p.open?.hour != null ? `${String(p.open.hour).padStart(2, "0")}:${String(p.open.minute ?? 0).padStart(2, "0")}` : "?";
    const close = p.close?.hour != null ? `${String(p.close.hour).padStart(2, "0")}:${String(p.close.minute ?? 0).padStart(2, "0")}` : "?";
    return `${day} ${open}-${close}`;
  }).join(", ");
}
